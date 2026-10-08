// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq, sql } from 'drizzle-orm'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sessions } from '../db/schema/sessions'
import { activeSessionCondition, sessionDeletions } from '../db/schema/session-deletions'
import { sessionBillingRefs, sessionRevisions, sessionSplits } from '../db/schema/session-history'
import { sourceMachines } from '../db/schema/activity-observers'
import { manualTimeEntries } from '../db/schema/manual-time-entries'
import { folderSyncSettings } from '../db/schema/folder-sync'
import { syncHistorySuppressions } from '../db/schema/sync-legacy'
import type { RecordConflict } from '../../shared/types/sync-conflict'
import { activitySyncAdapter, collectActivitySyncChanges } from './folder-sync-activity-records'
import type { SyncBatch, SyncChange } from './folder-sync-protocol'
import {
  applyReadySyncBatches,
  assembleOutgoingBatch,
  recordLocalSyncChanges,
  retainIncomingBatch,
  type SyncDomainAdapter
} from './folder-sync-store'
import type { RecordView, RevisionAction } from './folder-sync-revisions'
import {
  collectManualSyncChanges,
  getManualEntryView,
  manualRecordsAdapter,
  planManualEntryRevision,
  readManualEntryState
} from './folder-sync-manual-records'
import {
  journalManualSessionDeletion,
  journalManualSessionSplit
} from './folder-sync-session-local'
import { listSyncConflicts, resolveSyncConflict } from './folder-sync-conflicts'

vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
vi.mock('./device-context', () => ({
  getLocalDeviceSession: () => ({
    deviceId: '9b95ec41-b3b6-4cbb-b1b6-e7ce607ef222',
    machineName: 'Fixture'
  })
}))

const workspaceId = '6a0f8f64-3c1d-4b8e-9f51-2d7c4e9b1a30'
const T20 = '2026-03-05T09:20:00.000Z'
const T30 = '2026-03-05T09:30:00.000Z'
type Db = ReturnType<typeof drizzle>
const opened: Database.Database[] = []
const sent: SyncBatch[] = []
let a: Db
let b: Db
let deviceA: string
let deviceB: string
let entryId: string

function database(): Db {
  const connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  opened.push(connection)
  const db = drizzle(connection)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  db.insert(folderSyncSettings).values({ slot: 1, workspaceId, folderPath: 'C:/sync' }).run()
  return db
}

const adapter: SyncDomainAdapter = {
  validate: (change) =>
    (change.entityType === 'manual-entry' ? manualRecordsAdapter : activitySyncAdapter).validate(
      change
    ),
  apply: (tx, workspace, change: SyncChange) =>
    (change.entityType === 'manual-entry' ? manualRecordsAdapter : activitySyncAdapter).apply(
      tx,
      workspace,
      change
    )
}
const record = (db: Db, changes: unknown[]) =>
  recordLocalSyncChanges(db, workspaceId, changes, adapter)
const assemble = (db: Db): SyncBatch | null =>
  assembleOutgoingBatch(db, workspaceId, { writerEpochId: randomUUID(), deviceId: randomUUID() })

/** Retains and applies one batch at a time, so later batches may wait for earlier ones. */
function deliverEach(db: Db, batches: SyncBatch[]): void {
  let waiting: unknown[] = []
  for (const batch of batches) {
    retainIncomingBatch(db, workspaceId, batch, adapter)
    const result = applyReadySyncBatches(db, workspaceId, adapter)
    expect(result.errors).toEqual([])
    waiting = result.waiting
  }
  expect(waiting).toEqual([])
}
function exchange(): void {
  const fromA = assemble(a)
  const fromB = assemble(b)
  if (fromA) sent.push(fromA)
  if (fromB) sent.push(fromB)
  if (fromA) deliverEach(b, [fromA])
  if (fromB) deliverEach(a, [fromB])
}

const sessionOf = (db: Db, entry: string) => {
  const row = db.select().from(manualTimeEntries).where(eq(manualTimeEntries.id, entry)).get()!
  return db.select().from(sessions).where(eq(sessions.id, row.sessionId)).get()!
}
const totals = (db: Db) =>
  db
    .select({
      count: sql<number>`count(*)`,
      minutes: sql<number>`coalesce(sum(${sessions.durationMinutes}), 0)`
    })
    .from(sessions)
    .where(activeSessionCondition)
    .get()!
const held = (db: Db, entry: string) =>
  db
    .select()
    .from(syncHistorySuppressions)
    .where(eq(syncHistorySuppressions.sessionId, sessionOf(db, entry).id))
    .get()
const lineage = (db: Db, entry: string) =>
  readManualEntryState(db, workspaceId, entry)?.lifecycle?.state

