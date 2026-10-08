import { collectInvoiceSyncChanges, journalInvoiceSyncChanges } from './folder-sync-invoice-records'
import { and, eq, inArray, isNotNull, or } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { activityIdentities, activityObservations } from '../db/schema/activity-evidence'
import { sourceMachines } from '../db/schema/activity-observers'
import { manualTimeEntries } from '../db/schema/manual-time-entries'
import { sessions } from '../db/schema/sessions'
import { sessionActivityMappings } from '../db/schema/session-activity-mappings'
import { sessionDeletions } from '../db/schema/session-deletions'
import { sessionTimeOverrides } from '../db/schema/session-derivations'
import { sessionSplits, sessionReplacements } from '../db/schema/session-history'
import { sessionLegacyRecords } from '../db/schema/session-legacy'
import { getPortableClientId, getPortableProjectId } from './folder-sync-builtin-client'
import { isJoinReviewPending } from './folder-sync-identity-links'
import { activitySyncAdapter, syncFactChangeId } from './folder-sync-activity-records'
import { SyncError, type SyncChange } from './folder-sync-protocol'
import { collectAvailableActivity } from './folder-sync-activity-export'
import { planDirectoryExport, directoryRecordsAdapter } from './folder-sync-directory-records'
import {
  collectHistorySyncChanges,
  historyRecordsAdapter,
  readPortableHistoryFacts
} from './folder-sync-history-records'
import { statSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import {
  collectLegacySyncChanges,
  journalLegacySyncChanges,
  legacyRetentionCandidates,
  planLegacyExportBatches,
  planLegacyOriginPages,
  retainSourceLessSessionsForSync,
  type LegacyJournalOptions
} from './folder-sync-legacy-records'
import {
  collectManualSyncChanges,
  journalManualSyncChanges,
  manualEntryIdentityRoot,
  planManualEntryBootstrap,
  type ManualExport
} from './folder-sync-manual-records'
import {
  planSessionEditBaseline,
  journalSessionRecordChanges,
  readPortableSessionRecords,
  type PortableSessionValues
} from './folder-sync-session-records'
import {
  defaultSessionAnchor,
  observedSessionEditHeads,
  type PortableSessionFragment
} from './folder-sync-session-overlay'
import { recordLocalSyncChanges } from './folder-sync-store'
import {
  previewSessionActivityAdoption,
  adoptSessionActivityMappings
} from './session-activity-mappings'
import { getWorkspacePolicy } from './workspace-policy'
import { portableCoverageHash } from './folder-sync-portable-coverage'

type Db<S extends Record<string, unknown>> = BetterSQLite3Database<S>
export interface SyncProjectionIssue {
  source: string
  code: string
  message: string
}
export const JOIN_REVIEW_ISSUE: SyncProjectionIssue = Object.freeze({
  source: 'join review',
  code: 'SYNC_JOIN_REVIEW_REQUIRED',
  message: 'Connect shared projects to folders on this computer to finish sync setup.'
})

const keyOf = (provider: string, conversationId: string) =>
  JSON.stringify([provider, conversationId])
const conversationIdsOf = (keys: readonly string[]) => [
  ...new Set(keys.map((key) => (JSON.parse(key) as [string, string])[1]))
]

/**
 * Link only complete, unambiguous current-policy groups. No measurements or edits change.
 * `conversationKeys` previews and adopts only those conversations' ledger.
 */
export function linkComparableLocalActivity<S extends Record<string, unknown>>(
  db: Db<S>,
  conversationKeys?: readonly string[]
): void {
  if (!getWorkspacePolicy(db)) return
  const preview = previewSessionActivityAdoption(db, conversationKeys)
  const selected: number[] = []
  for (let index = 0; index < preview.conversations.length; index++) {
    const group = preview.comparisons.filter(
      (row) => row.conversationIndex === index && row.disposition === 'active'
    )
    if (
      !group.length ||
      group.some(
        (row) =>
          row.status !== 'comparable' ||
          preview.saved.sessions.find((saved) => saved.id === row.sessionId)?.status !== 'completed'
      )
    )
      continue
    selected.push(
      ...group
        .filter(
          (row) =>
            !preview.saved.activityMappings.some((mapping) => mapping.sessionId === row.sessionId)
        )
        .map((row) => row.sessionId)
    )
  }
  if (selected.length)
    adoptSessionActivityMappings(db, preview.fingerprint, selected, conversationKeys)
}

/**
 * Conversations linkComparableLocalActivity could adopt rows of: an unmapped, completed,
 * automatic row with a conversation ID and the history preview's 'active' disposition (not
 * deleted, split or replaced). Sorted; saved tables only, no ledger read.
 */
function adoptionCandidateKeys<S extends Record<string, unknown>>(db: Db<S>): string[] {
  if (!getWorkspacePolicy(db)) return []
  const excluded = new Set([
    ...db
      .select({ id: sessionActivityMappings.sessionId })
      .from(sessionActivityMappings)
      .all()
      .map((row) => row.id),
    ...db
      .select({ id: sessionDeletions.sessionId })
      .from(sessionDeletions)
      .all()
      .map((row) => row.id),
    ...db
      .select({ id: sessionSplits.parentSessionId })
      .from(sessionSplits)
      .all()
      .map((row) => row.id),
    ...db
      .select({ id: sessionReplacements.predecessorSessionId })
      .from(sessionReplacements)
      .all()
      .map((row) => row.id)
  ])
  const keys = new Set<string>()
  for (const row of db
    .select({ id: sessions.id, tool: sessions.tool, conversationId: sessions.claudeSessionId })
    .from(sessions)
    .where(and(eq(sessions.source, 'auto'), eq(sessions.status, 'completed')))
    .all())
    if (row.conversationId && !excluded.has(row.id)) keys.add(keyOf(row.tool, row.conversationId))
  return [...keys].sort()
}

/** Captured observations of these conversations, for a scoped activity export. */
function conversationObservationIds<S extends Record<string, unknown>>(
  db: Db<S>,
  conversationKeys: readonly string[]
): string[] {
  const scope = new Set(conversationKeys)
  return db
    .select({
      id: activityObservations.id,
      provider: activityIdentities.provider,
      conversationId: activityIdentities.conversationId
    })
    .from(activityObservations)
    .innerJoin(activityIdentities, eq(activityIdentities.eventId, activityObservations.eventId))
    .where(inArray(activityIdentities.conversationId, conversationIdsOf(conversationKeys)))
    .all()
    .filter((row) => scope.has(keyOf(row.provider, row.conversationId)))
    .map((row) => row.id)
}

/**
 * A baseline exports the exact saved values; paths and local integer IDs stay here.
 * `conversationKeys` limits this to those conversations' mappings.
 */
export function bootstrapMappedSessionEdits<S extends Record<string, unknown>>(
  db: Db<S>,
  workspaceId: string,
  conversationKeys?: readonly string[]
): SyncProjectionIssue[] {
  const issues: SyncProjectionIssue[] = []
  const scope = conversationKeys && new Set(conversationKeys)
  if (scope?.size === 0) return issues
  const mappings = scope
    ? db
        .select()
        .from(sessionActivityMappings)
        .where(inArray(sessionActivityMappings.conversationId, conversationIdsOf([...scope])))
        .all()
        .filter((row) => scope.has(keyOf(row.provider, row.conversationId)))
    : db.select().from(sessionActivityMappings).all()
  if (!mappings.length) return issues
  // Scoped: only these mappings' own retirements, not every split and replacement.
  const mapped = scope && mappings.map((row) => row.sessionId)
  const retired = new Set([
    ...(mapped
      ? db
          .select({ id: sessionSplits.parentSessionId })
          .from(sessionSplits)
          .where(inArray(sessionSplits.parentSessionId, mapped))
          .all()
      : db.select({ id: sessionSplits.parentSessionId }).from(sessionSplits).all()
    ).map((row) => row.id),
    ...(mapped
      ? db
          .select({ id: sessionReplacements.predecessorSessionId })
          .from(sessionReplacements)
          .where(inArray(sessionReplacements.predecessorSessionId, mapped))
          .all()
      : db.select({ id: sessionReplacements.predecessorSessionId }).from(sessionReplacements).all()
    ).map((row) => row.id)
  ])
  const history = readPortableHistoryFacts(db, conversationKeys, workspaceId)
  for (const mapping of mappings) {
    if (retired.has(mapping.sessionId)) continue
    const row = db.select().from(sessions).where(eq(sessions.id, mapping.sessionId)).get()
    if (!row || row.status !== 'completed') continue
    const interval = JSON.parse(mapping.intervalJson) as PortableSessionFragment & {
      endedAt: string
      durationMinutes: number
    }
    const target = { provider: mapping.provider, conversationId: mapping.conversationId }
    const cuts =
      history
        .get(JSON.stringify([target.provider, target.conversationId]))
        ?.cuts.map((cut) => cut.splitAt) ?? []
    const anchor = defaultSessionAnchor(interval, cuts, 'cut')
    if (!anchor) {
      issues.push({
        source: `session:${row.id}`,
        code: 'SYNC_SESSION_ANCHOR_REQUIRED',
        message: 'Saved history needs an activity anchor before it can be shared.'
      })
      continue
    }
    const flags = db
      .select()
      .from(sessionTimeOverrides)
      .where(eq(sessionTimeOverrides.sessionId, row.id))
      .get()
    const time: Record<string, string | number> = {}
    for (const field of ['startedAt', 'endedAt', 'durationMinutes'] as const)
      if (flags?.[field] || row[field] !== interval[field]) time[field] = row[field]
    const values: PortableSessionValues = {
      clientSyncId: row.clientId === null ? null : getPortableClientId(db, row.clientId),
      projectSyncId: row.projectId === null ? null : getPortableProjectId(db, row.projectId),
      description: row.description,
      billable: !!row.billable,
      time: Object.keys(time).length
        ? {
            ...time,
            baseCoverageHash: portableCoverageHash(
              target.provider,
              target.conversationId,
              interval.coverage
            )
          }
        : null
    }
    const plan = planSessionEditBaseline(db, workspaceId, { target, anchor, values })
    if (plan.status === 'ready') journalSessionRecordChanges(db, workspaceId, [plan.change])
    else if (plan.status === 'requires')
      issues.push({
        source: `session:${row.id}`,
        code: 'SYNC_REFERENCE_UNAVAILABLE',
        message: 'Shared assignment or activity references have not been exported.'
      })
  }
  return issues
}

export type SourceFileState = 'present' | 'missing' | 'unavailable'
export type SourceFileProbe = (path: string) => SourceFileState

function errorCode(error: unknown): unknown {
  return error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
}

/**
 * 'missing' only when the file reports ENOENT and its nearest existing ancestor is a directory,
 * so the volume is mounted. Any other error, an absent drive or share root, or a relative path
 * is 'unavailable', never proof that a log was deleted.
 */
export function probeSourceFile(path: string): SourceFileState {
  if (!path || !isAbsolute(path)) return 'unavailable'
  try {
    statSync(path)
    return 'present'
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') return 'unavailable'
  }
  for (let dir = path, parent = dirname(dir); parent !== dir; dir = parent, parent = dirname(dir)) {
    try {
      return statSync(parent).isDirectory() ? 'missing' : 'unavailable'
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') return 'unavailable'
    }
  }
  return 'unavailable'
}

// Bootstraps run on every local mutation; an unmapped row whose log is present is probed again
// only after this long. Missing rows are retained at once and leave the candidate list.
const PRESENT_RECHECK_MS = 5 * 60_000
const presentUntil = new Map<string, number>()

function cachedProbe(probe: SourceFileProbe, path: string, now: number): SourceFileState {
  if (probe !== probeSourceFile) return probe(path)
  if ((presentUntil.get(path) ?? 0) > now) return 'present'
  const state = probe(path)
  if (state === 'present') presentUntil.set(path, now + PRESENT_RECHECK_MS)
  else presentUntil.delete(path)
  return state
}

/**
 * Saved rows the ledger cannot map keep their history: source-less rows as before, and rows
 * whose original log is proved missing (probeSourceFile), including measured rows with model
 * totals. Rows whose file is present or unavailable are left for the ledger and rechecked later.
 * With `conversationKeys`, rows of other conversations are left alone: retention is permanent,
 * so they must first get their own chance to be linked. Rows without a conversation still count.
 */
export function retainSavedOnlyHistory<S extends Record<string, unknown>>(
  db: Db<S>,
  probe: SourceFileProbe = probeSourceFile,
  conversationKeys?: readonly string[]
): void {
  let candidates = legacyRetentionCandidates(db)
  if (conversationKeys && candidates.length) {
    const scope = new Set(conversationKeys)
    const keys = new Map(
      db
        .select({ id: sessions.id, tool: sessions.tool, conversationId: sessions.claudeSessionId })
        .from(sessions)
        .where(eq(sessions.source, 'auto'))
        .all()
        .map((row) => [row.id, row.conversationId ? keyOf(row.tool, row.conversationId) : null])
    )
    candidates = candidates.filter((row) => {
      const key = keys.get(row.sessionId)
      return !key || scope.has(key)
    })
  }
  if (!candidates.length) return
  const now = Date.now()
  const gone = candidates
    .filter((row) => row.sourceFile && cachedProbe(probe, row.sourceFile, now) === 'missing')
    .map((row) => row.sessionId)
  retainSourceLessSessionsForSync(
    db,
    candidates.map((row) => row.sessionId),
    { sourceFileGone: gone }
  )
}

/**
 * Proven splits and deletions of adopted rows with their metadata baselines. `scope` limits
 * this to those conversations; unscoped covers every adopted conversation at once.
 */
function exportAutomaticHistory<S extends Record<string, unknown>>(
  tx: Db<S>,
  workspaceId: string,
  scope: readonly string[] | undefined,
  issues: SyncProjectionIssue[]
): void {
  const history = collectHistorySyncChanges(tx, workspaceId, { conversationKeys: scope })
  // Cuts must exist before choosing a cut-anchored metadata baseline. Deletions follow it.
  recordLocalSyncChanges(
    tx,
    workspaceId,
    history.changes.filter((change) => change.entityType === 'session-split'),
    historyRecordsAdapter
  )
  issues.push(...bootstrapMappedSessionEdits(tx, workspaceId, scope))
  const withEdits = collectHistorySyncChanges(tx, workspaceId, {
    conversationKeys: scope,
    observedSessionEditHeads: (deletion) => {
      const mapping = tx
        .select()
        .from(sessionActivityMappings)
        .where(eq(sessionActivityMappings.sessionId, deletion.sessionId))
        .get()
      if (!mapping) return []
      const records = readPortableSessionRecords(tx, workspaceId, {
        provider: deletion.provider,
        conversationId: deletion.conversationId
      })
      return observedSessionEditHeads(
        JSON.parse(mapping.intervalJson) as PortableSessionFragment,
        records.edits
      )
    }
  })
  recordLocalSyncChanges(tx, workspaceId, withEdits.changes, historyRecordsAdapter)
  issues.push(
    ...withEdits.withheld.map((source) => ({
      source,
      code: 'SYNC_HISTORY_REVIEW_REQUIRED',
      message: 'A saved history operation needs review before export.'
    }))
  )
}

/** Adopted conversations, sorted: the only ones with automatic history to export. */
function mappedConversationKeys<S extends Record<string, unknown>>(db: Db<S>): string[] {
  return [
    ...new Set(
      db
        .selectDistinct({
          provider: sessionActivityMappings.provider,
          conversationId: sessionActivityMappings.conversationId
        })
        .from(sessionActivityMappings)
        .all()
        .map((row) => keyOf(row.provider, row.conversationId))
    )
  ].sort()
}

/**
 * The creating computers' machine facts that manual baselines depend on. Captured activity may
 * be skipped, paged or scoped away (a manual edit has no conversation), so they are exported
 * here from the few distinct devices without reading any activity. `entryIds`: only theirs.
 */
function exportManualEntryMachines<S extends Record<string, unknown>>(
  tx: Db<S>,
  workspaceId: string,
  issues: SyncProjectionIssue[],
  entryIds?: readonly string[]
): void {
  const parts: Array<string[] | undefined> = entryIds ? chunks(entryIds) : [undefined]
  const deviceIds = [
    ...new Set(
      parts.flatMap((part) =>
        tx
          .selectDistinct({ deviceId: manualTimeEntries.deviceId })
          .from(manualTimeEntries)
          .where(
            and(isNotNull(manualTimeEntries.deviceId), part && inArray(manualTimeEntries.id, part))
          )
          .all()
          .map((row) => row.deviceId as string)
      )
    )
  ]
  if (!deviceIds.length) return
  const changes: SyncChange[] = []
  for (const row of tx
    .select()
    .from(sourceMachines)
    .where(inArray(sourceMachines.deviceId, deviceIds))
    .orderBy(sourceMachines.deviceId)
    .all()) {
    const change: SyncChange = {
      id: syncFactChangeId(workspaceId, 'machine', row.deviceId),
      kind: 'fact',
      entityType: 'machine',
      entityId: row.deviceId,
      dependencies: [],
      payload: { deviceId: row.deviceId, initialName: row.initialName }
    }
    try {
      activitySyncAdapter.validate(change)
      changes.push(change)
    } catch (error) {
      if (!(error instanceof SyncError)) throw error
      issues.push({
        source: row.deviceId,
        code: 'SYNC_LOCAL_ACTIVITY_WITHHELD',
        message: `Local captured activity could not be shared: ${error.message}`
      })
    }
  }
  recordLocalSyncChanges(tx, workspaceId, changes, activitySyncAdapter)
}

/** Bound-parameter lists stay well under SQLite's variable limit (bulk reassignments). */
function chunks<T>(values: readonly T[], size = 500): T[][] {
  const parts: T[][] = []
  for (let at = 0; at < values.length; at += size) parts.push(values.slice(at, at + size))
  return parts
}

/** These rows with their local split lineage: parents, parts and siblings, recursively. */
function splitLineage<S extends Record<string, unknown>>(
  db: Db<S>,
  sessionIds: readonly number[]
): number[] {
  const seen = new Set(sessionIds)
  let frontier = [...seen]
  while (frontier.length) {
    const next: number[] = []
    for (const part of chunks(frontier))
      for (const row of db
        .select()
        .from(sessionSplits)
        .where(
          or(
            inArray(sessionSplits.parentSessionId, part),
            inArray(sessionSplits.firstSessionId, part),
            inArray(sessionSplits.secondSessionId, part)
          )
        )
        .all())
        for (const id of [row.parentSessionId, row.firstSessionId, row.secondSessionId])
          if (!seen.has(id)) {
            seen.add(id)
            next.push(id)
          }
    frontier = next
  }
  return [...seen]
}

/**
 * Legacy records of these rows and their split lineage (collectLegacySyncChanges loads split
 * children on demand), with the saved snapshots' conversations for keep-all planning.
 */
function savedHistoryScope<S extends Record<string, unknown>>(
  db: Db<S>,
  sessionIds: readonly number[]
): { legacyIds: string[]; origin: LegacyJournalOptions['origin'] } {
  const legacyIds: string[] = []
  const origin = new Map<string, { provider: string; conversationId: string }>()
  for (const part of chunks(splitLineage(db, sessionIds)))
    for (const row of db
      .select({ id: sessionLegacyRecords.id, snapshot: sessionLegacyRecords.session })
      .from(sessionLegacyRecords)
      .where(inArray(sessionLegacyRecords.sessionId, part))
      .all()) {
      legacyIds.push(row.id)
      const { source, tool, claudeSessionId } = row.snapshot
      if (source === 'auto' && claudeSessionId?.trim())
        origin.set(keyOf(tool, claudeSessionId), {
          provider: tool,
          conversationId: claudeSessionId
        })
    }
  return { legacyIds: legacyIds.sort(), origin: [...origin.values()] }
}

/** Manual entries of these rows with their split lineage: ancestors and parts, recursively. */
function manualEntryFamily<S extends Record<string, unknown>>(
  db: Db<S>,
  sessionIds: readonly number[]
): string[] {
  const seen = new Set<string>()
  let frontier = chunks(sessionIds).flatMap((part) =>
    db
      .select({ id: manualTimeEntries.id, parentId: manualTimeEntries.parentId })
      .from(manualTimeEntries)
      .where(inArray(manualTimeEntries.sessionId, part))
      .all()
  )
  while (frontier.length) {
    const added = frontier.filter((row) => !seen.has(row.id) && seen.add(row.id))
    const parents = added.flatMap((row) =>
      row.parentId && !seen.has(row.parentId) ? [row.parentId] : []
    )
    const ids = added.map((row) => row.id)
    frontier = [
      ...chunks(parents).flatMap((part) =>
        db
          .select({ id: manualTimeEntries.id, parentId: manualTimeEntries.parentId })
          .from(manualTimeEntries)
          .where(inArray(manualTimeEntries.id, part))
          .all()
      ),
      ...chunks(ids).flatMap((part) =>
        db
          .select({ id: manualTimeEntries.id, parentId: manualTimeEntries.parentId })
          .from(manualTimeEntries)
          .where(inArray(manualTimeEntries.parentId, part))
          .all()
      )
    ]
  }
  return [...seen].sort()
}

/**
 * collectManualSyncChanges over only `entryIds`, a closed lineage from manualEntryFamily:
 * parents first, split parents again once their parts' roots are planned.
 */
function collectManualEntries<S extends Record<string, unknown>>(
  db: Db<S>,
  workspaceId: string,
  entryIds: readonly string[]
): ManualExport {
  const result: ManualExport = { changes: [], blocked: [], withheld: [] }
  const entries = chunks(entryIds).flatMap((part) =>
    db.select().from(manualTimeEntries).where(inArray(manualTimeEntries.id, part)).all()
  )
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const depth = (id: string, seen = new Set<string>()): number => {
    const parent = byId.get(id)?.parentId
    return parent && !seen.has(parent) ? 1 + depth(parent, new Set([...seen, id])) : 0
  }
  const pending = new Set<string>()
  const add = (changes: ManualExport['changes']) => {
    for (const change of changes)
      if (!pending.has(change.id)) {
        pending.add(change.id)
        result.changes.push(change)
      }
  }
  const awaiting: string[] = []
  for (const entry of entries.sort((a, b) => depth(a.id) - depth(b.id) || (a.id < b.id ? -1 : 1))) {
    const plan = planManualEntryBootstrap(db, workspaceId, entry.id, pending)
    if (plan.status === 'ready') {
      add(plan.changes)
      pending.add(manualEntryIdentityRoot(db, workspaceId, entry.id).id)
      if (plan.awaiting) awaiting.push(entry.id)
    } else if (plan.status === 'requires')
      result.blocked.push({ entryId: entry.id, requires: plan.requires })
    else if (plan.status === 'withheld')
      result.withheld.push({ entryId: entry.id, reason: plan.reason })
  }
  for (const entryId of awaiting) {
    const plan = planManualEntryBootstrap(db, workspaceId, entryId, pending)
    if (plan.status === 'ready' && !plan.awaiting) add(plan.changes)
    else if (plan.status === 'ready')
      result.blocked.push({
        entryId,
        requires: plan.awaiting!.map((child) => ({
          entityType: 'manual-entry' as const,
          entityId: child
        }))
      })
  }
  return result
}

export interface FolderSyncBootstrapOptions {
  sourceFiles?: SourceFileProbe
  /** The caller exports captured activity separately (for example in bounded pages). */
  skipActivity?: boolean
  /**
   * The caller has already linked comparable local history (for example one conversation at a
   * time). Saved-only retention still runs and is permanent, so never skip linking altogether.
   */
  skipAdoption?: boolean
  /**
   * Only these conversations (JSON [provider, conversationId]) for activity, adoption and
   * automatic history. Directory, saved-history, manual and invoice domains stay whole.
   */
  conversationKeys?: readonly string[]
  /**
   * Only these local rows (with their split lineage) for saved history and manual entries, and
   * keep-all resolutions for only those records' conversations. Other rows wait for an unscoped
   * or stepped bootstrap. Unset: every row.
   */
  sessionIds?: readonly number[]
}

type BootstrapStage<S extends Record<string, unknown>> = {
  source: string
  apply: (tx: Db<S>) => void
}

function withheld(source: string, error: unknown): SyncProjectionIssue {
  return {
    source,
    code: 'SYNC_LOCAL_EXPORT_WITHHELD',
    message: `Local ${source} needs review before sharing: ${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * Native saved history (or only `scope.legacyIds`) with its baselines. Keep-all resolutions of
 * this computer's own overlaps are planned for every conversation, or `scope.origin`.
 */
function exportSavedHistory<S extends Record<string, unknown>>(
  tx: Db<S>,
  workspaceId: string,
  issues: SyncProjectionIssue[],
  scope?: { legacyIds: readonly string[]; origin: LegacyJournalOptions['origin'] }
): void {
  const legacy = collectLegacySyncChanges(tx, workspaceId, scope && { legacyIds: scope.legacyIds })
  journalLegacySyncChanges(tx, workspaceId, legacy.changes, {
    origin: scope ? scope.origin : 'all'
  })
  issues.push(
    ...legacy.withheld.map((row) => ({
      source: row.legacyId,
      code: 'SYNC_LEGACY_REVIEW_REQUIRED',
      message: row.reason
    })),
    ...legacy.metadataDrift.map((row) => ({
      source: row.legacyId,
      code: 'SYNC_LEGACY_EDIT_PENDING',
      message: 'Saved history is waiting for its shared client or project reference.'
    }))
  )
}

/** Domain stages in dependency order. Each commits independently; issues collect in `issues`. */
function bootstrapStages<S extends Record<string, unknown>>(
  workspaceId: string,
  options: FolderSyncBootstrapOptions,
  issues: SyncProjectionIssue[]
): BootstrapStage<S>[] {
  const scope = options.conversationKeys && [...new Set(options.conversationKeys)].sort()
  const stages: BootstrapStage<S>[] = []
  const stage = (source: string, apply: (tx: Db<S>) => void) => stages.push({ source, apply })
  if (!options.skipActivity && scope?.length !== 0)
    stage('activity', (tx) => {
      const available = collectAvailableActivity(
        tx,
        workspaceId,
        scope && conversationObservationIds(tx, scope)
      )
      recordLocalSyncChanges(tx, workspaceId, available.changes, activitySyncAdapter)
      issues.push(...available.issues)
    })
  stage('clients and projects', (tx) => {
    const directory = planDirectoryExport(tx, workspaceId)
    recordLocalSyncChanges(tx, workspaceId, directory.changes, directoryRecordsAdapter)
    issues.push(
      ...directory.invalid.map((row) => ({
        source: row.entityId,
        code: 'SYNC_DIRECTORY_INVALID',
        message: row.message
      })),
      ...directory.blocked.map((row) => ({
        source: row.entityId,
        code: 'SYNC_REFERENCE_UNAVAILABLE',
        message: 'Directory references are unavailable.'
      }))
    )
  })
  stage('automatic history', (tx) => {
    if (!options.skipAdoption && scope?.length !== 0) linkComparableLocalActivity(tx, scope)
    // Retain saved-only rows after linking; the collector reports anything ambiguous for review.
    retainSavedOnlyHistory(tx, options.sourceFiles, scope)
    if (scope?.length === 0) return
    exportAutomaticHistory(tx, workspaceId, scope, issues)
  })
  stage('saved history', (tx) => {
    if (!options.sessionIds) return exportSavedHistory(tx, workspaceId, issues)
    // Read after retention above, which may have just retained one of these rows.
    const saved = savedHistoryScope(tx, options.sessionIds)
    if (saved.legacyIds.length) exportSavedHistory(tx, workspaceId, issues, saved)
  })
  stage('manual entries', (tx) => {
    const entries = options.sessionIds && manualEntryFamily(tx, options.sessionIds)
    if (entries?.length === 0) return
    exportManualEntryMachines(tx, workspaceId, issues, entries)
    const manual = entries
      ? collectManualEntries(tx, workspaceId, entries)
      : collectManualSyncChanges(tx, workspaceId)
    journalManualSyncChanges(tx, workspaceId, manual.changes)
    issues.push(
      ...manual.blocked.map((row) => ({
        source: row.entryId,
        code: 'SYNC_REFERENCE_UNAVAILABLE',
        message: 'Manual entry references are unavailable.'
      })),
      ...manual.withheld
        .filter((row) => row.reason !== 'running')
        .map((row) => ({
          source: row.entryId,
          code: 'SYNC_MANUAL_REVIEW_REQUIRED',
          message: row.reason
        }))
    )
  })
  stage('invoices', (tx) => {
    const billing = collectInvoiceSyncChanges(tx, workspaceId)
    journalInvoiceSyncChanges(tx, workspaceId, billing.changes)
    issues.push(
      ...billing.withheld.map((row) => ({
        source: 'operationId' in row ? row.operationId : `invoice:${row.invoiceId}`,
        code: 'SYNC_INVOICE_REVIEW_REQUIRED',
        message: row.message ?? row.reason
      }))
    )
  })
  return stages
}

/**
 * Run before importing another computer's records, and after local capture. Baselines are
 * deterministic and idempotent. Existing causal records are never replaced by a new baseline.
 * The caller owns the setup/capture transaction; no sync folder, provider or credential is read.
 * Only the existence of unmapped rows' original log files is checked (see probeSourceFile).
 */
export function bootstrapFolderSync<S extends Record<string, unknown>>(
  db: Db<S>,
  workspaceId: string,
  options: FolderSyncBootstrapOptions = {}
): SyncProjectionIssue[] {
  // Joining with local clients/projects: import first, export nothing until the user has matched
  // or kept separate every never-exported record (sessions, entries and invoices reference them).
  if (isJoinReviewPending(db, workspaceId)) return [JOIN_REVIEW_ISSUE]
  return db.transaction((tx) => {
    const issues: SyncProjectionIssue[] = []
    // Each domain commits independently. A bad saved record cannot stop incoming history.
    for (const { source, apply } of bootstrapStages<S>(workspaceId, options, issues)) {
      try {
        tx.transaction((inner) => apply(inner))
      } catch (error) {
        issues.push(withheld(source, error))
      }
    }
    return issues
  })
}

/**
 * bootstrapFolderSync for large histories on the single writer: every stage is its own
 * committed transaction and `yieldControl` runs between them, never inside one. Captured
 * activity is skipped (the caller exports it in pages). Automatic adoption runs one candidate
 * conversation per transaction against a scoped ledger preview; saved-only retention then runs
 * once, and automatic history (cuts, mapped edits, deletions) one adopted conversation per
 * transaction. Saved history is exported in batches of whole conversations, then keep-all
 * resolutions are swept a page of conversations per transaction.
 */
export async function bootstrapFolderSyncInSteps<S extends Record<string, unknown>>(
  db: Db<S>,
  workspaceId: string,
  yieldControl: () => Promise<void>
): Promise<SyncProjectionIssue[]> {
  const issues: SyncProjectionIssue[] = []
  const stages = bootstrapStages<S>(workspaceId, { skipActivity: true, skipAdoption: true }, issues)
  const run = async (list: BootstrapStage<S>[]): Promise<boolean> => {
    for (const { source, apply } of list) {
      // Other writers run while this yields; a join started meanwhile stops further export.
      if (isJoinReviewPending(db, workspaceId)) return false
      try {
        db.transaction((tx) => apply(tx))
      } catch (error) {
        issues.push(withheld(source, error))
      }
      await yieldControl()
    }
    return true
  }
  const at = stages.findIndex((stage) => stage.source === 'automatic history')
  if (!(await run(stages.slice(0, at)))) return [JOIN_REVIEW_ISSUE]
  const perConversation = (
    keys: string[],
    apply: (tx: Db<S>, key: string) => void
  ): BootstrapStage<S>[] =>
    keys.map((key) => ({ source: 'automatic history', apply: (tx) => apply(tx, key) }))
  const adoption = perConversation(adoptionCandidateKeys(db), (tx, key) =>
    linkComparableLocalActivity(tx, [key])
  )
  if (!(await run(adoption))) return [JOIN_REVIEW_ISSUE]
  // Retention reads every saved row and probes logs once, after all linking, never per step.
  const retention: BootstrapStage<S> = {
    source: 'automatic history',
    apply: (tx) => retainSavedOnlyHistory(tx)
  }
  if (!(await run([retention]))) return [JOIN_REVIEW_ISSUE]
  const history = perConversation(mappedConversationKeys(db), (tx, key) =>
    exportAutomaticHistory(tx, workspaceId, [key], issues)
  )
  if (!(await run(history))) return [JOIN_REVIEW_ISSUE]
  // Saved history: batches of whole conversations (at least one step), then the keep-all sweep
  // page by page once every record is journaled, since a split in one batch can change which
  // rows count in another's conversation. Both are idempotent, so an interrupted run resumes.
  const saved = stages.findIndex((stage) => stage.source === 'saved history')
  const batches = planLegacyExportBatches(db, 25)
  const exportBatches = (batches.length ? batches : [[]]).map(
    (batch): BootstrapStage<S> => ({
      source: 'saved history',
      apply: (tx) =>
        exportSavedHistory(tx, workspaceId, issues, { legacyIds: batch, origin: 'none' })
    })
  )
  if (!(await run(exportBatches))) return [JOIN_REVIEW_ISSUE]
  const origin = planLegacyOriginPages(db, 10).map(
    (page): BootstrapStage<S> => ({
      source: 'saved history',
      apply: (tx) => {
        journalLegacySyncChanges(tx, workspaceId, [], { origin: page })
      }
    })
  )
  if (!(await run(origin))) return [JOIN_REVIEW_ISSUE]
  if (!(await run(stages.slice(saved + 1)))) return [JOIN_REVIEW_ISSUE]
  return issues
}
