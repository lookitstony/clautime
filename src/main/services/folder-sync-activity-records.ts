import { createHash } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import type { getDb } from '../db'
import { activityIdentities, activityObservations } from '../db/schema/activity-evidence'
import { activityObservers, sourceMachines } from '../db/schema/activity-observers'
import { syncChanges } from '../db/schema/folder-sync'
import { AppError } from '../../shared/types/ipc'
import {
  canonicalJson,
  isSyncUuid,
  SyncError,
  type JsonObject,
  type SyncChange,
  type SyncEntityType
} from './folder-sync-protocol'
import type { SyncDomainAdapter } from './folder-sync-store'

/*
 * Portable immutable activity facts (plan decisions B, C and H). Only the explicit
 * allowlists below leave this computer: never source paths, activity_sources, local
 * capture times, raw transcript text, credentials or settings. Importing a fact only
 * writes the immutable ledger. It never runs scanners or providers, and canonical
 * sessions are projected from the ledger separately.
 */

type Reader = Pick<ReturnType<typeof getDb>, 'select'>
type Transaction = Parameters<SyncDomainAdapter['apply']>[0]

export const ACTIVITY_SYNC_ENTITY_TYPES = [
  'machine',
  'activity-identity',
  'activity-observation',
  'activity-observer'
] as const satisfies readonly SyncEntityType[]
type ActivityEntityType = (typeof ACTIVITY_SYNC_ENTITY_TYPES)[number]
type Reference = [ActivityEntityType, string]

// Normalization vocabulary written by activity-evidence.ts and the provider identity captures.
const PROVIDER_BASES = new Map<string, readonly string[]>([
  ['claude', ['native', 'fingerprint']],
  ['codex', ['native', 'fingerprint', 'checkpoint', 'progress']],
  ['gemini', ['native', 'fingerprint']],
  ['opencode', ['native']]
])
const OBSERVATION_KINDS = ['message', 'activity', 'checkpoint']
const IDENTITY_KEYS = [
  'eventId',
  'provider',
  'identityVersion',
  'conversationId',
  'basis',
  'nativeEventId'
]
const OBSERVATION_KEYS = ['eventId', 'version', 'kind', 'payload']
const OBSERVER_KEYS = ['observationId', 'deviceId', 'basis']
const MACHINE_KEYS = ['deviceId', 'initialName']
const MESSAGE_KEYS = [
  'type',
  'timestamp',
  'model',
  'usage',
  'isToolResult',
  'hasToolUse',
  'toolNames'
]
const USAGE_KEYS = [
  'inputTokens',
  'outputTokens',
  'cacheCreationInputTokens',
  'cacheReadInputTokens'
]
const CHECKPOINT_KEYS = ['previousCheckpointId', 'activityEventId', 'timestamp', 'totals', 'model']
const TIMING_KEYS = ['startedAt', 'endedAt', 'completedAt']
const REQUIRED_TOTALS = ['input_tokens', 'output_tokens', 'cached_input_tokens']
const MAX_COUNTERS = 32
const DEPENDENCY_COUNTS: Record<ActivityEntityType, number> = {
  machine: 0,
  'activity-identity': 0,
  'activity-observation': 1,
  'activity-observer': 2
}

const EVENT_ID = /^([a-z][a-z0-9-]*):v(\d+):([a-z][a-z0-9-]*):[0-9a-f]{64}$/
const OBSERVATION_ID = /^observation:v(\d+):[0-9a-f]{64}$/
const VOCABULARY = /^[a-z][a-z0-9-]*$/
const COUNTER_NAME = /^[a-z][a-z0-9_]{0,63}$/
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i
const CHUNK = 500

function malformed(message: string): never {
  throw new SyncError('SYNC_MALFORMED', message)
}

function updateRequired(feature: string): never {
  throw new SyncError(
    'SYNC_UPDATE_REQUIRED',
    `Shared history uses ${feature}; update ClauTime to continue syncing`
  )
}

function conflict(message: string): never {
  throw new AppError('SYNC_ID_CONFLICT', message)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** The ledger's own canonical form (activity-evidence.ts), so recomputed IDs match exactly. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)])
    )
  return value
}

function payloadJson(fact: unknown): string {
  return JSON.stringify(canonical(fact))
}

/**
 * Deterministic RFC 9562 version-8 UUID for an immutable fact. Copies of one fact recorded
 * independently on several computers share this change ID, whatever their source or capture
 * time. Only for facts whose entity ID determines their contents; revisions need random IDs.
 */
