// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq, sql } from 'drizzle-orm'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sessions } from '../db/schema/sessions'
import { sessionModelUsage } from '../db/schema/session-model-usage'
import { sessionLegacyRecords } from '../db/schema/session-legacy'
import { activeSessionCondition } from '../db/schema/session-deletions'
import { sourceMachines } from '../db/schema/activity-observers'
import { activityIdentities } from '../db/schema/activity-evidence'
import { manualTimeEntries } from '../db/schema/manual-time-entries'
import { syncChanges } from '../db/schema/folder-sync'
import {
  syncFactChangeId,
  activitySyncAdapter,
  collectActivitySyncChanges
} from './folder-sync-activity-records'
import type { SyncBatch, SyncChange } from './folder-sync-protocol'
import {
  applyReadySyncBatches,
  assembleOutgoingBatch,
  recordLocalSyncChanges,
  retainIncomingBatch,
  type SyncDomainAdapter
} from './folder-sync-store'
import { directoryRecordsAdapter, isDirectoryEntityType } from './folder-sync-directory-records'
import {
  collectLegacySyncChanges,
  journalLegacySyncChanges,
  LEGACY_SYNC_ENTITY_TYPES,
  legacyRecordsAdapter,
  planLegacyExportBatches,
  planLegacyOriginPages,
  planLegacyReconciliation,
  planOriginLegacyReconciliations,
  readLegacyQueue,
  refreshLegacyState,
  retainSourceLessSessionsForSync,
  type LegacyExportOptions
} from './folder-sync-legacy-records'
import { sessionRevisions, sessionSplits } from '../db/schema/session-history'
import { syncHistorySuppressions } from '../db/schema/sync-legacy'
import { retainLegacySession } from './session-legacy'
import { collectManualSyncChanges, manualRecordsAdapter } from './folder-sync-manual-records'
import {
  collectHistoryObserverChanges,
  historyObserversAdapter,
  readHistoryObservers
} from './folder-sync-history-observers'

const workspaceId = '6a0f8f64-3c1d-4b8e-9f51-2d7c4e9b1a30'
type Db = ReturnType<typeof drizzle>
const opened: Database.Database[] = []
const connections = new Map<Db, Database.Database>()

function database(bytes?: Buffer): Db {
  const connection = new Database(bytes ?? ':memory:')
  connection.pragma('foreign_keys = ON')
  opened.push(connection)
  const db = drizzle(connection)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  connections.set(db, connection)
  return db
}
afterEach(() => {
  for (const connection of opened.splice(0)) connection.close()
  connections.clear()
})

const legacyTypes = new Set<string>(LEGACY_SYNC_ENTITY_TYPES)
const route = (change: SyncChange): SyncDomainAdapter =>
  legacyTypes.has(change.entityType)
    ? legacyRecordsAdapter
    : change.entityType === 'manual-entry'
      ? manualRecordsAdapter
      : change.entityType === 'history-observer'
        ? historyObserversAdapter
        : isDirectoryEntityType(change.entityType)
          ? directoryRecordsAdapter
          : activitySyncAdapter
const adapter: SyncDomainAdapter = {
  validate: (change) => route(change).validate(change),
  apply: (tx, workspace, change) => route(change).apply(tx, workspace, change)
}
const record = (db: Db, changes: unknown[]): string[] =>
  recordLocalSyncChanges(db, workspaceId, changes, adapter)
function publish(db: Db): SyncBatch {
  const batch = assembleOutgoingBatch(db, workspaceId, {
    writerEpochId: randomUUID(),
    deviceId: randomUUID()
  })
  if (!batch) throw new Error('Nothing to publish')
  return batch
}
function deliver(db: Db, ...batches: SyncBatch[]): void {
  for (const batch of batches) retainIncomingBatch(db, workspaceId, batch, adapter)
  const result = applyReadySyncBatches(db, workspaceId, adapter)
  expect(result.errors).toEqual([])
  expect(result.waiting).toEqual([])
}

const SECRET_PATH = '/home/fixture/secret-project'

