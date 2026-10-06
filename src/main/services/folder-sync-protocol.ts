import { createHash, randomUUID } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { AppError } from '../../shared/types/ipc'

/*
 * Portable folder-sync formats (plan decisions F and G). This layer only validates
 * structure and integrity: decoding never applies a change. Payload meaning and the
 * portable-data allowlist belong to the caller's domain adapter (`validateChange`).
 * Any field addition requires a new protocol version; protocol 1 rejects unknown fields.
 */

export const SYNC_PROTOCOL_VERSION = 1

export const SYNC_CHANGE_KINDS = ['fact', 'revision'] as const
export const SYNC_ENTITY_TYPES = [
  'activity-identity',
  'activity-observation',
  'activity-observer',
  'machine',
  'machine-label',
  'history-observer',
  'client',
  'project',
  'manual-entry',
  'legacy-session',
  'session-mapping',
  'session-edit',
  'session-deletion',
  'session-split',
  'legacy-reconciliation',
  'legacy-edit',
  'workspace-policy',
  'invoice',
  'invoice-line',
  'billing-reference',
  'provider-observation',
  'provider-intent'
] as const

export type SyncChangeKind = (typeof SYNC_CHANGE_KINDS)[number]
export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number]

export const SYNC_LIMITS = Object.freeze({
  /** Applies to both the compressed file and its inflated JSON. */
  maxBatchBytes: 16 * 1024 * 1024,
  maxChanges: 10_000,
  maxDependencies: 10_000,
  maxEntityIdLength: 512,
  maxPayloadDepth: 16,
  maxManifestBytes: 16 * 1024,
  maxWorkspaceNameLength: 120
})

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject
export interface JsonObject {
  [key: string]: JsonValue
}

export interface SyncChange {
  id: string
  kind: SyncChangeKind
  entityType: SyncEntityType
  entityId: string
  /** Change IDs that must be applied first. */
  dependencies: string[]
  payload: JsonObject
}

/**
 * Batch dependencies are change IDs. The sequence only orders one writer epoch's files;
 * a sequence gap never implies a dependency between batches.
 */
export interface SyncBatch {
  protocol: typeof SYNC_PROTOCOL_VERSION
  workspaceId: string
  batchId: string
  writerEpochId: string
  sequence: number
  deviceId: string
  dependencies: string[]
  changes: SyncChange[]
  /** SHA-256 (hex) of the canonical JSON of every other field. */
  checksum: string
}

export type SyncBatchInput = Omit<SyncBatch, 'protocol' | 'checksum'>

export interface EncodedSyncBatch {
  batch: SyncBatch
  bytes: Buffer
  fileName: string
}

export interface SyncChangeValidation {
  /** Domain adapter check; throw to reject the whole batch. Never apply changes here. */
  validateChange?: (change: SyncChange, batch: SyncBatch) => void
}

export interface SyncBatchReadOptions extends SyncChangeValidation {
  workspaceId: string
}

/** Immutable creation record. Never add local paths, settings or credentials. */
export interface WorkspaceManifest {
  protocol: typeof SYNC_PROTOCOL_VERSION
  workspaceId: string
  creationId: string
  createdAt: string
  name: string
}

export type SyncErrorCode =
  /** Newer protocol: pause sync and keep local capture running. */
  | 'SYNC_UPDATE_REQUIRED'
  | 'SYNC_MALFORMED'
  /** Truncated or still downloading; retry later. */
  | 'SYNC_INCOMPLETE'
  | 'SYNC_CHECKSUM_MISMATCH'
  | 'SYNC_TOO_LARGE'
  | 'SYNC_WRONG_WORKSPACE'
  | 'SYNC_INVALID_NAME'
  | 'SYNC_INVALID_FOLDER'
  | 'SYNC_FOLDER_UNAVAILABLE'
  | 'SYNC_FILE_UNAVAILABLE'
  | 'SYNC_PATH_REJECTED'
  | 'SYNC_UNRECOGNIZED_FILE'
  | 'SYNC_BATCH_CONFLICT'

export class SyncError extends AppError {
  declare readonly code: SyncErrorCode

