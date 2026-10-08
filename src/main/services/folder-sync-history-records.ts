import { createHash } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { folderSyncSettings, syncChanges, syncRecordStates } from '../db/schema/folder-sync'
import { AppError } from '../../shared/types/ipc'
import {
  canonicalJson,
  isSyncUuid,
  parseChange,
  SyncError,
  type JsonObject,
  type SyncChange,
  type SyncEntityType
} from './folder-sync-protocol'
import { recordLocalSyncChanges, type SyncDomainAdapter } from './folder-sync-store'
import { syncFactChangeId } from './folder-sync-activity-records'
import { readCanonicalCoverageUsage, type CodexUsageReference } from './canonical-codex'
import type { CanonicalEventReference } from './canonical-activity'
import type { CanonicalIntervalCoverage } from './canonical-intervals'
import { readCanonicalHistoryProofs } from './canonical-history-proof'

/*
 * Portable explicit history operations (plan decisions A and D): session splits and session
 * deletions as immutable facts keyed only by canonical identities. Local session, mapping,
 * decision and revision IDs and every path stay on this computer. Applying a fact only
 * validates it and its dependencies; the fact itself is the sync_changes row the store
 * already wrote. Projection into local rows happens separately (readPortableHistoryFacts).
 *
 * - session-split: entity [[provider, conversationId], splitAt]. Equal cuts made on several
 *   computers are the same fact and change ID, so cuts union by normalized instant.
 * - session-deletion: entity deletion:v1:<sha256 of the whole payload>, covering the target,
 *   the deleted canonical coverage and the session-edit heads the deletion observed. The
 *   observed heads are its dependencies; activity facts are not, so a deletion may arrive
 *   before its evidence and is held until that evidence is present.
 */

type Db<TSchema extends Record<string, unknown>> = BetterSQLite3Database<TSchema>
type Reader<TSchema extends Record<string, unknown>> = Pick<Db<TSchema>, 'select'>
type Transaction = Parameters<SyncDomainAdapter['apply']>[0]

export const HISTORY_SYNC_ENTITY_TYPES = [
  'session-split',
  'session-deletion'
] as const satisfies readonly SyncEntityType[]
type HistoryEntityType = (typeof HISTORY_SYNC_ENTITY_TYPES)[number]

// Same provider/basis vocabulary as folder-sync-activity-records (event IDs are ledger IDs).
const PROVIDER_BASES = new Map<string, readonly string[]>([
  ['claude', ['native', 'fingerprint']],
  ['codex', ['native', 'fingerprint', 'checkpoint', 'progress']],
  ['gemini', ['native', 'fingerprint']],
  ['opencode', ['native']]
])
const EVENT_ID = /^([a-z][a-z0-9-]*):v(\d+):([a-z][a-z0-9-]*):[0-9a-f]{64}$/
const OBSERVATION_ID = /^observation:v(\d+):[0-9a-f]{64}$/
const DELETION_ID = /^deletion:v1:[0-9a-f]{64}$/
const VOCABULARY = /^[a-z][a-z0-9-]*$/
const COUNTER_NAME = /^[a-z][a-z0-9_]{0,63}$/
const MAX_COUNTERS = 32
const MAX_HEADS = 1000
const SPLIT_KEYS = ['version', 'provider', 'conversationId', 'splitAt']
const DELETION_KEYS = [
  'version',
  'provider',
  'conversationId',
  'coverage',
  'observedSessionEditHeads'
]
const EVENT_KEYS = ['eventId', 'observationId', 'kind', 'timestamp']
const EDGE_KEYS = ['from', 'to', 'startedAt', 'endedAt', 'progress']
const USAGE_KEYS = [
  'inputTokens',
  'outputTokens',
  'cacheCreationInputTokens',
  'cacheReadInputTokens'
]
const USAGE_REFERENCE_KEYS = [
  'checkpointId',
  'observationId',
  'messageEventId',
  'timestamp',
  'model',
  'delta',
  'usage'
]