function machine(db: Db, name: string): string {
  const deviceId = randomUUID()
  db.insert(sourceMachines).values({ deviceId, initialName: name }).run()
  return deviceId
}

function savedRow(
  db: Db,
  values: Partial<typeof sessions.$inferInsert> = {},
  usage = [
    {
      model: 'claude-opus',
      inputTokens: 700,
      outputTokens: 90,
      cacheCreationInputTokens: 5,
      cacheReadInputTokens: 11
    },
    {
      model: 'claude-haiku',
      inputTokens: 300,
      outputTokens: 10,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 2
    }
  ]
): number {
  const row = db
    .insert(sessions)
    .values({
      projectPath: SECRET_PATH,
      sourceFile: null,
      tool: 'claude',
      claudeSessionId: 'conversation-x',
      startedAt: '2026-03-04T10:00:00Z',
      endedAt: '2026-03-04T11:00:00Z',
      durationMinutes: 60,
      promptCount: 12,
      inputTokens: 1000,
      outputTokens: 100,
      description: 'Saved before logs were deleted',
      billable: 1,
      ...values
    })
    .returning()
    .get()
  for (const entry of usage)
    db.insert(sessionModelUsage)
      .values({ sessionId: row.id, ...entry })
      .run()
  return row.id
}

function legacySession(db: Db, values: Partial<typeof sessions.$inferInsert> = {}): string {
  const { retained } = retainSourceLessSessionsForSync(db, [savedRow(db, values)])
  expect(retained).toHaveLength(1)
  return retained[0].legacyId
}

function manualEntry(db: Db, deviceId: string, description = 'Whiteboard session'): string {
  const row = db
    .insert(sessions)
    .values({
      projectPath: SECRET_PATH,
      source: 'manual',
      startedAt: '2026-03-05T09:00:00Z',
      endedAt: '2026-03-05T09:45:00Z',
      durationMinutes: 45,
      description
    })
    .returning()
    .get()
  const id = randomUUID()
  db.insert(manualTimeEntries).values({ id, sessionId: row.id, deviceId, basis: 'created' }).run()
  return id
}

/** Bootstrap order the root orchestrator follows: machines, legacy, manual, observers. */
function exportHistory(db: Db, deviceId: string, options: LegacyExportOptions = {}) {
  record(db, collectActivitySyncChanges(db, workspaceId))
  const legacy = collectLegacySyncChanges(db, workspaceId, options)
  journalLegacySyncChanges(db, workspaceId, legacy.changes)
  const manual = collectManualSyncChanges(db, workspaceId)
  expect(manual.blocked).toEqual([])
  record(db, manual.changes)
  const observers = collectHistoryObserverChanges(db, workspaceId, deviceId)
  expect(observers.requires).toEqual([])
  record(db, observers.changes)
  return { legacy, manual, observers }
}

const activeMinutes = (db: Db): number =>
  db
    .select({ total: sql<number>`coalesce(sum(${sessions.durationMinutes}), 0)` })
    .from(sessions)
    .where(activeSessionCondition)
    .get()!.total
const queue = (db: Db) =>
  readLegacyQueue(db, workspaceId).map(({ sessionId: _local, ...entry }) => entry)
const queued = (legacyIds: string[], candidates = legacyIds) =>
  [...legacyIds].sort().map((legacyId) => ({
    legacyId,
    status: 'queued',
    counting: false,
    reasons: ['overlapping-legacy'],
    candidates: [...candidates].sort(),
    activityOverlap: false,
    resolutions: [],
    lastAgreed: []
  }))