  constructor(code: SyncErrorCode, message: string) {
    super(code, message)
    this.name = 'SyncError'
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const BATCH_KEYS = [
  'protocol',
  'workspaceId',
  'batchId',
  'writerEpochId',
  'sequence',
  'deviceId',
  'dependencies',
  'changes',
  'checksum'
]
const CHANGE_KEYS = ['id', 'kind', 'entityType', 'entityId', 'dependencies', 'payload']
const MANIFEST_KEYS = ['protocol', 'workspaceId', 'creationId', 'createdAt', 'name']
// ignoreBOM keeps a BOM in the text so JSON.parse rejects it; fatal rejects invalid UTF-8.
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export function isSyncUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function fail(message: string): never {
  throw new SyncError('SYNC_MALFORMED', message)
}

function tooLarge(label: string): SyncError {
  return new SyncError('SYNC_TOO_LARGE', `${label} exceeds the sync size limit`)
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.getOwnPropertySymbols(value).length === 0
  )
}

function assertFields(value: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(value)
  if (actual.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) {
    fail(`${label} has missing or unsupported fields`)
  }
}

/** Checks the version before anything else so newer formats are never reported as damage. */
function supportedObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) fail(`${label} must be a JSON object`)
  const { protocol } = value
  if (protocol === SYNC_PROTOCOL_VERSION) return value
  if (
    typeof protocol === 'number' &&
    Number.isSafeInteger(protocol) &&
    protocol > SYNC_PROTOCOL_VERSION
  ) {
    throw new SyncError(
      'SYNC_UPDATE_REQUIRED',
      `${label} uses sync protocol ${protocol}; update ClauTime to continue syncing`
    )
  }
  return fail(`${label} has an invalid protocol version`)
}

function assertUuid(value: unknown, label: string): string {
  if (!isSyncUuid(value)) fail(`${label} must be a lowercase UUID`)
  return value
}

function assertUuidList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > SYNC_LIMITS.maxDependencies) {
    fail(`${label} must be a list of at most ${SYNC_LIMITS.maxDependencies} IDs`)
  }
  const seen = new Set<string>()
  for (const item of value) {
    if (seen.has(assertUuid(item, label))) fail(`${label} repeats ${item}`)
    seen.add(item)
  }
  return value
}

export function assertJson(value: unknown, depth = 0): void {
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'number') {
    // Unsafe integers would silently lose precision on another computer.
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      fail('Sync payload contains an unsupported number')
    }
    return
  }
  if (typeof value === 'string') {
    if (!value.isWellFormed()) fail('Sync payload contains invalid Unicode text')
    return
  }
  if (depth >= SYNC_LIMITS.maxPayloadDepth) fail('Sync payload is nested too deeply')
  if (Array.isArray(value)) {
    for (const item of value) assertJson(item, depth + 1)
    return
  }
  if (!isPlainObject(value)) fail('Sync payload contains an unsupported value')
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key) || !key.isWellFormed()) {
      fail(`Sync payload key "${key}" is not allowed`)
    }
    assertJson(item, depth + 1)
  }
}

export function parseChange(value: unknown): SyncChange {
  if (!isPlainObject(value)) fail('Sync change must be a JSON object')
  assertFields(value, CHANGE_KEYS, 'Sync change')
  const id = assertUuid(value.id, 'Sync change ID')
  const { kind, entityType, entityId, payload } = value
  if (typeof kind !== 'string' || !(SYNC_CHANGE_KINDS as readonly string[]).includes(kind)) {
    fail(`Sync change ${id} has an unsupported kind`)
  }
  if (
    typeof entityType !== 'string' ||
    !(SYNC_ENTITY_TYPES as readonly string[]).includes(entityType)
  ) {
    fail(`Sync change ${id} has an unsupported entity type`)
  }
  if (
    typeof entityId !== 'string' ||
    !entityId ||
    entityId.length > SYNC_LIMITS.maxEntityIdLength ||
    !entityId.isWellFormed() ||
    hasControlCharacter(entityId)
  ) {
    fail(`Sync change ${id} has an invalid entity ID`)
  }
  if (assertUuidList(value.dependencies, `Sync change ${id} dependencies`).includes(id)) {
    fail(`Sync change ${id} depends on itself`)
  }
  if (!isPlainObject(payload)) fail(`Sync change ${id} payload must be a JSON object`)
  assertJson(payload, 0)
  return value as unknown as SyncChange
}

