import { createHash, randomUUID } from 'node:crypto'
import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { sessions, type Session } from '../db/schema/sessions'
import { sessionLegacyRecords } from '../db/schema/session-legacy'
import { sessionModelUsage } from '../db/schema/session-model-usage'
import { activeSessionCondition, sessionDeletions } from '../db/schema/session-deletions'
import { sessionReplacements, sessionSplits, sessionRevisions } from '../db/schema/session-history'
import { sessionActivityMappings } from '../db/schema/session-activity-mappings'
import { sessionDerivations } from '../db/schema/session-derivations'
import { activityIdentities, activityObservations } from '../db/schema/activity-evidence'
import { syncChanges, syncRecordStates } from '../db/schema/folder-sync'
import { syncHistorySuppressions, syncLegacyImports } from '../db/schema/sync-legacy'
import { AppError } from '../../shared/types/ipc'
import type { SessionModelUsage } from '../../shared/types/session'
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
import { getDirectoryRecordView } from './folder-sync-directory-records'
import {
  findClientByPortableId,
  getPortableClientId,
  findProjectByPortableId,
  getPortableProjectId
} from './folder-sync-builtin-client'
import { coverageHash } from './session-mapping-plan'
import {
  applyLegacyEditChange,
  effectiveLegacyValues,
  getLegacyEditView,
  markLocalLegacyBaseline,
  ownLegacyLifecycle,
  planLegacyEditBaseline,
  portableLegacyValues,
  projectLegacyEditValues,
  readLegacyEditState,
  validateLegacyEditChange,
  type LegacyDisposition,
  type LegacyReference
} from './folder-sync-legacy-edits'

/*
 * Portable saved legacy history (folder-sync-plan.md decisions A, C and D).
 *
 * legacy-session: an immutable fact keyed by the existing session_legacy_records UUID. The payload
 * is an explicit allowlist of the saved snapshot: provider, conversation, times, counts, per-model
 * usage, the snapshot's baseline billable/description/client/project and, for a split child, the
 * legacy UUID it was split from. Local IDs, source files, project paths, raw text and local
 * capture times never leave; no computer is named (provenance travels as history-observer facts).
 * With no dependencies and syncFactChangeId, clones produce byte-identical changes. Times must
 * carry an explicit zone: a timezone-naive saved time is withheld unless the caller explicitly
 * confirms it as UTC, so no hash depends on the exporting computer's OS timezone.
 *
 * Values and lifecycle (edits, deletion, split, adoption) are causal legacy-edit revisions; see
 * folder-sync-legacy-edits.ts. Every native legacy row is exported, including deleted, split
 * and adopted ones, which stay non-counting audit history everywhere.
 *
 * A receiver restores the snapshot as a local source-less session with the same legacy UUID and
 * model totals, never fabricated activity. Only records that would count (lifecycle active or in
 * a lifecycle conflict, and not an unconfirmed split child) take part in overlap review. An
 * unknown legacy ID that overlaps another such record or ledger activity of the same
 * conversation is held outside active totals until a legacy-reconciliation settles the group.
 * The queue is a pure function of applied facts, native local rows and the ledger, so arrival
 * order never picks a winner. Nothing is deleted.
 *
 * legacy-reconciliation: entity legacy-reconciliation:v1:<sha256 of the payload>, naming the exact
 * candidate set, which to keep, which are duplicates, and the resolutions it supersedes; it
 * depends on every candidate fact and superseded resolution. When an overlap group consists only
 * of one computer's own counted rows, that computer journals a keep-all resolution of exactly
 * that group, so a blank receiver restores the same counts. The ID is content-derived, so clones
 * agree and diverged copies produce distinct, individually valid resolutions. Concurrent
 * resolutions that disagree keep the last agreed resolution (their common superseded ancestor);
 * without one, the unreviewed state (own history counts, unknown IDs held) remains.
 */

type Db<TSchema extends Record<string, unknown>> = BetterSQLite3Database<TSchema>
type Transaction = Parameters<SyncDomainAdapter['apply']>[0]
type Reader = Pick<Transaction, 'select'>

export const LEGACY_SYNC_ENTITY_TYPES = [
  'legacy-session',
  'legacy-reconciliation',
  'legacy-edit'
] as const satisfies readonly SyncEntityType[]
type LegacyEntityType = (typeof LEGACY_SYNC_ENTITY_TYPES)[number]
type LegacyFactType = Exclude<LegacyEntityType, 'legacy-edit'>
export const LEGACY_PROVIDERS = ['claude', 'codex', 'gemini', 'opencode'] as const

export interface PortableLegacySnapshot {
  version: 1
  /** session_legacy_records.version: the saved totals' own format version. */
  snapshotVersion: number
  provider: string
  conversationId: string | null
  startedAt: string
  endedAt: string
  durationMinutes: number
  promptCount: number
  inputTokens: number
  outputTokens: number
  modelUsage: SessionModelUsage[]
  billable: boolean
  description: string | null
  clientSyncId: string | null
  projectSyncId: string | null
  /** The legacy UUID whose split produced this snapshot; it counts once that split is agreed. */
  splitFrom: string | null
}

export interface LegacyReconciliation {
  version: 1
  provider: string
  conversationId: string
  /** The exact overlap group that was reviewed (sorted legacy IDs). */
  candidates: string[]
  activityOverlap: boolean
  keep: string[]
  duplicates: string[]
  /** Resolution entity IDs this one replaces (sorted). */
  supersedes: string[]
}

export type LegacyQueueStatus = 'queued' | 'duplicate' | 'conflict'
export type LegacyQueueReason =
  | 'overlapping-legacy'
  | 'overlapping-activity'
  | 'conflicting-resolutions'
  | 'resolved-duplicate'
  | 'pending-split'

export interface LegacyQueueEntry {
  legacyId: string
  sessionId: number
  status: LegacyQueueStatus
  /** Whether the row counts in active totals right now (conflicts may keep a last agreed row). */
  counting: boolean
  reasons: LegacyQueueReason[]
  candidates: string[]
  activityOverlap: boolean
  /** Current resolution heads for the group (entity IDs). */
  resolutions: string[]
  /** Conflicts only: the last agreed resolutions whose decision is applied. */
  lastAgreed: string[]
  /** pending-split only: the parent whose split has not been agreed. */
  splitFrom?: string
}

const SNAPSHOT_KEYS = [
  'version',
  'snapshotVersion',
  'provider',
  'conversationId',
  'startedAt',
  'endedAt',
  'durationMinutes',
  'promptCount',
  'inputTokens',
  'outputTokens',
  'modelUsage',
  'billable',
  'description',
  'clientSyncId',
  'projectSyncId',
  'splitFrom'
]
const USAGE_KEYS = [
  'model',
  'inputTokens',
  'outputTokens',
  'cacheCreationInputTokens',
  'cacheReadInputTokens'
]
const RECONCILIATION_KEYS = [
  'version',
  'provider',
  'conversationId',
  'candidates',
  'activityOverlap',
  'keep',
  'duplicates',
  'supersedes'
]
const RECONCILIATION_ID = /^legacy-reconciliation:v1:[0-9a-f]{64}$/
const VOCABULARY = /^[a-z][a-z0-9-]*$/
const ZONED_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/
const NAIVE_INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/
const MAX_CONVERSATION_ID = 400
const MAX_DESCRIPTION = 20_000
const MAX_MODEL = 200
const MAX_MODELS = 64
const MAX_CANDIDATES = 200
const MAX_SUPERSEDES = 100

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

/** RFC 9562 version-8 UUID over sha256 of canonical JSON. */
function v8(value: unknown): string {
  const bytes = createHash('sha256').update(canonicalJson(value)).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x80
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isText(value: unknown, max: number, multiline: boolean): value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || !value.isWellFormed())
    return false
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    const allowed = multiline && (code === 0x09 || code === 0x0a || code === 0x0d)
    if ((code < 0x20 || code === 0x7f) && !allowed) return false
  }
  return true
}

/** Normalized UTC only, so equal instants have one spelling and one fact. */
function isInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  )
}

/**
 * A saved time with an explicit zone as normalized UTC. A timezone-naive time is never read in
 * this computer's OS timezone: it is null unless `assumeUtc` records the user's explicit choice.
 */
export function portableInstant(value: unknown, assumeUtc = false): string | null {
  if (typeof value !== 'string') return null
  let text = value.trim()
  if (assumeUtc && NAIVE_INSTANT.test(text)) text = `${text.replace(' ', 'T')}Z`
  if (!ZONED_INSTANT.test(text)) return null
  const at = Date.parse(text)
  return Number.isFinite(at) ? new Date(at).toISOString() : null
}

export function isTimezoneNaive(value: unknown): boolean {
  return typeof value === 'string' && NAIVE_INSTANT.test(value.trim())
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Exact allowlist: every field present and nothing else. */
function fields(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isObject(value)) malformed(`${label} must be an object`)
  for (const key of Object.keys(value))
    if (!keys.includes(key)) malformed(`${label} has unsupported field "${key}"`)
  for (const key of keys) if (!Object.hasOwn(value, key)) malformed(`${label} is missing "${key}"`)
  return value
}

/** Checked before the shape, so a newer format pauses sync instead of reading as damage. */
function supportedVersion(value: unknown, feature: string): void {
  if (value === 1) return
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 1)
    updateRequired(`${feature} ${value}`)
  malformed(`${feature} is invalid`)
}

/** An unknown provider is never guessed into a known one. */
function readProvider(value: unknown, label: string): string {
  if (typeof value !== 'string' || !VOCABULARY.test(value))
    malformed(`${label} has an invalid provider`)
  if (!(LEGACY_PROVIDERS as readonly string[]).includes(value))
    updateRequired(`legacy provider "${value}"`)
  return value
}

function sortedIds(
  value: unknown,
  label: string,
  max: number,
  check: (value: unknown) => boolean = isSyncUuid
): string[] {
  if (!Array.isArray(value) || value.length > max) malformed(`${label} must be a short list`)
  value.forEach((id, index) => {
    if (!check(id) || (index && !((value[index - 1] as string) < (id as string))))
      malformed(`${label} must be sorted unique IDs`)
  })
  return value as string[]
}

