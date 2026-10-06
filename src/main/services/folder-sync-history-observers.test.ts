// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sessions } from '../db/schema/sessions'
import { sourceMachines } from '../db/schema/activity-observers'
import {
  activitySyncAdapter,
  collectActivitySyncChanges,
  syncFactChangeId
} from './folder-sync-activity-records'
import type { SyncChange } from './folder-sync-protocol'
import {
  applyReadySyncBatches,
  assembleOutgoingBatch,
  recordLocalSyncChanges,
  retainIncomingBatch,
  type SyncDomainAdapter
} from './folder-sync-store'
import {
  collectLegacySyncChanges,
  journalLegacySyncChanges,
  LEGACY_SYNC_ENTITY_TYPES,
  legacyRecordsAdapter,
  retainSourceLessSessionsForSync
} from './folder-sync-legacy-records'
import {
  collectHistoryObserverChanges,
  historyObserverEntityId,
  historyObserversAdapter,
  planHistoryObserverFact,
  readHistoryObservers,
  type HistoryObserver
} from './folder-sync-history-observers'

const workspaceId = '6a0f8f64-3c1d-4b8e-9f51-2d7c4e9b1a30'
type Db = ReturnType<typeof drizzle>
const opened: Database.Database[] = []

function database(): Db {
  const connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  opened.push(connection)
  const db = drizzle(connection)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  return db
}
afterEach(() => {
  for (const connection of opened.splice(0)) connection.close()
})

const legacyTypes = new Set<string>(LEGACY_SYNC_ENTITY_TYPES)
const route = (change: SyncChange): SyncDomainAdapter =>
  legacyTypes.has(change.entityType)
    ? legacyRecordsAdapter
    : change.entityType === 'history-observer'
      ? historyObserversAdapter
      : activitySyncAdapter
const adapter: SyncDomainAdapter = {
  validate: (change) => route(change).validate(change),
  apply: (tx, workspace, change) => route(change).apply(tx, workspace, change)
}

function legacySession(db: Db, startedAt: string, endedAt: string): string {
  const row = db
    .insert(sessions)
    .values({
      projectPath: '/home/fixture/project',
      tool: 'codex',
      claudeSessionId: 'conversation-y',
      startedAt,
      endedAt,
      durationMinutes: 30
    })
    .returning()
    .get()
  return retainSourceLessSessionsForSync(db, [row.id]).retained[0].legacyId
}

function exported(db: Db, deviceId: string) {
  recordLocalSyncChanges(db, workspaceId, collectActivitySyncChanges(db, workspaceId), adapter)
  journalLegacySyncChanges(db, workspaceId, collectLegacySyncChanges(db, workspaceId).changes)
  return collectHistoryObserverChanges(db, workspaceId, deviceId)
}

function setup() {
  const a = database()
  const deviceId = randomUUID()
  a.insert(sourceMachines).values({ deviceId, initialName: 'Desktop' }).run()
  const first = legacySession(a, '2026-04-01T09:00:00.000Z', '2026-04-01T09:30:00.000Z')
  const second = legacySession(a, '2026-04-02T09:00:00.000Z', '2026-04-02T09:30:00.000Z')
  return { a, deviceId, first, second }
}

it('labels each exported native legacy record once with its importing computer', () => {
  const { a, deviceId, first, second } = setup()
  const observers = exported(a, deviceId)
  expect(observers.requires).toEqual([])
  expect(observers.changes.map((change) => change.payload.recordId).sort()).toEqual(
    [first, second].sort()
  )
  recordLocalSyncChanges(a, workspaceId, observers.changes, adapter)
  // Already-recorded observers are not planned again.
  expect(collectHistoryObserverChanges(a, workspaceId, deviceId).changes).toEqual([])

  const b = database()
  const batch = assembleOutgoingBatch(a, workspaceId, { writerEpochId: randomUUID(), deviceId })!
  retainIncomingBatch(b, workspaceId, batch, adapter)
  expect(applyReadySyncBatches(b, workspaceId, adapter).errors).toEqual([])
  expect(readHistoryObservers(b, { workspaceId, recordType: 'legacy-session' })).toEqual(
    [first, second].sort().map((recordId) => ({
      recordType: 'legacy-session',
      recordId,
      deviceId,
      basis: 'imported',
      initialName: 'Desktop'
    }))
  )
})

it('exports provenance in resumable pages without omitting other records', () => {
  const { a, deviceId, first, second } = setup()
  const whole = exported(a, deviceId)
  const firstPage = collectHistoryObserverChanges(a, workspaceId, deviceId, {
    legacyIds: [first],
    manualIds: []
  })
  expect(firstPage.changes.map((change) => change.payload.recordId)).toEqual([first])
  recordLocalSyncChanges(a, workspaceId, firstPage.changes, adapter)
  expect(
    collectHistoryObserverChanges(a, workspaceId, deviceId, { legacyIds: [first], manualIds: [] })
      .changes
  ).toEqual([])
  const next = collectHistoryObserverChanges(a, workspaceId, deviceId, {
    legacyIds: [second],
    manualIds: []
  })
  expect([...firstPage.changes, ...next.changes].map((change) => change.id).sort()).toEqual(
    whole.changes.map((change) => change.id).sort()
  )
  recordLocalSyncChanges(a, workspaceId, next.changes, adapter)
  expect(collectHistoryObserverChanges(a, workspaceId, deviceId).changes).toEqual([])
})

it('rejects observers that misstate their record, contents or dependencies', () => {
  const { a, deviceId, first, second } = setup()
  exported(a, deviceId)
  const observer: HistoryObserver = {
    recordType: 'legacy-session',
    recordId: first,
    deviceId,
    basis: 'imported'
  }
  const valid = planHistoryObserverFact(
    workspaceId,
    observer,
    syncFactChangeId(workspaceId, 'legacy-session', first)
  )
  expect(valid.entityId).toBe(historyObserverEntityId(observer))

  expect(() =>
    historyObserversAdapter.validate({
      ...valid,
      entityId: historyObserverEntityId({ ...observer, recordId: second })
    })
  ).toThrow(/does not match/)
  expect(() =>
    historyObserversAdapter.validate({ ...valid, dependencies: valid.dependencies.slice(1) })
  ).toThrow(/depends on its machine and its record/)
  expect(() =>
    historyObserversAdapter.validate({ ...valid, payload: { ...valid.payload, basis: 'owned' } })
  ).toThrow(/basis/)
  expect(() =>
    historyObserversAdapter.validate({
      ...valid,
      payload: { ...valid.payload, recordType: 'legacy-folder' }
    })
  ).toThrow(/update ClauTime/)

  // Pointing at another record's fact is caught when applied.
  const misattributed = planHistoryObserverFact(
    workspaceId,
    observer,
    syncFactChangeId(workspaceId, 'legacy-session', second)
  )
  expect(() => recordLocalSyncChanges(a, workspaceId, [misattributed], adapter)).toThrow(
    /does not depend on its machine and record/
  )
  expect(recordLocalSyncChanges(a, workspaceId, [valid], adapter)).toEqual([valid.id])
})
