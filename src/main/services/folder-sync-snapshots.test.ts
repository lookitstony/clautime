// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { syncBatches, syncChanges, syncRecordStates } from '../db/schema/folder-sync'
import { createSyncWorkspace, scanSyncBatches } from './folder-sync-files'
import {
  canonicalJson,
  encodeSyncBatch,
  syncBatchChecksum,
  type SyncBatch,
  type SyncChange
} from './folder-sync-protocol'
import {
  applyReadySyncBatches,
  assembleOutgoingBatch,
  recordLocalSyncChanges,
  retainIncomingBatch,
  type SyncDomainAdapter
} from './folder-sync-store'
import { runFolderSync } from './folder-sync-runner'
import {
  exportAndPublishSyncSnapshot,
  exportEncodedSyncSnapshot,
  exportSyncSnapshot,
  listSyncSnapshots,
  publishEncodedSyncSnapshot,
  publishSyncSnapshot,
  restoreSyncSnapshot,
  uncoveredBySyncSnapshot,
  verifySyncSnapshot,
  type SyncSnapshotPlan
} from './folder-sync-snapshots'

// Lets a test play a concurrent publisher that finishes just before this one renames.
const race = vi.hoisted(() => ({ beforeRename: null as null | ((target: string) => void) }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      const hook = race.beforeRename
      race.beforeRename = null
      hook?.(to)
      return actual.renameSync(from, to)
    }
  }
})

let root: string
let workspaceId: string
let location: { folder: string; workspaceId: string }
let a: ReturnType<typeof drizzle>
const opened: Database.Database[] = []
const writerA = { writerEpochId: randomUUID(), deviceId: randomUUID() }
const writerB = { writerEpochId: randomUUID(), deviceId: randomUUID() }

function safe(path: string): string {
  const absolute = resolve(path)
  if (!absolute.startsWith(resolve(root) + sep)) throw new Error('Path outside fixture')
  return absolute
}
function database() {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  opened.push(sqlite)
  const db = drizzle(sqlite)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  return db
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clautime-sync-snapshots-'))
  workspaceId = createSyncWorkspace(root, 'Disposable shared history').manifest.workspaceId
  location = { folder: root, workspaceId }
  a = database()
})
afterEach(() => {
  race.beforeRename = null
  for (const db of opened.splice(0)) db.close()
  const target = resolve(root)
  if (
    !target.startsWith(resolve(tmpdir()) + sep) ||
    !basename(target).startsWith('clautime-sync-snapshots-')
  )
    throw new Error('Invalid cleanup target')
  rmSync(target, { recursive: true, force: true })
})

const adapter: SyncDomainAdapter = {
  validate(change) {
    if (
      change.kind !== 'fact' ||
      change.entityType !== 'legacy-session' ||
      Object.keys(change.payload).join(',') !== 'value' ||
      !Number.isSafeInteger(change.payload.value)
    )
      throw new Error('Not an allowlisted fixture record')
  },
  apply(tx, workspace, change) {
    tx.insert(syncRecordStates)
      .values({
        workspaceId: workspace,
        entityType: change.entityType,
        entityId: change.entityId,
        stateJson: JSON.stringify(change.payload)
      })
      .run()
  }
}
function change(value: number, dependencies: string[] = []): SyncChange {
  const id = randomUUID()
  return {
    id,
    kind: 'fact',
    entityType: 'legacy-session',
    entityId: id,
    dependencies,
    payload: { value }
  }
}
function batch(changes: SyncChange[], sequence: number, writer = writerB): SyncBatch {
  return encodeSyncBatch({
    workspaceId,
    batchId: randomUUID(),
    ...writer,
    sequence,
    dependencies: [],
    changes
  }).batch
}
const values = (db: ReturnType<typeof drizzle>) =>
  db
    .select()
    .from(syncRecordStates)
    .all()
    .map((row) => JSON.parse(row.stateJson).value)
    .sort((x, y) => x - y)
const batchIds = (db: ReturnType<typeof drizzle>) =>
  db
    .select({ id: syncBatches.id })
    .from(syncBatches)
    .all()
    .map((row) => row.id)
    .sort()
