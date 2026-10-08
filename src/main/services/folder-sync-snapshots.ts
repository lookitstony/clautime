import { createHash, randomUUID } from 'node:crypto'
import { renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { eq, inArray, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { syncBatchChanges, syncBatches, syncChanges, syncReceipts } from '../db/schema/folder-sync'
import { AppError } from '../../shared/types/ipc'
import {
  SYNC_LIMITS,
  SYNC_PROTOCOL_VERSION,
  SyncError,
  canonicalJson,
  isSyncUuid,
  parseSyncBatch,
  syncBatchChecksum,
  type SyncBatch,
  type SyncChangeValidation
} from './folder-sync-protocol'
import {
  openSyncWorkspace,
  isSyncMetadataName,
  fileUnavailable,
  verifiedDirectoryExists,
  ensureDirectory,
  readBoundedFile,
  publishImmutable,
  pathExists,
  readNames,
  type SyncFileIssue,
  type SyncWorkspaceLocation
} from './folder-sync-files'
import {
  applyReadySyncBatches,
  retainIncomingBatch,
  type SyncDomainAdapter
} from './folder-sync-store'

/*
 * Recovery snapshots (plan decision G). A snapshot physically contains the complete,
 * original immutable envelopes of every batch this computer has applied, so a blank
 * installation can restore without the original batch files. Coverage is proven only by
 * the sorted unique change IDs actually contained (count + hash); sequence numbers never
 * prove coverage. Restoring re-imports the original batches through the ordinary store,
 * so batch/change IDs are preserved and receipts deduplicate replays. Nothing here prunes.
 *
 *   <folder>/<workspaceId>/snapshots/<snapshotId>/chunk-000000.json.gz ...
 *   <folder>/<workspaceId>/snapshots/<snapshotId>/snapshot.json   (published last)
 *   <folder>/<workspaceId>/snapshots/.<snapshotId>.<random>.tmp/  (staging, ignored)
 *
 * The snapshot ID is derived from the workspace and the included batch IDs/checksums, so
 * the same applied history always republishes to the same immutable directory and a
 * directory holding different contents can never verify.
 */
const SNAPSHOTS_DIRECTORY = 'snapshots'
const MANIFEST_FILE = 'snapshot.json'
const TEMPORARY_SUFFIX = '.tmp'
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export const SYNC_SNAPSHOT_LIMITS = Object.freeze({
  /** Compressed and inflated chunk; one maximum-size batch plus its wrapper always fits. */
  maxChunkBytes: SYNC_LIMITS.maxBatchBytes + 64 * 1024,
  maxChunks: 4096,
  maxManifestBytes: 1024 * 1024,
  maxChanges: 2_000_000,
  maxTotalBytes: 1024 * 1024 * 1024
})

export interface SyncSnapshotChunkEntry {
  index: number
  batchCount: number
  /** Equals the chunk's own checksum. */
  checksum: string
}

export interface SyncSnapshotManifest {
  protocol: typeof SYNC_PROTOCOL_VERSION
  workspaceId: string
  snapshotId: string
  batchCount: number
  /** SHA-256 of canonical [batchId, checksum] pairs sorted by batch ID. */
  batchesHash: string
  /** Number of unique change IDs physically contained. */
  changeCount: number
  /** SHA-256 of the canonical sorted unique change ID list. */
  changesHash: string
  chunks: SyncSnapshotChunkEntry[]
  checksum: string
}

export interface SyncSnapshotChunk {
  protocol: typeof SYNC_PROTOCOL_VERSION
  workspaceId: string
  snapshotId: string
  index: number
  /** Complete original envelopes, sorted by writer epoch, sequence and batch ID. */
  batches: SyncBatch[]
  checksum: string
}

/** Plain JSON; deterministic for a given applied history, so it may be retained or rebuilt. */
export interface SyncSnapshotPlan {
  manifest: SyncSnapshotManifest
  chunks: SyncSnapshotChunk[]
}

/**
 * Bounded-memory form of a plan: only the gzip of each canonical chunk is kept, indexed like
 * manifest.chunks. Structured-clone/transfer safe (a Buffer arrives as a Uint8Array).
 */
export interface EncodedSyncSnapshot {
  manifest: SyncSnapshotManifest
  chunks: Uint8Array[]
}

export interface SyncSnapshotPublishResult {
  status: 'published' | 'already-published'
  snapshot: VerifiedSyncSnapshot
}

export interface VerifiedSyncSnapshot {
  manifest: SyncSnapshotManifest
  batchIds: ReadonlySet<string>
  /** Proven coverage: every change physically contained, with all its dependencies. */
  changeIds: ReadonlySet<string>
}

export interface SyncSnapshotRestoreResult {
  snapshotId: string
  /** Envelopes newly retained from the snapshot (already-known identical ones are skipped). */
  retained: number
  applied: string[]
  waiting: Array<{ batchId: string; missing: string[] }>
  errors: Array<{ batchId: string; message: string; code?: string }>
}

function rejected(path: string, reason: string): SyncError {
  return new SyncError('SYNC_PATH_REJECTED', `${reason}: ${path}`)
}

function tooLarge(label: string): SyncError {
  return new SyncError('SYNC_TOO_LARGE', `${label} exceeds the sync size limit`)
}

function conflict(path: string): SyncError {
  return new SyncError(
    'SYNC_BATCH_CONFLICT',
    `A different, damaged or incomplete file already exists and was not replaced: ${path}`
  )
}

function incomplete(message: string): SyncError {
  return new SyncError('SYNC_INCOMPLETE', message)
}

function malformed(message: string): never {
  throw new SyncError('SYNC_MALFORMED', message)
}

function mismatch(message: string): never {
  throw new SyncError('SYNC_CHECKSUM_MISMATCH', message)
}

// ---------------------------------------------------------------------------------------
// Strict format parsing. Protocol is checked first so newer formats are never "damage".

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.getOwnPropertySymbols(value).length === 0
  )
}

