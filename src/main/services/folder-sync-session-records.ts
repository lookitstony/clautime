import { createHash } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { syncChanges, syncRecordStates } from '../db/schema/folder-sync'
import { AppError } from '../../shared/types/ipc'
import {
  canonicalJson,
  isSyncUuid,
  SyncError,
  SYNC_LIMITS,
  type SyncChange
} from './folder-sync-protocol'
import { recordLocalSyncChanges, type SyncDomainAdapter } from './folder-sync-store'
import { syncFactChangeId } from './folder-sync-activity-records'
import { getDirectoryRecordView } from './folder-sync-directory-records'
import { portableIdOfLocalClient, UNASSIGNED_CLIENT_SYNC_ID } from './folder-sync-builtin-client'
import {
  PRESENT,
  RevisionError,
  checkRevision,
  materializeRecord,
  planRevision,
  readRevisionChange,
  type JsonValue,
  type ParsedRevision,
  type RecordSchema,
  type RecordView,
  type RevisionAction,
  type RevisionChange
} from './folder-sync-revisions'
import {
  PORTABLE_SESSION_FIELDS,
  attachedSessionRecords,
  defaultSessionAnchor,
  resolvePortableSessionFields,
  sessionCopiedFrom,
  sessionCopiesOf,
  sessionCopySources,
  sessionRecordHeads,
  unobservedCopySourceRevisions,
  type PortableHeldReason,
  type PortableSessionField,
  type PortableSessionFragment
} from './folder-sync-session-overlay'

/*
 * Portable session assignment and edits (folder-sync-plan.md decisions B, D and E).
 *
 * session-mapping: the conversation's default assignment, entity ID canonicalJson([provider,
 * conversationId]), fields clientSyncId/projectSyncId (nullable syncIds, written together).
 *
 * session-edit: per-fragment overrides anchored to a canonical event or an explicit cut. The
 * entity ID is a version-8 UUID over (target, anchor); both are create-only fields that every root
 * revision writes and that must hash to the entity ID. Fields left unwritten inherit (see the
 * overlay), so a baseline never invents per-fragment overrides. `$present` is the same causal
 * lifecycle as every revisioned record: deleting an edit reverts to inherited values, and a
 * concurrent edit/delete is a visible conflict.
 *
 * Only these allowlisted fields leave the computer. Local session/mapping/decision IDs never do.
 * Importing writes only sync_record_states; the root projects sessions from the resolved overlay.
 */

type Transaction = Parameters<SyncDomainAdapter['apply']>[0]
type Reader = Pick<Transaction, 'select'>
type Values = Record<string, JsonValue>

export const SESSION_RECORD_ENTITY_TYPES = ['session-mapping', 'session-edit'] as const
export type SessionRecordEntityType = (typeof SESSION_RECORD_ENTITY_TYPES)[number]
export const SESSION_PROVIDERS = ['claude', 'codex', 'gemini', 'opencode'] as const

export interface PortableSessionTarget {
  provider: string
  conversationId: string
}

export type PortableSessionAnchor =
  | { kind: 'event'; eventId: string }
  /** Normalized UTC split instant; attaches to the fragment starting there. */
  | { kind: 'cut'; splitAt: string }

export interface PortableTimeOverride {
  startedAt?: string
  endedAt?: string
  durationMinutes?: number
  /**
   * portableCoverageHash of the fragment the override was made on; a measured change holds it,
   * another observation of the same measurement does not.
   */
  baseCoverageHash: string
}

export interface PortableCopySource {
  /** The primary source session-edit. */
  entityId: string
  /** Every head of every source record observed when copying (sorted); all are dependencies. */
  heads: string[]
}

export interface PortableSessionValues {
  clientSyncId: string | null
  projectSyncId: string | null
  description: string | null
  billable: boolean
  time: PortableTimeOverride | null
}

/** A materialized record plus its applied history (the overlay needs ancestry). */
export interface PortableSessionRecord {
  entityId: string
  view: RecordView
  history: unknown[]
}

export interface PortableConversationRecords {
  target: PortableSessionTarget
  mapping: PortableSessionRecord | null
  edits: PortableSessionRecord[]
}

/** Persisted in sync_record_states.state_json; rebuildable from sync_changes. */
export interface SessionRecordState {
  view: RecordView
  target: PortableSessionTarget
  anchor?: PortableSessionAnchor
}

export interface SessionReference {
  entityType: 'client' | 'project' | 'activity-identity'
  entityId: string
}

const ANCHOR_KINDS = ['event', 'cut']
const TIME_KEYS = ['startedAt', 'endedAt', 'durationMinutes', 'baseCoverageHash']
const MAX_CONVERSATION_ID = 400
const MAX_DESCRIPTION = 4000
const MAX_DURATION_MINUTES = 100_000
const MAX_COPIED_HEADS = 512
const EVENT_ID = /^([a-z][a-z0-9-]*):v(\d+):([a-z][a-z0-9-]*):[0-9a-f]{64}$/
const VOCABULARY = /^[a-z][a-z0-9-]*$/
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const HASH = /^[0-9a-f]{64}$/
// Stands in for the derived baseline ID while the change body is planned.
const PLACEHOLDER_ID = '00000000-0000-8000-8000-000000000000'
const REFERENCES = [
  ['clientSyncId', 'client'],
  ['projectSyncId', 'project']
] as const