it('restores saved legacy totals onto a blank database without logs, paths or fabricated activity', () => {
  const a = database()
  const deviceA = machine(a, 'Desktop')
  const legacyId = legacySession(a)
  const { legacy } = exportHistory(a, deviceA)
  expect(legacy.withheld).toEqual([])
  expect(Object.keys(legacy.changes[0].payload).sort()).toEqual(
    [
      'billable',
      'clientSyncId',
      'conversationId',
      'description',
      'durationMinutes',
      'endedAt',
      'inputTokens',
      'modelUsage',
      'outputTokens',
      'projectSyncId',
      'promptCount',
      'provider',
      'snapshotVersion',
      'splitFrom',
      'startedAt',
      'version'
    ].sort()
  )

  const b = database()
  deliver(b, publish(a))
  const restored = b
    .select()
    .from(sessionLegacyRecords)
    .where(eq(sessionLegacyRecords.id, legacyId))
    .get()!
  const row = b.select().from(sessions).where(eq(sessions.id, restored.sessionId)).get()!
  expect(row).toMatchObject({
    projectPath: '',
    sourceFile: null,
    source: 'auto',
    tool: 'claude',
    claudeSessionId: 'conversation-x',
    startedAt: '2026-03-04T10:00:00.000Z',
    endedAt: '2026-03-04T11:00:00.000Z',
    durationMinutes: 60,
    promptCount: 12,
    inputTokens: 1000,
    outputTokens: 100,
    billable: 1
  })
  expect(
    b
      .select({
        model: sessionModelUsage.model,
        input: sessionModelUsage.inputTokens,
        cache: sessionModelUsage.cacheReadInputTokens
      })
      .from(sessionModelUsage)
      .where(eq(sessionModelUsage.sessionId, row.id))
      .orderBy(sessionModelUsage.model)
      .all()
  ).toEqual([
    { model: 'claude-haiku', input: 300, cache: 2 },
    { model: 'claude-opus', input: 700, cache: 11 }
  ])
  expect(activeMinutes(b)).toBe(activeMinutes(a))
  expect(readLegacyQueue(b, workspaceId)).toEqual([])
  // Saved totals only: no invented event fingerprints.
  expect(b.select().from(activityIdentities).all()).toEqual([])
  expect(readHistoryObservers(b, { recordType: 'legacy-session' })).toEqual([
    {
      recordType: 'legacy-session',
      recordId: legacyId,
      deviceId: deviceA,
      basis: 'imported',
      initialName: 'Desktop'
    }
  ])

  // A restored snapshot is imported history, so B never re-labels or re-exports it.
  expect(collectLegacySyncChanges(b, workspaceId).changes).toEqual([])
  expect(collectHistoryObserverChanges(b, workspaceId, machine(b, 'Laptop')).changes).toEqual([])
})

it('keeps local paths, source files, local IDs and capture times out of every change', () => {
  const a = database()
  const deviceA = machine(a, 'Desktop')
  legacySession(a, { sourceFile: '' })
  manualEntry(a, deviceA)
  exportHistory(a, deviceA)
  const rows = a.select({ json: syncChanges.changeJson }).from(syncChanges).all()
  expect(rows.length).toBeGreaterThan(4)
  for (const { json } of rows) {
    expect(json).not.toContain('secret-project')
    for (const key of [
      '"projectPath"',
      '"sourceFile"',
      '"sessionId"',
      '"createdAt"',
      '"updatedAt"',
      '"claudeSessionId"',
      '"clientId"',
      '"projectId"'
    ])
      expect(json).not.toContain(key)
  }
})

it('dedupes cloned databases by deterministic change IDs while keeping each computer as an observer', () => {
  const a = database()
  const deviceA = machine(a, 'Desktop')
  const legacyId = legacySession(a)
  const entryId = manualEntry(a, deviceA)
  const clone = database(connections.get(a)!.serialize())
  const deviceClone = machine(clone, 'Desktop copy')
  const fromA = exportHistory(a, deviceA)
  const fromClone = exportHistory(clone, deviceClone)
  expect(fromClone.legacy.changes.map((change) => change.id)).toEqual(
    fromA.legacy.changes.map((change) => change.id)
  )
  expect(fromClone.manual.changes.map((change) => change.id)).toEqual(
    fromA.manual.changes.map((change) => change.id)
  )

  const b = database()
  deliver(b, publish(a), publish(clone))
  expect(b.select().from(sessionLegacyRecords).all()).toHaveLength(1)
  expect(
    b.select().from(manualTimeEntries).where(eq(manualTimeEntries.id, entryId)).all()
  ).toHaveLength(1)
  expect(activeMinutes(b)).toBe(60 + 45)
  expect(readLegacyQueue(b, workspaceId)).toEqual([])
  expect(
    readHistoryObservers(b, { recordType: 'legacy-session', recordIds: [legacyId] })
      .map((row) => row.deviceId)
      .sort()
  ).toEqual([deviceA, deviceClone].sort())
  // The manual entry's origin is its stable creating device, shared by both copies.
  expect(readHistoryObservers(b, { recordType: 'manual-entry' })).toEqual([
    {
      recordType: 'manual-entry',
      recordId: entryId,
      deviceId: deviceA,
      basis: 'observed',
      initialName: 'Desktop'
    }
  ])
})