export interface SessionSplitTarget {
  provider: string
  conversationId: string
  splitAt: string
}

export interface SessionDeletionTarget {
  provider: string
  conversationId: string
  coverage: CanonicalIntervalCoverage
  /** session-edit revision change IDs the deletion observed (root metadata API supplies them). */
  observedSessionEditHeads?: readonly string[]
}

function malformed(message: string): never {
  throw new SyncError('SYNC_MALFORMED', message)
}

function updateRequired(feature: string): never {
  throw new SyncError(
    'SYNC_UPDATE_REQUIRED',
    `Shared history uses ${feature}; update ClauTime to continue syncing`
  )
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** Normalized UTC only, so equal instants have one spelling and one fact ID. */
function isInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  )
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Exact allowlist: every required field present and nothing else. */
function fields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string
): Record<string, unknown> {
  if (!isObject(value)) malformed(`${label} must be an object`)
  for (const key of Object.keys(value))
    if (!required.includes(key) && !optional.includes(key))
      malformed(`${label} has unsupported field "${key}"`)
  for (const key of required)
    if (!Object.hasOwn(value, key)) malformed(`${label} is missing "${key}"`)
  return value
}

/** Checked before the shape, so a newer format pauses sync instead of reading as damage. */
function supportedVersion(value: unknown, feature: string): void {
  if (value === 1) return
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 1)
    updateRequired(`${feature} ${value}`)
  malformed(`${feature} is invalid`)
}

function readProvider(value: unknown, label: string): string {
  if (typeof value !== 'string' || !VOCABULARY.test(value))
    malformed(`${label} has an invalid provider`)
  if (!PROVIDER_BASES.has(value)) updateRequired(`activity provider "${value}"`)
  return value
}

function readConversation(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || hasControlCharacter(value))
    malformed(`${label} has an invalid conversation`)
  return value
}

function eventId(value: unknown, provider: string, label: string): string {
  const match = typeof value === 'string' ? EVENT_ID.exec(value) : null
  if (!match) malformed(`${label} has an unrecognized event ID`)
  const [, owner = '', digits = '', basis = ''] = match
  if (owner !== provider) malformed(`${label} names an event of another provider`)
  if (digits !== '1') {
    if (/^[1-9]\d*$/.test(digits)) updateRequired(`activity identity version ${digits}`)
    malformed(`${label} has an invalid event ID version`)
  }
  if (!PROVIDER_BASES.get(provider)!.includes(basis))
    updateRequired(`${provider} activity basis "${basis}"`)
  return value as string
}

function observationId(value: unknown, label: string): string {
  const match = typeof value === 'string' ? OBSERVATION_ID.exec(value) : null
  if (!match) malformed(`${label} has an unrecognized observation ID`)
  if (match[1] !== '1') {
    if (/^[1-9]\d*$/.test(match[1] ?? '')) updateRequired(`activity observation ID ${match[1]}`)
    malformed(`${label} has an invalid observation ID version`)
  }
  return value as string
}

function readEvent(
  value: unknown,
  provider: string,
  kind: CanonicalEventReference['kind'],
  label: string
): CanonicalEventReference {
  const ref = fields(value, EVENT_KEYS, provider === 'codex' ? ['observationIds'] : [], label)
  eventId(ref.eventId, provider, label)
  observationId(ref.observationId, label)
  if (ref.kind !== kind) malformed(`${label} is not a ${kind}`)
  if (!isInstant(ref.timestamp)) malformed(`${label} has an invalid timestamp`)
  if (Object.hasOwn(ref, 'observationIds')) {
    const ids = ref.observationIds
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      new Set(ids).size !== ids.length ||
      !ids.includes(ref.observationId)
    )
      malformed(`${label} has invalid observations`)
    ids.forEach((id) => observationId(id, label))
  }
  return ref as unknown as CanonicalEventReference
}