function malformed(message: string): never {
  throw new SyncError('SYNC_MALFORMED', message)
}

function updateRequired(feature: string): never {
  throw new SyncError(
    'SYNC_UPDATE_REQUIRED',
    `Shared history uses ${feature}; update ClauTime to continue syncing`
  )
}

function invalid(message: string): never {
  throw new AppError('SYNC_INVALID_SESSION_CHANGE', message)
}

/** Planning errors surface as one domain code; unrelated errors pass through. */
function invalidPlan(error: unknown): never {
  if (error instanceof RevisionError || error instanceof SyncError) invalid(error.message)
  throw error
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOnlyKeys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  const keys = Object.keys(value)
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  )
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

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    TIMESTAMP.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  )
}

function isProvider(value: unknown): boolean {
  return (SESSION_PROVIDERS as readonly unknown[]).includes(value)
}

/** A recognizable provider this build does not know pauses sync instead of reading as damage. */
function supportedProvider(value: unknown): void {
  if (typeof value === 'string' && VOCABULARY.test(value) && !isProvider(value))
    updateRequired(`session provider "${value}"`)
}

function supportedEvent(value: unknown): void {
  const match = typeof value === 'string' ? EVENT_ID.exec(value) : null
  if (!match) return
  supportedProvider(match[1])
  if (match[2] !== '1' && /^[1-9]\d*$/.test(match[2]))
    updateRequired(`activity identity version ${match[2]}`)
}

function eventProvider(eventId: string): string | undefined {
  const match = EVENT_ID.exec(eventId)
  return match && match[2] === '1' && isProvider(match[1]) ? match[1] : undefined
}

function isTarget(value: unknown): value is PortableSessionTarget {
  return (
    isPlainObject(value) &&
    hasOnlyKeys(value, ['provider', 'conversationId']) &&
    isProvider(value.provider) &&
    isText(value.conversationId, MAX_CONVERSATION_ID, false) &&
    sessionMappingEntityId(value as unknown as PortableSessionTarget).length <=
      SYNC_LIMITS.maxEntityIdLength
  )
}

function isAnchor(value: unknown): value is PortableSessionAnchor {
  if (!isPlainObject(value)) return false
  if (value.kind === 'event')
    return (
      hasOnlyKeys(value, ['kind', 'eventId']) &&
      typeof value.eventId === 'string' &&
      eventProvider(value.eventId) !== undefined
    )
  return (
    value.kind === 'cut' && hasOnlyKeys(value, ['kind', 'splitAt']) && isTimestamp(value.splitAt)
  )
}

function isTime(value: unknown): boolean {
  if (value === null) return true
  if (!isPlainObject(value) || !hasOnlyKeys(value, ['baseCoverageHash'], TIME_KEYS)) return false
  const { startedAt, endedAt, durationMinutes, baseCoverageHash } = value
  if (typeof baseCoverageHash !== 'string' || !HASH.test(baseCoverageHash)) return false
  if (startedAt === undefined && endedAt === undefined && durationMinutes === undefined)
    return false
  if (startedAt !== undefined && !isTimestamp(startedAt)) return false
  if (endedAt !== undefined && !isTimestamp(endedAt)) return false
  if (typeof startedAt === 'string' && typeof endedAt === 'string' && startedAt >= endedAt)
    return false
  return (
    durationMinutes === undefined ||
    (Number.isSafeInteger(durationMinutes) &&
      (durationMinutes as number) >= 0 &&
      (durationMinutes as number) <= MAX_DURATION_MINUTES)
  )
}

function isCopySource(value: unknown): boolean {
  if (value === null) return true
  if (!isPlainObject(value) || !hasOnlyKeys(value, ['entityId', 'heads'])) return false
  const { entityId, heads } = value
  return (
    isSyncUuid(entityId) &&
    Array.isArray(heads) &&
    heads.length > 0 &&
    heads.length <= MAX_COPIED_HEADS &&
    heads.every(isSyncUuid) &&
    heads.every((head, index) => index === 0 || heads[index - 1] < head)
  )
}

const isNullableSyncId = (value: JsonValue): boolean => value === null || isSyncUuid(value)

function validator(
  checks: Record<string, (value: JsonValue) => boolean>
): RecordSchema['validate'] {
  return (field, value) => Object.hasOwn(checks, field) && checks[field](value)
}

export const SESSION_MAPPING_SCHEMA: RecordSchema = Object.freeze({
  entityType: 'session-mapping',
  fields: Object.freeze(['clientSyncId', 'projectSyncId']),
  validate: validator({ clientSyncId: isNullableSyncId, projectSyncId: isNullableSyncId })
})

