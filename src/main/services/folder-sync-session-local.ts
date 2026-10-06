import {
  afterLocalLegacyMutation,
  afterLocalLegacyDeletion,
  afterLocalLegacySplit,
  type LegacyHookResult
} from './folder-sync-legacy-edits'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { AppError } from '../../shared/types/ipc'
import { sessions, type Session } from '../db/schema/sessions'
import { manualTimeEntries } from '../db/schema/manual-time-entries'
import { sessionActivityMappings } from '../db/schema/session-activity-mappings'
import { sessionTimeOverrides } from '../db/schema/session-derivations'
import { historySyncWorkspace, readPortableHistoryFacts } from './folder-sync-history-records'
import { getPortableClientId, getPortableProjectId } from './folder-sync-builtin-client'
import { bootstrapFolderSync } from './folder-sync-bootstrap'
import {
  planManualEntryRevision,
  planManualEntryBootstrap,
  getManualEntryView,
  journalManualSyncChanges,
  type ManualDisposition
} from './folder-sync-manual-records'
import { canonicalJson } from './folder-sync-protocol'
import {
  planPortableSessionEdit,
  journalSessionRecordChanges,
  readPortableSessionRecords,
  planSessionSplitCopies,
  type PortableSessionValues
} from './folder-sync-session-records'
import {
  observedSessionEditHeads,
  type PortableSessionFragment
} from './folder-sync-session-overlay'
import { portableCoverageHash } from './folder-sync-portable-coverage'
import type { JsonValue } from './folder-sync-revisions'

type Db<S extends Record<string, unknown>> = BetterSQLite3Database<S>
const timeFields = ['startedAt', 'endedAt', 'durationMinutes'] as const
function valuesOf<S extends Record<string, unknown>>(db: Db<S>, row: Session) {
  return {
    startedAt: new Date(row.startedAt).toISOString(),
    endedAt: new Date(row.endedAt).toISOString(),
    durationMinutes: row.durationMinutes,
    clientSyncId: row.clientId === null ? null : getPortableClientId(db, row.clientId),
    projectSyncId: row.projectId === null ? null : getPortableProjectId(db, row.projectId),
    description: row.description,
    billable: !!row.billable
  }
}
/** Conversations of these rows, as JSON [provider, conversationId]; manual rows have none. */
function touchedConversationKeys<S extends Record<string, unknown>>(
  db: Db<S>,
  sessionIds: readonly number[]
): string[] {
  const keys = new Set<string>()
  for (const id of sessionIds) {
    const row = db.select().from(sessions).where(eq(sessions.id, id)).get()
    if (row?.source === 'auto' && row.claudeSessionId)
      keys.add(JSON.stringify([row.tool, row.claudeSessionId]))
    const mapping = db
      .select()
      .from(sessionActivityMappings)
      .where(eq(sessionActivityMappings.sessionId, id))
      .get()
    if (mapping) keys.add(JSON.stringify([mapping.provider, mapping.conversationId]))
  }
  return [...keys]
}

/**
 * Bootstrap what a local edit journals against. With `sessionIds`, captured activity, adoption
 * and automatic history cover only those rows' conversations, and saved history and manual
 * entries only those rows and their split lineage (the baselines their edits need); directory
 * and invoice domains stay whole. Without it, everything.
 */
export function prepareSessionSync<S extends Record<string, unknown>>(
  db: Db<S>,
  sessionIds?: readonly number[]
): string | null {
  const workspaceId = historySyncWorkspace(db)
  if (workspaceId)
    bootstrapFolderSync(
      db,
      workspaceId,
      sessionIds && { conversationKeys: touchedConversationKeys(db, sessionIds), sessionIds }
    )
  return workspaceId
}

/** The caller's session row, audit revision and causal edit commit together. */
export function journalSessionMutation<S extends Record<string, unknown>, T>(
  db: Db<S>,
  sessionId: number,
  mutate: () => T
): T {
  return journalSessionMutations(db, [sessionId], mutate)
}

export function journalSessionMutations<S extends Record<string, unknown>, T>(
  db: Db<S>,
  sessionIds: readonly number[],
  mutate: () => T
): T {
  const workspaceId = prepareSessionSync(db, sessionIds)
  if (!workspaceId) return mutate()
  const before = sessionIds
    .map((id) => db.select().from(sessions).where(eq(sessions.id, id)).get())
    .filter((row): row is Session => !!row)
  const result = mutate()
  for (const row of before) {
    const after = db.select().from(sessions).where(eq(sessions.id, row.id)).get()
    if (after) journalChangedSession(db, workspaceId, row, after)
  }
  return result
}