function readUsage(value: unknown, messages: Set<string>, label: string): CodexUsageReference[] {
  if (!Array.isArray(value)) malformed(`${label} usage must be a list`)
  const usage = readCanonicalCoverageUsage(value)
  if (!usage) malformed(`${label} has invalid usage`)
  for (const entry of value) {
    const reference = fields(entry, USAGE_REFERENCE_KEYS, [], `${label} usage`)
    fields(reference.usage, USAGE_KEYS, [], `${label} usage totals`)
  }
  for (const entry of usage) {
    eventId(entry.checkpointId, 'codex', `${label} usage`)
    observationId(entry.observationId, `${label} usage`)
    if (entry.messageEventId === null || !messages.has(entry.messageEventId))
      malformed(`${label} counts usage of a message it does not own`)
    const counters = Object.entries(entry.delta)
    if (
      counters.length > MAX_COUNTERS ||
      !counters.every(([key, count]) => COUNTER_NAME.test(key) && isCount(count))
    )
      malformed(`${label} has invalid usage counters`)
  }
  return usage
}

/** Strict portable coverage: canonical references only, never paths or local IDs. */
function readCoverage(value: unknown, provider: string, label: string): CanonicalIntervalCoverage {
  if (!isObject(value)) malformed(`${label} must be an object`)
  const expected = provider === 'codex' ? 2 : 1
  const version = value.version
  if (version !== expected) {
    if (typeof version === 'number' && Number.isSafeInteger(version) && version > 2)
      updateRequired(`coverage version ${version}`)
    malformed(`${label} has an invalid version`)
  }
  const keys = ['version', 'messages', 'continuity']
  const coverage = fields(value, expected === 2 ? [...keys, 'usage'] : keys, [], label)
  if (!Array.isArray(coverage.messages) || !Array.isArray(coverage.continuity))
    malformed(`${label} has invalid references`)
  const messages = coverage.messages.map((item) => readEvent(item, provider, 'message', label))
  const ids = new Set(messages.map((item) => item.eventId))
  if (ids.size !== messages.length) malformed(`${label} repeats a message`)
  const continuity = coverage.continuity.map((item) => {
    const edge = fields(item, EDGE_KEYS, [], `${label} continuity`)
    const from = readEvent(edge.from, provider, 'message', label)
    const to = readEvent(edge.to, provider, 'message', label)
    const { startedAt, endedAt, progress: listed } = edge
    if (
      !isInstant(startedAt) ||
      !isInstant(endedAt) ||
      !(startedAt < endedAt) ||
      from.eventId === to.eventId ||
      startedAt < from.timestamp ||
      endedAt > to.timestamp ||
      !Array.isArray(listed)
    )
      return malformed(`${label} has an invalid continuity span`)
    const progress = listed.map((entry) => readEvent(entry, provider, 'progress', label))
    if (
      progress.some(
        (entry) =>
          entry.timestamp <= from.timestamp ||
          entry.timestamp >= to.timestamp ||
          entry.timestamp < startedAt ||
          entry.timestamp >= endedAt
      )
    )
      malformed(`${label} has progress outside its span`)
    return { from, to, startedAt, endedAt, progress }
  })
  if (!messages.length && !continuity.length) malformed(`${label} is empty`)
  return expected === 2
    ? { version: 2, messages, continuity, usage: readUsage(coverage.usage, ids, label) }
    : { version: 1, messages, continuity }
}

function readHeads(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_HEADS)
    malformed(`${label} must list at most ${MAX_HEADS} observed edits`)
  value.forEach((id, index) => {
    // Sorted and unique: one spelling per observed set, so equal deletions share an ID.
    if (!isSyncUuid(id) || (index && !((value[index - 1] as string) < id)))
      malformed(`${label} has invalid observed edits`)
  })
  return value as string[]
}

export function sessionSplitEntityId(provider: string, conversationId: string, splitAt: string) {
  return canonicalJson([[provider, conversationId], splitAt])
}

