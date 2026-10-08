import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { clients } from '../db/schema/clients'
import { folderSyncSettings } from '../db/schema/folder-sync'
import { AppError } from '../../shared/types/ipc'
import { recordLocalSyncChanges } from './folder-sync-store'
import { RevisionError, type JsonValue } from './folder-sync-revisions'
import {
  directoryRecordsAdapter,
  getDirectoryRecordView,
  planDirectoryBootstrap,
  planDirectoryRevision,
  portableClientValues,
  portableProjectValues,
  type DirectoryEntityType
} from './folder-sync-directory-records'
import {
  findClientByPortableId,
  findProjectByPortableId,
  portableIdOfClientRow,
  portableIdOfLocalClient,
  portableIdOfLocalProject
} from './folder-sync-builtin-client'
import { isJoinReviewPending } from './folder-sync-identity-links'

/*
 * Journals local client/project mutations (folder-sync-plan.md decisions A and E).
 *
 * Every helper runs inside the caller's business transaction, so the row and its causal change
 * commit or roll back together. A retained workspace connection is tracked even while transfer
 * is disabled or the folder is offline; without one, every helper is a no-op. Only portable
 * fields are journaled: folder mappings and other local columns never produce a change.
 * Callers pass a row's local syncId; the built-in client and rows linked during join review are
 * journaled under their portable IDs. While a join review is pending, a never-exported row is
 * edited locally without a journal entry; the review decides its identity and exports it.
 */

type Db<TSchema extends Record<string, unknown>> = BetterSQLite3Database<TSchema>
type Values = Record<string, JsonValue>

/** The retained workspace whose journal records local edits, whether or not transfer is on. */
export function directorySyncWorkspace<TSchema extends Record<string, unknown>>(
  db: Db<TSchema>
): string | null {
  return (
    db
      .select({ workspaceId: folderSyncSettings.workspaceId })
      .from(folderSyncSettings)
      .where(eq(folderSyncSettings.slot, 1))
      .get()?.workspaceId ?? null
  )
}

function invalidChange(error: unknown): never {
  if (error instanceof RevisionError)
    throw new AppError('SYNC_INVALID_DIRECTORY_CHANGE', error.message)
  throw error
}

/** The entity ID a local row is journaled under. */
function entityIdOf<TSchema extends Record<string, unknown>>(
  db: Db<TSchema>,
  entityType: DirectoryEntityType,
  syncId: string
): string {
  return entityType === 'client'
    ? portableIdOfLocalClient(db, syncId)
    : portableIdOfLocalProject(db, syncId)
}

function portable<TSchema extends Record<string, unknown>>(
  db: Db<TSchema>,
  entityType: DirectoryEntityType,
  syncId: string
): Values | null {
  if (entityType === 'client') {
    const row = findClientByPortableId(db, syncId)
    return row ? portableClientValues(row) : null
  }
  const row = findProjectByPortableId(db, syncId)
  return row ? portableProjectValues(db, row) : null
}

/** A never-exported record whose identity the pending join review has not decided yet. */
function awaitingJoinReview<TSchema extends Record<string, unknown>>(
  db: Db<TSchema>,
  workspaceId: string,
  entityType: DirectoryEntityType,
  syncId: string
): boolean {
  return (
    isJoinReviewPending(db, workspaceId) &&
    getDirectoryRecordView(db, workspaceId, entityType, syncId).lifecycle === 'missing'
  )
}

/** Bootstraps the record (a project's client first) when this computer has not exported it. */
export function exportDirectoryRecord<TSchema extends Record<string, unknown>>(
  db: Db<TSchema>,
  workspaceId: string,
  entityType: DirectoryEntityType,
  syncId: string
): void {
  if (entityType === 'project') {
    const project = findProjectByPortableId(db, syncId)
    const client = project
      ? db
          .select({ id: clients.id, syncId: clients.syncId, systemRole: clients.systemRole })
          .from(clients)
          .where(eq(clients.id, project.clientId))
          .get()
      : undefined
    if (client) exportDirectoryRecord(db, workspaceId, 'client', portableIdOfClientRow(db, client))
  }
  let plan: ReturnType<typeof planDirectoryBootstrap>
  try {
    plan = planDirectoryBootstrap(db, workspaceId, entityType, syncId)
  } catch (error) {
    invalidChange(error)
  }
  if (plan.status === 'requires')
    throw new AppError(
      'SYNC_REFERENCE_UNAVAILABLE',
      `Export ${plan.requires.map((ref) => `${ref.entityType} ${ref.entityId}`).join(', ')} first`
    )
  if (plan.status === 'ready')
    recordLocalSyncChanges(db, workspaceId, [plan.change], directoryRecordsAdapter)
}