function supportedObject(value: unknown, label: string, keys: string[]): Record<string, unknown> {
  if (!isPlainObject(value)) malformed(`${label} must be a JSON object`)
  const { protocol } = value
  if (protocol !== SYNC_PROTOCOL_VERSION) {
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
    malformed(`${label} has an invalid protocol version`)
  }
  const actual = Object.keys(value)
  if (actual.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) {
    malformed(`${label} has missing or unsupported fields`)
  }
  return value
}

function count(value: unknown, label: string, minimum: number, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    malformed(`${label} is out of range`)
  }
  return value
}

function hash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !CHECKSUM_PATTERN.test(value)) malformed(`${label} is invalid`)
  return value
}

function uuid(value: unknown, label: string): string {
  if (!isSyncUuid(value)) malformed(`${label} must be a lowercase UUID`)
  return value
}

function parseJsonBytes(bytes: Uint8Array, label: string): unknown {
  let text: string
  try {
    text = UTF8.decode(bytes)
  } catch {
    return malformed(`${label} is not valid UTF-8`)
  }
  try {
    return JSON.parse(text)
  } catch {
    return malformed(`${label} is not valid JSON`)
  }
}

const MANIFEST_KEYS = [
  'protocol',
  'workspaceId',
  'snapshotId',
  'batchCount',
  'batchesHash',
  'changeCount',
  'changesHash',
  'chunks',
  'checksum'
]
const ENTRY_KEYS = ['index', 'batchCount', 'checksum']
const CHUNK_KEYS = ['protocol', 'workspaceId', 'snapshotId', 'index', 'batches', 'checksum']

function parseManifest(
  value: unknown,
  workspaceId: string,
  snapshotId: string
): SyncSnapshotManifest {
  const label = 'Sync snapshot manifest'
  const manifest = supportedObject(value, label, MANIFEST_KEYS)
  uuid(manifest.workspaceId, 'Sync snapshot workspace ID')
  uuid(manifest.snapshotId, 'Sync snapshot ID')
  const batchCount = count(manifest.batchCount, 'Snapshot batch count', 1, Number.MAX_SAFE_INTEGER)
  hash(manifest.batchesHash, 'Snapshot batch hash')
  count(manifest.changeCount, 'Snapshot change count', 1, SYNC_SNAPSHOT_LIMITS.maxChanges)
  hash(manifest.changesHash, 'Snapshot change hash')
  hash(manifest.checksum, 'Snapshot checksum')
  const { chunks } = manifest
  if (!Array.isArray(chunks) || !chunks.length || chunks.length > SYNC_SNAPSHOT_LIMITS.maxChunks) {
    malformed(`${label} must list 1 to ${SYNC_SNAPSHOT_LIMITS.maxChunks} chunks`)
  }
  let total = 0
  chunks.forEach((entry: unknown, position) => {
    if (!isPlainObject(entry)) malformed(`${label} has an invalid chunk entry`)
    const keys = Object.keys(entry)
    if (
      keys.length !== ENTRY_KEYS.length ||
      !ENTRY_KEYS.every((key) => Object.hasOwn(entry, key))
    ) {
      malformed(`${label} chunk entry has missing or unsupported fields`)
    }
    if (entry.index !== position) malformed(`${label} chunks are not in order`)
    total += count(entry.batchCount, 'Snapshot chunk batch count', 1, SYNC_LIMITS.maxBatchBytes)
    hash(entry.checksum, 'Snapshot chunk checksum')
  })
  if (total !== batchCount) malformed(`${label} chunk batch counts do not add up`)
  if (syncBatchChecksum(manifest) !== manifest.checksum) {
    mismatch('Sync snapshot manifest does not match its checksum')
  }
  if (manifest.workspaceId !== workspaceId) {
    throw new SyncError(
      'SYNC_WRONG_WORKSPACE',
      'Sync snapshot belongs to a different shared history'
    )
  }
  if (manifest.snapshotId !== snapshotId)
    malformed('Sync snapshot manifest does not match its folder')
  return manifest as unknown as SyncSnapshotManifest
}