/** Hash of the whole fact: target, deleted coverage and observed edit heads. */
export function sessionDeletionEntityId(payload: JsonObject): string {
  return `deletion:v1:${sha256(canonicalJson(payload))}`
}

function validateSplit(change: SyncChange): SessionSplitTarget {
  supportedVersion(change.payload.version, 'session split version')
  const split = fields(change.payload, SPLIT_KEYS, [], 'Session split')
  const provider = readProvider(split.provider, 'Session split')
  const conversationId = readConversation(split.conversationId, 'Session split')
  if (!isInstant(split.splitAt)) malformed('Session split instant is not normalized UTC')
  if (change.entityId !== sessionSplitEntityId(provider, conversationId, split.splitAt))
    malformed('Session split entity ID does not match its contents')
  if (change.dependencies.length) malformed('Session split has unexpected dependencies')
  return { provider, conversationId, splitAt: split.splitAt }
}

function validateDeletion(change: SyncChange) {
  supportedVersion(change.payload.version, 'session deletion version')
  const deletion = fields(change.payload, DELETION_KEYS, [], 'Session deletion')
  const provider = readProvider(deletion.provider, 'Session deletion')
  const conversationId = readConversation(deletion.conversationId, 'Session deletion')
  const coverage = readCoverage(deletion.coverage, provider, 'Session deletion coverage')
  const heads = readHeads(deletion.observedSessionEditHeads, 'Session deletion')
  if (
    !DELETION_ID.test(change.entityId) ||
    change.entityId !== sessionDeletionEntityId(change.payload)
  )
    malformed('Session deletion entity ID does not match its contents')
  if (canonicalJson(change.dependencies) !== canonicalJson(heads))
    malformed('Session deletion dependencies must be exactly its observed edits')
  return { provider, conversationId, coverage, observedSessionEditHeads: heads }
}

function isHistoryEntityType(value: string): value is HistoryEntityType {
  return (HISTORY_SYNC_ENTITY_TYPES as readonly string[]).includes(value)
}

/** Structural and semantic checks only; independent of any database. */
function validateHistoryChange(change: SyncChange): void {
  if (change.kind !== 'fact' || !isHistoryEntityType(change.entityType))
    malformed(`Sync change ${change.id} is not a history operation fact`)
  if (change.entityType === 'session-split') validateSplit(change)
  else validateDeletion(change)
}

/**
 * Validates the fact and that every observed edit is a session-edit change of this shared
 * history and of the deleted conversation. No provider effect and no local row write: the fact is its sync_changes row, and
 * mapping it onto local rows is the projector's job.
 */
function applyHistoryChange(tx: Transaction, workspaceId: string, change: SyncChange): void {
  validateHistoryChange(change)
  if (change.id !== syncFactChangeId(workspaceId, change.entityType, change.entityId))
    malformed(`History fact change ${change.id} is not derived from its fact`)
  if (!change.dependencies.length) return
  const found = new Map(
    tx
      .select({
        id: syncChanges.id,
        workspaceId: syncChanges.workspaceId,
        entityType: syncChanges.entityType,
        entityId: syncChanges.entityId
      })
      .from(syncChanges)
      .where(inArray(syncChanges.id, change.dependencies))
      .all()
      .map((row) => [row.id, row])
  )
  for (const id of change.dependencies) {
    const row = found.get(id)
    if (!row || row.workspaceId !== workspaceId || row.entityType !== 'session-edit')
      throw new AppError(
        'SYNC_MISSING_DEPENDENCY',
        `Session deletion ${change.entityId} is missing an observed session edit`
      )
  }
  const { provider, conversationId } = change.payload
  for (const id of change.dependencies) {
    const row = found.get(id)!
    // The session-edit adapter's rebuildable state names the record's agreed target.
    const state = tx
      .select({ json: syncRecordStates.stateJson })
      .from(syncRecordStates)
      .where(
        and(
          eq(syncRecordStates.workspaceId, workspaceId),
          eq(syncRecordStates.entityType, 'session-edit'),
          eq(syncRecordStates.entityId, row.entityId)
        )
      )
      .get()
    const target = state ? (JSON.parse(state.json) as { target?: unknown }).target : undefined
    if (
      !isObject(target) ||
      target.provider !== provider ||
      target.conversationId !== conversationId
    )
      malformed(`Session deletion ${change.entityId} observes an edit of another conversation`)
  }
}