/** No defaults: an unwritten field inherits, so creation never invents an override. */
export const SESSION_EDIT_SCHEMA: RecordSchema = Object.freeze({
  entityType: 'session-edit',
  fields: Object.freeze([
    'target',
    'anchor',
    'clientSyncId',
    'projectSyncId',
    'description',
    'billable',
    'time',
    'copiedFrom'
  ]),
  validate: validator({
    target: isTarget,
    anchor: isAnchor,
    clientSyncId: isNullableSyncId,
    projectSyncId: isNullableSyncId,
    description: (value) => value === null || isText(value, MAX_DESCRIPTION, true),
    billable: (value) => typeof value === 'boolean',
    time: isTime,
    copiedFrom: isCopySource
  })
})

export function isSessionRecordEntityType(value: unknown): value is SessionRecordEntityType {
  return (SESSION_RECORD_ENTITY_TYPES as readonly unknown[]).includes(value)
}

export function sessionRecordSchema(entityType: unknown): RecordSchema {
  if (entityType === 'session-mapping') return SESSION_MAPPING_SCHEMA
  if (entityType === 'session-edit') return SESSION_EDIT_SCHEMA
  return malformed(`${String(entityType)} is not a session record`)
}

function normalTarget(target: PortableSessionTarget): PortableSessionTarget {
  return { provider: target.provider, conversationId: target.conversationId }
}

function normalAnchor(anchor: PortableSessionAnchor): PortableSessionAnchor {
  return anchor.kind === 'event'
    ? { kind: 'event', eventId: anchor.eventId }
    : { kind: 'cut', splitAt: anchor.splitAt }
}