function codeOf(action: () => unknown): string | undefined {
  try {
    action()
  } catch (error) {
    return (error as { code?: string }).code
  }
  return undefined
}
const snapshotPath = (id: string, name = '') =>
  safe(join(root, workspaceId, 'snapshots', id, ...(name ? [name] : [])))
const MANIFEST = 'snapshot.json'
const CHUNK = 'chunk-000000.json.gz'

function publishedPlan(): SyncSnapshotPlan {
  const plan = exportSyncSnapshot(a, workspaceId)
  if (!plan) throw new Error('Expected a snapshot')
  publishSyncSnapshot(location, plan)
  return plan
}
function rewriteManifest(
  id: string,
  edit: (manifest: Record<string, unknown>) => void,
  sign = true
) {
  const manifest = JSON.parse(readFileSync(snapshotPath(id, MANIFEST), 'utf8'))
  edit(manifest)
  if (sign) manifest.checksum = syncBatchChecksum(manifest)
  writeFileSync(snapshotPath(id, MANIFEST), canonicalJson(manifest))
}

it('restores a blank database with original IDs after every batch file is deleted', () => {
  const first = change(1)
  recordLocalSyncChanges(a, workspaceId, [first], adapter)
  runFolderSync(a, location, writerA, adapter)
  recordLocalSyncChanges(a, workspaceId, [change(2, [first.id])], adapter)
  expect(runFolderSync(a, location, writerA, adapter).status).toBe('idle')

  const plan = exportSyncSnapshot(a, workspaceId)!
  expect(plan.manifest).toMatchObject({ batchCount: 2, changeCount: 2 })
  expect(exportSyncSnapshot(a, workspaceId)).toEqual(plan)
  expect(publishSyncSnapshot(location, plan).status).toBe('published')
  expect(publishSyncSnapshot(location, plan).status).toBe('already-published')
  expect(listSyncSnapshots(location)).toEqual({ snapshots: [plan.manifest], issues: [] })

  rmSync(safe(join(root, workspaceId, 'writers')), { recursive: true })
  const restored = database()
  expect(runFolderSync(restored, location, writerB, adapter).imported).toBe(0)
  expect(restoreSyncSnapshot(restored, location, plan.manifest.snapshotId, adapter)).toMatchObject({
    retained: 2,
    waiting: [],
    errors: []
  })
  expect(values(restored)).toEqual([1, 2])
  expect(batchIds(restored)).toEqual(batchIds(a))
  const changeIds = (db: ReturnType<typeof drizzle>) =>
    db
      .select({ id: syncChanges.id })
      .from(syncChanges)
      .all()
      .map((row) => row.id)
      .sort()
  expect(changeIds(restored)).toEqual(changeIds(a))

  // Replays deduplicate by batch ID and receipt.
  expect(restoreSyncSnapshot(restored, location, plan.manifest.snapshotId, adapter)).toMatchObject({
    retained: 0,
    applied: []
  })
  expect(values(restored)).toEqual([1, 2])
  // The restored computer can republish the missing original batch files unchanged.
  expect(runFolderSync(restored, location, writerB, adapter)).toMatchObject({ repaired: 2 })
  expect(
    scanSyncBatches(location)
      .batches.map((entry) => entry.batch.batchId)
      .sort()
  ).toEqual(batchIds(a))
})

it('satisfies a waiting dependency only when a verified snapshot proves coverage', () => {
  const first = change(1)
  recordLocalSyncChanges(a, workspaceId, [first], adapter)
  runFolderSync(a, location, writerA, adapter)
  const plan = publishedPlan()
  const second = change(2, [first.id])
  recordLocalSyncChanges(a, workspaceId, [second], adapter)
  runFolderSync(a, location, writerA, adapter)
  for (const entry of scanSyncBatches(location).batches)
    if (entry.batch.changes.some((item) => item.id === first.id))
      for (const path of entry.paths) rmSync(safe(path))

  const blank = database()
  expect(runFolderSync(blank, location, writerB, adapter)).toMatchObject({
    status: 'incomplete',
    imported: 0,
    waiting: [{ missing: [first.id] }]
  })
  const verified = verifySyncSnapshot(location, plan.manifest.snapshotId)
  expect(uncoveredBySyncSnapshot(verified, [first.id])).toEqual([])
  expect(uncoveredBySyncSnapshot(verified, [first.id, second.id])).toEqual([second.id])
  const result = restoreSyncSnapshot(blank, location, plan.manifest.snapshotId, adapter)
  expect(result.applied).toHaveLength(2)
  expect(result.waiting).toEqual([])
  expect(values(blank)).toEqual([1, 2])
})

