// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { syncBatches, syncChanges, syncReceipts, syncRecordStates } from '../db/schema/folder-sync'
import { encodeSyncBatch, decodeSyncBatch, type SyncChange } from './folder-sync-protocol'
import {
  recordLocalSyncChanges,
  assembleOutgoingBatch,
  unpublishedSyncBatches,
  markSyncBatchPublished,
  retainIncomingBatch,
  applyReadySyncBatches,
  knownSyncGaps,
  type SyncDomainAdapter
} from './folder-sync-store'

const workspaceId = '2fd7cbd1-7f6b-4935-b18c-367ae5ff5fb9'
const opened: Database.Database[] = []
let a: ReturnType<typeof drizzle>
let b: ReturnType<typeof drizzle>
const writer = () => ({ writerEpochId: randomUUID(), deviceId: randomUUID() })

it('commits a batch receipt only after its accumulated projection succeeds', () => {
  const incoming = batch([change(1), change(2)])
  retainIncomingBatch(b, workspaceId, incoming, adapter)
  const failed = applyReadySyncBatches(b, workspaceId, {
    ...adapter,
    forBatch: () => ({
      ...adapter,
      flush: () => {
        throw new Error('Projection failed')
      }
    })
  })
  expect(failed.errors).toHaveLength(1)
  expect(b.select().from(syncChanges).all()).toEqual([])
  expect(b.select().from(syncReceipts).all()).toEqual([])
  expect(b.select().from(syncRecordStates).all()).toEqual([])
  expect(applyReadySyncBatches(b, workspaceId, adapter).applied).toEqual([incoming.batchId])
})

