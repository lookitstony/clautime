import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { and, desc, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { AppError } from '../../shared/types/ipc'
import type {
  ApplyFolderSyncJoinReview,
  FolderSyncJoinDecision,
  FolderSyncJoinReview,
  JoinReviewLocalRecord,
  JoinReviewSharedRecord,
  JoinReviewValue
} from '../../shared/types/folder-sync'
import { clients, type ClientRow } from '../db/schema/clients'
import { projects, type ProjectRow } from '../db/schema/projects'
import { syncChanges, syncRecordStates } from '../db/schema/folder-sync'
import { canonicalJson } from './folder-sync-protocol'
import {
  UNASSIGNED_CLIENT_NAME,
  UNASSIGNED_CLIENT_SYNC_ID,
  findClientByPortableId,
  findProjectByPortableId,
  portableIdOfClientRow,
  portableIdOfProjectRow
} from './folder-sync-builtin-client'
import {
  getDirectoryRecordView,
  portableClientValues,
  portableProjectValues,
  refreshDirectoryProjections,
  type DirectoryEntityType
} from './folder-sync-directory-records'
import {
  isJoinReviewPending,
  recordIdentityLink,
  setJoinReviewPending
} from './folder-sync-identity-links'
import { manualRecordsAdapter } from './folder-sync-manual-records'
import type { RecordView } from './folder-sync-revisions'
import type { SyncDomainAdapter } from './folder-sync-store'
import { getProjectFolderMapping, setProjectFolderMapping } from './project-folder-mappings'

/* Joining imports shared identities before publishing local work. Clear client/project matches
 * are chosen automatically in setup; only unmatched shared project folders need user input.
 * The complete decision set and local folder choices apply atomically against a fresh preview.
 * Identity links retain local IDs, foreign keys, saved invoice amounts and folder mappings.
 */

type Db<S extends Record<string, unknown>> = BetterSQLite3Database<S>
type Reader = Pick<Parameters<SyncDomainAdapter['apply']>[0], 'select'>

interface Candidate {
  record: JoinReviewLocalRecord
  localId: number
}

function hasHistory(
  db: Reader,
  workspaceId: string,
  entityType: DirectoryEntityType,
  entityId: string
): boolean {
  return !!db
    .select({ id: syncChanges.id })
    .from(syncChanges)
    .where(
      and(
        eq(syncChanges.workspaceId, workspaceId),
        eq(syncChanges.entityType, entityType),
        eq(syncChanges.entityId, entityId)
      )
    )
    .limit(1)
    .get()
}

const normalized = (name: string): string => name.trim().replace(/\s+/g, ' ').toLocaleLowerCase()

/** The built-in client matches by role; remaining local rows participate in automatic matching. */
function candidateClients(db: Reader, workspaceId: string): ClientRow[] {
  return db
    .select()
    .from(clients)
    .orderBy(clients.id)
    .all()
    .filter(
      (row) =>
        row.systemRole === null &&
        !hasHistory(db, workspaceId, 'client', portableIdOfClientRow(db, row))
    )
}

function candidateProjects(db: Reader, workspaceId: string): ProjectRow[] {
  return db
    .select()
    .from(projects)
    .orderBy(projects.id)
    .all()
    .filter((row) => !hasHistory(db, workspaceId, 'project', portableIdOfProjectRow(db, row)))
}

export function hasJoinReviewCandidates(db: Reader, workspaceId: string): boolean {
  return (
    candidateClients(db, workspaceId).length > 0 || candidateProjects(db, workspaceId).length > 0
  )
}

/** Called by connect() in join mode before anything is exported. */
export function beginJoinReview<S extends Record<string, unknown>>(
  tx: Db<S>,
  workspaceId: string
): boolean {
  setJoinReviewPending(tx, workspaceId, true)
  return true
}

function sharedIds(db: Reader, workspaceId: string, entityType: DirectoryEntityType): string[] {
  const ids = db
    .select({ entityId: syncChanges.entityId })
    .from(syncChanges)
    .where(and(eq(syncChanges.workspaceId, workspaceId), eq(syncChanges.entityType, entityType)))
    .all()
    .map((row) => row.entityId)
  return [...new Set(ids)].sort()
}

function agreed(view: RecordView, field: string): JoinReviewValue | undefined {
  const state = view.fields[field]
  return state && state.status !== 'conflict'
    ? ((state.value ?? null) as JoinReviewValue)
    : undefined
}

function valuesOf(view: RecordView, omit: string[]): Record<string, JoinReviewValue> {
  const values: Record<string, JoinReviewValue> = {}
  for (const [field, state] of Object.entries(view.fields))
    if (!omit.includes(field)) values[field] = (state.value ?? null) as JoinReviewValue
  return values
}

function sharedClientName(db: Reader, workspaceId: string, clientSyncId: string): string | null {
  if (clientSyncId === UNASSIGNED_CLIENT_SYNC_ID)
    return findClientByPortableId(db, clientSyncId)?.name ?? UNASSIGNED_CLIENT_NAME
  const name = agreed(getDirectoryRecordView(db, workspaceId, 'client', clientSyncId), 'name')
  return typeof name === 'string' ? name : null
}

interface BuiltReview {
  review: FolderSyncJoinReview
  candidates: Map<string, Candidate>
}

const keyOf = (entityType: string, localSyncId: string): string => `${entityType}:${localSyncId}`

function buildReview(db: Reader, workspaceId: string, deviceId?: string): BuiltReview {
  const localFolder = (syncId: string): string | null => {
    if (!deviceId) return null
    const folder = getProjectFolderMapping(
      db as Db<Record<string, unknown>>,
      deviceId,
      syncId
    )?.directoryPath
    try {
      return folder && statSync(folder).isDirectory() ? folder : null
    } catch {
      return null
    }
  }
  const shared: JoinReviewSharedRecord[] = []
  const heads: Record<string, Record<string, string[]>> = {}
  const sharedClientNames = new Set<string>()
  for (const entityType of ['client', 'project'] as const)
    for (const entityId of sharedIds(db, workspaceId, entityType)) {
      const view = getDirectoryRecordView(db, workspaceId, entityType, entityId)
      if (view.lifecycle === 'missing') continue
      if (entityType === 'client')
        for (const value of [
          view.fields.name?.value,
          ...(view.fields.name?.heads.map((head) => head.value) ?? [])
        ])
          if (typeof value === 'string') sharedClientNames.add(value)
      // Link targets: live records with no local row yet. The built-in matches by role.
      if (view.lifecycle !== 'present' || entityId === UNASSIGNED_CLIENT_SYNC_ID) continue
      const existing =
        entityType === 'client'
          ? findClientByPortableId(db, entityId)
          : findProjectByPortableId(db, entityId)
      if (existing && (entityType === 'client' || !deviceId)) continue
      const name = agreed(view, 'name')
      const clientSyncId = entityType === 'project' ? agreed(view, 'clientSyncId') : undefined
      heads[`${entityType}:${entityId}`] = view.heads
      shared.push({
        entityType,
        entityId,
        name: typeof name === 'string' ? name : null,
        clientSyncId: typeof clientSyncId === 'string' ? clientSyncId : null,
        clientName:
          typeof clientSyncId === 'string' ? sharedClientName(db, workspaceId, clientSyncId) : null,
        values: valuesOf(view, ['name', 'clientSyncId']),
        conflicts: view.conflicts,
        ...(existing
          ? { localSyncId: existing.syncId, directoryPath: localFolder(existing.syncId) }
          : {})
      })
    }
  const suggestions = (entityType: DirectoryEntityType, name: string): string[] =>
    shared
      .filter(
        (row) =>
          row.entityType === entityType &&
          row.name !== null &&
          normalized(row.name) === normalized(name)
      )
      .map((row) => row.entityId)

  const candidates = new Map<string, Candidate>()
  for (const row of candidateClients(db, workspaceId)) {
    const { name, ...values } = portableClientValues(row)
    candidates.set(keyOf('client', row.syncId), {
      localId: row.id,
      record: {
        entityType: 'client',
        localSyncId: row.syncId,
        name,
        values,
        suggestions: suggestions('client', name)
      }
    })
  }
  for (const row of candidateProjects(db, workspaceId)) {
    const { name, clientSyncId: _clientSyncId, ...values } = portableProjectValues(db, row)
    const client = db.select().from(clients).where(eq(clients.id, row.clientId)).get()!
    const clientPortableId = portableIdOfClientRow(db, client)
    const clientDecided =
      client.systemRole !== null || hasHistory(db, workspaceId, 'client', clientPortableId)
    candidates.set(keyOf('project', row.syncId), {
      localId: row.id,
      record: {
        entityType: 'project',
        localSyncId: row.syncId,
        name,
        values,
        clientLocalSyncId: client.syncId,
        clientName: client.name,
        clientSharedId: clientDecided ? clientPortableId : null,
        suggestions: suggestions('project', name),
        ...(deviceId ? { directoryPath: localFolder(row.syncId) } : {})
      }
    })
  }
  const local = [...candidates.values()].map((candidate) => candidate.record)
  const names = [...sharedClientNames].sort()
  const fingerprint = createHash('sha256')
    .update(
      canonicalJson({
        purpose: 'clautime-join-review-1',
        workspaceId,
        local,
        shared,
        heads,
        sharedClientNames: names
      })
    )
    .digest('hex')
  return {
    review: { workspaceId, required: true, fingerprint, local, shared, sharedClientNames: names },
    candidates
  }
}

export function readJoinReview(
  db: Reader,
  workspaceId: string,
  deviceId?: string
): FolderSyncJoinReview {
  if (!isJoinReviewPending(db, workspaceId))
    return {
      workspaceId,
      required: false,
      fingerprint: '',
      local: [],
      shared: [],
      sharedClientNames: []
    }
  return buildReview(db, workspaceId, deviceId).review
}

function invalid(message: string): never {
  throw new AppError('SYNC_JOIN_REVIEW_INVALID', message)
}

function checkedName(value: unknown): string {
  if (typeof value !== 'string') invalid('Enter a name.')
  const name = value.trim()
  // eslint-disable-next-line no-control-regex
  if (!name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name) || !name.isWellFormed())
    invalid('Enter a name of 1 to 200 characters.')
  return name
}