function assertBatchShape(value: unknown): SyncBatch {
  const batch = supportedObject(value, 'Sync batch')
  assertFields(batch, BATCH_KEYS, 'Sync batch')
  assertUuid(batch.workspaceId, 'Sync workspace ID')
  assertUuid(batch.batchId, 'Sync batch ID')
  assertUuid(batch.writerEpochId, 'Sync writer epoch ID')
  assertUuid(batch.deviceId, 'Sync device ID')
  const { sequence, changes, checksum } = batch
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1) {
    fail('Sync batch sequence must be a positive integer')
  }
  const dependencies = assertUuidList(batch.dependencies, 'Sync batch dependencies')
  if (!Array.isArray(changes) || !changes.length || changes.length > SYNC_LIMITS.maxChanges) {
    fail(`Sync batch must contain 1 to ${SYNC_LIMITS.maxChanges} changes`)
  }
  const ids = new Set<string>()
  for (const item of changes) {
    const { id } = parseChange(item)
    if (ids.has(id)) fail(`Sync batch repeats change ${id}`)
    ids.add(id)
  }
  if (dependencies.some((id) => ids.has(id))) fail('Sync batch depends on one of its own changes')
  if (typeof checksum !== 'string' || !CHECKSUM_PATTERN.test(checksum)) {
    fail('Sync batch checksum is invalid')
  }
  return batch as unknown as SyncBatch
}

/** Sorted keys and no whitespace, so the checksum ignores property order and formatting. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    const members = Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    return `{${members.join(',')}}`
  }
  return JSON.stringify(value)
}

/** Checksum of every batch field except `checksum`. Input must already be plain JSON data. */
export function syncBatchChecksum(batch: object): string {
  const body: Record<string, unknown> = { ...batch }
  delete body.checksum
  return createHash('sha256').update(canonicalJson(body)).digest('hex')
}

export function syncBatchFileName(batch: Pick<SyncBatch, 'sequence' | 'batchId'>): string {
  return `${batch.sequence}-${batch.batchId}.json.gz`
}

function checkChanges(batch: SyncBatch, { validateChange }: SyncChangeValidation): void {
  if (!validateChange) return
  for (const change of batch.changes) {
    try {
      validateChange(change, batch)
    } catch (error) {
      if (error instanceof SyncError) throw error
      const reason = error instanceof Error ? error.message : String(error)
      fail(`Sync change ${change.id} was rejected: ${reason}`)
    }
  }
}

/** Strict reader for already-parsed JSON: shape, checksum, workspace, then the domain hook. */
export function parseSyncBatch(value: unknown, options: SyncBatchReadOptions): SyncBatch {
  const batch = assertBatchShape(value)
  if (syncBatchChecksum(batch) !== batch.checksum) {
    throw new SyncError('SYNC_CHECKSUM_MISMATCH', 'Sync batch contents do not match its checksum')
  }
  if (batch.workspaceId !== options.workspaceId) {
    throw new SyncError('SYNC_WRONG_WORKSPACE', 'Sync batch belongs to a different shared history')
  }
  checkChanges(batch, options)
  return batch
}

function parseJsonBytes(bytes: Uint8Array, label: string): unknown {
  let text: string
  try {
    text = UTF8.decode(bytes)
  } catch {
    return fail(`${label} is not valid UTF-8`)
  }
  try {
    return JSON.parse(text)
  } catch {
    return fail(`${label} is not valid JSON`)
  }
}