function readSnapshot(payload: unknown): PortableLegacySnapshot {
  if (isObject(payload)) {
    supportedVersion(payload.version, 'legacy session format')
    supportedVersion(payload.snapshotVersion, 'legacy snapshot version')
  }
  const snapshot = fields(payload, SNAPSHOT_KEYS, 'Legacy session')
  readProvider(snapshot.provider, 'Legacy session')
  const { conversationId, startedAt, endedAt, modelUsage, description } = snapshot
  if (conversationId !== null && !isText(conversationId, MAX_CONVERSATION_ID, false))
    malformed('Legacy session has an invalid conversation')
  if (!isInstant(startedAt) || !isInstant(endedAt) || endedAt < startedAt)
    malformed('Legacy session times must be ordered normalized UTC instants')
  for (const key of ['durationMinutes', 'promptCount', 'inputTokens', 'outputTokens'])
    if (!isCount(snapshot[key])) malformed(`Legacy session has an invalid ${key}`)
  if (!Array.isArray(modelUsage) || modelUsage.length > MAX_MODELS)
    malformed('Legacy session model usage must be a list')
  modelUsage.forEach((entry, index) => {
    const usage = fields(entry, USAGE_KEYS, 'Legacy model usage')
    if (!isText(usage.model, MAX_MODEL, false)) malformed('Legacy model usage has an invalid model')
    if (!USAGE_KEYS.slice(1).every((key) => isCount(usage[key])))
      malformed('Legacy model usage has invalid counts')
    if (index && !((modelUsage[index - 1] as SessionModelUsage).model < (usage.model as string)))
      malformed('Legacy model usage must be sorted by unique model')
  })
  if (typeof snapshot.billable !== 'boolean') malformed('Legacy session billable must be boolean')
  if (description !== null && !isText(description, MAX_DESCRIPTION, true))
    malformed('Legacy session has an invalid description')
  for (const key of ['clientSyncId', 'projectSyncId', 'splitFrom'])
    if (snapshot[key] !== null && !isSyncUuid(snapshot[key]))
      malformed(`Legacy session has an invalid ${key}`)
  return snapshot as unknown as PortableLegacySnapshot
}

export function legacyReconciliationEntityId(payload: JsonObject): string {
  return `legacy-reconciliation:v1:${sha256(canonicalJson(payload))}`
}

function readReconciliation(change: SyncChange): LegacyReconciliation {
  supportedVersion(change.payload.version, 'legacy reconciliation version')
  const payload = fields(change.payload, RECONCILIATION_KEYS, 'Legacy reconciliation')
  readProvider(payload.provider, 'Legacy reconciliation')
  if (!isText(payload.conversationId, MAX_CONVERSATION_ID, false))
    malformed('Legacy reconciliation has an invalid conversation')
  const candidates = sortedIds(
    payload.candidates,
    'Legacy reconciliation candidates',
    MAX_CANDIDATES
  )
  const keep = sortedIds(payload.keep, 'Legacy reconciliation keep', MAX_CANDIDATES)
  const duplicates = sortedIds(
    payload.duplicates,
    'Legacy reconciliation duplicates',
    MAX_CANDIDATES
  )
  sortedIds(
    payload.supersedes,
    'Legacy reconciliation supersedes',
    MAX_SUPERSEDES,
    (id) => typeof id === 'string' && RECONCILIATION_ID.test(id)
  )
  if (typeof payload.activityOverlap !== 'boolean')
    malformed('Legacy reconciliation activityOverlap must be boolean')
  if (!candidates.length || (candidates.length === 1 && !payload.activityOverlap))
    malformed('Legacy reconciliation has nothing to reconcile')
  if (
    keep.some((id) => duplicates.includes(id)) ||
    canonicalJson([...keep, ...duplicates].sort()) !== canonicalJson(candidates)
  )
    malformed('Legacy reconciliation must decide every candidate exactly once')
  if (
    !RECONCILIATION_ID.test(change.entityId) ||
    change.entityId !== legacyReconciliationEntityId(change.payload)
  )
    malformed('Legacy reconciliation entity ID does not match its contents')
  if ((payload.supersedes as string[]).includes(change.entityId))
    malformed('Legacy reconciliation cannot supersede itself')
  return payload as unknown as LegacyReconciliation
}

function isLegacyFactType(value: string): value is LegacyFactType {
  return value === 'legacy-session' || value === 'legacy-reconciliation'
}

/** Structural and semantic checks only; independent of any database. */
function validateLegacyChange(change: SyncChange): void {
  if (change.entityType === 'legacy-edit') {
    if (change.kind !== 'revision')
      malformed(`Sync change ${change.id} must be a legacy-edit revision`)
    validateLegacyEditChange(change)
    return
  }
  if (change.kind !== 'fact' || !isLegacyFactType(change.entityType))
    malformed(`Sync change ${change.id} is not a legacy history fact`)
  if (change.entityType === 'legacy-session') {
    if (!isSyncUuid(change.entityId)) malformed('Legacy session entity ID must be its legacy UUID')
    if (change.dependencies.length) malformed('Legacy session facts have no dependencies')
    if (readSnapshot(change.payload).splitFrom === change.entityId)
      malformed('A legacy session cannot be split from itself')
    return
  }
  const reconciliation = readReconciliation(change)
  if (
    change.dependencies.length !==
    reconciliation.candidates.length + reconciliation.supersedes.length
  )
    malformed('Legacy reconciliation must depend on its candidates and superseded resolutions')
}

function reconciliationDependencies(workspaceId: string, value: LegacyReconciliation): string[] {
  return [
    ...value.candidates.map((id) => syncFactChangeId(workspaceId, 'legacy-session', id)),
    ...value.supersedes.map((id) => syncFactChangeId(workspaceId, 'legacy-reconciliation', id))
  ].sort()
}

function requireWorkspace(workspaceId: string): void {
  if (!isSyncUuid(workspaceId)) malformed('A shared history ID is required')
}

function fact(
  workspaceId: string,
  entityType: LegacyFactType,
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
  validateLegacyChange(change)
  return change
}

// ── Reading applied facts ──

function storedFacts(db: Reader, workspaceId: string, entityType: LegacyFactType) {
  return db
    .select({ id: syncChanges.id, json: syncChanges.changeJson })
    .from(syncChanges)
    .where(and(eq(syncChanges.workspaceId, workspaceId), eq(syncChanges.entityType, entityType)))
    .all()
    .map((row) => parseChange(JSON.parse(row.json)))
}

/** The applied snapshot of one legacy UUID in this workspace, if any. */
export function readLegacySnapshot(
  db: Reader,
  workspaceId: string,
  legacyId: string
): PortableLegacySnapshot | null {
  const row = db
    .select({ json: syncChanges.changeJson })
    .from(syncChanges)
    .where(eq(syncChanges.id, syncFactChangeId(workspaceId, 'legacy-session', legacyId)))
    .get()
  return row ? readSnapshot((JSON.parse(row.json) as SyncChange).payload) : null
}

/** Applied facts whose payload value at `path` is one of `values`: one indexed pass per chunk. */
function storedFactsIn(
  db: Reader,
  workspaceId: string,
  entityType: LegacyFactType,
  path: '$.payload.conversationId' | '$.payload.splitFrom',
  values: Iterable<string>
): SyncChange[] {
  const changes: SyncChange[] = []
  for (const part of chunked(values))
    for (const row of db
      .select({ json: syncChanges.changeJson })
      .from(syncChanges)
      .where(
        and(
          eq(syncChanges.workspaceId, workspaceId),
          eq(syncChanges.entityType, entityType),
          inArray(sql`json_extract(${syncChanges.changeJson}, ${path})`, part)
        )
      )
      .all())
      changes.push(parseChange(JSON.parse(row.json)))
  return changes
}

/** Every applied split descendant of `roots` (excluding the roots), one pass per generation. */
function splitDescendants(db: Reader, workspaceId: string, roots: Iterable<string>): string[] {
  const seen = new Set(roots)
  const found: string[] = []
  let generation = [...seen]
  while (generation.length) {
    const parents = new Set(generation)
    generation = []
    for (const change of storedFactsIn(
      db,
      workspaceId,
      'legacy-session',
      '$.payload.splitFrom',
      parents
    ))
      if (
        typeof change.payload.splitFrom === 'string' &&
        parents.has(change.payload.splitFrom) &&
        !seen.has(change.entityId)
      ) {
        seen.add(change.entityId)
        found.push(change.entityId)
        generation.push(change.entityId)
      }
  }
  return found
}

// ── Local rows ──

/** Base retention conditions without this module's own suppressions (avoids feedback). */
const retainedActive = sql`NOT EXISTS (
  SELECT 1 FROM ${sessionDeletions} WHERE ${sessionDeletions.sessionId} = ${sessions.id}
) AND NOT EXISTS (
  SELECT 1 FROM ${sessionSplits} WHERE ${sessionSplits.parentSessionId} = ${sessions.id}
) AND NOT EXISTS (
  SELECT 1 FROM ${sessionReplacements} WHERE ${sessionReplacements.predecessorSessionId} = ${sessions.id}
)`

interface LocalLegacy {
  legacyId: string
  sessionId: number
  version: number
  /** The saved snapshot (local only; it may name a source file). */
  snapshot: Session
  modelUsage: SessionModelUsage[]
  row: Session
  /** Saved here before sync, not restored from shared history. */
  native: boolean
  /** Deleted, split or replaced by this computer's own history. */
  locallyInactive: boolean
  adopted: boolean
  /** A child of a split recorded on this computer. */
  localSplitChild: boolean
}

/** SQLite bound-parameter lists stay well under every build's variable limit. */
const IN_CHUNK = 500