/** RFC 9562 version-8 UUID over sha256 of canonical JSON. */
function v8(value: unknown): string {
  const bytes = createHash('sha256').update(canonicalJson(value)).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x80
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function sessionMappingEntityId(target: PortableSessionTarget): string {
  return canonicalJson([target.provider, target.conversationId])
}

/** Deterministic, so every computer names the same anchored record identically. */
export function sessionEditEntityId(
  target: PortableSessionTarget,
  anchor: PortableSessionAnchor
): string {
  return v8(['clautime-session-edit', 1, normalTarget(target), normalAnchor(anchor)])
}

export function readSessionMappingTarget(entityId: string): PortableSessionTarget {
  let parsed: unknown
  try {
    parsed = JSON.parse(entityId)
  } catch {
    return malformed('Session mapping entity ID is not a conversation key')
  }
  if (!Array.isArray(parsed) || parsed.length !== 2)
    malformed('Session mapping entity ID is not a conversation key')
  supportedProvider(parsed[0])
  const target = { provider: parsed[0], conversationId: parsed[1] }
  if (!isTarget(target) || sessionMappingEntityId(target) !== entityId)
    malformed('Session mapping entity ID is not a canonical conversation key')
  return target
}

/** Checked before the strict shape, so a newer vocabulary pauses sync. */
function supportedFormats(change: unknown): void {
  if (!isPlainObject(change)) return
  if (change.entityType === 'session-mapping' && typeof change.entityId === 'string') {
    let parsed: unknown
    try {
      parsed = JSON.parse(change.entityId)
    } catch {
      parsed = undefined
    }
    if (Array.isArray(parsed)) supportedProvider(parsed[0])
  }
  const payload = change.payload
  const fields = isPlainObject(payload) && isPlainObject(payload.fields) ? payload.fields : {}
  const valueOf = (field: string): unknown => {
    const write = Object.hasOwn(fields, field) ? fields[field] : undefined
    return isPlainObject(write) ? write.value : undefined
  }
  const target = valueOf('target')
  if (isPlainObject(target)) supportedProvider(target.provider)
  const anchor = valueOf('anchor')
  if (isPlainObject(anchor)) {
    if (
      typeof anchor.kind === 'string' &&
      VOCABULARY.test(anchor.kind) &&
      !ANCHOR_KINDS.includes(anchor.kind)
    )
      updateRequired(`session edit anchor "${anchor.kind}"`)
    if (anchor.kind === 'event') supportedEvent(anchor.eventId)
  }
}

/** Structural and domain check without database access. Facts are never accepted. */
export function validateSessionRecordChange(change: unknown): ParsedRevision {
  const entityType = (change as { entityType?: unknown } | null)?.entityType
  const schema = sessionRecordSchema(entityType)
  supportedFormats(change)
  let revision: ParsedRevision
  try {
    revision = readRevisionChange(change, schema)
  } catch (error) {
    if (error instanceof RevisionError) malformed(error.message)
    throw error
  }
  const { id, fields } = revision
  const present = fields.get(PRESENT)!
  const root = present.parents.length === 0
  if (root && present.value !== true) malformed(`${id} must create ${revision.entityId}`)
  if (fields.has('clientSyncId') !== fields.has('projectSyncId'))
    malformed(`${id} must write clientSyncId and projectSyncId together`)

  if (entityType === 'session-mapping') {
    readSessionMappingTarget(revision.entityId)
    if (root && !fields.has('clientSyncId')) malformed(`${id} creates a mapping without assignment`)
  } else {
    if (!isSyncUuid(revision.entityId)) malformed(`${id} must name a session-edit UUID`)
    if (fields.has('target') !== root || fields.has('anchor') !== root)
      malformed(`${id}: only creation writes target and anchor`)
    if (root) {
      const target = fields.get('target')!.value as unknown as PortableSessionTarget
      const anchor = fields.get('anchor')!.value as unknown as PortableSessionAnchor
      if (sessionEditEntityId(target, anchor) !== revision.entityId)
        malformed(`${id}: target and anchor do not match ${revision.entityId}`)
      if (anchor.kind === 'event' && eventProvider(anchor.eventId) !== target.provider)
        malformed(`${id}: anchor event belongs to another provider`)
    }
    const copied = fields.get('copiedFrom')?.value as unknown as
      | PortableCopySource
      | null
      | undefined
    if (copied) {
      if (copied.entityId === revision.entityId) malformed(`${id} cannot copy from itself`)
      if (!copied.heads.every((head) => revision.dependencies.includes(head)))
        malformed(`${id} must depend on every copied head`)
    }
  }
  // Directory references need a dependency beyond field parents (checked against applied
  // changes on apply).
  const parents = new Set([...fields.values()].flatMap((field) => field.parents))
  for (const [field] of REFERENCES)
    if (
      typeof fields.get(field)?.value === 'string' &&
      revision.dependencies.every((dependency) => parents.has(dependency))
    )
      malformed(`${id} must depend on the ${field} record it assigns`)
  return revision
}

// ── Reading applied history ──

function appliedChange(db: Reader, workspaceId: string, id: string): unknown {
  const row = db
    .select({ json: syncChanges.changeJson })
    .from(syncChanges)
    .where(and(eq(syncChanges.workspaceId, workspaceId), eq(syncChanges.id, id)))
    .get()
  return row ? JSON.parse(row.json) : undefined
}

function historyOf(
  db: Reader,
  workspaceId: string,
  entityType: SessionRecordEntityType,
  entityId: string
): unknown[] {
  return db
    .select({ json: syncChanges.changeJson })
    .from(syncChanges)
    .where(
      and(
        eq(syncChanges.workspaceId, workspaceId),
        eq(syncChanges.entityType, entityType),
        eq(syncChanges.entityId, entityId)
      )
    )
    .all()
    .map((row) => JSON.parse(row.json))
}

function readRecord(
  db: Reader,
  workspaceId: string,
  entityType: SessionRecordEntityType,
  entityId: string
): PortableSessionRecord {
  const history = historyOf(db, workspaceId, entityType, entityId)
  return {
    entityId,
    view: materializeRecord(sessionRecordSchema(entityType), entityId, history),
    history
  }
}

/** The authoritative causal view (lifecycle 'missing' without history). */
export function getSessionRecordView(
  db: Reader,
  workspaceId: string,
  entityType: SessionRecordEntityType,
  entityId: string
): RecordView {
  return readRecord(db, workspaceId, entityType, entityId).view
}

export function readSessionRecordState(
  db: Reader,
  workspaceId: string,
  entityType: SessionRecordEntityType,
  entityId: string
): SessionRecordState | null {
  const row = db
    .select({ json: syncRecordStates.stateJson })
    .from(syncRecordStates)
    .where(
      and(
        eq(syncRecordStates.workspaceId, workspaceId),
        eq(syncRecordStates.entityType, entityType),
        eq(syncRecordStates.entityId, entityId)
      )
    )
    .get()
  return row ? (JSON.parse(row.json) as SessionRecordState) : null
}

/**
 * The conversation's mapping and every session-edit targeting it, with histories. Edits are
 * found by the exact canonical root write of their target (JSON strings escape quotes, so no
 * description can imitate it); the root may replace this scan with an index table.
 */
export function readPortableSessionRecords(
  db: Reader,
  workspaceId: string,
  target: PortableSessionTarget
): PortableConversationRecords {
  const mappingId = sessionMappingEntityId(target)
  const mapping = historyOf(db, workspaceId, 'session-mapping', mappingId).length
    ? readRecord(db, workspaceId, 'session-mapping', mappingId)
    : null
  const needle = `"target":${canonicalJson({ parents: [], value: normalTarget(target) })}`
  const ids = db
    .select({ entityId: syncChanges.entityId })
    .from(syncChanges)
    .where(
      and(
        eq(syncChanges.workspaceId, workspaceId),
        eq(syncChanges.entityType, 'session-edit'),
        sql`instr(${syncChanges.changeJson}, ${needle}) > 0`
      )
    )
    .all()
    .map((row) => row.entityId)
  const edits = [...new Set(ids)]
    .sort()
    .map((entityId) => readRecord(db, workspaceId, 'session-edit', entityId))
  return { target: normalTarget(target), mapping, edits }
}

// ── Import ──

function requireDirectoryDependency(
  lookup: (id: string) => unknown,
  revision: ParsedRevision,
  entityType: 'client' | 'project',
  syncId: string
): void {
  const found = revision.dependencies.some((id) => {
    const dependency = lookup(id) as Partial<RevisionChange> | undefined
    return (
      dependency?.kind === 'revision' &&
      dependency.entityType === entityType &&
      dependency.entityId === syncId
    )
  })
  if (!found) malformed(`${revision.id} does not depend on ${entityType} ${syncId}`)
}

/**
 * Store hook, called after the change is inserted into sync_changes. Parents, directory
 * references, the anchor's activity identity and copied heads are checked against applied
 * changes in this workspace. Writes only the rebuildable record state.
 */
export function applySessionRecordChange(
  tx: Transaction,
  workspaceId: string,
  change: unknown
): void {
  const revision = validateSessionRecordChange(change)
  const entityType = revision.entityType as SessionRecordEntityType
  const { entityId } = revision
  const schema = sessionRecordSchema(entityType)
  const lookup = (id: string): unknown => appliedChange(tx, workspaceId, id)
  if (lookup(revision.id) === undefined)
    malformed(`Record ${revision.id} in sync_changes before applying it`)
  let view: RecordView
  try {
    const missing = checkRevision(change, schema, lookup)
    if (missing.length)
      throw new AppError(
        'SYNC_MISSING_DEPENDENCY',
        `${revision.id} waits for ${missing.join(', ')}`
      )
    view = materializeRecord(schema, entityId, historyOf(tx, workspaceId, entityType, entityId))
  } catch (error) {
    if (error instanceof RevisionError) malformed(error.message)
    throw error
  }

  for (const [field, referenced] of REFERENCES) {
    const syncId = revision.fields.get(field)?.value
    if (typeof syncId === 'string') requireDirectoryDependency(lookup, revision, referenced, syncId)
  }

  let target: PortableSessionTarget
  let anchor: PortableSessionAnchor | undefined
  if (entityType === 'session-mapping') target = readSessionMappingTarget(entityId)
  else {
    if (view.fields.target.status !== 'resolved' || view.fields.anchor.status !== 'resolved')
      malformed(`${entityId} has no agreed target and anchor`)
    target = view.fields.target.value as unknown as PortableSessionTarget
    anchor = view.fields.anchor.value as unknown as PortableSessionAnchor
    const written = revision.fields.get('anchor')?.value as unknown as
      | PortableSessionAnchor
      | undefined
    if (written?.kind === 'event') {
      const identityId = syncFactChangeId(workspaceId, 'activity-identity', written.eventId)
      if (!revision.dependencies.includes(identityId))
        malformed(`${revision.id} must depend on the activity identity of its anchor`)
      const identity = lookup(identityId) as Partial<SyncChange> | undefined
      if (
        identity?.kind !== 'fact' ||
        identity.entityType !== 'activity-identity' ||
        identity.entityId !== written.eventId ||
        identity.payload?.provider !== target.provider ||
        identity.payload?.conversationId !== target.conversationId
      )
        malformed(`${revision.id}: anchor event is not in conversation ${target.conversationId}`)
    }
    const copied = revision.fields.get('copiedFrom')?.value as unknown as
      | PortableCopySource
      | null
      | undefined
    if (copied) {
      let named = false
      for (const head of copied.heads) {
        const source = lookup(head) as Partial<RevisionChange> | undefined
        const state =
          source?.kind === 'revision' && source.entityType === 'session-edit'
            ? readSessionRecordState(tx, workspaceId, 'session-edit', source.entityId as string)
            : null
        if (
          !state ||
          source?.entityId === entityId ||
          canonicalJson(state.target) !== canonicalJson(normalTarget(target))
        )
          malformed(`${revision.id} copies ${head}, which is not an edit of this conversation`)
        if (source?.entityId === copied.entityId) named = true
      }
      if (!named) malformed(`${revision.id} names a copy source it did not observe`)
    }
  }

  const state: SessionRecordState = anchor ? { view, target, anchor } : { view, target }
  tx.insert(syncRecordStates)
    .values({ workspaceId, entityType, entityId, stateJson: JSON.stringify(state) })
    .onConflictDoUpdate({
      target: [
        syncRecordStates.workspaceId,
        syncRecordStates.entityType,
        syncRecordStates.entityId
      ],
      set: { stateJson: JSON.stringify(state) }
    })
    .run()
}

/** Handles only 'session-mapping' and 'session-edit' revisions; route other types elsewhere. */
export const sessionRecordsAdapter: SyncDomainAdapter = {
  validate: (change) => void validateSessionRecordChange(change),
  apply: applySessionRecordChange
}

/** Records local session changes in the caller's transaction (nested as a savepoint). */
export function journalSessionRecordChanges<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  workspaceId: string,
  changes: readonly RevisionChange[]
): string[] {
  if (!changes.length) return []
  return recordLocalSyncChanges(db, workspaceId, [...changes], sessionRecordsAdapter)
}