it('refuses unbatched local work, excludes pending envelopes, and rejects missing bodies', () => {
  recordLocalSyncChanges(a, workspaceId, [change(1)], adapter)
  expect(codeOf(() => exportSyncSnapshot(a, workspaceId))).toBe('SYNC_SNAPSHOT_UNBATCHED')
  assembleOutgoingBatch(a, workspaceId, writerA)
  const plan = exportSyncSnapshot(a, workspaceId)!
  expect(plan.manifest.batchCount).toBe(1)

  const b = database()
  const first = change(10)
  const independent = batch([first], 1)
  const dependent = batch([change(11, [first.id])], 2)
  retainIncomingBatch(b, workspaceId, dependent, adapter)
  applyReadySyncBatches(b, workspaceId, adapter)
  expect(exportSyncSnapshot(b, workspaceId)).toBeNull()
  retainIncomingBatch(b, workspaceId, independent, adapter)
  applyReadySyncBatches(b, workspaceId, adapter)
  expect(exportSyncSnapshot(b, workspaceId)?.manifest.batchCount).toBe(2)
  // A dependency whose applied batch is no longer provable is never silently omitted.
  opened[1].exec('DROP TRIGGER sync_receipt_no_delete')
  opened[1].prepare('DELETE FROM sync_receipts WHERE batch_id = ?').run(independent.batchId)
  expect(codeOf(() => exportSyncSnapshot(b, workspaceId))).toBe('SYNC_SNAPSHOT_INCOMPLETE')

  opened[0].exec('DROP TRIGGER sync_batch_change_no_delete')
  opened[0].prepare('DELETE FROM sync_batch_changes').run()
  expect(codeOf(() => exportSyncSnapshot(a, workspaceId))).toBe('SYNC_SNAPSHOT_INCOMPLETE')
})

it('exports the same snapshot in bounded form and publishes identical files', () => {
  expect(exportEncodedSyncSnapshot(a, workspaceId)).toBeNull()
  expect(exportAndPublishSyncSnapshot(a, location)).toBeNull()
  const first = change(1)
  recordLocalSyncChanges(a, workspaceId, [first], adapter)
  runFolderSync(a, location, writerA, adapter)
  retainIncomingBatch(a, workspaceId, batch([change(2, [first.id])], 1), adapter)
  applyReadySyncBatches(a, workspaceId, adapter)
  recordLocalSyncChanges(a, workspaceId, [change(3)], adapter)
  runFolderSync(a, location, writerA, adapter)

  const plan = exportSyncSnapshot(a, workspaceId)!
  expect(plan.manifest).toMatchObject({ batchCount: 3, changeCount: 3 })
  const encoded = exportEncodedSyncSnapshot(a, workspaceId)!
  expect(encoded.manifest).toEqual(plan.manifest)
  expect(encoded.chunks).toHaveLength(plan.chunks.length)
  encoded.chunks.forEach((bytes, index) => {
    expect(Buffer.from(bytes)).toEqual(gzipSync(canonicalJson(plan.chunks[index])))
    expect(JSON.parse(gunzipSync(bytes).toString('utf8'))).toEqual(plan.chunks[index])
  })

  // Crossing a worker boundary turns Buffers into plain Uint8Arrays.
  const published = publishEncodedSyncSnapshot(location, structuredClone(encoded))
  expect(published.status).toBe('published')
  expect(published.snapshot.manifest).toEqual(plan.manifest)
  const id = plan.manifest.snapshotId
  expect(readdirSync(snapshotPath(id)).sort()).toEqual([CHUNK, MANIFEST])
  expect(readFileSync(snapshotPath(id, CHUNK))).toEqual(Buffer.from(encoded.chunks[0]))
  expect(publishSyncSnapshot(location, plan).status).toBe('already-published')
  expect(exportAndPublishSyncSnapshot(a, location)?.status).toBe('already-published')
  expect(listSyncSnapshots(location)).toEqual({ snapshots: [plan.manifest], issues: [] })

  const blank = database()
  expect(restoreSyncSnapshot(blank, location, id, adapter)).toMatchObject({
    retained: 3,
    waiting: [],
    errors: []
  })
  expect(values(blank)).toEqual([1, 2, 3])
})