function chunked<T>(values: Iterable<T>): T[][] {
  const unique = [...new Set(values)]
  const parts: T[][] = []
  for (let at = 0; at < unique.length; at += IN_CHUNK) parts.push(unique.slice(at, at + IN_CHUNK))
  return parts
}

/** The saved snapshot's conversation, as conversationOfLocal and readLegacyGroups read it. */
const snapshotConversationId = sql`json_extract(
  ${sessionLegacyRecords.session}, '$.claudeSessionId'
)`

/**
 * Local legacy rows, all of them or only those with the given legacy IDs or saved snapshot
 * conversation IDs (callers still filter by provider). Scoped reads never visit other rows.
 */
function localLegacyIndex(
  db: Reader,
  filter?: { legacyIds?: Iterable<string>; conversationIds?: Iterable<string> }
): Map<string, LocalLegacy> {
  if (!filter) return toLocalLegacy(readLocalLegacyRows(db))
  const rows = new Map<string, ReturnType<typeof readLocalLegacyRows>[number]>()
  for (const part of chunked(filter.legacyIds ?? []))
    for (const row of readLocalLegacyRows(db, inArray(sessionLegacyRecords.id, part)))
      rows.set(row.id, row)
  for (const part of chunked(filter.conversationIds ?? []))
    for (const row of readLocalLegacyRows(db, inArray(snapshotConversationId, part)))
      rows.set(row.id, row)
  return toLocalLegacy([...rows.values()].sort((a, b) => (a.id < b.id ? -1 : 1)))
}

/** Adds rows missing from `locals` (scoped reads build the index up as they widen). */
function loadLocalLegacy(
  db: Reader,
  locals: Map<string, LocalLegacy>,
  filter: { legacyIds?: Iterable<string>; conversationIds?: Iterable<string> }
): void {
  const legacyIds = [...(filter.legacyIds ?? [])].filter((id) => !locals.has(id))
  for (const [id, local] of localLegacyIndex(db, { ...filter, legacyIds }))
    if (!locals.has(id)) locals.set(id, local)
}

function readLocalLegacyRows(db: Reader, where?: SQL) {
  return db
    .select({
      id: sessionLegacyRecords.id,
      sessionId: sessionLegacyRecords.sessionId,
      version: sessionLegacyRecords.version,
      snapshot: sessionLegacyRecords.session,
      modelUsage: sessionLegacyRecords.modelUsage,
      row: sessions,
      imported: syncLegacyImports.legacyId,
      active: sql<number>`CASE WHEN ${retainedActive} THEN 1 ELSE 0 END`,
      adopted: sql<number>`EXISTS (SELECT 1 FROM ${sessionActivityMappings} WHERE ${sessionActivityMappings.sessionId} = ${sessions.id})`,
      splitChild: sql<number>`EXISTS (SELECT 1 FROM ${sessionSplits} WHERE ${sessionSplits.firstSessionId} = ${sessions.id} OR ${sessionSplits.secondSessionId} = ${sessions.id})`
    })
    .from(sessionLegacyRecords)
    .innerJoin(sessions, eq(sessions.id, sessionLegacyRecords.sessionId))
    .leftJoin(syncLegacyImports, eq(syncLegacyImports.legacyId, sessionLegacyRecords.id))
    .where(where)
    .orderBy(sessionLegacyRecords.id)
    .all()
}

function toLocalLegacy(rows: ReturnType<typeof readLocalLegacyRows>): Map<string, LocalLegacy> {
  return new Map(
    rows.map((row) => [
      row.id,
      {
        legacyId: row.id,
        sessionId: row.sessionId,
        version: row.version,
        snapshot: row.snapshot,
        modelUsage: row.modelUsage,
        row: row.row,
        native: row.imported === null,
        locallyInactive: !row.active,
        adopted: !!row.adopted,
        localSplitChild: !!row.splitChild
      }
    ])
  )
}

/** Native rows that count here without sync: retained, active and not adopted to activity. */
function countingNative(local: LocalLegacy): boolean {
  return local.native && !local.locallyInactive && !local.adopted
}

// ── Local projection ──

/** Only resolves a reference whose record has applied history here and a local row. */
function localReferences(
  tx: Reader,
  workspaceId: string,
  snapshot: Pick<PortableLegacySnapshot, 'clientSyncId' | 'projectSyncId'>
): { clientId: number | null; projectId: number | null } {
  let clientId: number | null = null
  let projectId: number | null = null
  if (
    snapshot.clientSyncId &&
    getDirectoryRecordView(tx, workspaceId, 'client', snapshot.clientSyncId).lifecycle !== 'missing'
  )
    clientId = findClientByPortableId(tx, snapshot.clientSyncId)?.id ?? null
  if (
    snapshot.projectSyncId &&
    getDirectoryRecordView(tx, workspaceId, 'project', snapshot.projectSyncId).lifecycle !==
      'missing'
  )
    projectId = findProjectByPortableId(tx, snapshot.projectSyncId)?.id ?? null
  return { clientId, projectId }
}

/** Restores a snapshot once as a source-less local session under the same legacy UUID. */
function projectLegacySnapshot(
  tx: Transaction,
  workspaceId: string,
  legacyId: string,
  snapshot: PortableLegacySnapshot
): void {
  const existing = tx
    .select({ id: sessionLegacyRecords.id })
    .from(sessionLegacyRecords)
    .where(eq(sessionLegacyRecords.id, legacyId))
    .get()
  // Native or already restored history is retained exactly as it is.
  if (existing) return
  const now = new Date().toISOString()
  const row = tx
    .insert(sessions)
    .values({
      // No path or source file: this computer has no local copy of the logs.
      projectPath: '',
      sourceFile: null,
      startedAt: snapshot.startedAt,
      endedAt: snapshot.endedAt,
      durationMinutes: snapshot.durationMinutes,
      source: 'auto',
      status: 'completed',
      description: snapshot.description,
      tool: snapshot.provider as Session['tool'],
      claudeSessionId: snapshot.conversationId,
      promptCount: snapshot.promptCount,
      inputTokens: snapshot.inputTokens,
      outputTokens: snapshot.outputTokens,
      billable: snapshot.billable ? 1 : 0,
      ...localReferences(tx, workspaceId, snapshot),
      createdAt: now,
      updatedAt: now
    })
    .returning()
    .get()
  for (const usage of snapshot.modelUsage)
    tx.insert(sessionModelUsage)
      .values({ sessionId: row.id, ...usage })
      .run()
  tx.insert(sessionLegacyRecords)
    .values({
      id: legacyId,
      sessionId: row.id,
      version: snapshot.snapshotVersion,
      session: row,
      modelUsage: snapshot.modelUsage.map((usage) => ({ ...usage })),
      createdAt: now
    })
    .run()
  tx.insert(syncLegacyImports).values({ legacyId, workspaceId }).run()
}

/**
 * Root hook after directory imports: legacy rows gain their shared client/project once those
 * records are applied here. Values follow the legacy-edit record, else the snapshot.
 */
export function resolveLegacyReferences(
  tx: Transaction,
  workspaceId: string,
  legacyIds?: readonly string[]
): void {
  if (legacyIds?.length === 0) return
  const ids = new Set(
    tx
      .select({ legacyId: syncLegacyImports.legacyId })
      .from(syncLegacyImports)
      .innerJoin(sessionLegacyRecords, eq(sessionLegacyRecords.id, syncLegacyImports.legacyId))
      .innerJoin(sessions, eq(sessions.id, sessionLegacyRecords.sessionId))
      .where(
        and(
          eq(syncLegacyImports.workspaceId, workspaceId),
          legacyIds ? inArray(sessionLegacyRecords.id, [...legacyIds]) : undefined,
          or(isNull(sessions.clientId), isNull(sessions.projectId))
        )
      )
      .all()
      .map((row) => row.legacyId)
  )
  for (const row of tx
    .select({ entityId: syncRecordStates.entityId, json: syncRecordStates.stateJson })
    .from(syncRecordStates)
    .where(
      and(
        eq(syncRecordStates.workspaceId, workspaceId),
        eq(syncRecordStates.entityType, 'legacy-edit'),
        legacyIds ? inArray(syncRecordStates.entityId, [...legacyIds]) : undefined
      )
    )
    .all())
    if (
      (JSON.parse(row.json) as { blockers?: string[] }).blockers?.some((item) =>
        item.endsWith(':unavailable')
      )
    )
      ids.add(row.entityId)
  for (const legacyId of [...ids].sort()) projectLegacyEditValues(tx, workspaceId, legacyId)
}

// ── Lifecycle ──

export type LegacyRecordState = 'active' | 'conflict' | 'deleted' | 'retired' | 'pending-split'

export interface LegacyLifecycle {
  state: LegacyRecordState
  disposition: LegacyDisposition | null
  splitFrom: string | null
}
type LifecycleMemo = Map<string, LegacyLifecycle>

/**
 * Shared lifecycle of one record, a pure function of applied facts and revisions. A split child
 * counts only when its parent (itself live in its own lineage) agreed on a split naming it.
 */
export function legacyLifecycle(
  db: Reader,
  workspaceId: string,
  legacyId: string,
  memo: LifecycleMemo = new Map(),
  visiting: Set<string> = new Set()
): LegacyLifecycle {
  const known = memo.get(legacyId)
  if (known) return known
  const splitFrom = readLegacySnapshot(db, workspaceId, legacyId)?.splitFrom ?? null
  if (visiting.has(legacyId)) return { state: 'pending-split', disposition: null, splitFrom }
  visiting.add(legacyId)
  let result: LegacyLifecycle | undefined
  if (splitFrom) {
    const parent = legacyLifecycle(db, workspaceId, splitFrom, memo, visiting)
    const applies =
      parent.state === 'retired' &&
      parent.disposition?.kind === 'split' &&
      parent.disposition.children.includes(legacyId)
    if (!applies)
      result = {
        state:
          parent.state === 'deleted' ||
          parent.state === 'retired' ||
          readLegacyEditState(db, workspaceId, splitFrom)?.restoresLocalHistory
            ? 'retired'
            : 'pending-split',
        disposition: null,
        splitFrom
      }
  }
  if (!result) {
    const own = ownLegacyLifecycle(getLegacyEditView(db, workspaceId, legacyId))
    result =
      own.state === 'conflict'
        ? { state: 'conflict', disposition: null, splitFrom }
        : own.state === 'retired'
          ? {
              state: own.disposition?.kind === 'deleted' ? 'deleted' : 'retired',
              disposition: own.disposition,
              splitFrom
            }
          : { state: 'active', disposition: null, splitFrom }
  }
  visiting.delete(legacyId)
  memo.set(legacyId, result)
  return result
}