export const historyRecordsAdapter: SyncDomainAdapter = {
  validate: validateHistoryChange,
  apply: applyHistoryChange
}

function fact(
  workspaceId: string,
  entityType: HistoryEntityType,
  entityId: string,
  payload: JsonObject,
  dependencies: string[] = []
): SyncChange {
  const change: SyncChange = {
    id: syncFactChangeId(workspaceId, entityType, entityId),
    kind: 'fact',
    entityType,
    entityId,
    dependencies,
    payload
  }
  parseChange(change)
  validateHistoryChange(change)
  return change
}

function requireWorkspace(workspaceId: string): void {
  if (!isSyncUuid(workspaceId)) malformed('A shared history ID is required')
}

/** Deterministic split fact; the instant is normalized so equal cuts share one change ID. */
export function planSessionSplitFact(workspaceId: string, target: SessionSplitTarget): SyncChange {
  requireWorkspace(workspaceId)
  const at = Date.parse(target.splitAt)
  if (!Number.isFinite(at)) malformed('Session split instant is invalid')
  const splitAt = new Date(at).toISOString()
  return fact(
    workspaceId,
    'session-split',
    sessionSplitEntityId(target.provider, target.conversationId, splitAt),
    { version: 1, provider: target.provider, conversationId: target.conversationId, splitAt }
  )
}

// Explicit allowlist copies: nothing a local snapshot may carry besides references leaves.
const portableEvent = (item: CanonicalEventReference): JsonObject => ({
  eventId: item.eventId,
  observationId: item.observationId,
  kind: item.kind,
  timestamp: item.timestamp,
  ...(item.observationIds ? { observationIds: [...item.observationIds] } : {})
})
function portableCoverage(coverage: CanonicalIntervalCoverage): JsonObject {
  return {
    version: coverage.version,
    messages: coverage.messages.map(portableEvent),
    continuity: coverage.continuity.map((edge) => ({
      from: portableEvent(edge.from),
      to: portableEvent(edge.to),
      startedAt: edge.startedAt,
      endedAt: edge.endedAt,
      progress: edge.progress.map(portableEvent)
    })),
    ...(coverage.version === 2
      ? {
          usage: (coverage.usage ?? []).map((entry) => ({
            checkpointId: entry.checkpointId,
            observationId: entry.observationId,
            messageEventId: entry.messageEventId,
            timestamp: entry.timestamp,
            model: entry.model,
            delta: { ...entry.delta },
            usage: {
              inputTokens: entry.usage.inputTokens,
              outputTokens: entry.usage.outputTokens,
              cacheCreationInputTokens: entry.usage.cacheCreationInputTokens,
              cacheReadInputTokens: entry.usage.cacheReadInputTokens
            }
          }))
        }
      : {})
  }
}

/** Immutable deletion fact; a different coverage or observed edit set is a different fact. */
export function planSessionDeletionFact(
  workspaceId: string,
  target: SessionDeletionTarget
): SyncChange {
  requireWorkspace(workspaceId)
  const heads = [...new Set(target.observedSessionEditHeads ?? [])].sort()
  const payload: JsonObject = {
    version: 1,
    provider: target.provider,
    conversationId: target.conversationId,
    coverage: portableCoverage(target.coverage),
    observedSessionEditHeads: heads
  }
  return fact(workspaceId, 'session-deletion', sessionDeletionEntityId(payload), payload, heads)
}