it('retains the same saved row under the same legacy UUID on both copies of a cloned database', () => {
  const a = database()
  const sessionId = savedRow(a)
  const clone = database(connections.get(a)!.serialize())
  const [fromA] = retainSourceLessSessionsForSync(a, [sessionId]).retained
  const [fromClone] = retainSourceLessSessionsForSync(clone, [sessionId]).retained
  expect(fromClone.legacyId).toBe(fromA.legacyId)
  // Retaining again is idempotent.
  expect(retainSourceLessSessionsForSync(a, [sessionId]).retained).toEqual([fromA])

  exportHistory(a, machine(a, 'Desktop'))
  exportHistory(clone, machine(clone, 'Desktop copy'))
  const b = database()
  deliver(b, publish(clone), publish(a))
  expect(b.select().from(sessionLegacyRecords).all()).toHaveLength(1)
  expect(activeMinutes(b)).toBe(60)
  expect(readLegacyQueue(b, workspaceId)).toEqual([])
})

it("restores one computer's overlapping legacy rows with the same counts on a blank receiver", () => {
  const a = database()
  const deviceA = machine(a, 'Desktop')
  const first = legacySession(a)
  const second = legacySession(a, {
    startedAt: '2026-03-04T10:30:00Z',
    endedAt: '2026-03-04T11:30:00Z'
  })
  exportHistory(a, deviceA)
  expect(activeMinutes(a)).toBe(120)
  // The origin vouches for exactly the group it counts; nothing is deduplicated.
  const vouches = a
    .select()
    .from(syncChanges)
    .where(eq(syncChanges.entityType, 'legacy-reconciliation'))
    .all()
  expect(vouches).toHaveLength(1)
  expect(JSON.parse(vouches[0].changeJson).payload).toMatchObject({
    candidates: [first, second].sort(),
    keep: [first, second].sort(),
    duplicates: []
  })

  const b = database()
  deliver(b, publish(a))
  expect(activeMinutes(b)).toBe(120)
  expect(readLegacyQueue(b, workspaceId)).toEqual([])
  expect(b.select().from(sessionLegacyRecords).all()).toHaveLength(2)

  // An exact clone vouches with the identical fact and still dedupes.
  const clone = database(connections.get(a)!.serialize())
  exportHistory(clone, machine(clone, 'Desktop copy'))
  expect(
    clone
      .select()
      .from(syncChanges)
      .where(eq(syncChanges.entityType, 'legacy-reconciliation'))
      .all()
  ).toHaveLength(1)
})

it('holds a foreign overlap of vouched history identically in either arrival order', () => {
  const a = database()
  const c = database()
  const x = legacySession(a)
  const y = legacySession(a, { startedAt: '2026-03-04T10:30:00Z', endedAt: '2026-03-04T11:30:00Z' })
  const w = legacySession(c, { startedAt: '2026-03-04T11:15:00Z', endedAt: '2026-03-04T12:15:00Z' })
  exportHistory(a, machine(a, 'Desktop'))
  exportHistory(c, machine(c, 'Laptop'))
  const batchA = publish(a)
  const batchC = publish(c)
  const one = database()
  const two = database()
  deliver(one, batchA)
  deliver(one, batchC)
  deliver(two, batchC)
  deliver(two, batchA)
  const expected = queued([x, y, w])
  expect(queue(one)).toEqual(expected)
  expect(queue(two)).toEqual(expected)
  expect(activeMinutes(one)).toBe(0)
  expect(activeMinutes(two)).toBe(0)
  // Each origin keeps counting its own rows; only the unknown IDs are held.
  deliver(a, batchC)
  deliver(c, batchA)
  expect(queue(a).map((entry) => entry.legacyId)).toEqual([w])
  expect(queue(c).map((entry) => entry.legacyId)).toEqual([x, y].sort())
  expect(activeMinutes(a)).toBe(120)
  expect(activeMinutes(c)).toBe(60)
})