const isEffective = (lifecycle: LegacyLifecycle): boolean =>
  lifecycle.state === 'active' || lifecycle.state === 'conflict'

// ── Ambiguity queue ──

interface QueueRecord {
  legacyId: string
  sessionId: number | null
  native: boolean
  start: number
  end: number
  activity: boolean
}

export interface LegacyGroupDecision {
  /** The decision in force: the agreed heads, or the last agreed ancestor during a conflict. */
  agreed: { keep: string[]; duplicates: string[] } | null
  conflict: boolean
  lastAgreed: string[]
}

export interface LegacyGroup {
  provider: string
  conversationId: string
  candidates: string[]
  activityOverlap: boolean
  needsReview: boolean
  /** Current, non-superseded resolutions that exactly match this group. */
  heads: Array<{ entityId: string; keep: string[]; duplicates: string[] }>
  decision: LegacyGroupDecision
  members: QueueRecord[]
}

interface Conversation {
  provider: string
  conversationId: string
}

const conversationKey = (provider: string, conversationId: string): string =>
  JSON.stringify([provider, conversationId])

function overlaps(a: QueueRecord, b: QueueRecord): boolean {
  if (a.start === a.end || b.start === b.end) return a.start <= b.end && b.start <= a.end
  return a.start < b.end && b.start < a.end
}

function activityInstants(tx: Reader, provider: string, conversationId: string): number[] {
  return tx
    .select({
      timestamp: sql<
        string | null
      >`json_extract(${activityObservations.payloadJson}, '$.timestamp')`
    })
    .from(activityObservations)
    .innerJoin(activityIdentities, eq(activityIdentities.eventId, activityObservations.eventId))
    .where(
      and(
        eq(activityIdentities.provider, provider),
        eq(activityIdentities.conversationId, conversationId),
        eq(activityObservations.kind, 'message')
      )
    )
    .all()
    .map((row) => portableInstant(row.timestamp))
    .filter((at): at is string => at !== null)
    .map((at) => Date.parse(at))
}

type Resolution = { entityId: string; value: LegacyReconciliation }

/** Heads and the decision in force; walks superseded resolutions back to the last agreement. */
function decideResolutions(matching: Resolution[]): {
  heads: Resolution[]
  decision: LegacyGroupDecision
} {
  const byId = new Map(matching.map((resolution) => [resolution.entityId, resolution]))
  const parentsOf = (id: string): string[] =>
    (byId.get(id)?.value.supersedes ?? []).filter((parent) => byId.has(parent))
  const superseded = new Set(matching.flatMap((resolution) => parentsOf(resolution.entityId)))
  const heads = matching
    .filter((resolution) => !superseded.has(resolution.entityId))
    .sort((a, b) => (a.entityId < b.entityId ? -1 : 1))
  const key = (resolution: Resolution) =>
    canonicalJson([resolution.value.keep, resolution.value.duplicates])
  const agree = (list: Resolution[]) => list.every((item) => key(item) === key(list[0]))
  const pick = (resolution: Resolution) => ({
    keep: resolution.value.keep,
    duplicates: resolution.value.duplicates
  })
  if (!heads.length) return { heads, decision: { agreed: null, conflict: false, lastAgreed: [] } }
  if (agree(heads))
    return { heads, decision: { agreed: pick(heads[0]), conflict: false, lastAgreed: [] } }
  const lastCommon = (ids: string[]): string[] => {
    let common: Set<string> | undefined
    for (const id of ids) {
      const reach = new Set<string>()
      const stack = [id]
      while (stack.length) {
        const next = stack.pop() as string
        if (reach.has(next)) continue
        reach.add(next)
        stack.push(...parentsOf(next))
      }
      common = common ? new Set([...common].filter((item) => reach.has(item))) : reach
    }
    const covered = new Set([...(common ?? [])].flatMap(parentsOf))
    return [...(common ?? [])].filter((item) => !covered.has(item)).sort()
  }
  let base = lastCommon(heads.map((head) => head.entityId))
  for (let guard = 0; base.length && guard <= matching.length; guard++) {
    const list = base.map((id) => byId.get(id)!)
    if (agree(list))
      return { heads, decision: { agreed: pick(list[0]), conflict: true, lastAgreed: base } }
    base = lastCommon(base)
  }
  return { heads, decision: { agreed: null, conflict: true, lastAgreed: [] } }
}

/** Keyed by conversationKey. */
interface ConversationData {
  facts: Map<string, SyncChange[]>
  /** Local rows whose saved snapshot names the conversation (conversationOfLocal). */
  localRows: Map<string, LocalLegacy[]>
  resolutions: Map<string, SyncChange[]>
}

function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

/**
 * Applied facts, local rows and resolutions of a set of conversations (or all of them), read in
 * a few passes instead of once per conversation. `locals` must already hold every row when
 * 'all'; otherwise the conversations' rows and every fact's own row are added to it.
 */
function readConversationData(
  db: Reader,
  workspaceId: string,
  conversations: readonly Conversation[] | 'all',
  locals: Map<string, LocalLegacy>
): ConversationData {
  const all = conversations === 'all'
  const wanted = all
    ? null
    : new Set(conversations.map((item) => conversationKey(item.provider, item.conversationId)))
  const ids = all ? [] : conversations.map((item) => item.conversationId)
  const group = (changes: SyncChange[]): Map<string, SyncChange[]> => {
    const byKey = new Map<string, SyncChange[]>()
    for (const change of changes) {
      const { provider, conversationId } = change.payload
      if (typeof provider !== 'string' || typeof conversationId !== 'string') continue
      const key = conversationKey(provider, conversationId)
      if (!wanted || wanted.has(key)) pushTo(byKey, key, change)
    }
    return byKey
  }
  const facts = all
    ? storedFacts(db, workspaceId, 'legacy-session')
    : storedFactsIn(db, workspaceId, 'legacy-session', '$.payload.conversationId', ids)
  const resolutions = all
    ? storedFacts(db, workspaceId, 'legacy-reconciliation')
    : storedFactsIn(db, workspaceId, 'legacy-reconciliation', '$.payload.conversationId', ids)
  if (!all)
    loadLocalLegacy(db, locals, {
      conversationIds: ids,
      legacyIds: facts.map((change) => change.entityId)
    })
  const localRows = new Map<string, LocalLegacy[]>()
  for (const local of locals.values()) {
    const conversation = conversationOfLocal(local)
    if (!conversation) continue
    const key = conversationKey(conversation.provider, conversation.conversationId)
    if (!wanted || wanted.has(key)) pushTo(localRows, key, local)
  }
  return { facts: group(facts), localRows, resolutions: group(resolutions) }
}

/** Every overlap group of one conversation, from facts, native rows and the ledger. */
export function readLegacyGroups(
  tx: Reader,
  workspaceId: string,
  provider: string,
  conversationId: string,
  memo: LifecycleMemo = new Map(),
  locals: Map<string, LocalLegacy> = new Map()
): LegacyGroup[] {
  const data = readConversationData(tx, workspaceId, [{ provider, conversationId }], locals)
  return groupsOf(tx, workspaceId, provider, conversationId, memo, locals, data)
}

function groupsOf(
  tx: Reader,
  workspaceId: string,
  provider: string,
  conversationId: string,
  memo: LifecycleMemo,
  locals: Map<string, LocalLegacy>,
  data: ConversationData
): LegacyGroup[] {
  const key = conversationKey(provider, conversationId)
  const records = new Map<string, QueueRecord>()
  const exported = new Set<string>()
  for (const change of data.facts.get(key) ?? []) {
    const snapshot = readSnapshot(change.payload)
    if (snapshot.provider !== provider || snapshot.conversationId !== conversationId) continue
    exported.add(change.entityId)
    const local = locals.get(change.entityId)
    // This computer's own retired rows never count here, whatever the shared lifecycle says.
    if (local?.native && !countingNative(local)) continue
    if (!isEffective(legacyLifecycle(tx, workspaceId, change.entityId, memo))) continue
    const values = effectiveLegacyValues(
      getLegacyEditView(tx, workspaceId, change.entityId),
      snapshot
    )
    records.set(change.entityId, {
      legacyId: change.entityId,
      sessionId: local?.sessionId ?? null,
      native: !!local?.native,
      start: Date.parse(values.startedAt),
      end: Date.parse(values.endedAt),
      activity: false
    })
  }
  for (const local of data.localRows.get(key) ?? []) {
    if (!countingNative(local) || exported.has(local.legacyId)) continue
    if (
      local.snapshot.source !== 'auto' ||
      local.snapshot.tool !== provider ||
      local.snapshot.claudeSessionId !== conversationId
    )
      continue
    const start = portableInstant(local.row.startedAt)
    const end = portableInstant(local.row.endedAt)
    records.set(local.legacyId, {
      legacyId: local.legacyId,
      sessionId: local.sessionId,
      native: true,
      // An ambiguous (timezone-naive) time is treated as overlapping the whole conversation.
      start: start ? Date.parse(start) : -Infinity,
      end: end ? Date.parse(end) : Infinity,
      activity: false
    })
  }
  if (!records.size) return []
  const instants = activityInstants(tx, provider, conversationId)
  for (const record of records.values())
    record.activity = instants.some((at) => at >= record.start && at <= record.end)

  // Connected components of the overlap graph; order-independent by construction.
  const list = [...records.values()].sort((a, b) => (a.legacyId < b.legacyId ? -1 : 1))
  const parent = list.map((_, index) => index)
  const find = (index: number): number =>
    parent[index] === index ? index : (parent[index] = find(parent[index]))
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++)
      if (overlaps(list[i], list[j])) parent[find(j)] = find(i)
  const components = new Map<number, QueueRecord[]>()
  list.forEach((record, index) => {
    const root = find(index)
    components.set(root, [...(components.get(root) ?? []), record])
  })

  const resolutions = (data.resolutions.get(key) ?? [])
    .map((change) => ({ entityId: change.entityId, value: readReconciliation(change) }))
    .filter(({ value }) => value.provider === provider && value.conversationId === conversationId)
  return [...components.values()].map((members) => {
    const candidates = members.map((member) => member.legacyId)
    const activityOverlap = members.some((member) => member.activity)
    const { heads, decision } = decideResolutions(
      resolutions.filter(
        ({ value }) =>
          value.activityOverlap === activityOverlap &&
          canonicalJson(value.candidates) === canonicalJson(candidates)
      )
    )
    return {
      provider,
      conversationId,
      candidates,
      activityOverlap,
      needsReview: candidates.length > 1 || activityOverlap,
      heads: heads.map(({ entityId, value }) => ({
        entityId,
        keep: value.keep,
        duplicates: value.duplicates
      })),
      decision,
      members
    }
  })
}