function revise(db: Db, entry: string, action: (view: RecordView) => RevisionAction): void {
  const view = getManualEntryView(db, workspaceId, entry)
  record(db, [
    planManualEntryRevision(db, workspaceId, {
      id: randomUUID(),
      entryId: entry,
      action: action(view)
    })
  ])
}

/**
 * The local rows and audit of session-service's manual split, then its hook. `shareParts` runs
 * where the service's bootstrap would share the new parts; `journal: false` is a split made
 * before sharing was connected.
 */
function split(
  db: Db,
  device: string,
  entry: string,
  splitAt: string,
  options: { shareParts?: () => void; journal?: boolean } = {}
): string[] {
  const row = sessionOf(db, entry)
  const parts = [
    [row.startedAt, splitAt],
    [splitAt, row.endedAt]
  ].map(([startedAt, endedAt]) => {
    const part = db
      .insert(sessions)
      .values({
        projectPath: '',
        source: 'manual',
        startedAt,
        endedAt,
        durationMinutes: Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 60_000),
        description: row.description
      })
      .returning()
      .get()
    const id = randomUUID()
    db.insert(manualTimeEntries)
      .values({ id, sessionId: part.id, deviceId: device, basis: 'created', parentId: entry })
      .run()
    return { id, sessionId: part.id }
  })
  const sequence =
    db
      .select({ count: sql<number>`count(*)` })
      .from(sessionRevisions)
      .where(eq(sessionRevisions.sessionId, row.id))
      .get()!.count + 1
  const revisionId = randomUUID()
  db.insert(sessionRevisions)
    .values({
      id: revisionId,
      sessionId: row.id,
      sequence,
      kind: 'split',
      tool: row.tool,
      before: '{}',
      after: '{}',
      createdAt: splitAt
    })
    .run()
  db.insert(sessionSplits)
    .values({
      revisionId,
      parentSessionId: row.id,
      firstSessionId: parts[0].sessionId,
      secondSessionId: parts[1].sessionId,
      tool: row.tool,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      splitAt
    })
    .onConflictDoNothing({ target: sessionSplits.parentSessionId })
    .run()
  options.shareParts?.()
  if (options.journal !== false)
    journalManualSessionSplit(
      db,
      row.id,
      parts.map((part) => part.sessionId),
      splitAt
    )
  return parts.map((part) => part.id)
}

/** session-service's deletion: the audit row (kept on a repeat) and its hook. */
function remove(db: Db, entry: string): void {
  const row = sessionOf(db, entry)
  db.insert(sessionDeletions)
    .values({
      id: randomUUID(),
      sessionId: row.id,
      tool: row.tool,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      createdAt: row.endedAt
    })
    .onConflictDoNothing({ target: sessionDeletions.sessionId })
    .run()
  journalManualSessionDeletion(db, row.id)
}

const shown = (db: Db): RecordConflict =>
  listSyncConflicts(db).items.find(
    (item) => item.key === `manual-entry:${entryId}`
  ) as RecordConflict
function choose(
  db: Db,
  pick: (disposition: { kind?: string; splitAt?: string } | null) => boolean
): void {
  const item = shown(db)
  const choice = item.lifecycleChoices!.find((option) =>
    pick(option.disposition as { kind?: string } | null)
  )!
  resolveSyncConflict(db, {
    kind: 'record',
    entityType: 'manual-entry',
    entityId: entryId,
    expectedHeads: item.expectedHeads,
    present: choice.present,
    values: {},
    disposition: choice.disposition
  })
}

function manualEntry(db: Db, device: string): string {
  const row = db
    .insert(sessions)
    .values({
      projectPath: '/home/fixture/secret-project',
      source: 'manual',
      startedAt: '2026-03-05T09:00:00.000Z',
      endedAt: '2026-03-05T09:45:00.000Z',
      durationMinutes: 45,
      description: 'Initial'
    })
    .returning()
    .get()
  const id = randomUUID()
  db.insert(manualTimeEntries)
    .values({ id, sessionId: row.id, deviceId: device, basis: 'created' })
    .run()
  // Billed work on the entry; nothing here may drop it.
  db.insert(sessionBillingRefs)
    .values({ sessionId: row.id, stripeInvoiceId: 'in_fixture', testMode: 1 })
    .run()
  return id
}