function journalChangedSession<S extends Record<string, unknown>>(
  db: Db<S>,
  workspaceId: string,
  before: Session,
  after: Session
): void {
  // Running capture stays local. Its final saved metadata is exported when it completes.
  if (after.status === 'active') return
  const sessionId = before.id
  const manual = db
    .select()
    .from(manualTimeEntries)
    .where(eq(manualTimeEntries.sessionId, sessionId))
    .get()
  const mapping = db
    .select()
    .from(sessionActivityMappings)
    .where(eq(sessionActivityMappings.sessionId, sessionId))
    .get()
  if (!manual && !mapping) {
    requireLegacyJournal(afterLocalLegacyMutation(db, workspaceId, sessionId))
    return
  }
  const previous = valuesOf(db, before)
  const next = valuesOf(db, after)
  const changed: Record<string, JsonValue> = Object.fromEntries(
    Object.entries(next).filter(
      ([field, value]) => previous[field as keyof typeof previous] !== value
    )
  )
  if (!Object.keys(changed).length) return
  if ('clientSyncId' in changed || 'projectSyncId' in changed) {
    changed.clientSyncId = next.clientSyncId
    changed.projectSyncId = next.projectSyncId
  }
  if (manual) {
    const view = getManualEntryView(db, workspaceId, manual.id)
    if (
      view.lifecycle !== 'present' ||
      Object.keys(changed).some((field) => view.conflicts.includes(field))
    )
      throw new AppError(
        'SYNC_CONFLICT',
        'Resolve this manual entry shared conflict before editing it.'
      )
    journalManualSyncChanges(db, workspaceId, [
      planManualEntryRevision(db, workspaceId, {
        id: randomUUID(),
        entryId: manual.id,
        action: { type: 'edit', observedHeads: view.heads, values: changed }
      })
    ])
  } else if (mapping) {
    const fragment = JSON.parse(mapping.intervalJson) as PortableSessionFragment
    const target = { provider: mapping.provider, conversationId: mapping.conversationId }
    const values = { ...changed } as Partial<PortableSessionValues>
    if (timeFields.some((field) => field in changed)) {
      const flags = db
        .select()
        .from(sessionTimeOverrides)
        .where(eq(sessionTimeOverrides.sessionId, sessionId))
        .get()
      values.time = {
        baseCoverageHash: portableCoverageHash(
          target.provider,
          target.conversationId,
          fragment.coverage
        )
      }
      for (const field of timeFields)
        if (flags?.[field] || field in changed) Object.assign(values.time, { [field]: next[field] })
    }
    for (const field of timeFields) delete (values as Record<string, unknown>)[field]
    journalSessionRecordChanges(
      db,
      workspaceId,
      planPortableSessionEdit(db, workspaceId, { target, fragment, values, newId: randomUUID })
    )
  }
}

/**
 * The shared lifecycle a local removal supersedes. null: not exported yet (its bootstrap carries
 * the local audit row) or already removed exactly so.
 */
function removableManualView<S extends Record<string, unknown>>(
  db: Db<S>,
  workspaceId: string,
  entryId: string,
  disposition: ManualDisposition
) {
  const view = getManualEntryView(db, workspaceId, entryId)
  if (view.lifecycle === 'missing') return null
  const agreed = view.fields.disposition
  if (
    view.lifecycle === 'deleted' &&
    agreed.status === 'resolved' &&
    canonicalJson(agreed.value) === canonicalJson(disposition as unknown as JsonValue)
  )
    return null
  if (view.lifecycle !== 'present' || view.conflicts.includes('disposition'))
    throw new AppError(
      'SYNC_CONFLICT',
      'Resolve this manual entry shared conflict before removing or splitting it.'
    )
  return view
}

/** Call inside the deletion's transaction, after its audit row. A restored entry may be deleted again. */
export function journalManualSessionDeletion<S extends Record<string, unknown>>(
  db: Db<S>,
  sessionId: number
): void {
  const workspaceId = historySyncWorkspace(db)
  if (!workspaceId) return
  const entry = db
    .select()
    .from(manualTimeEntries)
    .where(eq(manualTimeEntries.sessionId, sessionId))
    .get()
  if (!entry) return
  const disposition: ManualDisposition = { kind: 'deleted' }
  const view = removableManualView(db, workspaceId, entry.id, disposition)
  if (!view) return
  journalManualSyncChanges(db, workspaceId, [
    planManualEntryRevision(db, workspaceId, {
      id: randomUUID(),
      entryId: entry.id,
      action: { type: 'delete', observedHeads: view.heads },
      disposition
    })
  ])
}

/**
 * Call inside a local manual split's transaction, after its parts exist. Shares the parts, then
 * retires the parent with a split naming exactly them, superseding the heads this computer saw.
 */