it('resumes outgoing pages after the committed prefix and includes later local writes', () => {
  const rows = [change(1), change(2), change(3), change(4)]
  recordLocalSyncChanges(a, workspaceId, rows, adapter)
  const cursor = { rowid: 0 }
  const identity = writer()
  const first = assembleOutgoingBatch(a, workspaceId, identity, 2, cursor)!
  const fifth = change(5)
  recordLocalSyncChanges(a, workspaceId, [fifth], adapter)
  const second = assembleOutgoingBatch(a, workspaceId, identity, 2, cursor)!
  const third = assembleOutgoingBatch(a, workspaceId, identity, 2, cursor)!
  expect(assembleOutgoingBatch(a, workspaceId, identity, 2, cursor)).toBeNull()
  expect(new Set([...first.changes, ...second.changes, ...third.changes].map((c) => c.id))).toEqual(
    new Set([...rows, fifth].map((c) => c.id))
  )
  expect([first.sequence, second.sequence, third.sequence]).toEqual([1, 2, 3])
})
function database(bytes?: Buffer) {
  const connection = new Database(bytes ?? ':memory:')
  connection.pragma('foreign_keys = ON')
  opened.push(connection)
  const db = drizzle(connection)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  return db
}
beforeEach(() => {
  a = database()
  b = database()
})
afterEach(() => {
  for (const connection of opened.splice(0)) connection.close()
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
function change(value: number, dependencies: string[] = [], id = randomUUID()): SyncChange {
  return {
    id,
    kind: 'fact',
    entityType: 'legacy-session',
    entityId: id,
    dependencies,
    payload: { value }
  }
}
function batch(changes: SyncChange[], sequence = 1, identity = writer()) {
  const ids = new Set(changes.map((row) => row.id))
  const input = {
    workspaceId,
    batchId: randomUUID(),
    ...identity,
    sequence,
    changes,
    dependencies: [...new Set(changes.flatMap((row) => row.dependencies))].filter(
      (id) => !ids.has(id)
    )
  }
  const encoded = encodeSyncBatch(input)
  return decodeSyncBatch(encoded.bytes, { workspaceId })
}
const values = (db = b) =>
  db
    .select()
    .from(syncRecordStates)
    .all()
    .map((row) => JSON.parse(row.stateJson).value)
    .sort((x, y) => x - y)

it('commits local projections and their durable queue together, then rolls both back on failure', () => {
  const before = opened[0].serialize()
  expect(() =>
    a.transaction((tx) => {
      recordLocalSyncChanges(tx, workspaceId, [change(1)], adapter)
      throw new Error('process failed before commit')
    })
  ).toThrow('before commit')
  expect(opened[0].serialize()).toEqual(before)
  const row = change(2)
  recordLocalSyncChanges(a, workspaceId, [row], adapter)
  recordLocalSyncChanges(a, workspaceId, [row], adapter)
  expect(a.select().from(syncChanges).all()).toHaveLength(1)
  expect(values(a)).toEqual([2])
})

it('retains publication receipts and exact batches across a clone and a fresh writer epoch', () => {
  recordLocalSyncChanges(a, workspaceId, [change(1)], adapter)
  const first = assembleOutgoingBatch(a, workspaceId, writer())!
  const clone = database(opened[0].serialize())
  expect(unpublishedSyncBatches(clone, workspaceId)).toEqual([first])
  expect(assembleOutgoingBatch(clone, workspaceId, writer())).toBeNull()
  recordLocalSyncChanges(a, workspaceId, [change(2)], adapter)
  recordLocalSyncChanges(clone, workspaceId, [change(3)], adapter)
  const nextA = assembleOutgoingBatch(a, workspaceId, writer())!
  const nextClone = assembleOutgoingBatch(clone, workspaceId, writer())!
  expect(nextA.writerEpochId).not.toBe(nextClone.writerEpochId)
  expect(nextA.sequence).toBe(1)
  expect(nextClone.sequence).toBe(1)
  for (const item of [first, nextA, nextClone]) retainIncomingBatch(b, workspaceId, item, adapter)
  expect(applyReadySyncBatches(b, workspaceId, adapter).errors).toEqual([])
  expect(values()).toEqual([1, 2, 3])
  markSyncBatchPublished(a, first.batchId)
  expect(unpublishedSyncBatches(a, workspaceId)).toEqual([nextA])
})

it('imports independent work across a gap, waits only for real dependencies and later converges', () => {
  const identity = writer()
  const first = change(1)
  const second = change(2, [first.id])
  const third = change(3)
  const one = batch([first], 1, identity)
  const two = batch([second], 2, identity)
  const three = batch([third], 3, identity)
  retainIncomingBatch(b, workspaceId, three, adapter)
  retainIncomingBatch(b, workspaceId, two, adapter)
  expect(applyReadySyncBatches(b, workspaceId, adapter)).toEqual({
    applied: [three.batchId],
    waiting: [{ batchId: two.batchId, missing: [first.id] }],
    errors: []
  })
  expect(values()).toEqual([3])
  expect(knownSyncGaps(b, workspaceId)).toEqual([
    { writerEpochId: identity.writerEpochId, from: 1, to: 1 }
  ])
  retainIncomingBatch(b, workspaceId, one, adapter)
  expect(applyReadySyncBatches(b, workspaceId, adapter).applied).toEqual([one.batchId, two.batchId])
  expect(values()).toEqual([1, 2, 3])
  expect(knownSyncGaps(b, workspaceId)).toEqual([])
  expect(b.select().from(syncReceipts).all()).toHaveLength(3)
  expect(assembleOutgoingBatch(b, workspaceId, writer())).toBeNull()
})

it('rolls back all changes and the receipt after a mid-import crash, then retries once', () => {
  const first = change(1)
  const second = change(2, [first.id])
  const incoming = batch([second, first])
  retainIncomingBatch(b, workspaceId, incoming, adapter)
  const broken: SyncDomainAdapter = {
    ...adapter,
    apply(tx, workspace, row) {
      adapter.apply(tx, workspace, row)
      if (row.id === second.id) throw new Error('crashed before receipt')
    }
  }
  expect(applyReadySyncBatches(b, workspaceId, broken).errors).toEqual([
    { batchId: incoming.batchId, message: 'crashed before receipt' }
  ])
  expect(values()).toEqual([])
  expect(b.select().from(syncChanges).all()).toEqual([])
  expect(b.select().from(syncReceipts).all()).toEqual([])
  expect(b.select().from(syncBatches).all()).toHaveLength(1)
  expect(applyReadySyncBatches(b, workspaceId, adapter).applied).toEqual([incoming.batchId])
  expect(retainIncomingBatch(b, workspaceId, incoming, adapter)).toBe(false)
  expect(applyReadySyncBatches(b, workspaceId, adapter).applied).toEqual([])
  expect(values()).toEqual([1, 2])
})

it('deduplicates the same change in different batches and rejects conflicting change contents', () => {
  const row = change(1)
  const one = batch([row])
  const duplicate = batch([row])
  const wrong = batch([{ ...row, payload: { value: 2 } }])
  for (const envelope of [one, duplicate]) retainIncomingBatch(b, workspaceId, envelope, adapter)
  expect(applyReadySyncBatches(b, workspaceId, adapter).applied).toHaveLength(2)
  expect(values()).toEqual([1])
  retainIncomingBatch(b, workspaceId, wrong, adapter)
  expect(applyReadySyncBatches(b, workspaceId, adapter).errors[0].message).toMatch(
    /change ID has different/
  )
  expect(values()).toEqual([1])
  expect(b.select().from(syncReceipts).all()).toHaveLength(2)
})

it('rejects changed batch IDs, sequence collisions, wrong workspaces and non-allowlisted payloads before import', () => {
  const identity = writer()
  const original = batch([change(1)], 1, identity)
  retainIncomingBatch(b, workspaceId, original, adapter)
  const collision = batch([change(2)], 1, identity)
  expect(() => retainIncomingBatch(b, workspaceId, collision, adapter)).toThrow(
    'same writer sequence'
  )
  const { protocol: _protocol, checksum: _checksum, ...body } = original
  const replaced = encodeSyncBatch({ ...body, changes: [change(3)] }).batch
  expect(() => retainIncomingBatch(b, workspaceId, replaced, adapter)).toThrow(
    'batch ID has different'
  )
  expect(() => retainIncomingBatch(b, randomUUID(), original, adapter)).toThrow(
    /different shared history/
  )
  const secret = batch([{ ...change(4), payload: { value: 4, apiKey: 'never-export' } }])
  expect(() => retainIncomingBatch(b, workspaceId, secret, adapter)).toThrow('allowlisted')
  expect(b.select().from(syncBatches).all()).toHaveLength(1)
  expect(values()).toEqual([])
})

it('keeps a huge writer gap visible as a single range and rejects dependency cycles', () => {
  const incoming = batch([change(1)], Number.MAX_SAFE_INTEGER)
  retainIncomingBatch(b, workspaceId, incoming, adapter)
  expect(applyReadySyncBatches(b, workspaceId, adapter).applied).toEqual([incoming.batchId])
  expect(knownSyncGaps(b, workspaceId)).toEqual([
    { writerEpochId: incoming.writerEpochId, from: 1, to: Number.MAX_SAFE_INTEGER - 1 }
  ])
  const left = change(2)
  const right = change(3, [left.id])
  left.dependencies = [right.id]
  expect(() => recordLocalSyncChanges(a, workspaceId, [left, right], adapter)).toThrow('cycle')
  expect(() => retainIncomingBatch(b, workspaceId, batch([left, right]), adapter)).toThrow('cycle')
  expect(a.select().from(syncChanges).all()).toEqual([])
})

it('retains committed local work as pending even when a duplicate arrives in an incoming batch', () => {
  const local = change(1)
  recordLocalSyncChanges(a, workspaceId, [local], adapter)
  retainIncomingBatch(a, workspaceId, batch([local]), adapter)
  applyReadySyncBatches(a, workspaceId, adapter)
  expect(assembleOutgoingBatch(a, workspaceId, writer())?.changes).toEqual([local])
  expect(values(a)).toEqual([1])
})