function checkedDecision(value: unknown): FolderSyncJoinDecision {
  if (!value || typeof value !== 'object') invalid('Each decision must be an object.')
  const { entityType, localSyncId, action, sharedId, name } = value as Record<string, unknown>
  if (entityType !== 'client' && entityType !== 'project')
    invalid('Decisions name a client or project.')
  if (typeof localSyncId !== 'string') invalid('Decisions name a local record.')
  if (action === 'link') {
    if (typeof sharedId !== 'string') invalid('Choose the shared record to link.')
    return { entityType, localSyncId, action, sharedId }
  }
  if (action !== 'separate') invalid('Choose link or keep separate.')
  return {
    entityType,
    localSyncId,
    action,
    ...(name === undefined ? {} : { name: checkedName(name) })
  }
}

/**
 * Re-projects imported time entries held only because a shared client/project had no local row,
 * through the manual adapter's own idempotent apply. Each runs in a savepoint; a failure leaves
 * the entry held for its next revision rather than aborting the review.
 */
function reprojectHeldManualEntries<S extends Record<string, unknown>>(
  tx: Db<S>,
  workspaceId: string
): void {
  const held = tx
    .select()
    .from(syncRecordStates)
    .where(
      and(
        eq(syncRecordStates.workspaceId, workspaceId),
        eq(syncRecordStates.entityType, 'manual-entry')
      )
    )
    .all()
    .filter((row) =>
      ((JSON.parse(row.stateJson) as { blockers?: string[] }).blockers ?? []).some((blocker) =>
        blocker.endsWith(':unavailable')
      )
    )
  for (const row of held) {
    const latest = tx
      .select({ json: syncChanges.changeJson })
      .from(syncChanges)
      .where(
        and(
          eq(syncChanges.workspaceId, workspaceId),
          eq(syncChanges.entityType, 'manual-entry'),
          eq(syncChanges.entityId, row.entityId)
        )
      )
      .orderBy(desc(syncChanges.recordedAt))
      .limit(1)
      .get()
    if (!latest) continue
    try {
      tx.transaction((inner) =>
        manualRecordsAdapter.apply(inner, workspaceId, JSON.parse(latest.json))
      )
    } catch {
      // Still held and visible; the entry's next revision projects it again.
    }
  }
}