it('queues overlapping unknown legacy history identically in any arrival order and converges on resolution', () => {
  const a = database()
  const c = database()
  const deviceA = machine(a, 'Desktop')
  const deviceC = machine(c, 'Laptop')
  const fromA = legacySession(a)
  const fromC = legacySession(c, {
    startedAt: '2026-03-04T10:30:00Z',
    endedAt: '2026-03-04T11:30:00Z'
  })
  exportHistory(a, deviceA)
  exportHistory(c, deviceC)
  const batchA = publish(a)
  const batchC = publish(c)

  const first = database()
  const second = database()
  deliver(first, batchA)
  deliver(first, batchC)
  deliver(second, batchC)
  deliver(second, batchA)
  const expected = queued([fromA, fromC])
  expect(queue(first)).toEqual(expected)
  expect(queue(second)).toEqual(expected)
  expect(activeMinutes(first)).toBe(0)
  expect(activeMinutes(second)).toBe(0)

  // Existing local history keeps counting; only the incoming unknown ID is held.
  deliver(a, batchC)
  deliver(c, batchA)
  expect(queue(a).map((entry) => entry.legacyId)).toEqual([fromC])
  expect(queue(c).map((entry) => entry.legacyId)).toEqual([fromA])
  expect(activeMinutes(a)).toBe(60)
  expect(activeMinutes(c)).toBe(60)

  const resolution = planLegacyReconciliation(first, workspaceId, {
    provider: 'claude',
    conversationId: 'conversation-x',
    candidates: [fromC, fromA],
    keep: [fromA],
    duplicates: [fromC]
  })
  record(first, [resolution])
  const resolved = publish(first)
  for (const db of [a, c, second]) deliver(db, resolved)
  for (const db of [a, c, first, second]) {
    expect(queue(db).map(({ legacyId, status }) => ({ legacyId, status }))).toEqual([
      { legacyId: fromC, status: 'duplicate' }
    ])
    expect(activeMinutes(db)).toBe(60)
    // Nothing is erased: both snapshots and their sessions remain for audit.
    expect(db.select().from(sessionLegacyRecords).all()).toHaveLength(2)
  }
  // Replaying the same resolution is a no-op.
  deliver(second, resolved, batchA, batchC)
  expect(queue(second).map(({ legacyId, status }) => ({ legacyId, status }))).toEqual([
    { legacyId: fromC, status: 'duplicate' }
  ])
  // A stale review of a group that no longer exists is rejected.
  expect(() =>
    planLegacyReconciliation(first, workspaceId, {
      provider: 'claude',
      conversationId: 'conversation-x',
      candidates: [fromA],
      keep: [fromA],
      duplicates: []
    })
  ).toThrow()
})