// ── Planning ──

function definedValues(values: Readonly<Partial<Record<string, unknown>>>): Values {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined)
  ) as Values
}

/**
 * Canonical client spelling: a local client syncId becomes its portable ID, and the built-in
 * Unassigned client (its local syncId or the reserved portable ID) is written as null.
 */
function portableAssignment(db: Reader, values: Values): Values {
  const client = values.clientSyncId
  if (typeof client !== 'string') return values
  const portable = portableIdOfLocalClient(db, client)
  return { ...values, clientSyncId: portable === UNASSIGNED_CLIENT_SYNC_ID ? null : portable }
}

function directoryDependencies(
  db: Reader,
  workspaceId: string,
  values: Values,
  requires?: SessionReference[]
): string[] {
  const dependencies: string[] = []
  for (const [field, entityType] of REFERENCES) {
    const syncId = values[field]
    if (syncId === null || syncId === undefined) continue
    if (!isSyncUuid(syncId)) invalid(`${field} must be a syncId`)
    const view = getDirectoryRecordView(db, workspaceId, entityType, syncId)
    if (view.lifecycle !== 'missing') dependencies.push(...view.heads[PRESENT])
    else if (requires) requires.push({ entityType, entityId: syncId })
    else
      throw new AppError(
        'SYNC_REFERENCE_UNAVAILABLE',
        `Export ${entityType} ${syncId} before assigning sessions to it`
      )
  }
  return dependencies
}