interface MemberOutcome {
  counting: boolean
  status: LegacyQueueStatus
  reasons: LegacyQueueReason[]
}

/** null: counts with nothing to review. */
function memberOutcome(group: LegacyGroup, member: QueueRecord): MemberOutcome | null {
  if (!group.needsReview) return null
  const { agreed, conflict } = group.decision
  if (conflict) {
    const reasons: LegacyQueueReason[] = ['conflicting-resolutions']
    // The last agreed decision applies to every computer; without one, the unreviewed state.
    if (agreed)
      return { counting: !agreed.duplicates.includes(member.legacyId), status: 'conflict', reasons }
    return { counting: member.native, status: 'conflict', reasons }
  }
  if (agreed)
    return agreed.duplicates.includes(member.legacyId)
      ? { counting: false, status: 'duplicate', reasons: ['resolved-duplicate'] }
      : null
  // Native history keeps counting until an explicit agreed resolution says otherwise.
  if (member.native) return null
  return {
    counting: false,
    status: 'queued',
    reasons: [
      ...(group.candidates.length > 1 ? (['overlapping-legacy'] as const) : []),
      ...(group.activityOverlap ? (['overlapping-activity'] as const) : [])
    ]
  }
}

function groupDetail(group: LegacyGroup, outcome: MemberOutcome) {
  return {
    reasons: outcome.reasons,
    candidates: group.candidates,
    activityOverlap: group.activityOverlap,
    resolutions: group.heads.map((head) => head.entityId),
    lastAgreed: group.decision.lastAgreed
  }
}

type Suppression = { status: LegacyQueueStatus | 'deleted'; detail: Record<string, unknown> }

function writeSuppression(
  tx: Transaction,
  workspaceId: string,
  local: LocalLegacy,
  suppression: Suppression | null
): void {
  tx.delete(syncHistorySuppressions)
    .where(
      and(
        eq(syncHistorySuppressions.sessionId, local.sessionId),
        eq(syncHistorySuppressions.recordType, 'legacy-session')
      )
    )
    .run()
  if (suppression)
    tx.insert(syncHistorySuppressions)
      .values({
        sessionId: local.sessionId,
        workspaceId,
        recordType: 'legacy-session',
        recordId: local.legacyId,
        status: suppression.status,
        detailJson: JSON.stringify(suppression.detail)
      })
      .run()
}

function conversationOfLocal(local: LocalLegacy): Conversation | null {
  return local.snapshot.source === 'auto' && local.snapshot.claudeSessionId?.trim()
    ? { provider: local.snapshot.tool, conversationId: local.snapshot.claudeSessionId }
    : null
}

/**
 * Recomputes the non-counting state of legacy records: agreed deletions/retirements, split
 * children awaiting their parent, and the overlap queue. Scope: the given records (with their
 * split descendants and conversations), the given conversations, or everything.
 * Root: call refreshLegacyQueue after activity imports, since new ledger coverage can create
 * ambiguity.
 */
export function refreshLegacyState(
  tx: Transaction,
  workspaceId: string,
  scope: { legacyIds?: readonly string[]; conversations?: readonly Conversation[] } | 'all' = 'all'
): void {
  const ids = new Set<string>()
  const conversations = new Map<string, Conversation>()
  const addConversation = (value: Conversation | null) => {
    if (value)
      conversations.set(conversationKey(value.provider, value.conversationId), {
        provider: value.provider,
        conversationId: value.conversationId
      })
  }
  let locals: Map<string, LocalLegacy>
  if (scope === 'all') {
    locals = localLegacyIndex(tx)
    for (const change of storedFacts(tx, workspaceId, 'legacy-session')) ids.add(change.entityId)
    for (const local of locals.values()) ids.add(local.legacyId)
  } else {
    // Only the records, split descendants and conversations in scope are read.
    for (const id of scope.legacyIds ?? []) ids.add(id)
    for (const conversation of scope.conversations ?? []) addConversation(conversation)
    for (const id of splitDescendants(tx, workspaceId, ids)) ids.add(id)
    locals = localLegacyIndex(tx, { legacyIds: ids })
  }
  for (const id of ids) {
    const snapshot = readLegacySnapshot(tx, workspaceId, id)
    if (snapshot?.conversationId)
      addConversation({ provider: snapshot.provider, conversationId: snapshot.conversationId })
    else if (!snapshot) {
      const local = locals.get(id)
      if (local) addConversation(conversationOfLocal(local))
    }
  }
  const data = readConversationData(
    tx,
    workspaceId,
    scope === 'all' ? 'all' : [...conversations.values()],
    locals
  )
  const memo: LifecycleMemo = new Map()
  const outcomes = new Map<string, Suppression | null>()
  for (const { provider, conversationId } of conversations.values()) {
    const key = conversationKey(provider, conversationId)
    for (const change of data.facts.get(key) ?? []) {
      const snapshot = readSnapshot(change.payload)
      if (snapshot.provider === provider && snapshot.conversationId === conversationId)
        ids.add(change.entityId)
    }
    for (const local of data.localRows.get(key) ?? []) ids.add(local.legacyId)
    for (const group of groupsOf(tx, workspaceId, provider, conversationId, memo, locals, data))
      for (const member of group.members) {
        const outcome = memberOutcome(group, member)
        outcomes.set(
          member.legacyId,
          outcome && !outcome.counting
            ? { status: outcome.status, detail: groupDetail(group, outcome) }
            : null
        )
      }
  }
  for (const id of [...ids].sort()) {
    const local = locals.get(id)
    if (!local) continue
    const lifecycle = legacyLifecycle(tx, workspaceId, id, memo)
    let suppression: Suppression | null = null
    if (lifecycle.state === 'deleted' || lifecycle.state === 'retired')
      suppression = {
        status: 'deleted',
        detail: { lifecycle: lifecycle.state, disposition: lifecycle.disposition }
      }
    else if (lifecycle.state === 'pending-split')
      suppression = local.localSplitChild
        ? null
        : {
            status: 'queued',
            detail: {
              reasons: ['pending-split'],
              candidates: [id],
              activityOverlap: false,
              resolutions: [],
              lastAgreed: [],
              splitFrom: lifecycle.splitFrom
            }
          }
    else suppression = outcomes.get(id) ?? null
    // This computer's own deletion, split, replacement or adoption already decides its row.
    if (local.native && local.adopted) suppression = null
    writeSuppression(tx, workspaceId, local, suppression)
  }
}

/** Recomputes the queue for conversations (everything if omitted). */
export function refreshLegacyQueue(
  tx: Transaction,
  workspaceId: string,
  conversations?: ReadonlyArray<Conversation>
): void {
  refreshLegacyState(tx, workspaceId, conversations ? { conversations } : 'all')
}

/**
 * Visible queue: held, conflicting, pending-split and resolved-duplicate legacy rows (all
 * retained), plus rows that keep counting under a last agreed resolution during a conflict.
 */
export function readLegacyQueue(db: Reader, workspaceId: string): LegacyQueueEntry[] {
  const entries: LegacyQueueEntry[] = db
    .select()
    .from(syncHistorySuppressions)
    .where(
      and(
        eq(syncHistorySuppressions.workspaceId, workspaceId),
        eq(syncHistorySuppressions.recordType, 'legacy-session'),
        inArray(syncHistorySuppressions.status, ['queued', 'duplicate', 'conflict'])
      )
    )
    .all()
    .map((row) => {
      const detail = JSON.parse(row.detailJson) as Partial<LegacyQueueEntry>
      return {
        legacyId: row.recordId,
        sessionId: row.sessionId,
        status: row.status as LegacyQueueStatus,
        counting: false,
        reasons: detail.reasons ?? [],
        candidates: detail.candidates ?? [row.recordId],
        activityOverlap: detail.activityOverlap ?? false,
        resolutions: detail.resolutions ?? [],
        lastAgreed: detail.lastAgreed ?? [],
        ...(detail.splitFrom ? { splitFrom: detail.splitFrom } : {})
      }
    })
  const conversations = new Map<string, Conversation>()
  for (const change of storedFacts(db, workspaceId, 'legacy-reconciliation')) {
    const value = readReconciliation(change)
    conversations.set(conversationKey(value.provider, value.conversationId), value)
  }
  const memo: LifecycleMemo = new Map()
  const locals = new Map<string, LocalLegacy>()
  const data = readConversationData(db, workspaceId, [...conversations.values()], locals)
  for (const { provider, conversationId } of conversations.values())
    for (const group of groupsOf(db, workspaceId, provider, conversationId, memo, locals, data)) {
      if (!group.decision.conflict) continue
      for (const member of group.members) {
        const outcome = memberOutcome(group, member)
        if (!outcome?.counting || member.sessionId === null) continue
        entries.push({
          legacyId: member.legacyId,
          sessionId: member.sessionId,
          status: 'conflict',
          counting: true,
          ...groupDetail(group, outcome)
        })
      }
    }
  return entries.sort((a, b) => (a.legacyId < b.legacyId ? -1 : a.legacyId > b.legacyId ? 1 : 0))
}

