// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq, sql } from 'drizzle-orm'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sessions } from '../db/schema/sessions'
import { activeSessionCondition } from '../db/schema/session-deletions'
import { sourceMachines } from '../db/schema/activity-observers'
import { manualTimeEntries } from '../db/schema/manual-time-entries'
import { activitySyncAdapter, collectActivitySyncChanges } from './folder-sync-activity-records'
import type { SyncBatch, SyncChange } from './folder-sync-protocol'
import {
  applyReadySyncBatches,
  assembleOutgoingBatch,
  recordLocalSyncChanges,
  retainIncomingBatch,
  type SyncDomainAdapter
} from './folder-sync-store'
import { PRESENT, type RecordView, type RevisionAction } from './folder-sync-revisions'
import {
  collectManualSyncChanges,
  getManualEntryView,
  manualRecordsAdapter,
  planManualEntryRevision,
  readManualEntryState,
  validateManualChange
} from './folder-sync-manual-records'
import {
  collectHistoryObserverChanges,
  historyObserversAdapter,
  readHistoryObservers
} from './folder-sync-history-observers'

const workspaceId = '6a0f8f64-3c1d-4b8e-9f51-2d7c4e9b1a30'
type Db = ReturnType<typeof drizzle>
const opened: Database.Database[] = []
let a: Db
let b: Db
let deviceA: string
let entryId: string

function database(): Db {
  const connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  opened.push(connection)
  const db = drizzle(connection)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  return db
}

const route = (change: SyncChange): SyncDomainAdapter =>
  change.entityType === 'manual-entry'
    ? manualRecordsAdapter
    : change.entityType === 'history-observer'
      ? historyObserversAdapter
      : activitySyncAdapter
const adapter: SyncDomainAdapter = {
  validate: (change) => route(change).validate(change),
  apply: (tx, workspace, change) => route(change).apply(tx, workspace, change)
}
const record = (db: Db, changes: unknown[]): string[] =>
  recordLocalSyncChanges(db, workspaceId, changes, adapter)
const assemble = (db: Db): SyncBatch | null =>
  assembleOutgoingBatch(db, workspaceId, { writerEpochId: randomUUID(), deviceId: randomUUID() })
function deliver(db: Db, ...batches: SyncBatch[]): void {
  for (const batch of batches) retainIncomingBatch(db, workspaceId, batch, adapter)
  const result = applyReadySyncBatches(db, workspaceId, adapter)
  expect(result.errors).toEqual([])
  expect(result.waiting).toEqual([])
}
const sent: SyncBatch[] = []
function exchange(): void {
  const fromA = assemble(a)
  const fromB = assemble(b)
  if (fromA) sent.push(fromA)
  if (fromB) sent.push(fromB)
  if (fromA) deliver(b, fromA)
  if (fromB) deliver(a, fromB)
}

const view = (db: Db): RecordView => getManualEntryView(db, workspaceId, entryId)
function revise(db: Db, action: (current: RecordView) => RevisionAction): void {
  record(db, [
    planManualEntryRevision(db, workspaceId, {
      id: randomUUID(),
      entryId,
      action: action(view(db))
    })
  ])
}
const localSession = (db: Db) => {
  const entry = db.select().from(manualTimeEntries).where(eq(manualTimeEntries.id, entryId)).get()!
  return db.select().from(sessions).where(eq(sessions.id, entry.sessionId)).get()!
}
const counted = (db: Db): number =>
  db
    .select({ count: sql<number>`count(*)` })
    .from(sessions)
    .where(activeSessionCondition)
    .get()!.count

beforeEach(() => {
  sent.length = 0
  a = database()
  b = database()
  deviceA = randomUUID()
  a.insert(sourceMachines).values({ deviceId: deviceA, initialName: 'Desktop' }).run()
  const row = a
    .insert(sessions)
    .values({
      projectPath: '/home/fixture/secret-project',
      source: 'manual',
      startedAt: '2026-03-05T09:00:00Z',
      endedAt: '2026-03-05T09:45:00Z',
      durationMinutes: 45,
      description: 'Initial'
    })
    .returning()
    .get()
  entryId = randomUUID()
  a.insert(manualTimeEntries)
    .values({ id: entryId, sessionId: row.id, deviceId: deviceA, basis: 'created' })
    .run()
  record(a, collectActivitySyncChanges(a, workspaceId))
  const manual = collectManualSyncChanges(a, workspaceId)
  expect(manual).toMatchObject({ blocked: [], withheld: [] })
  record(a, manual.changes)
  record(a, collectHistoryObserverChanges(a, workspaceId, deviceA).changes)
  exchange()
})
afterEach(() => {
  for (const connection of opened.splice(0)) connection.close()
})