beforeEach(() => {
  sent.length = 0
  a = database()
  b = database()
  deviceA = randomUUID()
  deviceB = randomUUID()
  a.insert(sourceMachines).values({ deviceId: deviceA, initialName: 'Desktop' }).run()
  b.insert(sourceMachines).values({ deviceId: deviceB, initialName: 'Laptop' }).run()
  entryId = manualEntry(a, deviceA)
  record(a, collectActivitySyncChanges(a, workspaceId))
  record(b, collectActivitySyncChanges(b, workspaceId))
  record(a, collectManualSyncChanges(a, workspaceId).changes)
  exchange()
  for (const db of [a, b]) expect(totals(db)).toEqual({ count: 1, minutes: 45 })
})
afterEach(() => {
  for (const connection of opened.splice(0)) connection.close()
})

it('counts split parts only once the split naming them arrives, in any arrival order', () => {
  const early: SyncBatch[] = []
  const parts = split(a, deviceA, entryId, T20, {
    shareParts: () => {
      record(a, collectManualSyncChanges(a, workspaceId).changes)
      early.push(assemble(a)!)
    }
  })
  const late = assemble(a)!
  expect(totals(a)).toEqual({ count: 2, minutes: 45 })

  // Parts before their split: outside totals while the whole entry still counts.
  deliverEach(b, early)
  expect(totals(b)).toEqual({ count: 1, minutes: 45 })
  for (const part of parts) {
    expect(held(b, part)).toMatchObject({ status: 'queued' })
    expect(lineage(b, part)).toBe('pending-split')
  }
  expect(listSyncConflicts(b).items).toContainEqual(
    expect.objectContaining({ kind: 'held', key: `manual-parts:${entryId}` })
  )
  deliverEach(b, [late])
  expect(totals(b)).toEqual({ count: 2, minutes: 45 })
  expect(lineage(b, entryId)).toBe('split')

  // The split first waits for its parts; a blank computer ends the same either way.
  const fresh = database()
  deliverEach(fresh, [...sent, late, ...early])
  expect(totals(fresh)).toEqual({ count: 2, minutes: 45 })
  expect(listSyncConflicts(b).items.filter((item) => item.key.includes(entryId))).toEqual([])
})

it.each(['keep', 'delete', 'split'] as const)(
  'holds delete-versus-split as one visible conflict with equal totals, then converges on %s',
  (choice) => {
    const parts = split(a, deviceA, entryId, T20)
    remove(b, entryId)
    exchange()
    for (const db of [a, b]) {
      // Not two equal deletions: the last agreed state (the whole entry) counts everywhere.
      expect(readManualEntryState(db, workspaceId, entryId)?.lifecycle).toMatchObject({
        state: 'conflict',
        counting: true
      })
      expect(totals(db)).toEqual({ count: 1, minutes: 45 })
      for (const part of parts) expect(held(db, part)).toMatchObject({ status: 'queued' })
    }
    const choices = shown(b).lifecycleChoices!
    expect(shown(a).lifecycleChoices).toEqual(choices)
    expect(choices).toHaveLength(3)
    expect(choices.map((option) => option.disposition)).toEqual(
      expect.arrayContaining([
        null,
        { kind: 'deleted' },
        { kind: 'split', splitAt: T20, children: parts }
      ])
    )
    expect(shown(b).waiting).toEqual(['2 part(s) split from it do not count until you choose.'])

    choose(b, (disposition) =>
      choice === 'keep'
        ? disposition === null
        : disposition?.kind === (choice === 'delete' ? 'deleted' : 'split')
    )
    exchange()
    const expected =
      choice === 'keep'
        ? { count: 1, minutes: 45 }
        : choice === 'delete'
          ? { count: 0, minutes: 0 }
          : { count: 2, minutes: 45 }
    for (const db of [a, b]) {
      expect(totals(db)).toEqual(expected)
      expect(listSyncConflicts(db).items.filter((item) => item.key.includes(entryId))).toEqual([])
      for (const part of parts) {
        // A split that was not chosen stays as settled, non-counting audit history.
        if (choice === 'split') expect(held(db, part)).toBeUndefined()
        else {
          expect(held(db, part)).toMatchObject({ status: 'deleted' })
          expect(lineage(db, part)).toBe('rejected')
        }
      }
      expect(db.select().from(manualTimeEntries).all()).toHaveLength(3)
    }
    // Local audit rows and billed work are retained whatever was chosen.
    expect(a.select().from(sessionSplits).all()).toHaveLength(1)
    expect(b.select().from(sessionDeletions).all()).toHaveLength(1)
    expect(a.select().from(sessionBillingRefs).all()).toHaveLength(1)
  }
)

