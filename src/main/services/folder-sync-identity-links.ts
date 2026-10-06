import { and, eq } from 'drizzle-orm'
import { folderSyncSettings, syncLocalLinks } from '../db/schema/folder-sync'
import { AppError } from '../../shared/types/ipc'
import type { SyncDomainAdapter } from './folder-sync-store'

/*
 * Explicit links from a never-exported local client/project row to an existing shared record
 * (folder-sync-plan.md decision E, "Join existing history").
 *
 * A link is created only by the user's join review. It never rewrites the row's local ID or
 * syncId, never touches local foreign keys, and never renames a published portable ID: it only
 * says "this local row IS shared record X" so every portable translation uses X. Links live in
 * sync_local_links (local compatibility IDs, never exported) under their own entity types.
 * One shared ID maps to at most one local row (primary key); the reverse is enforced on write.
 *
 * The pending join review is a marker row in the same table. While it is present, local
 * directory exports and every export that references client/project IDs are withheld.
 */

type Reader = Pick<Parameters<SyncDomainAdapter['apply']>[0], 'select'>
type Writer = Pick<Parameters<SyncDomainAdapter['apply']>[0], 'select' | 'insert' | 'delete'>

export type LinkedEntityType = 'client' | 'project'

const LINK_TYPES: Record<LinkedEntityType, string> = {
  client: 'client-identity',
  project: 'project-identity'
}
const JOIN_REVIEW_TYPE = 'join-review'

/** The retained workspace, or null when sync was never configured. */
function connectedWorkspace(db: Reader): string | null {
  return (
    db
      .select({ workspaceId: folderSyncSettings.workspaceId })
      .from(folderSyncSettings)
      .where(eq(folderSyncSettings.slot, 1))
      .get()?.workspaceId ?? null
  )
}

/** Local row ID explicitly linked to a shared portable ID in the connected workspace. */
export function linkedLocalId(
  db: Reader,
  entityType: LinkedEntityType,
  portableId: string
): number | null {
  const workspaceId = connectedWorkspace(db)
  if (!workspaceId) return null
  return (
    db
      .select({ localId: syncLocalLinks.localId })
      .from(syncLocalLinks)
      .where(
        and(
          eq(syncLocalLinks.workspaceId, workspaceId),
          eq(syncLocalLinks.entityType, LINK_TYPES[entityType]),
          eq(syncLocalLinks.entityId, portableId)
        )
      )
      .get()?.localId ?? null
  )
}

/** Shared portable ID a local row is linked to, or null when it keeps its own identity. */
export function linkedPortableId(
  db: Reader,
  entityType: LinkedEntityType,
  localId: number
): string | null {
  const workspaceId = connectedWorkspace(db)
  if (!workspaceId) return null
  return (
    db
      .select({ entityId: syncLocalLinks.entityId })
      .from(syncLocalLinks)
      .where(
        and(
          eq(syncLocalLinks.workspaceId, workspaceId),
          eq(syncLocalLinks.entityType, LINK_TYPES[entityType]),
          eq(syncLocalLinks.localId, localId)
        )
      )
      .get()?.entityId ?? null
  )
}

/** Records one explicit link. Existing links are permanent; relinking is refused. */
export function recordIdentityLink(
  tx: Writer,
  workspaceId: string,
  entityType: LinkedEntityType,
  portableId: string,
  localId: number
): void {
  const type = LINK_TYPES[entityType]
  const taken = tx
    .select({ entityId: syncLocalLinks.entityId, localId: syncLocalLinks.localId })
    .from(syncLocalLinks)
    .where(and(eq(syncLocalLinks.workspaceId, workspaceId), eq(syncLocalLinks.entityType, type)))
    .all()
    .find((row) => row.entityId === portableId || row.localId === localId)
  if (taken)
    throw new AppError(
      'SYNC_JOIN_REVIEW_INVALID',
      `Shared ${entityType} ${portableId} or local row ${localId} is already linked`
    )
  tx.insert(syncLocalLinks)
    .values({ workspaceId, entityType: type, entityId: portableId, localId })
    .run()
}

export function isJoinReviewPending(db: Reader, workspaceId: string): boolean {
  return !!db
    .select({ localId: syncLocalLinks.localId })
    .from(syncLocalLinks)
    .where(
      and(
        eq(syncLocalLinks.workspaceId, workspaceId),
        eq(syncLocalLinks.entityType, JOIN_REVIEW_TYPE),
        eq(syncLocalLinks.entityId, workspaceId)
      )
    )
    .get()
}

export function setJoinReviewPending(tx: Writer, workspaceId: string, pending: boolean): void {
  const marker = and(
    eq(syncLocalLinks.workspaceId, workspaceId),
    eq(syncLocalLinks.entityType, JOIN_REVIEW_TYPE),
    eq(syncLocalLinks.entityId, workspaceId)
  )
  if (!pending) {
    tx.delete(syncLocalLinks).where(marker).run()
    return
  }
  if (!isJoinReviewPending(tx, workspaceId))
    tx.insert(syncLocalLinks)
      .values({ workspaceId, entityType: JOIN_REVIEW_TYPE, entityId: workspaceId, localId: 0 })
      .run()
}