it('refuses bounded export and publication atomically on bad membership or unbatched work', () => {
  const snapshots = safe(join(root, workspaceId, 'snapshots'))
  recordLocalSyncChanges(a, workspaceId, [change(1)], adapter)
  expect(codeOf(() => exportEncodedSyncSnapshot(a, workspaceId))).toBe('SYNC_SNAPSHOT_UNBATCHED')
  expect(codeOf(() => exportAndPublishSyncSnapshot(a, location))).toBe('SYNC_SNAPSHOT_UNBATCHED')
  expect(existsSync(snapshots)).toBe(false)

  runFolderSync(a, location, writerA, adapter)
  const encoded = exportEncodedSyncSnapshot(a, workspaceId)!
  // Bytes that do not decode to the manifest's chunk are refused before any folder exists.
  const forged = { manifest: encoded.manifest, chunks: [gzipSync('{}')] }
  expect(codeOf(() => publishEncodedSyncSnapshot(location, forged))).toBe('SYNC_MALFORMED')
  const extra = { manifest: encoded.manifest, chunks: [...encoded.chunks, ...encoded.chunks] }
  expect(codeOf(() => publishEncodedSyncSnapshot(location, extra))).toBe('SYNC_MALFORMED')
  expect(existsSync(snapshots)).toBe(false)

  opened[0].exec('DROP TRIGGER sync_batch_change_no_delete')
  opened[0].prepare('DELETE FROM sync_batch_changes').run()
  expect(codeOf(() => exportEncodedSyncSnapshot(a, workspaceId))).toBe('SYNC_SNAPSHOT_INCOMPLETE')
  expect(codeOf(() => exportAndPublishSyncSnapshot(a, location))).toBe('SYNC_SNAPSHOT_INCOMPLETE')
  expect(existsSync(snapshots)).toBe(false)
})

it('keeps partial snapshot copies visibly incomplete and never publishes over them', () => {
  recordLocalSyncChanges(a, workspaceId, [change(1)], adapter)
  runFolderSync(a, location, writerA, adapter)
  const plan = publishedPlan()
  const id = plan.manifest.snapshotId
  const blank = database()
  const chunk = readFileSync(snapshotPath(id, CHUNK))

  rmSync(snapshotPath(id, MANIFEST))
  expect(codeOf(() => verifySyncSnapshot(location, id))).toBe('SYNC_INCOMPLETE')
  expect(listSyncSnapshots(location).issues.map((issue) => issue.error.code)).toEqual([
    'SYNC_INCOMPLETE'
  ])
  expect(codeOf(() => restoreSyncSnapshot(blank, location, id, adapter))).toBe('SYNC_INCOMPLETE')
  expect(batchIds(blank)).toEqual([])

  // A damaged chunk is not replaced and the manifest is not published after it.
  writeFileSync(snapshotPath(id, CHUNK), chunk.subarray(0, 12))
  expect(codeOf(() => publishSyncSnapshot(location, plan))).toBe('SYNC_BATCH_CONFLICT')
  expect(readFileSync(snapshotPath(id, CHUNK))).toEqual(chunk.subarray(0, 12))
  expect(existsSync(snapshotPath(id, MANIFEST))).toBe(false)

  rmSync(snapshotPath(id, CHUNK))
  expect(publishSyncSnapshot(location, plan).status).toBe('published')
  writeFileSync(snapshotPath(id, CHUNK), chunk.subarray(0, 12))
  expect(codeOf(() => verifySyncSnapshot(location, id))).toBe('SYNC_INCOMPLETE')
  rmSync(snapshotPath(id, CHUNK))
  expect(codeOf(() => restoreSyncSnapshot(blank, location, id, adapter))).toBe('SYNC_INCOMPLETE')
  expect(batchIds(blank)).toEqual([])
  expect(values(blank)).toEqual([])
})