// ── Import ──

type RefreshScope = { legacyIds: string[]; conversations: Conversation[] }

/**
 * Store hook body, called after the change is inserted into sync_changes. Never calls providers.
 * Returns the scope whose non-counting state must be refreshed afterwards.
 */
function applyLegacyChangeValues(
  tx: Transaction,
  workspaceId: string,
  change: SyncChange
): RefreshScope {
  validateLegacyChange(change)
  if (change.entityType === 'legacy-edit') {
    applyLegacyEditChange(tx, workspaceId, change)
    return { legacyIds: [change.entityId], conversations: [] }
  }
  if (change.id !== syncFactChangeId(workspaceId, change.entityType, change.entityId))
    malformed(`Legacy fact change ${change.id} is not derived from its fact`)
  if (change.entityType === 'legacy-session') {
    projectLegacySnapshot(tx, workspaceId, change.entityId, readSnapshot(change.payload))
    return { legacyIds: [change.entityId], conversations: [] }
  }
  const reconciliation = readReconciliation(change)
  if (
    canonicalJson(change.dependencies) !==
    canonicalJson(reconciliationDependencies(workspaceId, reconciliation))
  )
    malformed(`Legacy reconciliation ${change.entityId} has unexpected dependencies`)
  // The store has already confirmed every (deterministic) dependency ID is applied here.
  const { provider, conversationId } = reconciliation
  return { legacyIds: [], conversations: [{ provider, conversationId }] }
}

/** Routes legacy-session, legacy-reconciliation and legacy-edit. */
export const legacyRecordsAdapter: SyncDomainAdapter = {
  validate: validateLegacyChange,
  apply: (tx, workspaceId, change) =>
    refreshLegacyState(tx, workspaceId, applyLegacyChangeValues(tx, workspaceId, change))
}

/**
 * The adapter for journaling many local changes in one transaction: values are applied per
 * change, but non-counting state is refreshed once, for the union of their scopes, by `flush`
 * (before the transaction commits). Suppressions are a pure function of applied facts, local
 * rows and the ledger, and nothing applied in between reads them, so the result is the same.
 */
export function deferredLegacyAdapter(): {
  adapter: SyncDomainAdapter
  touch: (legacyId: string) => void
  flush: (tx: Transaction, workspaceId: string) => void
} {
  const legacyIds = new Set<string>()
  const conversations = new Map<string, Conversation>()
  return {
    adapter: {
      validate: validateLegacyChange,
      apply: (tx, workspaceId, change) => {
        const scope = applyLegacyChangeValues(tx, workspaceId, change)
        for (const id of scope.legacyIds) legacyIds.add(id)
        for (const item of scope.conversations)
          conversations.set(conversationKey(item.provider, item.conversationId), item)
      }
    },
    touch: (legacyId) => legacyIds.add(legacyId),
    flush: (tx, workspaceId) => {
      if (legacyIds.size || conversations.size)
        refreshLegacyState(tx, workspaceId, {
          legacyIds: [...legacyIds].sort(),
          conversations: [...conversations.values()]
        })
      legacyIds.clear()
      conversations.clear()
    }
  }
}

function isBaselineChange(change: SyncChange): boolean {
  const fields = change.payload.fields as unknown as
    | Record<string, { parents?: unknown[] }>
    | undefined
  const present = fields?.$present
  return (
    change.entityType === 'legacy-edit' &&
    Array.isArray(present?.parents) &&
    !present.parents.length
  )
}

export interface LegacyJournalOptions {
  /**
   * Conversations whose keep-all resolutions to plan: every conversation (the default), none,
   * or only these. A stepped bootstrap journals records with 'none' and then sweeps
   * conversations page by page once every record is journaled.
   */
  origin?: 'all' | 'none' | readonly Conversation[]
}

/**
 * Journals legacy facts and revisions in dependency order, marks this computer's baselines
 * (including one identical to an already imported clone baseline) and then journals keep-all
 * resolutions for overlap groups made only of this computer's own counted history. One
 * transaction; non-counting state is refreshed once for everything journaled.
 */
export function journalLegacySyncChanges<TSchema extends Record<string, unknown>>(
  db: Db<TSchema>,
  workspaceId: string,
  changes: readonly SyncChange[],
  options: LegacyJournalOptions = {}
): string[] {
  const origin = options.origin ?? 'all'
  return db.transaction((tx) => {
    const deferred = deferredLegacyAdapter()
    const ids = changes.length
      ? recordLocalSyncChanges(tx, workspaceId, [...changes], deferred.adapter)
      : []
    const baselines = [
      ...new Set(changes.filter(isBaselineChange).map((change) => change.entityId))
    ]
    for (const legacyId of baselines) {
      markLocalLegacyBaseline(tx, workspaceId, legacyId)
      deferred.touch(legacyId)
    }
    const planned =
      origin === 'none'
        ? []
        : planOriginLegacyReconciliations(tx, workspaceId, origin === 'all' ? undefined : origin)
    if (planned.length)
      ids.push(...recordLocalSyncChanges(tx, workspaceId, planned, deferred.adapter))
    deferred.flush(tx, workspaceId)
    return ids
  })
}

// ── Export ──

export type LegacyWithheldReason =
  | 'manual-entry'
  | 'unknown-provider'
  | 'invalid-snapshot'
  | 'timezone-naive'
  | 'reference-missing'
  /** The snapshot is exported, but its split cannot be until both children can. */
  | 'split-children-unavailable'

export interface LegacyExport {
  /** Facts, baselines and historical retirements; record with journalLegacySyncChanges. */
  changes: SyncChange[]
  withheld: Array<{ legacyId: string; reason: LegacyWithheldReason }>
  /** Saved values waiting for client/project records to be exported first. */
  metadataDrift: Array<{ legacyId: string; fields: string[] }>
  requires: Array<{ legacyId: string; requires: LegacyReference[] }>
}

export interface LegacyExportOptions {
  legacyIds?: readonly string[]
  /** Legacy IDs whose timezone-naive saved times the user explicitly confirmed as UTC. */
  naiveTimesAsUtc?: readonly string[]
}

function parentLegacyOf(db: Reader, sessionId: number): string | null {
  const first = db
    .select({ legacyRecordId: sessionSplits.legacyRecordId })
    .from(sessionSplits)
    .where(
      or(eq(sessionSplits.firstSessionId, sessionId), eq(sessionSplits.secondSessionId, sessionId))
    )
    .get()
  if (first?.legacyRecordId) return first.legacyRecordId
  // A restored parent can split again. Its immutable first split stays, and the new revision
  // retains the exact child IDs; no time or name matching participates in lineage.
  return (
    db
      .select({ id: sessionLegacyRecords.id })
      .from(sessionRevisions)
      .innerJoin(
        sessionLegacyRecords,
        eq(sessionLegacyRecords.sessionId, sessionRevisions.sessionId)
      )
      .where(
        and(
          eq(sessionRevisions.kind, 'split'),
          sql`(json_extract(${sessionRevisions.after}, '$.children[0].id') = ${sessionId} or json_extract(${sessionRevisions.after}, '$.children[1].id') = ${sessionId})`
        )
      )
      .get()?.id ?? null
  )
}

function snapshotPayload(
  db: Reader,
  local: LocalLegacy,
  assumeUtc: boolean
): JsonObject | LegacyWithheldReason {
  const { snapshot } = local
  if (snapshot.source !== 'auto') return 'manual-entry'
  if (!(LEGACY_PROVIDERS as readonly string[]).includes(snapshot.tool)) return 'unknown-provider'
  const startedAt = portableInstant(snapshot.startedAt, assumeUtc)
  const endedAt = portableInstant(snapshot.endedAt, assumeUtc)
  if (!startedAt || !endedAt)
    return isTimezoneNaive(snapshot.startedAt) || isTimezoneNaive(snapshot.endedAt)
      ? 'timezone-naive'
      : 'invalid-snapshot'
  const clientId = snapshot.clientId ?? null
  const projectId = snapshot.projectId ?? null
  // The built-in helper exports Unassigned under its reserved portable ID.
  const clientSyncId = clientId === null ? null : getPortableClientId(db, clientId)
  const projectSyncId = projectId === null ? null : getPortableProjectId(db, projectId)
  if ((clientId !== null && !clientSyncId) || (projectId !== null && !projectSyncId))
    return 'reference-missing'
  return {
    version: 1,
    snapshotVersion: local.version,
    provider: snapshot.tool,
    conversationId: snapshot.claudeSessionId?.trim() ? snapshot.claudeSessionId : null,
    startedAt,
    endedAt,
    durationMinutes: snapshot.durationMinutes,
    promptCount: snapshot.promptCount,
    inputTokens: snapshot.inputTokens,
    outputTokens: snapshot.outputTokens,
    modelUsage: [...local.modelUsage]
      .sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0))
      .map((usage) => ({
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens
      })),
    billable: !!snapshot.billable,
    description: snapshot.description?.trim() ? snapshot.description : null,
    clientSyncId,
    projectSyncId,
    splitFrom: parentLegacyOf(db, local.sessionId)
  }
}

function planSnapshotFact(
  db: Reader,
  workspaceId: string,
  local: LocalLegacy,
  assumeUtc: boolean
): { change: SyncChange | null } | { withheld: LegacyWithheldReason } {
  if (readLegacySnapshot(db, workspaceId, local.legacyId)) return { change: null }
  const payload = snapshotPayload(db, local, assumeUtc)
  if (typeof payload === 'string') return { withheld: payload }
  try {
    return { change: fact(workspaceId, 'legacy-session', local.legacyId, payload) }
  } catch (error) {
    if (!(error instanceof SyncError)) throw error
    return {
      withheld: error.code === 'SYNC_UPDATE_REQUIRED' ? 'unknown-provider' : 'invalid-snapshot'
    }
  }
}