function parseChunk(
  value: unknown,
  manifest: SyncSnapshotManifest,
  entry: SyncSnapshotChunkEntry,
  options: SyncChangeValidation
): SyncBatch[] {
  const chunk = supportedObject(value, 'Sync snapshot chunk', CHUNK_KEYS)
  hash(chunk.checksum, 'Snapshot chunk checksum')
  if (syncBatchChecksum(chunk) !== chunk.checksum || chunk.checksum !== entry.checksum) {
    mismatch(`Sync snapshot chunk ${entry.index} does not match its checksum`)
  }
  if (chunk.workspaceId !== manifest.workspaceId) {
    throw new SyncError(
      'SYNC_WRONG_WORKSPACE',
      'Sync snapshot belongs to a different shared history'
    )
  }
  if (chunk.snapshotId !== manifest.snapshotId || chunk.index !== entry.index) {
    malformed(`Sync snapshot chunk ${entry.index} belongs to another snapshot or position`)
  }
  const { batches } = chunk
  if (!Array.isArray(batches) || batches.length !== entry.batchCount) {
    malformed(`Sync snapshot chunk ${entry.index} has the wrong number of batches`)
  }
  return batches.map((batch) =>
    parseSyncBatch(batch, { ...options, workspaceId: manifest.workspaceId })
  )
}

function decodeChunkBytes(bytes: Uint8Array, path: string): unknown {
  if (!bytes.byteLength)
    throw incomplete(`Sync snapshot chunk is empty or still downloading: ${path}`)
  if (bytes.byteLength > SYNC_SNAPSHOT_LIMITS.maxChunkBytes) throw tooLarge('Sync snapshot chunk')
  if (bytes[0] !== 0x1f || (bytes.byteLength > 1 && bytes[1] !== 0x8b)) {
    malformed(`Sync snapshot chunk is not gzip data: ${path}`)
  }
  let inflated: Buffer
  try {
    inflated = gunzipSync(bytes, { maxOutputLength: SYNC_SNAPSHOT_LIMITS.maxChunkBytes })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ERR_BUFFER_TOO_LARGE') throw tooLarge('Sync snapshot chunk contents')
    if (code === 'Z_BUF_ERROR') {
      throw incomplete(`Sync snapshot chunk is truncated or still downloading: ${path}`)
    }
    return malformed(`Sync snapshot chunk is damaged: ${path}`)
  }
  return parseJsonBytes(inflated, 'Sync snapshot chunk')
}

// ---------------------------------------------------------------------------------------
// Coverage: computed identically by the exporter, the publisher and every receiver.

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function compareBatches(a: SyncBatch, b: SyncBatch): number {
  return (
    compareText(a.writerEpochId, b.writerEpochId) ||
    a.sequence - b.sequence ||
    compareText(a.batchId, b.batchId)
  )
}

