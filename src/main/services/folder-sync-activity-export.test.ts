// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { activityIdentities, activityObservations } from '../db/schema/activity-evidence'
import { activityObservers, sourceMachines } from '../db/schema/activity-observers'
import { syncChanges } from '../db/schema/folder-sync'
import {
  collectAvailableActivity,
  exportActivityPage,
  type ActivityExportPage,
  type ActivityExportPhase
} from './folder-sync-activity-export'
import {
  activityObservationId,
  activityObserverEntityId,
  collectActivitySyncChanges,
  syncFactChangeId
} from './folder-sync-activity-records'
import type { SyncEntityType } from './folder-sync-protocol'

vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

type Db = ReturnType<typeof drizzle>
const WORKSPACE = '2fd7cbd1-7f6b-4935-b18c-367ae5ff5fb9'
const DEVICE_A = '9b95ec41-b3b6-4cbb-b1b6-e7ce607ef222'
const DEVICE_B = '7c8f7eab-af58-4cbb-9e74-d1e47f80d600'
const CAPTURED = '2031-03-04T05:06:07.000Z'
const migrationsFolder = join(__dirname, '../db/migrations')
const opened: Database.Database[] = []
let db: Db

beforeEach(() => {
  const connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  opened.push(connection)
  db = drizzle(connection)
  migrate(db, { migrationsFolder })
})
afterEach(() => {
  for (const connection of opened.splice(0)) connection.close()
})

const at = (n: number) => new Date(Date.parse('2026-07-19T18:07:00.000Z') + n * 1000).toISOString()

function machine(deviceId: string, initialName = 'Desk'): void {
  db.insert(sourceMachines).values({ deviceId, initialName }).onConflictDoNothing().run()
}

/** A valid Claude native identity. */
function identity(n: number): string {
  const nativeEventId = `message-${n}`
  const eventId = `claude:v1:native:${createHash('sha256')
    .update(JSON.stringify(['claude', 1, 'conversation-a', 'native', nativeEventId]))
    .digest('hex')}`
  db.insert(activityIdentities)
    .values({
      eventId,
      provider: 'claude',
      identityVersion: 1,
      conversationId: 'conversation-a',
      basis: 'native',
      nativeEventId
    })
    .onConflictDoNothing()
    .run()
  return eventId
}

function observer(observationId: string, deviceId: string): void {
  machine(deviceId)
  db.insert(activityObservers).values({ observationId, deviceId, basis: 'observed' }).run()
}

/** A valid progress observation of identity `n`, observed by `devices`. */
function observation(n: number, devices: string[] = [DEVICE_A]): string {
  const eventId = identity(n)
  const fact = { kind: 'progress', progressType: 'hook_progress', timestamp: at(n) }
  const id = activityObservationId(eventId, 'activity', fact)
  db.insert(activityObservations)
    .values({
      id,
      eventId,
      version: 1,
      kind: 'activity',
      payloadJson: JSON.stringify(fact),
      createdAt: CAPTURED
    })
    .run()
  for (const deviceId of devices) observer(id, deviceId)
  return id
}

/** An unsupported local capture that can never be shared. */
function unsupported(id: string, n = 1000): void {
  db.insert(activityObservations)
    .values({
      id,
      eventId: identity(n),
      version: 999,
      kind: 'message',
      payloadJson: '{}',
      createdAt: CAPTURED
    })
    .run()
}

function drain(phase: ActivityExportPhase = 'observations', limit = 100): ActivityExportPage[] {
  const pages: ActivityExportPage[] = []
  let cursor = 0
  for (let i = 0; i < 100; i++) {
    const page = exportActivityPage(db, WORKSPACE, cursor, limit, phase)
    expect(page.cursor).toBeGreaterThanOrEqual(cursor)
    pages.push(page)
    if (page.done) return pages
    expect(page.cursor).toBeGreaterThan(cursor)
    cursor = page.cursor
  }
  throw new Error('Export did not finish')
}

function drainAll(limit = 100): ActivityExportPage[] {
  return (['observations', 'identities', 'machines'] as const).flatMap((phase) =>
    drain(phase, limit)
  )
}

const journaled = () =>
  db
    .select({
      id: syncChanges.id,
      entityType: syncChanges.entityType,
      entityId: syncChanges.entityId
    })
    .from(syncChanges)
    .all()
const journaledIds = () => new Set(journaled().map((row) => row.id))
const has = (entityType: SyncEntityType, entityId: string) =>
  journaledIds().has(syncFactChangeId(WORKSPACE, entityType, entityId))

it('journals observations in bounded pages with their dependencies', () => {
  const ids = [1, 2, 3, 4, 5].map((n) => observation(n))
  const pages = drain('observations', 2)
  expect(pages.map((page) => page.done)).toEqual([false, false, true])
  // One machine, then per observation its identity, observation and observer.
  expect(pages.map((page) => page.exported)).toEqual([7, 6, 3])
  expect(pages.flatMap((page) => page.issues)).toEqual([])
  expect(journaledIds()).toEqual(
    new Set(collectActivitySyncChanges(db, WORKSPACE).map((change) => change.id))
  )
  for (const id of ids) expect(has('activity-observation', id)).toBe(true)
})