it('keeps the last agreed resolution on every computer while later reviews disagree', () => {
  const a = database()
  const c = database()
  const fromA = legacySession(a)
  const fromC = legacySession(c, {
    startedAt: '2026-03-04T10:30:00Z',
    endedAt: '2026-03-04T11:30:00Z'
  })
  exportHistory(a, machine(a, 'Desktop'))
  exportHistory(c, machine(c, 'Laptop'))
  const batchA = publish(a)
  const batchC = publish(c)
  const hub = database()
  const left = database()
  const right = database()
  for (const db of [hub, left, right]) deliver(db, batchA, batchC)
  deliver(a, batchC)
  deliver(c, batchA)
  const review = (db: Db, keep: string[], duplicates: string[]) =>
    planLegacyReconciliation(db, workspaceId, {
      provider: 'claude',
      conversationId: 'conversation-x',
      candidates: [fromA, fromC],
      keep,
      duplicates
    })
  const agreed = review(hub, [fromA, fromC], [])
  record(hub, [agreed])
  const agreedBatch = publish(hub)
  for (const db of [a, c, left, right]) deliver(db, agreedBatch)
  record(left, [review(left, [fromA], [fromC])])
  record(right, [review(right, [fromC], [fromA])])
  const leftBatch = publish(left)
  const rightBatch = publish(right)
  deliver(left, rightBatch)
  deliver(right, leftBatch)
  for (const db of [a, c, hub]) deliver(db, leftBatch, rightBatch)

  for (const db of [a, c, hub, left, right]) {
    // Both rows keep counting under the keep-all decision, not this computer's own rows.
    expect(activeMinutes(db)).toBe(120)
    expect(
      queue(db).map(({ legacyId, status, counting, lastAgreed }) => ({
        legacyId,
        status,
        counting,
        lastAgreed
      }))
    ).toEqual(
      [fromA, fromC].sort().map((legacyId) => ({
        legacyId,
        status: 'conflict',
        counting: true,
        lastAgreed: [agreed.entityId]
      }))
    )
  }
  // A resolution naming both current heads converges everywhere.
  const settle = review(hub, [fromA], [fromC])
  expect(settle.payload.supersedes).toHaveLength(2)
  record(hub, [settle])
  const settled = publish(hub)
  for (const db of [a, c, left, right]) deliver(db, settled)
  for (const db of [a, c, hub, left, right]) {
    expect(activeMinutes(db)).toBe(60)
    expect(queue(db).map(({ legacyId, status }) => ({ legacyId, status }))).toEqual([
      { legacyId: fromC, status: 'duplicate' }
    ])
  }
})

it('never fabricates history for an unknown provider', () => {
  const a = database()
  machine(a, 'Desktop')
  const legacyId = legacySession(a, { tool: 'cursor' as never })
  expect(collectLegacySyncChanges(a, workspaceId).withheld).toEqual([
    { legacyId, reason: 'unknown-provider' }
  ])
  const incoming: SyncChange = {
    id: syncFactChangeId(workspaceId, 'legacy-session', legacyId),
    kind: 'fact',
    entityType: 'legacy-session',
    entityId: legacyId,
    dependencies: [],
    payload: {
      version: 1,
      snapshotVersion: 1,
      provider: 'cursor',
      conversationId: 'conversation-x',
      startedAt: '2026-03-04T10:00:00.000Z',
      endedAt: '2026-03-04T11:00:00.000Z',
      durationMinutes: 60,
      promptCount: 1,
      inputTokens: 1,
      outputTokens: 1,
      modelUsage: [],
      billable: true,
      description: null,
      clientSyncId: null,
      projectSyncId: null,
      splitFrom: null
    }
  }
  expect(() => legacyRecordsAdapter.validate(incoming)).toThrow(/update ClauTime/)
  expect(() =>
    legacyRecordsAdapter.validate({
      ...incoming,
      payload: { ...incoming.payload, snapshotVersion: 2 }
    })
  ).toThrow(/update ClauTime/)
})

it('withholds timezone-naive saved times unless explicitly confirmed as UTC', () => {
  const a = database()
  const deviceA = machine(a, 'Desktop')
  const legacyId = legacySession(a, {
    startedAt: '2026-03-04 10:00:00',
    endedAt: '2026-03-04T11:00:00'
  })
  const pending = collectLegacySyncChanges(a, workspaceId)
  expect(pending.changes).toEqual([])
  expect(pending.withheld).toEqual([{ legacyId, reason: 'timezone-naive' }])

  // A foreign row of the same conversation on another day is held: the naive row's instant is unknown.
  const c = database()
  legacySession(c, { startedAt: '2026-03-09T10:00:00Z', endedAt: '2026-03-09T11:00:00Z' })
  exportHistory(c, machine(c, 'Laptop'))
  deliver(a, publish(c))
  expect(queue(a).map((entry) => entry.status)).toEqual(['queued'])
  expect(activeMinutes(a)).toBe(60)

  const { legacy } = exportHistory(a, deviceA, { naiveTimesAsUtc: [legacyId] })
  const fact = legacy.changes.find((change) => change.entityType === 'legacy-session')!
  expect(fact.payload).toMatchObject({
    startedAt: '2026-03-04T10:00:00.000Z',
    endedAt: '2026-03-04T11:00:00.000Z'
  })
})