function derivedSnapshotId(workspaceId: string, batchesHash: string): string {
  const hex = sha256(canonicalJson({ format: 'clautime-sync-snapshot', workspaceId, batchesHash }))
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** From [batchId, checksum] pairs alone, so an exporter knows the ID before reading bodies. */
function batchIdentity(workspaceId: string, pairs: Iterable<[string, string]>) {
  const sorted = [...pairs].sort((a, b) => compareText(a[0], b[0]))
  const batchesHash = sha256(canonicalJson(sorted))
  return {
    batchCount: sorted.length,
    batchesHash,
    snapshotId: derivedSnapshotId(workspaceId, batchesHash)
  }
}

class Coverage {
  readonly batches = new Map<string, string>()
  readonly changes = new Map<string, string>()
  private readonly dependencies = new Set<string>()
  private last: SyncBatch | null = null
  private bytes = 0

  add(batch: SyncBatch): void {
    if (this.batches.has(batch.batchId)) malformed(`Sync snapshot repeats batch ${batch.batchId}`)
    this.bytes += Buffer.byteLength(canonicalJson(batch))
    if (this.bytes > SYNC_SNAPSHOT_LIMITS.maxTotalBytes) throw tooLarge('Sync snapshot')
    if (this.last) {
      const order = compareBatches(this.last, batch)
      if (
        order >= 0 ||
        (this.last.writerEpochId === batch.writerEpochId && this.last.sequence === batch.sequence)
      ) {
        malformed(
          `Sync snapshot batch ${batch.batchId} is repeated, out of order or reuses a sequence`
        )
      }
    }
    this.last = batch
    this.batches.set(batch.batchId, batch.checksum)
    for (const dependency of batch.dependencies) this.dependencies.add(dependency)
    for (const change of batch.changes) {
      const digest = sha256(canonicalJson(change))
      const known = this.changes.get(change.id)
      if (known !== undefined && known !== digest) {
        malformed(`Sync snapshot holds different contents for change ${change.id}`)
      }
      this.changes.set(change.id, digest)
      for (const dependency of change.dependencies) this.dependencies.add(dependency)
    }
    if (this.changes.size > SYNC_SNAPSHOT_LIMITS.maxChanges) throw tooLarge('Sync snapshot')
  }

  summary(workspaceId: string) {
    const ids = [...this.changes.keys()].sort()
    return {
      ...batchIdentity(workspaceId, this.batches),
      changeCount: ids.length,
      changesHash: sha256(canonicalJson(ids)),
      missing: [...this.dependencies].filter((id) => !this.changes.has(id)).sort()
    }
  }
}

/** Every chunk is parsed and every coverage claim recomputed before anything is trusted. */
function verifyContents(
  manifest: SyncSnapshotManifest,
  readChunk: (entry: SyncSnapshotChunkEntry) => unknown,
  options: SyncChangeValidation
): VerifiedSyncSnapshot {
  const coverage = new Coverage()
  for (const entry of manifest.chunks) {
    for (const batch of parseChunk(readChunk(entry), manifest, entry, options)) coverage.add(batch)
  }
  const actual = coverage.summary(manifest.workspaceId)
  if (
    actual.batchCount !== manifest.batchCount ||
    actual.batchesHash !== manifest.batchesHash ||
    actual.changeCount !== manifest.changeCount ||
    actual.changesHash !== manifest.changesHash
  ) {
    mismatch('Sync snapshot contents do not match its claimed coverage')
  }
  if (actual.snapshotId !== manifest.snapshotId) {
    mismatch('Sync snapshot ID does not match its contents')
  }
  if (actual.missing.length) {
    malformed(`Sync snapshot is missing ${actual.missing.length} dependencies of its own changes`)
  }
  return {
    manifest,
    batchIds: new Set(coverage.batches.keys()),
    changeIds: new Set(coverage.changes.keys())
  }
}

/** IDs a verified snapshot does not prove covered; empty means it satisfies all of them. */
export function uncoveredBySyncSnapshot(
  snapshot: VerifiedSyncSnapshot,
  changeIds: Iterable<string>
): string[] {
  return [...new Set(changeIds)].filter((id) => !snapshot.changeIds.has(id)).sort()
}

// ---------------------------------------------------------------------------------------
// Export: one consistent read transaction over retained, applied envelopes.

/**
 * The single export implementation. Reads batch metadata first (so the snapshot ID and the
 * total size are known, and the size cap is refused before any body is read), then reads,
 * validates and groups one envelope at a time, handing each finished chunk to `emit` and
 * dropping it. Only coverage hashes survive between chunks. Every refusal is thrown before
 * this returns, so nothing emitted may be published unless a manifest is returned.
 */
function buildSyncSnapshot<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  workspaceId: string,
  options: SyncChangeValidation,
  emit: (chunk: SyncSnapshotChunk) => void
): SyncSnapshotManifest | null {
  if (!isSyncUuid(workspaceId)) {
    throw new AppError('INVALID_SYNC_WORKSPACE', 'A workspace UUID is required')
  }
  const refuse = (message: string): never => {
    throw new AppError('SYNC_SNAPSHOT_INCOMPLETE', message)
  }
  return db.transaction((tx) => {
    const included = tx
      .select({
        id: syncBatches.id,
        writerEpochId: syncBatches.writerEpochId,
        sequence: syncBatches.sequence,
        checksum: syncBatches.checksum,
        bytes: sql<number>`length(cast(${syncBatches.envelopeJson} as blob))`,
        direction: syncBatches.direction,
        receipt: syncReceipts.batchId
      })
      .from(syncBatches)
      .leftJoin(syncReceipts, eq(syncReceipts.batchId, syncBatches.id))
      .where(eq(syncBatches.workspaceId, workspaceId))
      .all()
      .filter((row) => row.direction === 'outgoing' || row.receipt !== null)
      .sort(
        (x, y) =>
          compareText(x.writerEpochId, y.writerEpochId) ||
          x.sequence - y.sequence ||
          compareText(x.id, y.id)
      )
    let declared = 0
    for (const row of included) {
      declared += Number(row.bytes)
      if (declared > SYNC_SNAPSHOT_LIMITS.maxTotalBytes) throw tooLarge('Sync snapshot')
    }
    const { snapshotId } = batchIdentity(
      workspaceId,
      included.map((row): [string, string] => [row.id, row.checksum])
    )
    const stored = new Map(
      tx
        .select({ id: syncChanges.id, origin: syncChanges.origin })
        .from(syncChanges)
        .where(eq(syncChanges.workspaceId, workspaceId))
        .all()
        .map((row) => [row.id, row])
    )
    const coverage = new Coverage()
    const entries: SyncSnapshotChunkEntry[] = []
    const budget = SYNC_SNAPSHOT_LIMITS.maxChunkBytes - 4096
    let group: SyncBatch[] = []
    let size = 0
    const flush = (): void => {
      if (!group.length) return
      const index = entries.length
      if (index >= SYNC_SNAPSHOT_LIMITS.maxChunks) throw tooLarge('Sync snapshot')
      const body: Omit<SyncSnapshotChunk, 'checksum'> = {
        protocol: SYNC_PROTOCOL_VERSION,
        workspaceId,
        snapshotId,
        index,
        batches: group
      }
      const chunk = { ...body, checksum: syncBatchChecksum(body) }
      entries.push({ index, batchCount: group.length, checksum: chunk.checksum })
      group = []
      size = 0
      emit(chunk)
    }
    for (const entry of included) {
      const row = tx.select().from(syncBatches).where(eq(syncBatches.id, entry.id)).get()!
      const batch = parseSyncBatch(JSON.parse(row.envelopeJson), { ...options, workspaceId })
      if (
        batch.batchId !== row.id ||
        batch.checksum !== row.checksum ||
        batch.writerEpochId !== row.writerEpochId ||
        batch.sequence !== row.sequence ||
        canonicalJson(batch) !== row.envelopeJson
      ) {
        refuse(`Retained batch ${row.id} does not match its record`)
      }
      const members = new Set(
        tx
          .select({ id: syncBatchChanges.changeId })
          .from(syncBatchChanges)
          .where(eq(syncBatchChanges.batchId, row.id))
          .all()
          .map((member) => member.id)
      )
      if (
        members.size !== batch.changes.length ||
        batch.changes.some((change) => !members.has(change.id))
      ) {
        refuse(`Applied batch ${row.id} does not match its recorded changes`)
      }
      const contents = new Map(
        tx
          .select({ id: syncChanges.id, json: syncChanges.changeJson })
          .from(syncChanges)
          .where(
            inArray(
              syncChanges.id,
              batch.changes.map((change) => change.id)
            )
          )
          .all()
          .map((change) => [change.id, change.json])
      )
      for (const change of batch.changes) {
        if (!stored.has(change.id) || contents.get(change.id) !== canonicalJson(change)) {
          refuse(`Applied change ${change.id} is missing or differs from its batch`)
        }
      }
      coverage.add(batch)
      const length = Buffer.byteLength(row.envelopeJson) + 1
      if (size + length > budget) flush()
      group.push(batch)
      size += length
    }
    flush()
    const uncovered = [...stored.values()].filter((row) => !coverage.changes.has(row.id))
    const local = uncovered.filter((row) => row.origin === 'local').length
    if (local) {
      throw new AppError(
        'SYNC_SNAPSHOT_UNBATCHED',
        `${local} local changes are not in an outgoing batch yet; assemble them before a snapshot`
      )
    }
    if (uncovered.length) refuse(`${uncovered.length} imported changes have no applied batch`)
    if (!entries.length) return null
    const summary = coverage.summary(workspaceId)
    if (summary.missing.length) {
      refuse(`Applied history is missing ${summary.missing.length} dependencies`)
    }
    if (summary.snapshotId !== snapshotId) {
      refuse('Retained batch records do not match their envelopes')
    }
    const body: Omit<SyncSnapshotManifest, 'checksum'> = {
      protocol: SYNC_PROTOCOL_VERSION,
      workspaceId,
      snapshotId,
      batchCount: summary.batchCount,
      batchesHash: summary.batchesHash,
      changeCount: summary.changeCount,
      changesHash: summary.changesHash,
      chunks: entries
    }
    return { ...body, checksum: syncBatchChecksum(body) }
  })
}