it('bounds already-exported scans and journals nothing when run again', () => {
  for (const n of [1, 2, 3]) observation(n)
  drainAll(2)
  const before = journaled()
  const again = drainAll(2)
  expect(again.every((page) => page.exported === 0 && page.issues.length === 0)).toBe(true)
  expect(again.filter((page) => !page.done)).toHaveLength(2)
  expect(journaled()).toEqual(before)
})

it('journals a new observer of an already-exported observation', () => {
  const [first] = [observation(1), observation(2)]
  drain()
  const count = journaled().length
  observer(first, DEVICE_B)
  const [page] = drain()
  // The new machine and observer only; the observation fact is unchanged.
  expect(page).toMatchObject({ done: true, exported: 2, issues: [] })
  expect(journaled()).toHaveLength(count + 2)
  expect(has('machine', DEVICE_B)).toBe(true)
  expect(has('activity-observer', activityObserverEntityId(first, DEVICE_B, 'observed'))).toBe(true)
})

it('moves past malformed rows so valid successors still export', () => {
  for (let i = 0; i < 3; i++) unsupported(`bad-${i}`)
  const valid = [observation(1), observation(2)]
  const pages = drain('observations', 2)
  expect(pages.map((page) => page.issues.map((issue) => issue.source))).toEqual([
    ['bad-0', 'bad-1'],
    ['bad-2'],
    []
  ])
  expect(new Set(pages.flatMap((page) => page.issues).map((issue) => issue.code))).toEqual(
    new Set(['SYNC_LOCAL_ACTIVITY_WITHHELD'])
  )
  for (const id of valid) expect(has('activity-observation', id)).toBe(true)
  for (let i = 0; i < 3; i++) expect(has('activity-observation', `bad-${i}`)).toBe(false)
  // The withheld captures stay in the local ledger.
  expect(db.select().from(activityObservations).all()).toHaveLength(5)
})

it('caps issues reported by one page', () => {
  for (let i = 0; i < 25; i++) unsupported(`bad-${String(i).padStart(2, '0')}`)
  const valid = observation(1)
  const [page] = drain()
  expect(page.issues).toHaveLength(11)
  expect(page.issues[10].message).toContain('additional')
  expect(has('activity-observation', valid)).toBe(true)
})

it('exports machines and identities that no observation carries', () => {
  observation(1)
  machine(DEVICE_B, 'Laptop')
  const lone = identity(2)
  machine(randomUUID(), ' ')
  const other = randomUUID()
  machine(other, 'Spare')
  expect(drain()[0].exported).toBe(4)
  expect(has('machine', DEVICE_B)).toBe(false)
  expect(has('activity-identity', lone)).toBe(false)
  const identities = drain('identities', 1)
  expect(identities.reduce((sum, page) => sum + page.exported, 0)).toBe(1)
  expect(has('activity-identity', lone)).toBe(true)
  // An invalid machine is reported once and passed; valid machines after it still export.
  const machines = drain('machines', 1)
  expect(machines.flatMap((page) => page.issues)).toHaveLength(1)
  expect(machines.reduce((sum, page) => sum + page.exported, 0)).toBe(2)
  expect(has('machine', DEVICE_B)).toBe(true)
  expect(has('machine', other)).toBe(true)
})

it('withholds an observation whose dependency cannot be shared', () => {
  const orphaned = observation(1, ['not-a-device-uuid'])
  const valid = observation(2)
  const [page] = drain()
  expect(page.issues.map((issue) => issue.source)).toEqual(['not-a-device-uuid'])
  expect(has('activity-observation', orphaned)).toBe(false)
  expect(has('activity-observation', valid)).toBe(true)
  expect(journaled().some((row) => row.entityId.includes('not-a-device-uuid'))).toBe(false)
})

it('reports conflicting immutable history and keeps exporting the rest', () => {
  const conflicted = observation(1)
  const valid = observation(2)
  const eventId = identity(1)
  const id = syncFactChangeId(WORKSPACE, 'activity-identity', eventId)
  const existing = {
    id,
    workspaceId: WORKSPACE,
    kind: 'fact' as const,
    entityType: 'activity-identity',
    entityId: eventId,
    changeJson: '{"different":true}',
    origin: 'imported' as const,
    recordedAt: CAPTURED
  }
  db.insert(syncChanges).values(existing).run()
  const [page] = drain()
  expect(page.issues).toMatchObject([{ source: conflicted, code: 'SYNC_LOCAL_ACTIVITY_WITHHELD' }])
  expect(page.issues[0].message).toContain('different contents')
  expect(has('activity-observation', conflicted)).toBe(false)
  expect(has('activity-observation', valid)).toBe(true)
  expect(
    db
      .select()
      .from(syncChanges)
      .all()
      .find((row) => row.id === id)
  ).toEqual(existing)
})

it('scopes the withheld-capture fallback to the selected observations', () => {
  machine(randomUUID(), ' ')
  unsupported('bad-0')
  const valid = observation(1)
  const available = collectAvailableActivity(db, WORKSPACE, [valid, 'bad-0'])
  expect(available.issues.map((issue) => issue.source)).toEqual(['bad-0'])
  expect(new Set(available.changes.map((change) => change.id))).toEqual(
    new Set(collectActivitySyncChanges(db, WORKSPACE, [valid]).map((change) => change.id))
  )
})
