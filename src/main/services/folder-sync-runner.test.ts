// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { randomUUID } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { gzipSync } from 'node:zlib'
import { syncRecordStates } from '../db/schema/folder-sync'
import { createSyncWorkspace, scanSyncBatches, listSyncBatchCandidates } from './folder-sync-files'
import { encodeSyncBatch, type SyncChange } from './folder-sync-protocol'
import {
  recordLocalSyncChanges,
  retainIncomingBatch,
  type SyncDomainAdapter
} from './folder-sync-store'
import { runFolderSync } from './folder-sync-runner'

let root: string
let workspaceId: string
const opened: Database.Database[] = []
let a: ReturnType<typeof drizzle>
let b: ReturnType<typeof drizzle>
let left: { folder: string; workspaceId: string }
let right: typeof left
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
  root = mkdtempSync(join(tmpdir(), 'clautime-sync-runner-'))
  mkdirSync(safe(join(root, 'a')))
  mkdirSync(safe(join(root, 'b')))
  workspaceId = createSyncWorkspace(join(root, 'a'), 'Disposable shared history').manifest
    .workspaceId
  left = { folder: join(root, 'a'), workspaceId }
  right = { folder: join(root, 'b'), workspaceId }
  transfer(left, right)
  a = database()
  b = database()
})
afterEach(() => {
  for (const db of opened.splice(0)) db.close()
  const target = resolve(root)
  if (
    !target.startsWith(resolve(tmpdir()) + sep) ||
    !basename(target).startsWith('clautime-sync-runner-')
  )
    throw new Error('Invalid cleanup target')
  rmSync(target, { recursive: true, force: true })
})
function transfer(from: typeof left, to: typeof left) {
  cpSync(safe(join(from.folder, workspaceId)), safe(join(to.folder, workspaceId)), {
    recursive: true
  })
}
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
function change(value: number): SyncChange {
  const id = randomUUID()
  return {
    id,
    kind: 'fact',
    entityType: 'legacy-session',
    entityId: id,
    dependencies: [],
    payload: { value }
  }
}
const values = (db = b) =>
  db
    .select()
    .from(syncRecordStates)
    .all()
    .map((row) => JSON.parse(row.stateJson).value)
    .sort((x, y) => x - y)

it('exchanges offline changes in both directions and never echoes imported changes', () => {
  recordLocalSyncChanges(a, workspaceId, [change(1)], adapter)
  expect(runFolderSync(a, left, writerA, adapter)).toMatchObject({
    status: 'idle',
    published: 1,
    imported: 0,
    pending: 0
  })
  transfer(left, right)
  expect(runFolderSync(b, right, writerB, adapter)).toMatchObject({
    status: 'idle',
    published: 0,
    imported: 1,
    repaired: 0
  })
  recordLocalSyncChanges(b, workspaceId, [change(2)], adapter)
  expect(runFolderSync(b, right, writerB, adapter).published).toBe(1)
  transfer(right, left)
  expect(runFolderSync(a, left, writerA, adapter).imported).toBe(1)
  expect(values(a)).toEqual([1, 2])
  expect(values(b)).toEqual([1, 2])
  expect(runFolderSync(a, left, writerA, adapter)).toMatchObject({
    published: 0,
    imported: 0,
    repaired: 0
  })
})

it('keeps unbatched local work pending while the folder is unavailable', () => {
  recordLocalSyncChanges(a, workspaceId, [change(1)], adapter)
  const path = safe(join(left.folder, workspaceId))
  const away = safe(join(root, 'away'))
  renameSync(path, away)
  expect(runFolderSync(a, left, writerA, adapter)).toMatchObject({
    status: 'unavailable',
    pending: 1,
    published: 0
  })
  expect(values(a)).toEqual([1])
  renameSync(away, path)
  expect(runFolderSync(a, left, writerA, adapter)).toMatchObject({
    status: 'idle',
    published: 1,
    pending: 0
  })
})

it('repairs a deleted batch from a surviving receiver and restores it onto a blank database', () => {
  recordLocalSyncChanges(a, workspaceId, [change(1)], adapter)
  runFolderSync(a, left, writerA, adapter)
  transfer(left, right)
  runFolderSync(b, right, writerB, adapter)
  for (const location of [left, right])
    for (const path of listSyncBatchCandidates(location).candidates) rmSync(safe(path))
  expect(runFolderSync(b, right, writerB, adapter)).toMatchObject({
    repaired: 1,
    published: 0,
    imported: 0
  })
  transfer(right, left)
  const restored = database()
  expect(runFolderSync(restored, left, writerA, adapter)).toMatchObject({
    imported: 1,
    status: 'idle'
  })
  expect(values(restored)).toEqual([1])
})