/**
 * Builds a snapshot of every applied batch (outgoing, or incoming with a receipt). Unapplied
 * pending envelopes are excluded. Refuses (SYNC_SNAPSHOT_UNBATCHED) while local changes are
 * not yet in an outgoing batch: call assembleOutgoingBatch until it returns null first.
 * Refuses (SYNC_SNAPSHOT_INCOMPLETE) when a retained body, membership or dependency is
 * missing or inconsistent. Returns null when nothing has been applied yet. Holds every parsed
 * batch; production export should use exportEncodedSyncSnapshot.
 */
export function exportSyncSnapshot<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  workspaceId: string,
  options: SyncChangeValidation = {}
): SyncSnapshotPlan | null {
  const chunks: SyncSnapshotChunk[] = []
  const manifest = buildSyncSnapshot(db, workspaceId, options, (chunk) => chunks.push(chunk))
  return manifest && { manifest, chunks }
}

/**
 * Same snapshot, refusals and bytes as exportSyncSnapshot, but each chunk is gzipped as soon as
 * it is complete and only the compressed bytes are kept: at most one chunk of parsed batches
 * and JSON is alive at a time, and the kept bytes stay under the total snapshot cap.
 */
export function exportEncodedSyncSnapshot<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  workspaceId: string,
  options: SyncChangeValidation = {}
): EncodedSyncSnapshot | null {
  const chunks: Uint8Array[] = []
  let total = 0
  const manifest = buildSyncSnapshot(db, workspaceId, options, (chunk) => {
    const encoded = gzipSync(canonicalJson(chunk))
    total += encoded.byteLength
    if (total > SYNC_SNAPSHOT_LIMITS.maxTotalBytes) throw tooLarge('Sync snapshot')
    chunks.push(encoded)
  })
  return manifest && { manifest, chunks }
}