it('imports the entry once under its UUID and origin device, then edits it in place', () => {
  const imported = localSession(b)
  expect(imported).toMatchObject({
    source: 'manual',
    projectPath: '',
    sourceFile: null,
    startedAt: '2026-03-05T09:00:00.000Z',
    durationMinutes: 45,
    description: 'Initial'
  })
  expect(b.select().from(manualTimeEntries).get()).toMatchObject({
    id: entryId,
    deviceId: deviceA,
    basis: 'created',
    parentId: null
  })
  expect(readHistoryObservers(b, { recordType: 'manual-entry' })).toMatchObject([
    { recordId: entryId, deviceId: deviceA, basis: 'observed' }
  ])
  // The origin row keeps its local spelling and ID.
  expect(localSession(a).startedAt).toBe('2026-03-05T09:00:00Z')

  revise(a, (current) => ({
    type: 'edit',
    observedHeads: current.heads,
    values: { description: 'Renamed' }
  }))
  exchange()
  expect(localSession(b)).toMatchObject({ id: imported.id, description: 'Renamed' })
  expect(b.select().from(sessions).all()).toHaveLength(1)
})

it('keeps the last agreed value and a visible blocker for concurrent field edits', () => {
  revise(a, (current) => ({
    type: 'edit',
    observedHeads: current.heads,
    values: { description: 'From A' }
  }))
  revise(b, (current) => ({
    type: 'edit',
    observedHeads: current.heads,
    values: { description: 'From B' }
  }))
  exchange()
  for (const db of [a, b]) {
    expect(view(db).fields.description).toMatchObject({ status: 'conflict', value: 'Initial' })
    expect(localSession(db).description).toBe('Initial')
    expect(readManualEntryState(db, workspaceId, entryId)?.blockers).toEqual(['description'])
  }
  // No clock winner: an explicit resolution naming both heads converges.
  revise(a, (current) => ({
    type: 'resolve',
    expectedHeads: current.heads,
    values: { description: 'Agreed' }
  }))
  exchange()
  for (const db of [a, b]) {
    expect(localSession(db).description).toBe('Agreed')
    expect(readManualEntryState(db, workspaceId, entryId)?.blockers).toEqual([])
  }
})

it('holds edit-versus-delete as a conflict, then suppresses without erasing or resurrecting', () => {
  revise(a, (current) => ({ type: 'delete', observedHeads: current.heads }))
  revise(b, (current) => ({
    type: 'edit',
    observedHeads: current.heads,
    values: { billable: false }
  }))
  exchange()
  for (const db of [a, b]) {
    expect(view(db).lifecycle).toBe('conflict')
    // Last agreed lifecycle (present) is retained and flagged.
    expect(counted(db)).toBe(1)
    expect(readManualEntryState(db, workspaceId, entryId)?.blockers).toContain(PRESENT)
  }
  revise(b, (current) => ({ type: 'resolve', expectedHeads: current.heads, present: false }))
  exchange()
  for (const db of [a, b]) {
    expect(view(db).lifecycle).toBe('deleted')
    expect(counted(db)).toBe(0)
    // Suppressed, not erased: the row and its identity stay for audit.
    expect(db.select().from(manualTimeEntries).all()).toHaveLength(1)
    expect(db.select().from(sessions).all()).toHaveLength(1)
  }
  // Replaying every earlier batch, including the original creation, never resurrects it.
  for (const batch of sent) retainIncomingBatch(a, workspaceId, batch, adapter)
  const fresh = database()
  deliver(fresh, ...sent)
  for (const db of [a, fresh]) expect(counted(db)).toBe(0)
  expect(() =>
    planManualEntryRevision(a, workspaceId, {
      id: randomUUID(),
      entryId,
      action: { type: 'edit', observedHeads: view(a).heads, values: { description: 'Back' } }
    })
  ).toThrow()
})

it('rejects roots that are not the deterministic identity and edits of create-only fields', () => {
  const root = collectManualSyncChanges(database(), workspaceId).changes
  expect(root).toEqual([])
  const edit = planManualEntryRevision(a, workspaceId, {
    id: randomUUID(),
    entryId,
    action: { type: 'edit', observedHeads: view(a).heads, values: { billable: false } }
  })
  const forged = {
    ...edit,
    payload: { fields: { ...edit.payload.fields, basis: { value: 'imported', parents: [] } } }
  }
  expect(() => validateManualChange(forged)).toThrow()
  expect(() =>
    planManualEntryRevision(a, workspaceId, {
      id: randomUUID(),
      entryId,
      action: { type: 'edit', observedHeads: view(a).heads, values: { deviceId: null } }
    })
  ).toThrow()
})

it('never exports a running timer', () => {
  const running = a
    .insert(sessions)
    .values({
      projectPath: '',
      source: 'manual',
      status: 'active',
      startedAt: '2026-03-06T09:00:00Z',
      endedAt: '2026-03-06T09:00:00Z',
      durationMinutes: 0
    })
    .returning()
    .get()
  const timerId = randomUUID()
  a.insert(manualTimeEntries)
    .values({ id: timerId, sessionId: running.id, deviceId: deviceA, basis: 'created' })
    .run()
  expect(collectManualSyncChanges(a, workspaceId)).toEqual({
    changes: [],
    blocked: [],
    withheld: [{ entryId: timerId, reason: 'running' }]
  })
})