/** Portable operations of one conversation, by conversation key. */
export interface PortableHistoryFacts {
  cuts: Array<{ operationId: string; splitAt: string }>
  deletions: Array<{
    operationId: string
    coverage: CanonicalIntervalCoverage
    observedSessionEditHeads: string[]
  }>
  /** Stored facts that no longer read back; their conversation must be held. */
  invalid: Array<{ operationId: string; reason: 'invalid-portable-operation' }>
}

const conversationKey = (provider: string, conversationId: string) =>
  JSON.stringify([provider, conversationId])

/**
 * Split and deletion facts recorded in sync_changes (local or imported), re-validated on
 * read. Without `workspaceId`, facts of every shared history this database has recorded are
 * returned, so disconnecting or joining another history never counts deleted work again.
 * A stored fact whose target is readable but whose contents are not is reported invalid;
 * one whose target is unreadable fails loudly rather than being skipped.
 */
export function readPortableHistoryFacts<TSchema extends Record<string, unknown>>(
  db: Reader<TSchema>,
  conversationKeys?: readonly string[],
  workspaceId?: string
): Map<string, PortableHistoryFacts> {
  const scope = conversationKeys ? new Set(conversationKeys) : null
  const result = new Map<string, PortableHistoryFacts>()
  if (scope?.size === 0) return result
  const rows = db
    .select({ id: syncChanges.id, changeJson: syncChanges.changeJson })
    .from(syncChanges)
    .where(
      workspaceId
        ? and(
            eq(syncChanges.workspaceId, workspaceId),
            inArray(syncChanges.entityType, [...HISTORY_SYNC_ENTITY_TYPES])
          )
        : inArray(syncChanges.entityType, [...HISTORY_SYNC_ENTITY_TYPES])
    )
    .all()
  for (const row of rows) {
    let value: unknown
    try {
      value = JSON.parse(row.changeJson)
    } catch {
      value = undefined
    }
    const payload = isObject(value) && isObject(value.payload) ? value.payload : null
    if (
      !payload ||
      typeof payload.provider !== 'string' ||
      typeof payload.conversationId !== 'string'
    )
      throw new AppError(
        'INVALID_SYNC_HISTORY',
        `Recorded history operation ${row.id} cannot be read; shared history needs repair`
      )
    const key = conversationKey(payload.provider, payload.conversationId)
    if (scope && !scope.has(key)) continue
    const entry = result.get(key) ?? { cuts: [], deletions: [], invalid: [] }
    result.set(key, entry)
    try {
      const change = parseChange(value)
      if (change.id !== row.id) malformed('Stored change ID differs')
      validateHistoryChange(change)
      if (change.entityType === 'session-split')
        entry.cuts.push({ operationId: change.id, splitAt: validateSplit(change).splitAt })
      else {
        const deletion = validateDeletion(change)
        entry.deletions.push({
          operationId: change.id,
          coverage: deletion.coverage,
          observedSessionEditHeads: deletion.observedSessionEditHeads
        })
      }
    } catch {
      entry.invalid.push({ operationId: row.id, reason: 'invalid-portable-operation' })
    }
  }
  const byId = (a: { operationId: string }, b: { operationId: string }) =>
    a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0
  for (const entry of result.values()) {
    entry.cuts.sort((a, b) => (a.splitAt < b.splitAt ? -1 : a.splitAt > b.splitAt ? 1 : byId(a, b)))
    entry.deletions.sort(byId)
    entry.invalid.sort(byId)
  }
  return result
}

/** The retained workspace whose journal records local operations, whether or not transfer is on. */
export function historySyncWorkspace<TSchema extends Record<string, unknown>>(
  db: Reader<TSchema>
): string | null {
  return (
    db
      .select({ workspaceId: folderSyncSettings.workspaceId })
      .from(folderSyncSettings)
      .where(eq(folderSyncSettings.slot, 1))
      .get()?.workspaceId ?? null
  )
}

/**
 * Call inside the split's own transaction. Without a workspace connection this is a no-op.
 * Returns the fact's change ID (an existing equal cut is the same fact and is not repeated).
 */