// ---------------------------------------------------------------------------------------
// Folder publication and reading.

const chunkFileName = (index: number): string => `chunk-${String(index).padStart(6, '0')}.json.gz`

/** Re-resolved on every call; `existing` also requires both folders to be real directories. */
function snapshotDirectory(
  location: SyncWorkspaceLocation,
  snapshotId: string,
  mode: 'existing' | 'create' | 'resolve'
): { workspaceId: string; path: string } {
  if (!isSyncUuid(snapshotId)) throw rejected(String(snapshotId), 'Invalid sync snapshot ID')
  const { manifest, directory } = openSyncWorkspace(location)
  const snapshots = join(directory, SNAPSHOTS_DIRECTORY)
  const path = join(snapshots, snapshotId)
  if (mode === 'create') {
    ensureDirectory(snapshots)
  } else if (
    mode === 'existing' &&
    (!verifiedDirectoryExists(snapshots) || !verifiedDirectoryExists(path))
  ) {
    throw new SyncError('SYNC_FILE_UNAVAILABLE', `Sync snapshot ${snapshotId} is not in the folder`)
  }
  return { workspaceId: manifest.workspaceId, path }
}

/**
 * Writes every missing file without replacing anything and reads each back; any different
 * existing file is a conflict and is left untouched. True when the manifest was new here.
 */
function publishFiles(
  path: string,
  workspaceId: string,
  manifest: SyncSnapshotManifest,
  encoded: Uint8Array[]
): boolean {
  for (const entry of manifest.chunks) {
    const file = join(path, chunkFileName(entry.index))
    const published = publishImmutable(path, chunkFileName(entry.index), encoded[entry.index])
    try {
      parseChunk(readChunkAt(path, entry), manifest, entry, {})
    } catch (error) {
      if (published) throw fileUnavailable(file, error)
      throw conflict(file)
    }
  }
  const file = join(path, MANIFEST_FILE)
  const published = publishImmutable(
    path,
    MANIFEST_FILE,
    Buffer.from(canonicalJson(manifest) + '\n')
  )
  let existing: SyncSnapshotManifest
  try {
    existing = readManifestAt(path, workspaceId, manifest.snapshotId)
  } catch (error) {
    if (published) throw fileUnavailable(file, error)
    throw conflict(file)
  }
  if (existing.checksum !== manifest.checksum) throw conflict(file)
  return published
}

function readExisting(path: string, maxBytes: number, label: string): Buffer {
  if (!pathExists(path)) throw incomplete(`${label} is missing or still syncing: ${path}`)
  return readBoundedFile(path, maxBytes)
}