/** Snapshot facts of native records not yet exported (for the root's split hook). */
export function planLegacySnapshotFacts(
  db: Reader,
  workspaceId: string,
  legacyIds: readonly string[],
  options: { naiveTimesAsUtc?: readonly string[] } = {}
): { changes: SyncChange[]; withheld: Array<{ legacyId: string; reason: LegacyWithheldReason }> } {
  requireWorkspace(workspaceId)
  const locals = localLegacyIndex(db, { legacyIds })
  const confirmed = new Set(options.naiveTimesAsUtc ?? [])
  const result: ReturnType<typeof planLegacySnapshotFacts> = { changes: [], withheld: [] }
  for (const legacyId of legacyIds) {
    const local = locals.get(legacyId)
    if (!local?.native) {
      if (!readLegacySnapshot(db, workspaceId, legacyId))
        result.withheld.push({ legacyId, reason: 'invalid-snapshot' })
      continue
    }
    const plan = planSnapshotFact(db, workspaceId, local, confirmed.has(legacyId))
    if ('withheld' in plan) result.withheld.push({ legacyId, reason: plan.withheld })
    else if (plan.change) result.changes.push(plan.change)
  }
  return result
}

function adoptionCoverageHash(db: Reader, sessionId: number): string | null {
  const mapping = db
    .select()
    .from(sessionActivityMappings)
    .where(eq(sessionActivityMappings.sessionId, sessionId))
    .get()
  if (!mapping) return null
  try {
    const interval = JSON.parse(mapping.intervalJson) as {
      coverage?: Parameters<typeof coverageHash>[2]
    }
    return interval.coverage
      ? coverageHash(mapping.provider, mapping.conversationId, interval.coverage)
      : null
  } catch {
    return null
  }
}

/** A deletion, split, replacement or adoption that already happened on this computer. */
function historicalRetirement(
  db: Reader,
  workspaceId: string,
  local: LocalLegacy,
  exported: (legacyId: string) => boolean
): { disposition: LegacyDisposition; dependencies: string[] } | null | LegacyWithheldReason {
  const { sessionId } = local
  if (
    db
      .select({ id: sessionDeletions.id })
      .from(sessionDeletions)
      .where(eq(sessionDeletions.sessionId, sessionId))
      .get()
  )
    return { disposition: { kind: 'deleted' }, dependencies: [] }
  const split = db
    .select()
    .from(sessionSplits)
    .where(eq(sessionSplits.parentSessionId, sessionId))
    .get()
  if (split) {
    const children = [split.firstSessionId, split.secondSessionId].map(
      (child) =>
        db
          .select({ id: sessionLegacyRecords.id })
          .from(sessionLegacyRecords)
          .where(eq(sessionLegacyRecords.sessionId, child))
          .get()?.id
    )
    const splitAt = portableInstant(split.splitAt)
    if (!splitAt) return 'timezone-naive'
    if (children.some((child) => !child || !exported(child))) return 'split-children-unavailable'
    const ids = children as string[]
    return {
      disposition: { kind: 'split', splitAt, children: ids },
      dependencies: ids.map((id) => syncFactChangeId(workspaceId, 'legacy-session', id))
    }
  }
  if (
    db
      .select({ id: sessionReplacements.revisionId })
      .from(sessionReplacements)
      .where(eq(sessionReplacements.predecessorSessionId, sessionId))
      .get()
  )
    return { disposition: { kind: 'replaced' }, dependencies: [] }
  if (local.adopted)
    return {
      disposition: { kind: 'adopted', coverageHash: adoptionCoverageHash(db, sessionId) },
      dependencies: []
    }
  return null
}

/**
 * Bootstrap: every native legacy record as an immutable snapshot fact plus a content-derived
 * baseline of its current values and, when it was already deleted, split, replaced or adopted
 * here, a content-derived retirement. Split children are exported with their parent. Manual
 * entries (exported by folder-sync-manual-records), unknown providers, ambiguous times and
 * missing references are withheld with a reason. Record with journalLegacySyncChanges after
 * exporting directory records.
 */
export function collectLegacySyncChanges(
  db: Reader,
  workspaceId: string,
  options: LegacyExportOptions = {}
): LegacyExport {
  requireWorkspace(workspaceId)
  const scope = options.legacyIds ? new Set(options.legacyIds) : null
  const confirmed = new Set(options.naiveTimesAsUtc ?? [])
  const result: LegacyExport = { changes: [], withheld: [], metadataDrift: [], requires: [] }
  // Scoped: only the records in scope are read, plus split children on demand.
  const index = localLegacyIndex(db, scope ? { legacyIds: scope } : undefined)
  const locals = [...index.values()].filter((local) => local.native)
  const localsByFact = new Map(
    locals.map((local) => [syncFactChangeId(workspaceId, 'legacy-session', local.legacyId), local])
  )
  const exported = new Map<string, boolean>()
  const evaluate = (local: LocalLegacy) => {
    const assumeUtc = confirmed.has(local.legacyId)
    const plan = planSnapshotFact(db, workspaceId, local, assumeUtc)
    if ('withheld' in plan) {
      exported.set(local.legacyId, false)
      return { plan }
    }
    const current = portableLegacyValues(db, local.row, { assumeUtc })
    exported.set(local.legacyId, !('withheld' in current) || !plan.change)
    return { plan, current }
  }
  /** Whether a native record's snapshot is shared or exported now (non-native: never). */
  const isExported = (legacyId: string): boolean => {
    const known = exported.get(legacyId)
    if (known !== undefined) return known
    const local = localLegacyIndex(db, { legacyIds: [legacyId] }).get(legacyId)
    if (!local?.native) {
      exported.set(legacyId, false)
      return false
    }
    localsByFact.set(syncFactChangeId(workspaceId, 'legacy-session', legacyId), local)
    evaluate(local)
    return exported.get(legacyId)!
  }
  const ready: Array<{ local: LocalLegacy; values: Parameters<typeof planLegacyEditBaseline>[3] }> =
    []
  const edits: SyncChange[] = []
  for (const local of locals) {
    const evaluated = evaluate(local)
    const { plan } = evaluated
    if ('withheld' in plan) {
      if (!scope || scope.has(local.legacyId))
        result.withheld.push({ legacyId: local.legacyId, reason: plan.withheld })
      continue
    }
    const current = evaluated.current!
    if ('withheld' in current) {
      if (!scope || scope.has(local.legacyId))
        result.withheld.push({ legacyId: local.legacyId, reason: current.withheld })
      continue
    }
    if (scope && !scope.has(local.legacyId)) continue
    if (plan.change) result.changes.push(plan.change)
    ready.push({ local, values: current.values })
  }
  for (const { local, values } of ready) {
    const retire = historicalRetirement(db, workspaceId, local, isExported)
    if (typeof retire === 'string')
      result.withheld.push({ legacyId: local.legacyId, reason: retire })
    const plan = planLegacyEditBaseline(
      db,
      workspaceId,
      local.legacyId,
      values,
      typeof retire === 'string' ? null : retire
    )
    if (plan.status === 'ready') edits.push(...(plan.changes as unknown as SyncChange[]))
    else if (plan.status === 'requires') {
      result.requires.push({ legacyId: local.legacyId, requires: plan.requires })
      result.metadataDrift.push({
        legacyId: local.legacyId,
        fields: plan.requires.map((item) =>
          item.entityType === 'client' ? 'clientSyncId' : 'projectSyncId'
        )
      })
    }
  }
  // A split needs its children's snapshots even when only the parent is in scope.
  const planned = new Set(result.changes.map((change) => change.id))
  for (const edit of edits)
    for (const dependency of edit.dependencies)
      if (!planned.has(dependency)) {
        const child = localsByFact.get(dependency)
        const plan =
          child && planSnapshotFact(db, workspaceId, child, confirmed.has(child.legacyId))
        if (plan && 'change' in plan && plan.change) {
          result.changes.push(plan.change)
          planned.add(dependency)
        }
      }
  result.changes.push(...edits)
  return result
}

/**
 * Keep-all resolutions for overlap groups consisting only of this computer's exported, counted
 * native rows, so blank receivers count exactly what this computer counts. Content-derived, so
 * clones produce the same fact. Groups already reviewed (any head) are left alone. `scope`
 * limits this to those conversations (only their rows are read).
 */
export function planOriginLegacyReconciliations(
  db: Reader,
  workspaceId: string,
  scope?: readonly Conversation[]
): SyncChange[] {
  requireWorkspace(workspaceId)
  const wanted =
    scope && new Set(scope.map((item) => conversationKey(item.provider, item.conversationId)))
  const locals = scope
    ? localLegacyIndex(db, { conversationIds: scope.map((item) => item.conversationId) })
    : localLegacyIndex(db)
  const conversations = new Map<string, Conversation>()
  for (const local of locals.values()) {
    const conversation = countingNative(local) ? conversationOfLocal(local) : null
    if (!conversation) continue
    const key = conversationKey(conversation.provider, conversation.conversationId)
    if (!wanted || wanted.has(key)) conversations.set(key, conversation)
  }
  const data = readConversationData(
    db,
    workspaceId,
    wanted ? [...conversations.values()] : 'all',
    locals
  )
  const memo: LifecycleMemo = new Map()
  const changes: SyncChange[] = []
  for (const { provider, conversationId } of conversations.values()) {
    if (!(LEGACY_PROVIDERS as readonly string[]).includes(provider)) continue
    for (const group of groupsOf(db, workspaceId, provider, conversationId, memo, locals, data)) {
      if (!group.needsReview || group.heads.length) continue
      if (!group.members.every((member) => member.native)) continue
      if (group.candidates.some((id) => !readLegacySnapshot(db, workspaceId, id))) continue
      const payload: JsonObject = {
        version: 1,
        provider,
        conversationId,
        candidates: group.candidates,
        activityOverlap: group.activityOverlap,
        keep: group.candidates,
        duplicates: [],
        supersedes: []
      }
      changes.push(
        fact(
          workspaceId,
          'legacy-reconciliation',
          legacyReconciliationEntityId(payload),
          payload,
          reconciliationDependencies(workspaceId, payload as unknown as LegacyReconciliation)
        )
      )
    }
  }
  return changes.sort((a, b) => (a.entityId < b.entityId ? -1 : 1))
}