function identityDependency(
  db: Reader,
  workspaceId: string,
  anchor: PortableSessionAnchor,
  requires?: SessionReference[]
): string[] {
  if (anchor.kind !== 'event') return []
  const id = syncFactChangeId(workspaceId, 'activity-identity', anchor.eventId)
  if (appliedChange(db, workspaceId, id) !== undefined) return [id]
  if (requires) {
    requires.push({ entityType: 'activity-identity', entityId: anchor.eventId })
    return []
  }
  throw new AppError(
    'SYNC_REFERENCE_UNAVAILABLE',
    `Export activity ${anchor.eventId} before anchoring an edit to it`
  )
}

function checkPlannedValues(values: Values): void {
  const unknown = Object.keys(values).find(
    (field) => !(PORTABLE_SESSION_FIELDS as readonly string[]).includes(field)
  )
  if (unknown !== undefined) invalid(`Cannot edit session field ${unknown}`)
  if (Object.hasOwn(values, 'clientSyncId') !== Object.hasOwn(values, 'projectSyncId'))
    invalid('Assign a client and project together')
}

function planned(plan: Parameters<typeof planRevision>[0]): RevisionChange {
  try {
    const change = planRevision(plan)
    validateSessionRecordChange(change)
    return change
  } catch (error) {
    return invalidPlan(error)
  }
}

export type SessionBaseline =
  | { status: 'ready'; change: RevisionChange }
  /** Nothing differs from the inherited value; no record is written. */
  | { status: 'unnecessary' }
  /** Already has causal history; plan edits instead. */
  | { status: 'has-history' }
  | { status: 'requires'; requires: SessionReference[] }

/** Version 8 UUID over the workspace and complete change body, so exact clones dedupe. */
function baselineChange(
  workspaceId: string,
  schema: RecordSchema,
  entityId: string,
  values: Values,
  dependencies: string[]
): RevisionChange {
  const { id: _placeholder, ...body } = planned({
    id: PLACEHOLDER_ID,
    schema,
    entityId,
    history: [],
    action: { type: 'create', values },
    dependencies: [...new Set(dependencies)]
  })
  const change: RevisionChange = {
    id: v8({ purpose: 'clautime-session-baseline-1', workspaceId, body }),
    ...body
  }
  validateSessionRecordChange(change)
  return change
}

/**
 * Baseline default assignment for a conversation (bootstrap). An unassigned conversation needs
 * no record. Differing baselines from different computers become competing roots, i.e. a visible
 * mapping conflict.
 */
export function planSessionMappingBaseline(
  db: Reader,
  workspaceId: string,
  target: PortableSessionTarget,
  assignment: { clientSyncId: string | null; projectSyncId: string | null }
): SessionBaseline {
  const values = portableAssignment(db, {
    clientSyncId: assignment.clientSyncId,
    projectSyncId: assignment.projectSyncId
  })
  if (values.clientSyncId === null && values.projectSyncId === null)
    return { status: 'unnecessary' }
  const entityId = sessionMappingEntityId(target)
  if (historyOf(db, workspaceId, 'session-mapping', entityId).length)
    return { status: 'has-history' }
  const requires: SessionReference[] = []
  const dependencies = directoryDependencies(db, workspaceId, values, requires)
  if (requires.length) return { status: 'requires', requires }
  return {
    status: 'ready',
    change: baselineChange(workspaceId, SESSION_MAPPING_SCHEMA, entityId, values, dependencies)
  }
}

/**
 * Baseline override for one anchored fragment. Pass only fields that differ from what the
 * fragment would inherit (and a time override with its current base coverage hash).
 */
export function planSessionEditBaseline(
  db: Reader,
  workspaceId: string,
  request: {
    target: PortableSessionTarget
    anchor: PortableSessionAnchor
    values: Partial<PortableSessionValues>
  }
): SessionBaseline {
  const values = portableAssignment(db, definedValues(request.values))
  checkPlannedValues(values)
  if (!Object.keys(values).length) return { status: 'unnecessary' }
  const target = normalTarget(request.target)
  const anchor = normalAnchor(request.anchor)
  const entityId = sessionEditEntityId(target, anchor)
  if (historyOf(db, workspaceId, 'session-edit', entityId).length) return { status: 'has-history' }
  const requires: SessionReference[] = []
  const dependencies = [
    ...identityDependency(db, workspaceId, anchor, requires),
    ...directoryDependencies(db, workspaceId, values, requires)
  ]
  if (requires.length) return { status: 'requires', requires }
  return {
    status: 'ready',
    change: baselineChange(
      workspaceId,
      SESSION_EDIT_SCHEMA,
      entityId,
      { target: target as unknown as JsonValue, anchor: anchor as unknown as JsonValue, ...values },
      dependencies
    )
  }
}