function readManifestAt(path: string, workspaceId: string, snapshotId: string) {
  const file = join(path, MANIFEST_FILE)
  const bytes = readExisting(file, SYNC_SNAPSHOT_LIMITS.maxManifestBytes, 'Sync snapshot manifest')
  if (!bytes.byteLength) throw incomplete(`Sync snapshot manifest is empty: ${file}`)
  return parseManifest(parseJsonBytes(bytes, 'Sync snapshot manifest'), workspaceId, snapshotId)
}

function readChunkAt(path: string, entry: SyncSnapshotChunkEntry): unknown {
  const file = join(path, chunkFileName(entry.index))
  const bytes = readExisting(file, SYNC_SNAPSHOT_LIMITS.maxChunkBytes, 'Sync snapshot chunk')
  return decodeChunkBytes(bytes, file)
}

/**
 * Reads and verifies a whole snapshot. A missing manifest or chunk is SYNC_INCOMPLETE,
 * a newer format SYNC_UPDATE_REQUIRED; nothing is trusted until every check passes.
 */
export function verifySyncSnapshot(
  location: SyncWorkspaceLocation,
  snapshotId: string,
  options: SyncChangeValidation = {}
): VerifiedSyncSnapshot {
  const { workspaceId, path } = snapshotDirectory(location, snapshotId, 'existing')
  const manifest = readManifestAt(path, workspaceId, snapshotId)
  return verifyContents(manifest, (entry) => readChunkAt(path, entry), options)
}

/** Read-only streaming for the file worker; all coverage is verified before the first batch. */
export function* readVerifiedSnapshotBatches(
  location: SyncWorkspaceLocation,
  snapshotId: string,
  options: SyncChangeValidation = {}
): Generator<SyncBatch> {
  const verified = verifySyncSnapshot(location, snapshotId, options)
  const { path } = snapshotDirectory(location, snapshotId, 'existing')
  for (const entry of verified.manifest.chunks)
    yield* parseChunk(readChunkAt(path, entry), verified.manifest, entry, options)
}

/** Manifest-level listing only; call verifySyncSnapshot before relying on one. */
export function listSyncSnapshots(location: SyncWorkspaceLocation): {
  snapshots: SyncSnapshotManifest[]
  issues: SyncFileIssue[]
} {
  const { manifest, directory } = openSyncWorkspace(location)
  const snapshots: SyncSnapshotManifest[] = []
  const issues: SyncFileIssue[] = []
  const root = join(directory, SNAPSHOTS_DIRECTORY)
  if (!verifiedDirectoryExists(root)) return { snapshots, issues }
  for (const name of readNames(root).sort()) {
    const path = join(root, name)
    if (name.endsWith(TEMPORARY_SUFFIX) || isSyncMetadataName(name)) continue
    if (!isSyncUuid(name)) {
      const message = `Unrecognized sync item was not read: ${path}`
      issues.push({ path, error: new SyncError('SYNC_UNRECOGNIZED_FILE', message) })
      continue
    }
    try {
      if (!verifiedDirectoryExists(path)) continue
      snapshots.push(readManifestAt(path, manifest.workspaceId, name))
    } catch (error) {
      issues.push({ path, error: fileUnavailable(path, error) })
    }
  }
  return { snapshots, issues }
}

/**
 * Verifies the plan as a receiver would, then writes and reads back every chunk and the
 * manifest in an ignored `.tmp` sibling folder that is renamed to the final ID only once
 * complete, so a terminated publisher never leaves an incomplete snapshot folder. A folder
 * rename never replaces a non-empty one: when the final folder already exists (another
 * publisher won, or an older version left it partial) missing files are added without
 * replacing anything. Republishing the same plan is already-published; any different
 * existing file is a conflict and is left untouched.
 */
export function publishSyncSnapshot(
  location: SyncWorkspaceLocation,
  plan: SyncSnapshotPlan
): SyncSnapshotPublishResult {
  const { workspaceId, manifest } = publicationManifest(location, plan?.manifest, plan?.chunks)
  const encoded = plan.chunks.map((chunk) => gzipSync(canonicalJson(chunk)))
  return publishEncoded(location, workspaceId, manifest, encoded)
}

/**
 * publishSyncSnapshot for exportEncodedSyncSnapshot output: the exact compressed bytes are
 * verified as a receiver would (decoded one chunk at a time) and then written unchanged.
 */