it('retains a saved row whose source log is confirmed gone without exporting its file name', () => {
  const a = database()
  const sessionId = savedRow(a, { sourceFile: '/logs/fixture/gone.jsonl' })
  expect(retainSourceLessSessionsForSync(a, [sessionId])).toEqual({
    retained: [],
    skipped: [sessionId]
  })
  const { retained } = retainSourceLessSessionsForSync(a, [sessionId], {
    sourceFileGone: [sessionId]
  })
  expect(retained).toHaveLength(1)
  exportHistory(a, machine(a, 'Desktop'))
  for (const { json } of a.select({ json: syncChanges.changeJson }).from(syncChanges).all())
    expect(json).not.toContain('gone.jsonl')
  // The original saved row keeps its local metadata.
  expect(a.select().from(sessions).where(eq(sessions.id, sessionId)).get()!.sourceFile).toBe(
    '/logs/fixture/gone.jsonl'
  )

  const b = database()
  deliver(b, publish(a))
  const restored = b
    .select()
    .from(sessionLegacyRecords)
    .where(eq(sessionLegacyRecords.id, retained[0].legacyId))
    .get()!
  expect(
    b.select().from(sessions).where(eq(sessions.id, restored.sessionId)).get()!.sourceFile
  ).toBeNull()
  expect(activeMinutes(b)).toBe(60)
})

/** What session-service.splitSession records for a legacy row, including child snapshots. */
function splitLocally(db: Db, sessionId: number, splitAt: string): [string, string, string] {
  const parent = db.select().from(sessions).where(eq(sessions.id, sessionId)).get()!
  const parentLegacyId = retainLegacySession(db as never, parent)
  const revisionId = randomUUID()
  db.insert(sessionRevisions)
    .values({
      id: revisionId,
      sessionId,
      sequence: 1,
      kind: 'split',
      tool: parent.tool,
      claudeSessionId: parent.claudeSessionId,
      startedAt: parent.startedAt,
      endedAt: parent.endedAt,
      before: '{}',
      after: '{}',
      createdAt: new Date().toISOString()
    })
    .run()
  const children = [
    [parent.startedAt, splitAt],
    [splitAt, parent.endedAt]
  ].map(([startedAt, endedAt]) => {
    const { id: _id, ...rest } = parent
    const row = db
      .insert(sessions)
      .values({ ...rest, startedAt, endedAt, durationMinutes: 30 })
      .returning()
      .get()
    return { row, legacyId: retainLegacySession(db as never, row) }
  })
  db.insert(sessionSplits)
    .values({
      revisionId,
      legacyRecordId: parentLegacyId,
      parentSessionId: sessionId,
      firstSessionId: children[0].row.id,
      secondSessionId: children[1].row.id,
      sourceFile: null,
      tool: parent.tool,
      claudeSessionId: parent.claudeSessionId,
      startedAt: parent.startedAt,
      endedAt: parent.endedAt,
      splitAt
    })
    .run()
  return [parentLegacyId, children[0].legacyId, children[1].legacyId]
}

const changeIds = (db: Db) =>
  db
    .select({ id: syncChanges.id })
    .from(syncChanges)
    .all()
    .map((row) => row.id)
    .sort()
const reconciliations = (db: Db) =>
  db.select().from(syncChanges).where(eq(syncChanges.entityType, 'legacy-reconciliation')).all()
const suppressions = (db: Db) =>
  db
    .select()
    .from(syncHistorySuppressions)
    .orderBy(syncHistorySuppressions.recordId)
    .all()
    .map(({ recordId, status, detailJson }) => ({ recordId, status, detailJson }))