export function decodeSyncBatch(bytes: Uint8Array, options: SyncBatchReadOptions): SyncBatch {
  if (!bytes.byteLength) {
    throw new SyncError('SYNC_INCOMPLETE', 'Sync batch file is empty or still downloading')
  }
  if (bytes.byteLength > SYNC_LIMITS.maxBatchBytes) throw tooLarge('Sync batch file')
  if (bytes[0] !== 0x1f || (bytes.byteLength > 1 && bytes[1] !== 0x8b)) {
    fail('Sync batch file is not gzip data')
  }
  let inflated: Buffer
  try {
    inflated = gunzipSync(bytes, { maxOutputLength: SYNC_LIMITS.maxBatchBytes })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ERR_BUFFER_TOO_LARGE') throw tooLarge('Sync batch contents')
    if (code === 'Z_BUF_ERROR') {
      throw new SyncError('SYNC_INCOMPLETE', 'Sync batch file is truncated or still downloading')
    }
    return fail('Sync batch file is damaged')
  }
  return parseSyncBatch(parseJsonBytes(inflated, 'Sync batch'), options)
}

/** Validates before writing anything; the returned batch is decoded from the output bytes. */
export function encodeSyncBatch(
  input: SyncBatchInput,
  options: SyncChangeValidation = {}
): EncodedSyncBatch {
  const unsigned = { ...input, protocol: SYNC_PROTOCOL_VERSION }
  // Validate first: canonicalJson assumes plain, acyclic JSON data.
  assertBatchShape({ ...unsigned, checksum: '0'.repeat(64) })
  const text = canonicalJson({ ...unsigned, checksum: syncBatchChecksum(unsigned) })
  if (Buffer.byteLength(text) > SYNC_LIMITS.maxBatchBytes) {
    throw tooLarge('Sync batch; split its changes into smaller batches')
  }
  const bytes = gzipSync(text)
  const batch = decodeSyncBatch(bytes, { ...options, workspaceId: input.workspaceId })
  return { batch, bytes, fileName: syncBatchFileName(batch) }
}

function isWorkspaceName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= SYNC_LIMITS.maxWorkspaceNameLength &&
    value === value.trim() &&
    value.isWellFormed() &&
    !hasControlCharacter(value)
  )
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    TIMESTAMP_PATTERN.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  )
}

export function createWorkspaceManifest(name: string, createdAt: Date): WorkspaceManifest {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (!isWorkspaceName(trimmed)) {
    throw new SyncError(
      'SYNC_INVALID_NAME',
      `Enter a history name of 1 to ${SYNC_LIMITS.maxWorkspaceNameLength} characters`
    )
  }
  const timestamp =
    createdAt instanceof Date && !Number.isNaN(createdAt.getTime()) ? createdAt.toISOString() : ''
  if (!isTimestamp(timestamp)) fail('A valid creation time is required')
  return {
    protocol: SYNC_PROTOCOL_VERSION,
    workspaceId: randomUUID(),
    creationId: randomUUID(),
    createdAt: timestamp,
    name: trimmed
  }
}

export function parseWorkspaceManifest(value: unknown, workspaceId: string): WorkspaceManifest {
  const manifest = supportedObject(value, 'Workspace manifest')
  assertFields(manifest, MANIFEST_KEYS, 'Workspace manifest')
  assertUuid(manifest.creationId, 'Workspace creation ID')
  if (assertUuid(manifest.workspaceId, 'Workspace ID') !== workspaceId) {
    fail('Workspace manifest does not match its folder')
  }
  if (!isTimestamp(manifest.createdAt)) fail('Workspace manifest has an invalid creation time')
  if (typeof manifest.name !== 'string' || !isWorkspaceName(manifest.name)) {
    fail('Workspace manifest has an invalid name')
  }
  return manifest as unknown as WorkspaceManifest
}

export function serializeWorkspaceManifest(manifest: WorkspaceManifest): string {
  return canonicalJson(manifest) + '\n'
}

export function decodeWorkspaceManifest(bytes: Uint8Array, workspaceId: string): WorkspaceManifest {
  if (!bytes.byteLength) {
    throw new SyncError('SYNC_INCOMPLETE', 'Workspace manifest is empty or still downloading')
  }
  if (bytes.byteLength > SYNC_LIMITS.maxManifestBytes) throw tooLarge('Workspace manifest')
  return parseWorkspaceManifest(parseJsonBytes(bytes, 'Workspace manifest'), workspaceId)
}