it('ignores an interrupted temporary snapshot folder and publishes atomically beside it', () => {
  recordLocalSyncChanges(a, workspaceId, [change(1)], adapter)
  runFolderSync(a, location, writerA, adapter)
  const plan = exportSyncSnapshot(a, workspaceId)!
  const id = plan.manifest.snapshotId
  const snapshots = safe(join(root, workspaceId, 'snapshots'))
  // A publisher terminated mid-write leaves only its staging folder, never the final one.
  const leftover = `.${id}.${randomUUID()}.tmp`
  mkdirSync(join(snapshots, leftover), { recursive: true })
  writeFileSync(join(snapshots, leftover, CHUNK), gzipSync('{"partial":').subarray(0, 12))

  expect(listSyncSnapshots(location)).toEqual({ snapshots: [], issues: [] })
  expect(codeOf(() => verifySyncSnapshot(location, id))).toBe('SYNC_FILE_UNAVAILABLE')
  expect(publishSyncSnapshot(location, plan).status).toBe('published')
  expect(readdirSync(snapshots).sort()).toEqual([leftover, id].sort())
  expect(readdirSync(snapshotPath(id)).sort()).toEqual([CHUNK, MANIFEST])
  expect(listSyncSnapshots(location)).toEqual({ snapshots: [plan.manifest], issues: [] })
  expect(publishSyncSnapshot(location, plan).status).toBe('already-published')
})

it('never replaces an existing damaged, conflicting or concurrently published snapshot', () => {
  recordLocalSyncChanges(a, workspaceId, [change(1)], adapter)
  runFolderSync(a, location, writerA, adapter)
  const plan = publishedPlan()
  const id = plan.manifest.snapshotId
  const snapshots = safe(join(root, workspaceId, 'snapshots'))
  const chunk = readFileSync(snapshotPath(id, CHUNK))
  const manifest = readFileSync(snapshotPath(id, MANIFEST))
  const unchanged = (files: Record<string, Uint8Array>) => {
    for (const [name, bytes] of Object.entries(files))
      expect(readFileSync(snapshotPath(id, name))).toEqual(Buffer.from(bytes))
    expect(readdirSync(snapshots)).toEqual([id])
  }

  // A re-signed manifest claiming different coverage.
  rewriteManifest(id, (edit) => (edit.changeCount = 2))
  const forged = readFileSync(snapshotPath(id, MANIFEST))
  expect(codeOf(() => publishSyncSnapshot(location, plan))).toBe('SYNC_BATCH_CONFLICT')
  unchanged({ [CHUNK]: chunk, [MANIFEST]: forged })

  // A damaged chunk under an otherwise valid manifest.
  writeFileSync(snapshotPath(id, MANIFEST), manifest)
  writeFileSync(snapshotPath(id, CHUNK), chunk.subarray(0, 12))
  expect(codeOf(() => publishSyncSnapshot(location, plan))).toBe('SYNC_BATCH_CONFLICT')
  unchanged({ [CHUNK]: chunk.subarray(0, 12), [MANIFEST]: manifest })

  // A file where the final folder belongs is rejected, not replaced.
  rmSync(snapshotPath(id), { recursive: true })
  writeFileSync(snapshotPath(id), 'not a snapshot')
  expect(codeOf(() => publishSyncSnapshot(location, plan))).toBe('SYNC_PATH_REJECTED')
  expect(readFileSync(snapshotPath(id), 'utf8')).toBe('not a snapshot')
  expect(readdirSync(snapshots)).toEqual([id])
  rmSync(snapshotPath(id))

  // Another publisher completes the same snapshot while this one is staged.
  const winner = (files: Record<string, Uint8Array>) => (target: string) => {
    mkdirSync(target)
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(target, name), bytes)
  }
  race.beforeRename = winner({ [CHUNK]: chunk, [MANIFEST]: manifest })
  expect(publishSyncSnapshot(location, plan).status).toBe('already-published')
  unchanged({ [CHUNK]: chunk, [MANIFEST]: manifest })

  // A different concurrent winner is kept and reported as a conflict.
  rmSync(snapshotPath(id), { recursive: true })
  race.beforeRename = winner({ [CHUNK]: chunk, [MANIFEST]: forged })
  expect(codeOf(() => publishSyncSnapshot(location, plan))).toBe('SYNC_BATCH_CONFLICT')
  unchanged({ [CHUNK]: chunk, [MANIFEST]: forged })
})