export function journalSessionSplit<TSchema extends Record<string, unknown>>(
  db: Db<TSchema>,
  target: SessionSplitTarget
): string | null {
  const workspaceId = historySyncWorkspace(db)
  if (!workspaceId) return null
  const change = planSessionSplitFact(workspaceId, target)
  recordLocalSyncChanges(db, workspaceId, [change], historyRecordsAdapter)
  return change.id
}

/** Call inside the deletion's own transaction. Without a workspace connection this is a no-op. */
export function journalSessionDeletion<TSchema extends Record<string, unknown>>(
  db: Db<TSchema>,
  target: SessionDeletionTarget
): string | null {
  const workspaceId = historySyncWorkspace(db)
  if (!workspaceId) return null
  const change = planSessionDeletionFact(workspaceId, target)
  recordLocalSyncChanges(db, workspaceId, [change], historyRecordsAdapter)
  return change.id
}

/**
 * Bootstrap: proven original splits and deletions of adopted rows, from local immutable proof
 * rows only (no source logs). A conversation with any unproven operation is withheld whole so
 * a receiver never gets a partial set. A deletion already recorded for this workspace with the
 * same target and coverage (for example journaled when it was made) is not exported again.
 * Record the result with recordLocalSyncChanges and historyRecordsAdapter.
 */
export function collectHistorySyncChanges<TSchema extends Record<string, unknown>>(
  db: Reader<TSchema>,
  workspaceId: string,
  options: {
    conversationKeys?: readonly string[]
    /** Root metadata hook: session-edit heads observed by a proven local deletion. */
    observedSessionEditHeads?: (deletion: {
      sessionId: number
      provider: string
      conversationId: string
    }) => readonly string[]
  } = {}
): { changes: SyncChange[]; withheld: string[] } {
  requireWorkspace(workspaceId)
  const proofs = readCanonicalHistoryProofs(db, options.conversationKeys)
  const recorded = readPortableHistoryFacts(db, options.conversationKeys, workspaceId)
  const changes = new Map<string, SyncChange>()
  const withheld: string[] = []
  for (const [key, proof] of proofs) {
    if (proof.invalid.length) {
      withheld.push(key)
      continue
    }
    const [provider, conversationId] = JSON.parse(key) as [string, string]
    for (const cut of proof.cuts) {
      const change = planSessionSplitFact(workspaceId, {
        provider,
        conversationId,
        splitAt: cut.splitAt
      })
      changes.set(change.id, change)
    }
    const existing = new Set(
      (recorded.get(key)?.deletions ?? []).map((row) => canonicalJson(row.coverage))
    )
    for (const deletion of proof.deletions) {
      const coverage = portableCoverage(deletion.coverage)
      if (existing.has(canonicalJson(coverage))) continue
      const change = planSessionDeletionFact(workspaceId, {
        provider,
        conversationId,
        coverage: deletion.coverage,
        observedSessionEditHeads:
          options.observedSessionEditHeads?.({
            sessionId: deletion.sessionId,
            provider,
            conversationId
          }) ?? []
      })
      changes.set(change.id, change)
    }
  }
  const order = (change: SyncChange) =>
    HISTORY_SYNC_ENTITY_TYPES.indexOf(change.entityType as HistoryEntityType)
  return {
    changes: [...changes.values()].sort((a, b) =>
      order(a) !== order(b) ? order(a) - order(b) : a.entityId < b.entityId ? -1 : 1
    ),
    withheld: withheld.sort()
  }
}

/** Shared strict coverage reader for other records that retain immutable activity ownership. */
export function readPortableHistoryCoverage(
  value: unknown,
  provider: string
): CanonicalIntervalCoverage {
  return readCoverage(value, provider, 'Portable activity coverage')
}
export function portableHistoryCoverage(
  coverage: CanonicalIntervalCoverage,
  provider: string
): CanonicalIntervalCoverage {
  return readPortableHistoryCoverage(portableCoverage(coverage), provider)
}