/** A local edit/delete/resolve of the conversation's default assignment (random change ID). */
export function planSessionMappingRevision(
  db: Reader,
  workspaceId: string,
  request: { id: string; target: PortableSessionTarget; action: RevisionAction }
): RevisionChange {
  const values =
    request.action.type === 'delete'
      ? {}
      : portableAssignment(db, definedValues(request.action.values ?? {}))
  const action = (
    request.action.type === 'delete' ? request.action : { ...request.action, values }
  ) as RevisionAction
  const entityId = sessionMappingEntityId(request.target)
  return planned({
    id: request.id,
    schema: SESSION_MAPPING_SCHEMA,
    entityId,
    history: historyOf(db, workspaceId, 'session-mapping', entityId),
    action,
    dependencies: directoryDependencies(db, workspaceId, values)
  })
}

export interface PortableSessionEditRequest {
  target: PortableSessionTarget
  /** The fragment the user edited, as currently calculated. */
  fragment: PortableSessionFragment
  /** Every explicit cut of the conversation; a new record may anchor at one. */
  cuts?: readonly string[]
  /** Portable fields to set; clientSyncId and projectSyncId go together. */
  values: Partial<PortableSessionValues>
  /**
   * Explicit resolution of conflicts the user was shown: conflicted fields (a conflicted
   * copiedFrom included) or a lifecycle conflict. Never acknowledges unseen source revisions.
   */
  resolve?: boolean
  /**
   * The post-split-edit holds the user was shown and accepted, as the overlay reported them
   * ({ entityId, source, revisions }). They must equal the copy's current unobserved source
   * revisions exactly; only then does the copy's copiedFrom move to the sources' current heads.
   */
  acknowledgedCopyEdits?: readonly PortableCopyAcknowledgment[]
  /** Session-deletion fact change IDs the user saw; the edit depends on them (not a conflict). */
  observedDeletions?: readonly string[]
  newId: () => string
}

export interface PortableCopyAcknowledgment {
  entityId: string
  source: string
  revisions: readonly string[]
}

function sameAcknowledgment(
  shown: readonly PortableCopyAcknowledgment[],
  current: ReadonlyArray<{ source: string; revisions: string[] }>
): boolean {
  const normal = shown
    .map((item) => ({ source: item.source, revisions: [...new Set(item.revisions)].sort() }))
    .sort((left, right) => (left.source < right.source ? -1 : left.source > right.source ? 1 : 0))
  return canonicalJson(normal) === canonicalJson(current)
}

function deletionDependencies(db: Reader, workspaceId: string, ids: readonly string[]): string[] {
  for (const id of ids) {
    const change = appliedChange(db, workspaceId, id) as Partial<SyncChange> | undefined
    if (change?.kind !== 'fact' || change.entityType !== 'session-deletion')
      invalid(`${id} is not a recorded session deletion`)
  }
  return [...ids]
}

/**
 * Plans the user's edit of one fragment. With one attached record it revises that record; with
 * several (a merged interval) it writes the same values to each, each superseding its own
 * observed heads; with none it creates a record at defaultSessionAnchor. Editing a record that
 * has split copies also depends on those copies, marking the edit as made after the split.
 * Editing a record that was only deleted restores it (plain restore, no conflict to resolve); a
 * restored split copy keeps its copiedFrom, so unseen source edits stay held.
 * Record every returned change together with journalSessionRecordChanges.
 */