it('rejects wrong coverage, checksums, workspace, IDs and newer protocols before restoring', () => {
  recordLocalSyncChanges(a, workspaceId, [change(1), change(2)], adapter)
  runFolderSync(a, location, writerA, adapter)
  const plan = publishedPlan()
  const id = plan.manifest.snapshotId
  const original = readFileSync(snapshotPath(id, MANIFEST))
  const originalChunk = readFileSync(snapshotPath(id, CHUNK))
  const blank = database()
  const check = (code: string) => {
    expect(codeOf(() => verifySyncSnapshot(location, id))).toBe(code)
    expect(codeOf(() => restoreSyncSnapshot(blank, location, id, adapter))).toBe(code)
    expect(batchIds(blank)).toEqual([])
    writeFileSync(snapshotPath(id, MANIFEST), original)
    writeFileSync(snapshotPath(id, CHUNK), originalChunk)
  }

  rewriteManifest(id, (manifest) => (manifest.changesHash = 'a'.repeat(64)))
  check('SYNC_CHECKSUM_MISMATCH')
  rewriteManifest(id, (manifest) => (manifest.changeCount = 3))
  check('SYNC_CHECKSUM_MISMATCH')
  rewriteManifest(id, (manifest) => (manifest.checksum = '0'.repeat(64)), false)
  check('SYNC_CHECKSUM_MISMATCH')
  rewriteManifest(id, (manifest) => (manifest.protocol = 2), false)
  check('SYNC_UPDATE_REQUIRED')

  // A re-signed chunk holding different valid batches cannot claim the original coverage.
  const chunk = JSON.parse(gunzipSync(originalChunk).toString('utf8'))
  chunk.batches = [batch([change(3), change(4)], 1, writerA)]
  chunk.checksum = syncBatchChecksum(chunk)
  writeFileSync(snapshotPath(id, CHUNK), gzipSync(canonicalJson(chunk)))
  rewriteManifest(id, (manifest) => {
    ;(manifest.chunks as Array<{ checksum: string }>)[0].checksum = chunk.checksum
  })
  check('SYNC_CHECKSUM_MISMATCH')

  const forged = structuredClone(plan)
  forged.manifest.changeCount = 3
  forged.manifest.checksum = syncBatchChecksum(forged.manifest)
  expect(codeOf(() => publishSyncSnapshot(location, forged))).toBe('SYNC_CHECKSUM_MISMATCH')

  const other = createSyncWorkspace(root, 'Another shared history').manifest.workspaceId
  const elsewhere = { folder: root, workspaceId: other }
  expect(codeOf(() => publishSyncSnapshot(elsewhere, plan))).toBe('SYNC_WRONG_WORKSPACE')
  expect(existsSync(safe(join(root, other, 'snapshots')))).toBe(false)
  cpSync(snapshotPath(id), safe(join(root, other, 'snapshots', id)), { recursive: true })
  expect(codeOf(() => verifySyncSnapshot(elsewhere, id))).toBe('SYNC_WRONG_WORKSPACE')
  expect(codeOf(() => verifySyncSnapshot(location, '..'))).toBe('SYNC_PATH_REJECTED')

  expect(restoreSyncSnapshot(blank, location, id, adapter).applied).toHaveLength(1)
  expect(values(blank)).toEqual([1, 2])
})