export function journalManualSessionSplit<S extends Record<string, unknown>>(
  db: Db<S>,
  parentSessionId: number,
  partSessionIds: readonly number[],
  splitAt: string
): void {
  const workspaceId = historySyncWorkspace(db)
  if (!workspaceId) return
  const parent = db
    .select()
    .from(manualTimeEntries)
    .where(eq(manualTimeEntries.sessionId, parentSessionId))
    .get()
  if (!parent) return
  const parts = partSessionIds.map((id) =>
    db.select().from(manualTimeEntries).where(eq(manualTimeEntries.sessionId, id)).get()
  )
  if (parts.some((part) => part?.parentId !== parent.id))
    throw new AppError(
      'MANUAL_ENTRY_NOT_FOUND',
      'Manual split parts are missing their identity; saved history was retained'
    )
  const disposition: ManualDisposition = {
    kind: 'split',
    splitAt: new Date(splitAt).toISOString(),
    children: parts.map((part) => part!.id)
  }
  const view = removableManualView(db, workspaceId, parent.id, disposition)
  if (!view) return
  // Usually already shared by the transaction's bootstrap; the parts depend only on the parent root.
  const shared = parts.map((part) => planManualEntryBootstrap(db, workspaceId, part!.id))
  if (shared.some((plan) => plan.status !== 'ready' && plan.status !== 'has-history'))
    throw new AppError(
      'SYNC_REFERENCE_UNAVAILABLE',
      'The split parts cannot be shared yet. Sync, then split again.'
    )
  journalManualSyncChanges(
    db,
    workspaceId,
    shared.flatMap((plan) => (plan.status === 'ready' ? plan.changes : []))
  )
  journalManualSyncChanges(db, workspaceId, [
    planManualEntryRevision(db, workspaceId, {
      id: randomUUID(),
      entryId: parent.id,
      action: { type: 'delete', observedHeads: view.heads },
      disposition
    })
  ])
}

export function mappedSessionObservedHeads<S extends Record<string, unknown>>(
  db: Db<S>,
  sessionId: number
): string[] {
  const workspaceId = prepareSessionSync(db, [sessionId])
  if (!workspaceId) return []
  const mapping = db
    .select()
    .from(sessionActivityMappings)
    .where(eq(sessionActivityMappings.sessionId, sessionId))
    .get()
  if (!mapping) return []
  const records = readPortableSessionRecords(db, workspaceId, {
    provider: mapping.provider,
    conversationId: mapping.conversationId
  })
  return observedSessionEditHeads(
    JSON.parse(mapping.intervalJson) as PortableSessionFragment,
    records.edits
  )
}

/** Call after a local mapped split, before committing its new rows and cut. */
export function journalMappedSplitCopies<S extends Record<string, unknown>>(
  db: Db<S>,
  parentId: number,
  childIds: number[]
): void {
  const workspaceId = historySyncWorkspace(db)
  if (!workspaceId) return
  const parent = db
    .select()
    .from(sessionActivityMappings)
    .where(eq(sessionActivityMappings.sessionId, parentId))
    .get()!
  const target = { provider: parent.provider, conversationId: parent.conversationId }
  const pieces = childIds
    .map(
      (id) =>
        db
          .select()
          .from(sessionActivityMappings)
          .where(eq(sessionActivityMappings.sessionId, id))
          .get()!
    )
    .map((row) => JSON.parse(row.intervalJson) as PortableSessionFragment)
  const cuts =
    readPortableHistoryFacts(db, undefined, workspaceId)
      .get(JSON.stringify([target.provider, target.conversationId]))
      ?.cuts.map((cut) => cut.splitAt) ?? []
  const plan = planSessionSplitCopies(db, workspaceId, {
    target,
    fragment: JSON.parse(parent.intervalJson) as PortableSessionFragment,
    pieces,
    cuts,
    newId: randomUUID
  })
  if (plan.status === 'held')
    throw new AppError('SYNC_CONFLICT', 'Resolve this session shared edits before splitting it.')
  journalSessionRecordChanges(db, workspaceId, plan.changes)
}

function requireLegacyJournal(result: LegacyHookResult): void {
  if (result.status === 'journaled' || result.status === 'unchanged') return
  throw new AppError(
    'SYNC_LEGACY_REVIEW_REQUIRED',
    result.status === 'conflict'
      ? result.message
      : 'This saved history needs shared references or time review before it can be changed. Resolve the Shared history issue in Settings first.'
  )
}
export function journalLegacySessionDeletion<S extends Record<string, unknown>>(
  db: Db<S>,
  sessionId: number
): void {
  const workspaceId = historySyncWorkspace(db)
  if (
    !workspaceId ||
    db.select().from(manualTimeEntries).where(eq(manualTimeEntries.sessionId, sessionId)).get()
  )
    return
  requireLegacyJournal(afterLocalLegacyDeletion(db, workspaceId, sessionId))
}
export function journalLegacySessionSplit<S extends Record<string, unknown>>(
  db: Db<S>,
  sessionId: number,
  currentSplit?: {
    legacyRecordId: string
    firstSessionId: number
    secondSessionId: number
    splitAt: string
  }
): void {
  const workspaceId = historySyncWorkspace(db)
  if (
    !workspaceId ||
    db.select().from(manualTimeEntries).where(eq(manualTimeEntries.sessionId, sessionId)).get()
  )
    return
  requireLegacyJournal(afterLocalLegacySplit(db, workspaceId, sessionId, undefined, currentSplit))
}