it('lets a kept entry be edited, split again over its first split audit, and deleted again', () => {
  const first = split(a, deviceA, entryId, T20)
  remove(b, entryId)
  exchange()
  choose(a, (disposition) => disposition === null)
  exchange()
  for (const db of [a, b]) expect(totals(db)).toEqual({ count: 1, minutes: 45 })

  revise(b, entryId, (view) => ({
    type: 'edit',
    observedHeads: view.heads,
    values: { description: 'After restore' }
  }))
  exchange()
  for (const db of [a, b]) expect(sessionOf(db, entryId).description).toBe('After restore')

  const second = split(a, deviceA, entryId, T30)
  exchange()
  for (const db of [a, b]) {
    expect(totals(db)).toEqual({ count: 2, minutes: 45 })
    for (const part of second) expect(held(db, part)).toBeUndefined()
    for (const part of first) expect(lineage(db, part)).toBe('rejected')
  }
  // The first split's audit row is kept; the second is recorded by its revision and shared split.
  expect(
    a
      .select()
      .from(sessionSplits)
      .where(eq(sessionSplits.parentSessionId, sessionOf(a, entryId).id))
      .all()
  ).toHaveLength(1)
})

it('deletes a kept entry again while keeping the original deletion audit', () => {
  split(a, deviceA, entryId, T20)
  remove(b, entryId)
  exchange()
  choose(b, (disposition) => disposition === null)
  exchange()
  expect(totals(b)).toEqual({ count: 1, minutes: 45 })
  const original = b.select().from(sessionDeletions).get()!
  remove(b, entryId)
  exchange()
  for (const db of [a, b]) {
    expect(totals(db)).toEqual({ count: 0, minutes: 0 })
    expect(lineage(db, entryId)).toBe('deleted')
  }
  expect(b.select().from(sessionDeletions).all()).toEqual([original])
})

it('holds two different splits until one is chosen, then only its parts count', () => {
  const fromA = split(a, deviceA, entryId, T20)
  const fromB = split(b, deviceB, entryId, T30)
  exchange()
  for (const db of [a, b]) expect(totals(db)).toEqual({ count: 1, minutes: 45 })
  expect(shown(a).lifecycleChoices!.map((option) => option.disposition)).toEqual(
    expect.arrayContaining([
      null,
      { kind: 'split', splitAt: T20, children: fromA },
      { kind: 'split', splitAt: T30, children: fromB }
    ])
  )
  choose(a, (disposition) => disposition?.splitAt === T30)
  exchange()
  for (const db of [a, b]) {
    expect(totals(db)).toEqual({ count: 2, minutes: 45 })
    for (const part of fromB) expect(held(db, part)).toBeUndefined()
    for (const part of fromA) expect(lineage(db, part)).toBe('rejected')
  }
})

it('holds edit-versus-split with the edited entry counting until the split is chosen', () => {
  revise(a, entryId, (view) => ({
    type: 'edit',
    observedHeads: view.heads,
    values: { description: 'Edited' }
  }))
  const parts = split(b, deviceB, entryId, T20)
  exchange()
  for (const db of [a, b]) {
    expect(lineage(db, entryId)).toBe('conflict')
    expect(totals(db)).toEqual({ count: 1, minutes: 45 })
    expect(sessionOf(db, entryId).description).toBe('Edited')
  }
  expect(
    shown(a)
      .lifecycleChoices!.map((option) => option.present)
      .sort()
  ).toEqual([false, true])
  choose(a, (disposition) => disposition?.kind === 'split')
  exchange()
  for (const db of [a, b]) {
    expect(totals(db)).toEqual({ count: 2, minutes: 45 })
    for (const part of parts) expect(held(db, part)).toBeUndefined()
  }
})

it('exports a split made before sharing as its parts, and a blank computer counts the same', () => {
  const h = database()
  const device = randomUUID()
  h.insert(sourceMachines).values({ deviceId: device, initialName: 'Old laptop' }).run()
  const entry = manualEntry(h, device)
  const parts = split(h, device, entry, T20, { journal: false })
  record(h, collectActivitySyncChanges(h, workspaceId))
  const exported = collectManualSyncChanges(h, workspaceId)
  expect(exported).toMatchObject({ blocked: [], withheld: [] })
  // Parent root and values, both parts' roots and values, and the split naming the parts.
  expect(exported.changes).toHaveLength(7)
  record(h, exported.changes)
  expect(collectManualSyncChanges(h, workspaceId).changes).toEqual([])
  expect(totals(h)).toEqual({ count: 2, minutes: 45 })
  expect(readManualEntryState(h, workspaceId, entry)?.lifecycle?.disposition).toEqual({
    kind: 'split',
    splitAt: T20,
    children: parts
  })
  const fresh = database()
  deliverEach(fresh, [assemble(h)!])
  expect(totals(fresh)).toEqual({ count: 2, minutes: 45 })
})