export function planPortableSessionEdit(
  db: Reader,
  workspaceId: string,
  request: PortableSessionEditRequest
): RevisionChange[] {
  const values = portableAssignment(db, definedValues(request.values))
  checkPlannedValues(values)
  if (!Object.keys(values).length) invalid('An edit must change at least one field')
  const target = normalTarget(request.target)
  const references = [
    ...directoryDependencies(db, workspaceId, values),
    ...deletionDependencies(db, workspaceId, request.observedDeletions ?? [])
  ]
  const records = readPortableSessionRecords(db, workspaceId, target)
  const attached = attachedSessionRecords(request.fragment, records.edits)
  const acknowledgments = request.acknowledgedCopyEdits ?? []
  if (acknowledgments.some((item) => !attached.some((record) => record.entityId === item.entityId)))
    invalid('An acknowledged split copy is not attached to this fragment')

  if (!attached.length) {
    const anchor = defaultSessionAnchor(request.fragment, request.cuts ?? [])
    if (!anchor) invalid('The fragment has no event or cut to anchor an edit to')
    return [
      planned({
        id: request.newId(),
        schema: SESSION_EDIT_SCHEMA,
        entityId: sessionEditEntityId(target, anchor),
        history: [],
        action: {
          type: 'create',
          values: {
            target: target as unknown as JsonValue,
            anchor: anchor as unknown as JsonValue,
            ...values
          }
        },
        dependencies: [...identityDependency(db, workspaceId, anchor), ...references]
      })
    ]
  }

  return attached.map((record) => {
    const { view } = record
    const written: Values = { ...values }
    const dependencies = [
      ...references,
      ...sessionCopiesOf(record, records.edits).flatMap((copy) => sessionRecordHeads(copy.view))
    ]
    // copiedFrom moves only when the user accepted exactly the source revisions now unobserved
    // (none, when resolving a conflicted copiedFrom that holds nothing unseen).
    const acknowledged = acknowledgments.filter((item) => item.entityId === record.entityId)
    const copyConflict = view.fields.copiedFrom?.status === 'conflict'
    if (acknowledged.length || (request.resolve && copyConflict)) {
      const copied = sessionCopiedFrom(record)
      if (!copied) invalid('Only a split copy can acknowledge source edits')
      if (!sameAcknowledgment(acknowledged, unobservedCopySourceRevisions(record, records.edits)))
        throw new AppError(
          'SYNC_CONFLICT',
          'The split session was edited elsewhere since it was shown; review it again'
        )
      const heads = [
        ...new Set(
          sessionCopySources(record, records.edits).flatMap((source) =>
            sessionRecordHeads(source.view)
          )
        )
      ].sort()
      if (heads.length) {
        written.copiedFrom = { entityId: copied.entityId, heads }
        dependencies.push(...heads)
      }
    }
    const conflicted = Object.keys(written).filter(
      (field) => field !== 'copiedFrom' && view.fields[field]?.status === 'conflict'
    )
    if (!request.resolve && (view.lifecycle === 'conflict' || conflicted.length))
      throw new AppError(
        'SYNC_CONFLICT',
        view.lifecycle === 'conflict'
          ? "This session's synced edit was edited and deleted concurrently; resolve it before editing"
          : `Resolve the synced ${conflicted.join(', ')} conflict on this session before editing it`
      )
    // A resolve names exact current heads: explicit resolutions, restoring a deleted record, and
    // an acknowledged rewrite of a conflicted copiedFrom.
    const action: RevisionAction =
      request.resolve ||
      view.lifecycle !== 'present' ||
      (copyConflict && written.copiedFrom !== undefined)
        ? { type: 'resolve', expectedHeads: view.heads, values: written, present: true }
        : { type: 'edit', observedHeads: view.heads, values: written }
    return planned({
      id: request.newId(),
      schema: SESSION_EDIT_SCHEMA,
      entityId: record.entityId,
      history: record.history,
      action,
      dependencies: [...new Set(dependencies)]
    })
  })
}

export interface SessionSplitCopyRequest {
  target: PortableSessionTarget
  /** The fragment being split, as calculated before the new cut. */
  fragment: PortableSessionFragment
  /** Its pieces after the new cut set. */
  pieces: readonly PortableSessionFragment[]
  /** Every explicit cut of the conversation, the new one included. */
  cuts: readonly string[]
  newId: () => string
}

export type SessionSplitCopies =
  | { status: 'ready'; changes: RevisionChange[] }
  /** The fragment's metadata is not agreed; resolve it before splitting. */
  | { status: 'held'; reasons: PortableHeldReason[] }

/**
 * Copy-on-split for the cut journaling code: every piece that no existing record attaches to gets
 * a copy of the edited (not inherited) values, anchored at its cut, whose copiedFrom observes
 * every head of the source records. Later source edits the copy did not observe hold that piece.
 */
export function planSessionSplitCopies(
  db: Reader,
  workspaceId: string,
  request: SessionSplitCopyRequest
): SessionSplitCopies {
  const target = normalTarget(request.target)
  const records = readPortableSessionRecords(db, workspaceId, target)
  const before = resolvePortableSessionFields({
    target,
    fragment: request.fragment,
    mapping: records.mapping,
    edits: records.edits
  })
  if (before.status === 'held') return { status: 'held', reasons: before.reasons }
  const sources = records.edits.filter((record) => before.attached.includes(record.entityId))
  const values: Values = {}
  for (const field of PORTABLE_SESSION_FIELDS) {
    const state = before.fields[field as PortableSessionField]
    if (state.status === 'resolved' && state.source === 'edit') values[field] = state.value
  }
  if (!sources.length || !Object.keys(values).length) return { status: 'ready', changes: [] }
  const heads = [...new Set(sources.flatMap((source) => sessionRecordHeads(source.view)))].sort()
  const references = directoryDependencies(db, workspaceId, values)
  const changes: RevisionChange[] = []
  for (const piece of request.pieces) {
    if (attachedSessionRecords(piece, records.edits).length) continue
    const anchor = defaultSessionAnchor(piece, request.cuts, 'cut')
    if (!anchor) invalid('A split piece has no cut or event to anchor its copy to')
    changes.push(
      planned({
        id: request.newId(),
        schema: SESSION_EDIT_SCHEMA,
        entityId: sessionEditEntityId(target, anchor),
        history: [],
        action: {
          type: 'create',
          values: {
            target: target as unknown as JsonValue,
            anchor: anchor as unknown as JsonValue,
            ...values,
            copiedFrom: { entityId: sources[0].entityId, heads }
          }
        },
        dependencies: [
          ...new Set([...heads, ...references, ...identityDependency(db, workspaceId, anchor)])
        ]
      })
    )
  }
  return { status: 'ready', changes }
}