it('repairs a partial file with a complete copy without deleting or repeatedly copying it', () => {
  recordLocalSyncChanges(a, workspaceId, [change(1)], adapter)
  runFolderSync(a, left, writerA, adapter)
  const original = listSyncBatchCandidates(left).candidates[0]
  writeFileSync(safe(original), Buffer.from([0x1f, 0x8b]))
  expect(runFolderSync(a, left, writerA, adapter)).toMatchObject({
    status: 'incomplete',
    repaired: 1
  })
  expect(listSyncBatchCandidates(left).candidates).toHaveLength(2)
  expect(scanSyncBatches(left).batches).toHaveLength(1)
  expect(runFolderSync(a, left, writerA, adapter)).toMatchObject({
    repaired: 0,
    status: 'idle',
    issues: []
  })
  expect(listSyncBatchCandidates(left).candidates).toHaveLength(2)
})

it('holds conflicting copies, including an earlier pending receipt, without publishing more copies', () => {
  recordLocalSyncChanges(a, workspaceId, [change(1)], adapter)
  runFolderSync(a, left, writerA, adapter)
  transfer(left, right)
  const original = scanSyncBatches(right).batches[0]
  retainIncomingBatch(b, workspaceId, original.batch, adapter)
  const { protocol: _protocol, checksum: _checksum, ...body } = original.batch
  const altered = encodeSyncBatch({ ...body, changes: [change(2)] })
  const path = safe(
    join(
      right.folder,
      workspaceId,
      'writers',
      original.batch.writerEpochId,
      'conflicting-copy.json.gz'
    )
  )
  writeFileSync(path, altered.bytes)
  const result = runFolderSync(b, right, writerB, adapter)
  expect(result).toMatchObject({ status: 'incomplete', imported: 0, repaired: 0 })
  expect(result.issues.some((entry) => entry.code === 'SYNC_BATCH_CONFLICT')).toBe(true)
  expect(values()).toEqual([])
  runFolderSync(b, right, writerB, adapter)
  expect(listSyncBatchCandidates(right).candidates).toHaveLength(2)
})

it('pauses the entire pass for an unsupported version while preserving local pending capture', () => {
  recordLocalSyncChanges(a, workspaceId, [change(1)], adapter)
  runFolderSync(a, left, writerA, adapter)
  transfer(left, right)
  const original = scanSyncBatches(right).batches[0]
  const path = safe(
    join(right.folder, workspaceId, 'writers', original.batch.writerEpochId, 'future.json.gz')
  )
  writeFileSync(
    path,
    gzipSync(JSON.stringify({ ...original.batch, batchId: randomUUID(), protocol: 2 }))
  )
  recordLocalSyncChanges(b, workspaceId, [change(2)], adapter)
  const before = opened[1].serialize()
  expect(runFolderSync(b, right, writerB, adapter)).toMatchObject({
    status: 'update-required',
    imported: 0,
    published: 0,
    pending: 1
  })
  expect(opened[1].serialize()).toEqual(before)
  expect(values()).toEqual([2])
})

it('ignores OS folder bookkeeping while retaining unknown damaged batches as incomplete', () => {
  recordLocalSyncChanges(a, workspaceId, [change(1)], adapter)
  runFolderSync(a, left, writerA, adapter)
  const writers = join(left.folder, workspaceId, 'writers')
  writeFileSync(join(writers, '.DS_Store'), 'metadata')
  const batch = scanSyncBatches(left).batches[0].batch
  writeFileSync(join(writers, batch.writerEpochId, 'desktop.ini'), 'metadata')
  expect(runFolderSync(a, left, writerA, adapter)).toMatchObject({ status: 'idle', issues: [] })
  writeFileSync(
    join(writers, batch.writerEpochId, `2-${randomUUID()}.json.gz`),
    Buffer.from([0x1f, 0x8b])
  )
  expect(runFolderSync(a, left, writerA, adapter).status).toBe('incomplete')
})