/** This computer's own (native) legacy rows, grouped by saved snapshot conversation. */
function nativeLegacyGroups(
  db: Reader
): Array<{ conversation: Conversation | null; ids: string[] }> {
  const groups = new Map<string, { conversation: Conversation | null; ids: string[] }>()
  for (const row of db
    .select({
      id: sessionLegacyRecords.id,
      source: sql<unknown>`json_extract(${sessionLegacyRecords.session}, '$.source')`,
      tool: sql<unknown>`json_extract(${sessionLegacyRecords.session}, '$.tool')`,
      conversationId: snapshotConversationId
    })
    .from(sessionLegacyRecords)
    .leftJoin(syncLegacyImports, eq(syncLegacyImports.legacyId, sessionLegacyRecords.id))
    .where(isNull(syncLegacyImports.legacyId))
    .orderBy(sessionLegacyRecords.id)
    .all()) {
    const conversation =
      row.source === 'auto' &&
      typeof row.tool === 'string' &&
      typeof row.conversationId === 'string' &&
      row.conversationId.trim()
        ? { provider: row.tool, conversationId: row.conversationId }
        : null
    const key = conversation
      ? conversationKey(conversation.provider, conversation.conversationId)
      : `record:${row.id}`
    const group = groups.get(key)
    if (group) group.ids.push(row.id)
    else groups.set(key, { conversation, ids: [row.id] })
  }
  return [...groups.values()]
}

/**
 * Native legacy IDs for a stepped bootstrap, in batches of whole conversations of about
 * `size` records (a larger conversation is a batch of its own). Export each batch with
 * collectLegacySyncChanges({ legacyIds }) and journalLegacySyncChanges(..., { origin: 'none' }),
 * then sweep planLegacyOriginPages.
 */
export function planLegacyExportBatches(db: Reader, size = 200): string[][] {
  const batches: string[][] = []
  let batch: string[] = []
  for (const { ids } of nativeLegacyGroups(db)) {
    if (batch.length && batch.length + ids.length > size) {
      batches.push(batch)
      batch = []
    }
    batch.push(...ids)
  }
  if (batch.length) batches.push(batch)
  return batches
}

/** Conversations of native legacy rows in pages, for journalLegacySyncChanges' origin option. */
export function planLegacyOriginPages(db: Reader, size = 200): Conversation[][] {
  const conversations = nativeLegacyGroups(db).flatMap(({ conversation }) =>
    conversation ? [conversation] : []
  )
  const pages: Conversation[][] = []
  for (let at = 0; at < conversations.length; at += size)
    pages.push(conversations.slice(at, at + size))
  return pages
}

/** Clone-stable: a copied database retains the same row under the same legacy UUID. */
function retainForSync(tx: Pick<Transaction, 'select' | 'insert'>, row: Session): string {
  const existing = tx
    .select({ id: sessionLegacyRecords.id })
    .from(sessionLegacyRecords)
    .where(eq(sessionLegacyRecords.sessionId, row.id))
    .get()
  if (existing) return existing.id
  let id = v8({
    purpose: 'clautime-legacy-retain-1',
    sessionId: row.id,
    createdAt: row.createdAt,
    tool: row.tool,
    conversationId: row.claudeSessionId,
    startedAt: row.startedAt,
    endedAt: row.endedAt
  })
  if (
    tx
      .select({ id: sessionLegacyRecords.id })
      .from(sessionLegacyRecords)
      .where(eq(sessionLegacyRecords.id, id))
      .get()
  )
    id = randomUUID()
  const modelUsage = tx
    .select({
      model: sessionModelUsage.model,
      inputTokens: sessionModelUsage.inputTokens,
      outputTokens: sessionModelUsage.outputTokens,
      cacheCreationInputTokens: sessionModelUsage.cacheCreationInputTokens,
      cacheReadInputTokens: sessionModelUsage.cacheReadInputTokens
    })
    .from(sessionModelUsage)
    .where(eq(sessionModelUsage.sessionId, row.id))
    .orderBy(sessionModelUsage.model)
    .all()
  tx.insert(sessionLegacyRecords)
    .values({
      id,
      sessionId: row.id,
      version: 1,
      session: row,
      modelUsage,
      createdAt: new Date().toISOString()
    })
    .run()
  return id
}

/**
 * Explicitly selected, retained automatic rows gain a legacy snapshot UUID so they can be
 * exported. By default only source-less rows without derivations qualify; `sourceFileGone` lists
 * rows whose source log the caller has proved is gone: their saved row, including measured
 * (derived) times, local time edits and model totals, is kept as is (the file name stays local
 * metadata) and no activity is invented. Adopted or suppressed rows are always skipped. The UUID
 * is derived from the local row, so clones retain identical IDs.
 */
export function retainSourceLessSessionsForSync<TSchema extends Record<string, unknown>>(
  db: Db<TSchema>,
  sessionIds: readonly number[],
  options: { sourceFileGone?: readonly number[] } = {}
): { retained: Array<{ sessionId: number; legacyId: string }>; skipped: number[] } {
  const gone = new Set(options.sourceFileGone ?? [])
  return db.transaction((tx) => {
    const retained: Array<{ sessionId: number; legacyId: string }> = []
    const skipped: number[] = []
    for (const sessionId of [...new Set(sessionIds)].sort((a, b) => a - b)) {
      const found = tx
        .select({
          row: sessions,
          derived: sql<number>`EXISTS (SELECT 1 FROM ${sessionDerivations} WHERE ${sessionDerivations.sessionId} = ${sessions.id})`
        })
        .from(sessions)
        .where(
          and(
            eq(sessions.id, sessionId),
            eq(sessions.source, 'auto'),
            eq(sessions.status, 'completed'),
            activeSessionCondition,
            sql`NOT EXISTS (SELECT 1 FROM ${sessionActivityMappings} WHERE ${sessionActivityMappings.sessionId} = ${sessions.id})`
          )
        )
        .get()
      const eligible = found && (found.row.sourceFile ? gone.has(sessionId) : !found.derived)
      if (!found || !eligible) skipped.push(sessionId)
      else retained.push({ sessionId, legacyId: retainForSync(tx, found.row) })
    }
    return { retained, skipped }
  })
}

/**
 * Unmapped, active, completed automatic rows that have no legacy snapshot yet: the only rows
 * retainSourceLessSessionsForSync could still change. One query, so a bootstrap does not visit
 * every saved row. `sourceFile` is local metadata for the caller's missing-file proof only.
 */
export function legacyRetentionCandidates(
  db: Reader
): Array<{ sessionId: number; sourceFile: string | null }> {
  return db
    .select({ sessionId: sessions.id, sourceFile: sessions.sourceFile })
    .from(sessions)
    .where(
      and(
        eq(sessions.source, 'auto'),
        eq(sessions.status, 'completed'),
        activeSessionCondition,
        sql`NOT EXISTS (SELECT 1 FROM ${sessionActivityMappings} WHERE ${sessionActivityMappings.sessionId} = ${sessions.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${sessionLegacyRecords} WHERE ${sessionLegacyRecords.sessionId} = ${sessions.id})`
      )
    )
    .orderBy(sessions.id)
    .all()
}

export interface LegacyReconciliationRequest {
  provider: string
  conversationId: string
  /** The group exactly as the user reviewed it. */
  candidates: readonly string[]
  keep: readonly string[]
  duplicates: readonly string[]
}

/**
 * Plans an explicit resolution of the group as currently computed. A changed group (new
 * candidates or new ledger overlap) is stale; unexported candidates must be exported first.
 * Current resolution heads of the group are superseded, so replays, later reviews and the
 * resolution of a conflict converge.
 */
export function planLegacyReconciliation(
  db: Reader,
  workspaceId: string,
  request: LegacyReconciliationRequest
): SyncChange {
  requireWorkspace(workspaceId)
  const candidates = [...new Set(request.candidates)].sort()
  const group = readLegacyGroups(db, workspaceId, request.provider, request.conversationId).find(
    (item) => item.candidates.includes(candidates[0])
  )
  if (!group || canonicalJson(group.candidates) !== canonicalJson(candidates))
    throw new AppError('SYNC_STALE_REVIEW', 'This legacy group has changed; review it again')
  if (!group.needsReview) throw new AppError('SYNC_NOTHING_TO_RESOLVE', 'Nothing to reconcile')
  const missing = candidates.filter((id) => !readLegacySnapshot(db, workspaceId, id))
  if (missing.length)
    throw new AppError(
      'SYNC_REFERENCE_UNAVAILABLE',
      `Export legacy history ${missing.join(', ')} before reconciling it`
    )
  const payload: JsonObject = {
    version: 1,
    provider: request.provider,
    conversationId: request.conversationId,
    candidates,
    activityOverlap: group.activityOverlap,
    keep: [...new Set(request.keep)].sort(),
    duplicates: [...new Set(request.duplicates)].sort(),
    supersedes: group.heads.map((head) => head.entityId).sort()
  }
  const entityId = legacyReconciliationEntityId(payload)
  return fact(
    workspaceId,
    'legacy-reconciliation',
    entityId,
    payload,
    reconciliationDependencies(workspaceId, payload as unknown as LegacyReconciliation)
  )
}

/** For the Sessions UI: shared lifecycle, edit state and conflicts of one legacy record. */
export function readLegacyRecordState(db: Reader, workspaceId: string, legacyId: string) {
  return {
    lifecycle: legacyLifecycle(db, workspaceId, legacyId),
    edit: readLegacyEditState(db, workspaceId, legacyId)
  }
}