it('exports saved history in bounded batches, in any order and across an interruption, exactly as in one pass', () => {
  const a = database()
  const [parent, first, second] = splitLocally(
    a,
    savedRow(a, { claudeSessionId: 'split' }),
    '2026-03-04T10:30:00.000Z'
  )
  const x = legacySession(a, { claudeSessionId: 'overlap' })
  const y = legacySession(a, {
    claudeSessionId: 'overlap',
    startedAt: '2026-03-04T10:30:00Z',
    endedAt: '2026-03-04T11:30:00Z'
  })
  const z = legacySession(a, { claudeSessionId: 'single' })
  const b = database(connections.get(a)!.serialize())
  const counted = activeMinutes(a)
  expect(counted).toBe(30 + 30 + 60 * 3)

  // One pass on A.
  journalLegacySyncChanges(a, workspaceId, collectLegacySyncChanges(a, workspaceId).changes)

  // B: batches, with keep-all resolutions swept only after every record is journaled.
  const exportBatch = (legacyIds: string[]) => {
    const legacy = collectLegacySyncChanges(b, workspaceId, { legacyIds })
    expect(legacy.withheld).toEqual([])
    journalLegacySyncChanges(b, workspaceId, legacy.changes, { origin: 'none' })
    // This computer's own history keeps counting between batches.
    expect(activeMinutes(b)).toBe(counted)
  }
  // A split parent before its children (their snapshots come with it), and half of an overlap.
  exportBatch([parent])
  exportBatch([x])
  // "Interrupted" here: the plan is made afresh from whole conversations and resumes.
  const batches = planLegacyExportBatches(b, 1)
  const sorted = (lists: string[][]) => lists.map((list) => [...list].sort()).sort()
  expect(sorted(batches)).toEqual(sorted([[parent, first, second], [x, y], [z]]))
  for (const batch of batches) exportBatch(batch)
  expect(reconciliations(b)).toEqual([])
  for (const page of planLegacyOriginPages(b, 1))
    journalLegacySyncChanges(b, workspaceId, [], { origin: page })

  expect(changeIds(b)).toEqual(changeIds(a))
  expect(reconciliations(b)).toHaveLength(1)
  expect(suppressions(b)).toEqual(suppressions(a))
  expect(queue(b)).toEqual(queue(a))
  expect(activeMinutes(b)).toBe(counted)
  expect(activeMinutes(a)).toBe(counted)
  // No baseline drift on a rerun: nothing new to journal.
  expect(collectLegacySyncChanges(b, workspaceId).changes).toEqual([])
  expect(planOriginLegacyReconciliations(b, workspaceId)).toEqual([])

  // A blank receiver counts the split children once and the overlap as its origin does.
  const c = database()
  deliver(c, publish(b))
  expect(activeMinutes(c)).toBe(counted)
  expect(readLegacyQueue(c, workspaceId)).toEqual([])
})

it('refreshes only the conversations in scope, exactly as a full refresh does', () => {
  const a = database()
  const c = database()
  legacySession(a)
  legacySession(a, { startedAt: '2026-03-04T10:30:00Z', endedAt: '2026-03-04T11:30:00Z' })
  const own = legacySession(a, { claudeSessionId: 'conversation-y' })
  const w = legacySession(c, { startedAt: '2026-03-04T11:15:00Z', endedAt: '2026-03-04T12:15:00Z' })
  const v = legacySession(c, {
    claudeSessionId: 'conversation-y',
    startedAt: '2026-03-04T10:30:00Z',
    endedAt: '2026-03-04T11:30:00Z'
  })
  exportHistory(a, machine(a, 'Desktop'))
  exportHistory(c, machine(c, 'Laptop'))
  deliver(a, publish(c))
  const full = suppressions(a)
  // Only the foreign IDs are held; this computer's own rows keep counting.
  expect(full.map((row) => row.recordId)).toEqual([v, w].sort())
  expect(activeMinutes(a)).toBe(180)

  a.delete(syncHistorySuppressions).run()
  a.transaction((tx) => refreshLegacyState(tx, workspaceId, { legacyIds: [own] }))
  expect(suppressions(a)).toEqual(full.filter((row) => row.recordId === v))
  a.transaction((tx) => refreshLegacyState(tx, workspaceId, 'all'))
  expect(suppressions(a)).toEqual(full)
  expect(activeMinutes(a)).toBe(180)
})