export function publishEncodedSyncSnapshot(
  location: SyncWorkspaceLocation,
  snapshot: EncodedSyncSnapshot
): SyncSnapshotPublishResult {
  const chunks = snapshot?.chunks
  const { workspaceId, manifest } = publicationManifest(location, snapshot?.manifest, chunks)
  if (!chunks.every((bytes) => bytes instanceof Uint8Array)) {
    malformed('Sync snapshot chunks must be encoded bytes')
  }
  return publishEncoded(location, workspaceId, manifest, chunks)
}

/**
 * Bounded-memory export plus publication. Null when nothing has been applied yet; every
 * export refusal is thrown before anything is written to the folder.
 */
export function exportAndPublishSyncSnapshot<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  location: SyncWorkspaceLocation,
  options: SyncChangeValidation = {}
): SyncSnapshotPublishResult | null {
  const snapshot = exportEncodedSyncSnapshot(db, location.workspaceId, options)
  return snapshot && publishEncodedSyncSnapshot(location, snapshot)
}

function publicationManifest(
  location: SyncWorkspaceLocation,
  value: SyncSnapshotManifest | undefined,
  chunks: unknown
): { workspaceId: string; manifest: SyncSnapshotManifest } {
  const snapshotId = String(value?.snapshotId)
  const { workspaceId } = snapshotDirectory(location, snapshotId, 'resolve')
  // Round-trip through JSON so the plan is checked exactly as a receiver would see it.
  const manifest = parseManifest(JSON.parse(canonicalJson(value)), workspaceId, snapshotId)
  if (!Array.isArray(chunks) || chunks.length !== manifest.chunks.length) {
    malformed('Sync snapshot plan does not match its manifest')
  }
  return { workspaceId, manifest }
}

function publishEncoded(
  location: SyncWorkspaceLocation,
  workspaceId: string,
  manifest: SyncSnapshotManifest,
  encoded: Uint8Array[]
): SyncSnapshotPublishResult {
  const { snapshotId } = manifest
  verifyContents(manifest, (entry) => decodeChunkBytes(encoded[entry.index], 'plan'), {})
  const { path } = snapshotDirectory(location, snapshotId, 'create')
  if (!verifiedDirectoryExists(path)) {
    const staging = join(dirname(path), `.${snapshotId}.${randomUUID()}${TEMPORARY_SUFFIX}`)
    let renamed = false
    try {
      ensureDirectory(staging)
      publishFiles(staging, workspaceId, manifest, encoded)
      try {
        renameSync(staging, path)
        renamed = true
      } catch (error) {
        if (!verifiedDirectoryExists(path)) throw fileUnavailable(path, error)
      }
    } finally {
      try {
        rmSync(staging, { recursive: true, force: true })
      } catch {
        // Listings ignore leftover temporary folders.
      }
    }
    if (renamed) {
      return { status: 'published', snapshot: verifySyncSnapshot(location, snapshotId) }
    }
  }
  const published = publishFiles(path, workspaceId, manifest, encoded)
  return {
    status: published ? 'published' : 'already-published',
    snapshot: verifySyncSnapshot(location, manifest.snapshotId)
  }
}

/**
 * Verifies the entire snapshot, then retains its original envelopes as incoming batches and
 * applies whatever is ready through the ordinary store (atomic receipts, no provider calls).
 * Chunks are re-read and must still match the verified manifest checksums. Applying also
 * lets folder batches that were waiting on covered dependencies proceed.
 */
export function restoreSyncSnapshot<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  location: SyncWorkspaceLocation,
  snapshotId: string,
  adapter: SyncDomainAdapter,
  heldBatchIds: ReadonlySet<string> = new Set()
): SyncSnapshotRestoreResult {
  const options: SyncChangeValidation = { validateChange: (change) => adapter.validate(change) }
  const verified = verifySyncSnapshot(location, snapshotId, options)
  const { workspaceId, path } = snapshotDirectory(location, snapshotId, 'existing')
  const held = new Set<string>(heldBatchIds)
  const errors: SyncSnapshotRestoreResult['errors'] = []
  let retained = 0
  for (const entry of verified.manifest.chunks) {
    const batches = parseChunk(readChunkAt(path, entry), verified.manifest, entry, options)
    for (const batch of batches) {
      try {
        if (retainIncomingBatch(db, workspaceId, batch, adapter)) retained++
      } catch (error) {
        held.add(batch.batchId)
        errors.push({
          batchId: batch.batchId,
          message: error instanceof Error ? error.message : 'Unable to retain batch',
          ...(error instanceof AppError ? { code: error.code } : {})
        })
      }
    }
  }
  const applied = applyReadySyncBatches(db, workspaceId, adapter, held)
  return {
    snapshotId,
    retained,
    applied: applied.applied,
    waiting: applied.waiting,
    errors: [...errors, ...applied.errors]
  }
}