/** Call after inserting a new local client/project row. */
export function journalDirectoryCreate<TSchema extends Record<string, unknown>>(
  db: Db<TSchema>,
  entityType: DirectoryEntityType,
  syncId: string
): void {
  const workspaceId = directorySyncWorkspace(db)
  if (workspaceId)
    exportDirectoryRecord(db, workspaceId, entityType, entityIdOf(db, entityType, syncId))
}

/**
 * Runs `mutate` and journals the portable fields it changed as an edit superseding the observed
 * heads. Unexported records are bootstrapped from their pre-edit values first. Editing a
 * conflicted field, or a deleted/lifecycle-conflicted record, fails with SYNC_CONFLICT (rolling
 * back the caller's transaction); edits to other fields proceed.
 */
export function journalDirectoryEdit<TSchema extends Record<string, unknown>, T>(
  db: Db<TSchema>,
  entityType: DirectoryEntityType,
  localSyncId: string,
  mutate: () => T
): T {
  const workspaceId = directorySyncWorkspace(db)
  if (!workspaceId) return mutate()
  const syncId = entityIdOf(db, entityType, localSyncId)
  exportDirectoryRecord(db, workspaceId, entityType, syncId)
  // The join review exports its current values, or adopts the linked record's.
  if (awaitingJoinReview(db, workspaceId, entityType, syncId)) return mutate()
  const before = portable(db, entityType, syncId)
  const result = mutate()
  const after = portable(db, entityType, syncId)
  if (!before || !after) return result
  const values: Values = Object.fromEntries(
    Object.entries(after).filter(([field, value]) => before[field] !== value)
  )
  if (!Object.keys(values).length) return result
  if (typeof values.clientSyncId === 'string') {
    exportDirectoryRecord(db, workspaceId, 'client', values.clientSyncId)
    if (awaitingJoinReview(db, workspaceId, 'client', values.clientSyncId))
      throw new AppError(
        'SYNC_JOIN_REVIEW_REQUIRED',
        'Finish matching clients and projects with the joined history before moving a shared project to this client.'
      )
  }

  const view = getDirectoryRecordView(db, workspaceId, entityType, syncId)
  if (view.lifecycle !== 'present')
    throw new AppError(
      'SYNC_CONFLICT',
      `This ${entityType} is ${view.lifecycle} in synced history; resolve it before editing`
    )
  const conflicted = Object.keys(values).filter((field) => view.conflicts.includes(field))
  if (conflicted.length)
    throw new AppError(
      'SYNC_CONFLICT',
      `Resolve the synced ${conflicted.join(', ')} conflict on this ${entityType} before editing it`
    )
  let change: ReturnType<typeof planDirectoryRevision>
  try {
    change = planDirectoryRevision(db, workspaceId, {
      id: randomUUID(),
      entityType,
      entityId: syncId,
      action: { type: 'edit', observedHeads: view.heads, values }
    })
  } catch (error) {
    invalidChange(error)
  }
  recordLocalSyncChanges(db, workspaceId, [change], directoryRecordsAdapter)
  return result
}

/**
 * With a workspace connection, records a causal deletion instead of removing rows: the record
 * is deactivated by projection, and its projects, sessions and folder mappings are untouched.
 * Returns false when no workspace is configured, so the caller keeps its local delete.
 */
export function journalDirectoryDelete<TSchema extends Record<string, unknown>>(
  db: Db<TSchema>,
  entityType: DirectoryEntityType,
  localSyncId: string
): boolean {
  const workspaceId = directorySyncWorkspace(db)
  if (!workspaceId) return false
  const syncId = entityIdOf(db, entityType, localSyncId)
  exportDirectoryRecord(db, workspaceId, entityType, syncId)
  // Never exported and not yet matched: refuse rather than fall back to a destructive local delete.
  if (awaitingJoinReview(db, workspaceId, entityType, syncId))
    throw new AppError(
      'SYNC_JOIN_REVIEW_REQUIRED',
      `Finish matching clients and projects with the joined history before deleting this ${entityType}.`
    )
  const view = getDirectoryRecordView(db, workspaceId, entityType, syncId)
  if (view.lifecycle === 'deleted') return true
  if (view.lifecycle !== 'present')
    throw new AppError(
      'SYNC_CONFLICT',
      `This ${entityType} has a synced edit/delete conflict; resolve it before deleting`
    )
  let change: ReturnType<typeof planDirectoryRevision>
  try {
    change = planDirectoryRevision(db, workspaceId, {
      id: randomUUID(),
      entityType,
      entityId: syncId,
      action: { type: 'delete', observedHeads: view.heads }
    })
  } catch (error) {
    invalidChange(error)
  }
  recordLocalSyncChanges(db, workspaceId, [change], directoryRecordsAdapter)
  return true
}