/**
 * Applies every decision atomically, then clears the pending review and re-projects held shared
 * records. The caller runs the normal bootstrap in the same transaction to export the result.
 */
export function applyJoinReview<S extends Record<string, unknown>>(
  tx: Db<S>,
  workspaceId: string,
  input: ApplyFolderSyncJoinReview,
  deviceId?: string
): void {
  if (!isJoinReviewPending(tx, workspaceId))
    throw new AppError(
      'SYNC_JOIN_REVIEW_NOT_REQUIRED',
      'No clients or projects on this computer are waiting for review.'
    )
  if (!input || typeof input.fingerprint !== 'string' || !Array.isArray(input.decisions))
    invalid('Send the review fingerprint and decisions.')
  const { review, candidates } = buildReview(tx, workspaceId, deviceId)
  if (input.fingerprint !== review.fingerprint)
    throw new AppError(
      'SYNC_JOIN_REVIEW_STALE',
      'Clients or projects changed since this review was shown. Review the updated list and choose again.'
    )

  const decisions = new Map<string, FolderSyncJoinDecision>()
  for (const raw of input.decisions) {
    const decision = checkedDecision(raw)
    const key = keyOf(decision.entityType, decision.localSyncId)
    if (!candidates.has(key))
      invalid(`${decision.entityType} ${decision.localSyncId} is not in this review.`)
    if (decisions.has(key))
      invalid(`${decision.entityType} ${decision.localSyncId} has more than one decision.`)
    decisions.set(key, decision)
  }
  if (decisions.size !== candidates.size)
    throw new AppError(
      'SYNC_JOIN_REVIEW_INCOMPLETE',
      `Choose link or keep separate for every client and project (${candidates.size - decisions.size} remaining).`
    )

  const shared = new Map(
    review.shared
      .filter((row) => !row.localSyncId)
      .map((row) => [keyOf(row.entityType, row.entityId), row])
  )
  const targets = new Set<string>()
  for (const decision of decisions.values()) {
    if (decision.action !== 'link') continue
    const key = keyOf(decision.entityType, decision.sharedId)
    if (!shared.has(key)) invalid(`Choose a shared ${decision.entityType} from this review.`)
    if (targets.has(key))
      invalid(
        `Two ${decision.entityType}s on this computer cannot both be the same shared ${decision.entityType}.`
      )
    targets.add(key)
  }

  // A linked project keeps its local client, so that client must be the shared project's client.
  for (const [key, decision] of decisions) {
    if (decision.entityType !== 'project' || decision.action !== 'link') continue
    const local = candidates.get(key)!.record
    const target = shared.get(keyOf('project', decision.sharedId))!
    const clientDecision =
      local.clientSharedId === null
        ? decisions.get(keyOf('client', local.clientLocalSyncId!))
        : undefined
    const future =
      local.clientSharedId ?? (clientDecision?.action === 'link' ? clientDecision.sharedId : null)
    if (!future || target.clientSyncId !== future)
      throw new AppError(
        'SYNC_JOIN_PROJECT_CLIENT_MISMATCH',
        `Project "${local.name}" belongs to "${local.clientName}". Link that client to "${target.clientName ?? "the shared project's client"}" too, or keep the project separate.`
      )
  }

  // A separate client must not collide with a shared client name.
  const now = new Date().toISOString()
  const separateClients = new Map<number, { name: string; previous: string }>()
  for (const [key, decision] of decisions) {
    if (decision.action !== 'separate') continue
    const { record, localId } = candidates.get(key)!
    const name = decision.name ?? record.name
    if (decision.entityType === 'client') {
      if (review.sharedClientNames.includes(name))
        throw new AppError(
          'SYNC_JOIN_NAME_COLLISION',
          `The shared history already has a client named "${name}". Enter a different name to keep this computer's client separate, or link it.`
        )
      separateClients.set(localId, { name, previous: record.name })
    } else if (name !== record.name) {
      tx.update(projects).set({ name, updatedAt: now }).where(eq(projects.id, localId)).run()
    }
  }
  const finalNames = tx
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .all()
    .map((row) => ({ id: row.id, name: separateClients.get(row.id)?.name ?? row.name }))
  for (const [id, { name, previous }] of separateClients) {
    if (finalNames.some((row) => row.id !== id && row.name === name))
      throw new AppError(
        'SYNC_JOIN_NAME_COLLISION',
        `Another client on this computer is already named "${name}".`
      )
    if (name !== previous)
      tx.update(clients).set({ name, updatedAt: now }).where(eq(clients.id, id)).run()
  }

  for (const entityType of ['client', 'project'] as const)
    for (const [key, decision] of decisions)
      if (decision.entityType === entityType && decision.action === 'link')
        recordIdentityLink(
          tx,
          workspaceId,
          entityType,
          decision.sharedId,
          candidates.get(key)!.localId
        )

  setJoinReviewPending(tx, workspaceId, false)
  // Linked rows now project their shared values; unlinked shared records get their own rows.
  refreshDirectoryProjections(tx, workspaceId)
  if (input.folders !== undefined) {
    if (!deviceId || !Array.isArray(input.folders)) invalid('Choose folders on this computer.')
    const mapped = new Set<string>()
    for (const folder of input.folders) {
      if (
        !folder ||
        typeof folder.sharedId !== 'string' ||
        typeof folder.directoryPath !== 'string' ||
        mapped.has(folder.sharedId)
      )
        invalid('Choose one folder per shared project.')
      if (
        !review.shared.some(
          (row) => row.entityType === 'project' && row.entityId === folder.sharedId
        )
      )
        invalid('Choose a project from this review.')
      try {
        if (!statSync(folder.directoryPath).isDirectory())
          invalid('Choose an existing project folder.')
      } catch {
        invalid('Choose an existing project folder.')
      }
      const project = findProjectByPortableId(tx, folder.sharedId)
      if (!project) invalid('The shared project is unavailable.')
      setProjectFolderMapping(tx, deviceId, project.syncId, folder.directoryPath)
      mapped.add(folder.sharedId)
    }
  }
  reprojectHeldManualEntries(tx, workspaceId)
}