export function syncFactChangeId(
  workspaceId: string,
  entityType: SyncEntityType,
  entityId: string
): string {
  const bytes = createHash('sha256')
    .update(JSON.stringify(['clautime-sync-fact', 1, workspaceId, entityType, entityId]))
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x80
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The ledger's observation key, recomputed from a normalized fact (never from raw text). */
export function activityObservationId(eventId: string, kind: string, fact: unknown): string {
  return `observation:v1:${sha256(
    JSON.stringify(['activity-observation', 1, eventId, kind, payloadJson(fact)])
  )}`
}

export function activityObserverEntityId(
  observationId: string,
  deviceId: string,
  basis: string
): string {
  return canonicalJson([observationId, deviceId, basis])
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isReference(value: unknown): value is string | null {
  return value === null || isText(value)
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && TIMESTAMP.test(value) && Number.isFinite(Date.parse(value))
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

function supportedDigits(digits: string, feature: string): void {
  if (digits === '1') return
  if (/^[1-9]\d*$/.test(digits)) updateRequired(`${feature} ${digits}`)
  malformed(`${feature} is invalid`)
}

/** Every ledger event ID states its provider, identity version and basis. */
function eventKey(value: unknown, label: string): { provider: string; basis: string } {
  const match = typeof value === 'string' ? EVENT_ID.exec(value) : null
  if (!match) malformed(`${label} has an unrecognized event ID`)
  const [, provider = '', digits = '', basis = ''] = match
  supportedDigits(digits, 'activity identity version')
  const bases = PROVIDER_BASES.get(provider)
  if (!bases) updateRequired(`activity provider "${provider}"`)
  if (!bases.includes(basis)) updateRequired(`${provider} activity basis "${basis}"`)
  return { provider, basis }
}

function observationKey(value: unknown, label: string): void {
  const match = typeof value === 'string' ? OBSERVATION_ID.exec(value) : null
  if (!match) malformed(`${label} has an unrecognized observation ID`)
  supportedDigits(match[1] ?? '', 'activity observation ID version')
}

/** Only the native keys that the identity fully determines are recomputed. */
function nativeKey(provider: string, conversationId: string, nativeEventId: string): string | null {
  if (provider !== 'claude' && provider !== 'gemini') return null
  return `${provider}:v1:native:${sha256(
    JSON.stringify([provider, 1, conversationId, 'native', nativeEventId])
  )}`
}

function validateIdentity(change: SyncChange): void {
  const payload = change.payload
  supportedVersion(payload.identityVersion, 'activity identity version')
  const identity = fields(payload, IDENTITY_KEYS, [], 'Activity identity')
  const { provider, basis } = eventKey(identity.eventId, 'Activity identity')
  if (identity.provider !== provider || identity.basis !== basis)
    malformed('Activity identity does not match its event ID')
  if (change.entityId !== identity.eventId)
    malformed('Activity identity entity ID is not its event')
  if (!isText(identity.conversationId)) malformed('Activity identity has no conversation')
  if (basis !== 'native') {
    if (identity.nativeEventId !== null) malformed('Activity identity has an unexpected native ID')
    return
  }
  if (!isText(identity.nativeEventId)) malformed('Activity identity has an invalid native ID')
  const expected = nativeKey(provider, identity.conversationId, identity.nativeEventId)
  if (expected !== null && expected !== identity.eventId)
    malformed('Activity identity does not match its native event ID')
}

function validateParent(provider: string, fact: Record<string, unknown>, label: string): void {
  // Required-ness is enforced by the field list; absent means unknown ancestry.
  if (!Object.hasOwn(fact, 'parentEventId')) return
  // OpenCode records only explicit links; the others record null for a root.
  if (provider === 'opencode' ? !isText(fact.parentEventId) : !isReference(fact.parentEventId))
    malformed(`${label} has an invalid parent reference`)
}

function validateTiming(value: unknown, allowed: readonly string[], label: string): void {
  const timing = fields(value, [], allowed, `${label} timing`)
  if (!Object.keys(timing).length || !Object.values(timing).every(isTimestamp))
    malformed(`${label} has invalid timing`)
}

function validateCheckpoint(value: unknown, label: string): void {
  const fact = fields(value, CHECKPOINT_KEYS, [], label)
  if (
    !isReference(fact.previousCheckpointId) ||
    !isReference(fact.activityEventId) ||
    !isTimestamp(fact.timestamp) ||
    !(fact.model === null || typeof fact.model === 'string')
  )
    malformed(`${label} has an invalid field`)
  // Original cumulative counters: the delta reader uses every one, so names are open
  // but bounded, and every value is a count.
  const totals = fact.totals
  if (!isObject(totals)) malformed(`${label} has invalid token totals`)
  const counters = Object.entries(totals)
  if (
    counters.length > MAX_COUNTERS ||
    !REQUIRED_TOTALS.every((key) => Object.hasOwn(totals, key)) ||
    !counters.every(([key, count]) => COUNTER_NAME.test(key) && isCount(count))
  )
    malformed(`${label} has invalid token totals`)
}

function validateMessage(provider: string, value: unknown, label: string): void {
  // Codex and Gemini always record a predecessor (null for a root).
  const parentRequired = provider === 'codex' || provider === 'gemini'
  const fact = fields(
    value,
    parentRequired ? [...MESSAGE_KEYS, 'parentEventId'] : MESSAGE_KEYS,
    provider === 'opencode'
      ? ['parentEventId', 'parentConversationId', 'timing']
      : parentRequired
        ? []
        : ['parentEventId'],
    label
  )
  if (
    !isText(fact.type) ||
    // The Claude parser records a missing timestamp as ''; canonical readers hold it.
    !(isTimestamp(fact.timestamp) || (provider === 'claude' && fact.timestamp === '')) ||
    !(fact.model === null || typeof fact.model === 'string') ||
    typeof fact.isToolResult !== 'boolean' ||
    typeof fact.hasToolUse !== 'boolean' ||
    !Array.isArray(fact.toolNames) ||
    !fact.toolNames.every((name) => typeof name === 'string')
  )
    malformed(`${label} has an invalid field`)
  if (fact.usage !== null) {
    const usage = fields(fact.usage, USAGE_KEYS, [], `${label} usage`)
    if (!USAGE_KEYS.every((key) => isCount(usage[key]))) malformed(`${label} has invalid usage`)
  }
  validateParent(provider, fact, label)
  if (Object.hasOwn(fact, 'parentConversationId') && !isReference(fact.parentConversationId))
    malformed(`${label} has an invalid parent conversation`)
  if (Object.hasOwn(fact, 'timing')) validateTiming(fact.timing, ['completedAt'], label)
}

function validateActivity(provider: string, basis: string, value: unknown, label: string): void {
  if (provider === 'claude' || basis === 'progress') {
    // Claude native progress, or a Codex anchored progress leaf: type and time only.
    const claude = provider === 'claude'
    const keys = ['kind', 'progressType', 'timestamp']
    const fact = fields(
      value,
      claude ? keys : [...keys, 'parentEventId'],
      claude ? ['parentEventId'] : [],
      label
    )
    if (
      fact.kind !== 'progress' ||
      !isTimestamp(fact.timestamp) ||
      !(isText(fact.progressType) || (claude && fact.progressType === null))
    )
      malformed(`${label} has an invalid field`)
    validateParent(provider, fact, label)
    return
  }
  if (provider === 'opencode') {
    // Tool and completion timing replace a single timestamp.
    const fact = fields(value, ['kind', 'parentConversationId'], ['parentEventId', 'timing'], label)
    if (!isText(fact.kind) || !isReference(fact.parentConversationId))
      malformed(`${label} has an invalid field`)
    validateParent(provider, fact, label)
    if (Object.hasOwn(fact, 'timing')) validateTiming(fact.timing, TIMING_KEYS, label)
    return
  }
  const fact = fields(value, ['kind', 'timestamp', 'parentEventId'], [], label)
  if (!isText(fact.kind) || !isTimestamp(fact.timestamp)) malformed(`${label} has an invalid field`)
  validateParent(provider, fact, label)
}

function validateObservation(change: SyncChange): void {
  const payload = change.payload
  supportedVersion(payload.version, 'activity observation version')
  observationKey(change.entityId, 'Activity observation')
  const observation = fields(payload, OBSERVATION_KEYS, [], 'Activity observation')
  const { provider, basis } = eventKey(observation.eventId, 'Activity observation')
  const kind = observation.kind
  if (typeof kind !== 'string' || !VOCABULARY.test(kind))
    malformed('Activity observation has an invalid kind')
  if (!OBSERVATION_KINDS.includes(kind)) updateRequired(`activity observation kind "${kind}"`)
  const label = `${provider} ${kind} observation`
  if (kind === 'checkpoint' || basis === 'checkpoint') {
    if (kind !== basis) malformed(`${label} does not match its ${basis} identity`)
    validateCheckpoint(observation.payload, label)
  } else if (kind === 'message') {
    if (basis === 'progress') malformed(`${label} does not match its progress identity`)
    validateMessage(provider, observation.payload, label)
  } else validateActivity(provider, basis, observation.payload, label)
  const id = activityObservationId(observation.eventId as string, kind, observation.payload)
  if (id !== change.entityId) malformed('Activity observation ID does not match its contents')
}

function validateMachine(change: SyncChange): void {
  const machine = fields(change.payload, MACHINE_KEYS, [], 'Source machine')
  if (!isSyncUuid(machine.deviceId) || change.entityId !== machine.deviceId)
    malformed('Source machine has an invalid device ID')
  // Same rule as the local device registration.
  if (!isText(machine.initialName) || machine.initialName.includes('\0'))
    malformed('Source machine has an invalid name')
}

function validateObserver(change: SyncChange): void {
  observationKey(change.payload.observationId, 'Activity observer')
  const observer = fields(change.payload, OBSERVER_KEYS, [], 'Activity observer')
  if (!isSyncUuid(observer.deviceId)) malformed('Activity observer has an invalid device ID')
  if (observer.basis !== 'observed' && observer.basis !== 'imported')
    malformed('Activity observer has an invalid basis')
  const entityId = activityObserverEntityId(
    observer.observationId as string,
    observer.deviceId,
    observer.basis as string
  )
  if (change.entityId !== entityId)
    malformed('Activity observer entity ID does not match its contents')
}

function isActivityEntityType(value: string): value is ActivityEntityType {
  return (ACTIVITY_SYNC_ENTITY_TYPES as readonly string[]).includes(value)
}

/** Structural and semantic checks only; independent of any database. */
function validateActivityChange(change: SyncChange): void {
  if (change.kind !== 'fact' || !isActivityEntityType(change.entityType))
    malformed(`Sync change ${change.id} is not an activity fact`)
  if (change.entityType === 'machine') validateMachine(change)
  else if (change.entityType === 'activity-identity') validateIdentity(change)
  else if (change.entityType === 'activity-observation') validateObservation(change)
  else validateObserver(change)
  if (change.dependencies.length !== DEPENDENCY_COUNTS[change.entityType])
    malformed(`Activity fact change ${change.id} has unexpected dependencies`)
}

/** An observation depends on its identity; an observer on its observation and machine. */
function references(change: SyncChange): Reference[] {
  const payload = change.payload
  if (change.entityType === 'activity-observation')
    return [['activity-identity', payload.eventId as string]]
  if (change.entityType === 'activity-observer')
    return [
      ['activity-observation', payload.observationId as string],
      ['machine', payload.deviceId as string]
    ]
  return []
}

function dependencyIds(workspaceId: string, change: SyncChange): string[] {
  return references(change)
    .map(([entityType, entityId]) => syncFactChangeId(workspaceId, entityType, entityId))
    .sort()
}

function fact(
  workspaceId: string,
  entityType: ActivityEntityType,
  entityId: string,
  payload: JsonObject
): SyncChange {
  const change: SyncChange = {
    id: syncFactChangeId(workspaceId, entityType, entityId),
    kind: 'fact',
    entityType,
    entityId,
    dependencies: [],
    payload
  }
  change.dependencies = dependencyIds(workspaceId, change)
  return change
}

function applyMachine(tx: Transaction, payload: JsonObject): void {
  const deviceId = payload.deviceId as string
  const initialName = payload.initialName as string
  const existing = tx
    .select()
    .from(sourceMachines)
    .where(eq(sourceMachines.deviceId, deviceId))
    .get()
  if (existing) {
    if (existing.initialName !== initialName)
      conflict(`Source machine ${deviceId} already has a different original name`)
    return
  }
  tx.insert(sourceMachines).values({ deviceId, initialName }).run()
}

function applyIdentity(tx: Transaction, payload: JsonObject): void {
  const row = {
    eventId: payload.eventId as string,
    provider: payload.provider as string,
    identityVersion: payload.identityVersion as number,
    conversationId: payload.conversationId as string,
    basis: payload.basis as string,
    nativeEventId: payload.nativeEventId as string | null
  }
  const existing = tx
    .select()
    .from(activityIdentities)
    .where(eq(activityIdentities.eventId, row.eventId))
    .get()
  if (existing) {
    if (
      existing.provider !== row.provider ||
      existing.identityVersion !== row.identityVersion ||
      existing.conversationId !== row.conversationId ||
      existing.basis !== row.basis ||
      existing.nativeEventId !== row.nativeEventId
    )
      conflict(`Activity event ${row.eventId} already has a different identity`)
    return
  }
  tx.insert(activityIdentities).values(row).run()
}

function applyObservation(tx: Transaction, id: string, payload: JsonObject): void {
  const eventId = payload.eventId as string
  const row = {
    id,
    eventId,
    version: payload.version as number,
    kind: payload.kind as 'message' | 'activity' | 'checkpoint',
    payloadJson: payloadJson(payload.payload)
  }
  const identity = tx
    .select({ eventId: activityIdentities.eventId })
    .from(activityIdentities)
    .where(eq(activityIdentities.eventId, eventId))
    .get()
  if (!identity)
    throw new AppError('SYNC_MISSING_DEPENDENCY', `Activity event ${eventId} is not in the ledger`)
  const existing = tx
    .select({
      eventId: activityObservations.eventId,
      version: activityObservations.version,
      kind: activityObservations.kind,
      payloadJson: activityObservations.payloadJson
    })
    .from(activityObservations)
    .where(eq(activityObservations.id, id))
    .get()
  if (existing) {
    // Capture time differs between copies and is not part of the fact.
    if (
      existing.eventId !== row.eventId ||
      existing.version !== row.version ||
      existing.kind !== row.kind ||
      existing.payloadJson !== row.payloadJson
    )
      conflict(`Activity observation ${id} already has different contents`)
    return
  }
  // This copy's local capture time: never exported and never causal.
  tx.insert(activityObservations)
    .values({ ...row, createdAt: new Date().toISOString() })
    .run()
}

function applyObserver(tx: Transaction, payload: JsonObject): void {
  const observationId = payload.observationId as string
  const deviceId = payload.deviceId as string
  const observation = tx
    .select({ id: activityObservations.id })
    .from(activityObservations)
    .where(eq(activityObservations.id, observationId))
    .get()
  const machine = tx
    .select({ deviceId: sourceMachines.deviceId })
    .from(sourceMachines)
    .where(eq(sourceMachines.deviceId, deviceId))
    .get()
  if (!observation || !machine)
    throw new AppError(
      'SYNC_MISSING_DEPENDENCY',
      `Activity observer ${observationId} is missing its observation or machine`
    )
  // Every column is the key, so an existing row is the same fact.
  tx.insert(activityObservers)
    .values({ observationId, deviceId, basis: payload.basis as 'observed' | 'imported' })
    .onConflictDoNothing()
    .run()
}

/**
 * Maps facts onto the existing immutable ledger. Never writes source links, the local
 * provenance-upgrade queue or manual queues. An equal existing fact does nothing; a
 * different one with the same ID rejects the whole batch, so no correction picks a winner.
 */
function applyActivityChange(tx: Transaction, workspaceId: string, change: SyncChange): void {
  // Re-checked here: this is the last step before the immutable ledger.
  validateActivityChange(change)
  if (change.id !== syncFactChangeId(workspaceId, change.entityType, change.entityId))
    malformed(`Activity fact change ${change.id} is not derived from its fact`)
  if (canonicalJson(change.dependencies) !== canonicalJson(dependencyIds(workspaceId, change)))
    malformed(`Activity fact change ${change.id} has unexpected dependencies`)
  for (const [entityType, entityId] of references(change)) {
    const dependency = tx
      .select({
        workspaceId: syncChanges.workspaceId,
        entityType: syncChanges.entityType,
        entityId: syncChanges.entityId
      })
      .from(syncChanges)
      .where(eq(syncChanges.id, syncFactChangeId(workspaceId, entityType, entityId)))
      .get()
    if (
      !dependency ||
      dependency.workspaceId !== workspaceId ||
      dependency.entityType !== entityType ||
      dependency.entityId !== entityId
    )
      throw new AppError(
        'SYNC_MISSING_DEPENDENCY',
        `Activity fact ${change.entityId} is missing its ${entityType} fact in this shared history`
      )
  }
  if (change.entityType === 'machine') applyMachine(tx, change.payload)
  else if (change.entityType === 'activity-identity') applyIdentity(tx, change.payload)
  else if (change.entityType === 'activity-observation')
    applyObservation(tx, change.entityId, change.payload)
  else applyObserver(tx, change.payload)
}

export const activitySyncAdapter: SyncDomainAdapter = {
  validate: validateActivityChange,
  apply: applyActivityChange
}

function chunked<T, R>(values: readonly T[], read: (part: T[]) => R[]): R[] {
  const result: R[] = []
  for (let index = 0; index < values.length; index += CHUNK)
    result.push(...read(values.slice(index, index + CHUNK)))
  return result
}

function byEntity(a: SyncChange, b: SyncChange): number {
  return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0
}

// Explicit portable columns. activity_observations.created_at is local capture time.
const identityColumns = {
  eventId: activityIdentities.eventId,
  provider: activityIdentities.provider,
  identityVersion: activityIdentities.identityVersion,
  conversationId: activityIdentities.conversationId,
  basis: activityIdentities.basis,
  nativeEventId: activityIdentities.nativeEventId
}
const observationColumns = {
  id: activityObservations.id,
  eventId: activityObservations.eventId,
  version: activityObservations.version,
  kind: activityObservations.kind,
  payloadJson: activityObservations.payloadJson
}

/**
 * Reads (never writes) the captured ledger as fact changes: machines, identities,
 * observations, then observers, each sorted, so the list is deterministic and in dependency
 * order. Pass the result to recordLocalSyncChanges, where already-recorded facts are no-ops.
 * `observationIds` scopes the export to those observations with their identities, observers
 * and machines (for ingestion hooks). A local row that fails validation throws rather than
 * being skipped.
 */
export function collectActivitySyncChanges(
  db: Reader,
  workspaceId: string,
  observationIds?: readonly string[]
): SyncChange[] {
  if (!isSyncUuid(workspaceId)) malformed('A shared history ID is required')
  const scope = observationIds && [...new Set(observationIds)].sort()
  if (scope?.length === 0) return []
  const observations = scope
    ? chunked(scope, (part) =>
        db
          .select(observationColumns)
          .from(activityObservations)
          .where(inArray(activityObservations.id, part))
          .all()
      )
    : db.select(observationColumns).from(activityObservations).all()
  if (scope && observations.length !== scope.length)
    throw new AppError(
      'ACTIVITY_OBSERVATION_NOT_FOUND',
      'An activity observation selected for sync is not in the local ledger'
    )
  const identities = scope
    ? chunked([...new Set(observations.map((row) => row.eventId))], (part) =>
        db
          .select(identityColumns)
          .from(activityIdentities)
          .where(inArray(activityIdentities.eventId, part))
          .all()
      )
    : db.select(identityColumns).from(activityIdentities).all()
  const observers = scope
    ? chunked(scope, (part) =>
        db
          .select()
          .from(activityObservers)
          .where(inArray(activityObservers.observationId, part))
          .all()
      )
    : db.select().from(activityObservers).all()
  const machines = scope
    ? chunked([...new Set(observers.map((row) => row.deviceId))], (part) =>
        db.select().from(sourceMachines).where(inArray(sourceMachines.deviceId, part)).all()
      )
    : db.select().from(sourceMachines).all()

  const changes = [
    ...machines
      .map((row) =>
        fact(workspaceId, 'machine', row.deviceId, {
          deviceId: row.deviceId,
          initialName: row.initialName
        })
      )
      .sort(byEntity),
    ...identities
      .map((row) => fact(workspaceId, 'activity-identity', row.eventId, { ...row }))
      .sort(byEntity),
    ...observations
      .map((row) => {
        let normalized: JsonObject
        try {
          normalized = JSON.parse(row.payloadJson)
        } catch {
          return malformed(`Local activity observation ${row.id} is not valid JSON`)
        }
        return fact(workspaceId, 'activity-observation', row.id, {
          eventId: row.eventId,
          version: row.version,
          kind: row.kind,
          payload: normalized
        })
      })
      .sort(byEntity),
    ...observers
      .map((row) =>
        fact(
          workspaceId,
          'activity-observer',
          activityObserverEntityId(row.observationId, row.deviceId, row.basis),
          { observationId: row.observationId, deviceId: row.deviceId, basis: row.basis }
        )
      )
      .sort(byEntity)
  ]
  changes.forEach(validateActivityChange)
  return changes
}
