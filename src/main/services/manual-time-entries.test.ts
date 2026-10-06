import { randomUUID } from 'node:crypto'
// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { sessions } from '../db/schema/sessions'
import { manualTimeEntries, manualEntryProvenanceImports } from '../db/schema/manual-time-entries'
import { sessionSplits, sessionRevisions } from '../db/schema/session-history'
import { invoiceLineItems } from '../db/schema/invoices'
import { initializeManualEntryProvenance, getManualTimeEntry } from './manual-time-entries'

let sqlite: Database.Database
let db: ReturnType<typeof drizzle>
const migrationsFolder = join(__dirname, '../db/migrations')
const deviceA = '9b95ec41-b3b6-4cbb-b1b6-e7ce607ef222'
const deviceB = '7c8f7eab-af58-4cbb-9e74-d1e47f80d600'
let deviceId = deviceA
vi.mock('../db', () => ({ getDb: () => db }))
vi.mock('./device-context', () => ({
  getLocalDeviceSession: () => ({ deviceId, machineName: 'Fixture' })
}))
vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
vi.mock('electron', () => ({ Notification: vi.fn(), shell: {} }))
vi.mock('./settings-service', () => ({ settingsService: { getSetting: () => null } }))
vi.mock('../providers', () => ({
  enabledProviders: () => [],
  providerForFile: () => ({ id: 'claude' })
}))
import { sessionService } from './session-service'

const data = {
  projectPath: 'C:/fixture',
  startedAt: '2026-09-26T10:00:00Z',
  endedAt: '2026-09-26T11:00:00Z',
  durationMinutes: 60,
  description: 'Saved manual work'
}
beforeEach(() => {
  deviceId = deviceA
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder })
})
afterEach(() => sqlite.close())

it('gives identical-looking manual entries distinct permanent identities and records the creating computer', () => {
  const first = sessionService.createSession(data)
  const second = sessionService.createSession(data)
  const identity = getManualTimeEntry(db, first.id)!
  expect(identity).toMatchObject({
    sessionId: first.id,
    deviceId: deviceA,
    basis: 'created',
    parentId: null
  })
  expect(identity.id).toMatch(/^[0-9a-f-]{36}$/)
  expect(getManualTimeEntry(db, second.id)!.id).not.toBe(identity.id)
  deviceId = deviceB
  sessionService.updateSession(first.id, { description: 'Edited elsewhere', durationMinutes: 75 })
  expect(getManualTimeEntry(db, first.id)).toEqual(identity)
  sessionService.deleteSession(first.id)
  expect(getManualTimeEntry(db, first.id)).toEqual(identity)
})

it('preserves parent identity and records portable split lineage and the splitting computer', () => {
  const parent = sessionService.createSession(data)
  const identity = getManualTimeEntry(db, parent.id)!
  deviceId = deviceB
  const children = sessionService.splitSession(parent.id, '2026-09-26T10:30:00Z')
  const childEntries = children.map((child) => getManualTimeEntry(db, child.id)!)
  expect(new Set([identity.id, ...childEntries.map((entry) => entry.id)]).size).toBe(3)
  for (const entry of childEntries)
    expect(entry).toMatchObject({ parentId: identity.id, deviceId: deviceB, basis: 'created' })
  expect(getManualTimeEntry(db, parent.id)).toEqual(identity)
  expect(children.reduce((sum, child) => sum + child.durationMinutes, 0)).toBe(60)
  const grandchildren = sessionService.splitSession(children[0].id, '2026-09-26T10:15:00Z')
  for (const child of grandchildren)
    expect(getManualTimeEntry(db, child.id)?.parentId).toBe(childEntries[0].id)
  expect(() =>
    db
      .update(manualTimeEntries)
      .set({ id: deviceB })
      .where(eq(manualTimeEntries.id, identity.id))
      .run()
  ).toThrow('immutable')
})

it('rolls back a new entry when its identity cannot be saved', () => {
  sqlite.exec(`CREATE TRIGGER fail_manual BEFORE INSERT ON manual_time_entries
    BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`)
  expect(() => sessionService.createSession(data)).toThrow('fixture failure')
  expect(db.select().from(sessions).all()).toEqual([])
  expect(db.select().from(manualTimeEntries).all()).toEqual([])
})

it('rolls back the entire split when a child identity cannot be saved', () => {
  const parent = sessionService.createSession(data)
  const entries = db.select().from(manualTimeEntries).all()
  sqlite.exec(`CREATE TRIGGER fail_manual BEFORE INSERT ON manual_time_entries
    BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`)
  expect(() => sessionService.splitSession(parent.id, '2026-09-26T10:30:00Z')).toThrow(
    'fixture failure'
  )
  expect(db.select().from(sessions).all()).toEqual([parent])
  expect(db.select().from(manualTimeEntries).all()).toEqual(entries)
  expect(db.select().from(sessionSplits).all()).toEqual([])
  expect(db.select().from(sessionRevisions).all()).toEqual([])
})

function reopenBeforeMigration() {
  sqlite.close()
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite)
  const previous = readMigrationFiles({ migrationsFolder }).filter(
    (m) => m.folderMillis < 1790380800001
  )
  sqlite.transaction(() => {
    for (const migration of previous) for (const statement of migration.sql) sqlite.exec(statement)
    sqlite.exec(
      'CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC)'
    )
    const last = previous[previous.length - 1]
    sqlite
      .prepare('INSERT INTO __drizzle_migrations(hash, created_at) VALUES (?, ?)')
      .run(last.hash, last.folderMillis)
  })()
}

it('upgrades old manual entries and split lineage without altering history or invoice links, then survives a copied database', () => {
  reopenBeforeMigration()
  const client = sqlite
    .prepare(
      'INSERT INTO clients (name, color, sync_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id'
    )
    .get('Fixture', 'red', randomUUID(), new Date().toISOString(), new Date().toISOString()) as {
    id: number
  }
  const parent = db
    .insert(sessions)
    .values({ ...data, source: 'manual', clientId: client.id })
    .returning()
    .get()
  const first = db
    .insert(sessions)
    .values({ ...data, source: 'manual', endedAt: '2026-09-26T10:30:00Z', durationMinutes: 30 })
    .returning()
    .get()
  const second = db
    .insert(sessions)
    .values({ ...data, source: 'manual', startedAt: '2026-09-26T10:30:00Z', durationMinutes: 30 })
    .returning()
    .get()
  db.insert(sessions)
    .values({ ...data, source: 'auto' })
    .run()
  db.insert(sessionRevisions)
    .values({
      id: 'split-fixture',
      sessionId: parent.id,
      sequence: 1,
      kind: 'split',
      tool: 'claude',
      before: '{}',
      after: '{}',
      createdAt: data.startedAt
    })
    .run()
  db.insert(sessionSplits)
    .values({
      revisionId: 'split-fixture',
      parentSessionId: parent.id,
      firstSessionId: first.id,
      secondSessionId: second.id,
      tool: 'claude',
      startedAt: data.startedAt,
      endedAt: data.endedAt,
      splitAt: '2026-09-26T10:30:00Z'
    })
    .run()
  const invoice = sqlite
    .prepare(
      'INSERT INTO invoices (client_id, stripe_invoice_id, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id'
    )
    .get(client.id, 'in_fixture', new Date().toISOString(), new Date().toISOString()) as {
    id: number
  }
  db.insert(invoiceLineItems)
    .values({
      invoiceId: invoice.id,
      description: 'Saved work',
      amountCents: 15000,
      sessionIds: String(parent.id)
    })
    .run()
  const snapshot = () =>
    ['sessions', 'invoices', 'invoice_line_items', 'session_splits', 'session_revisions'].map(
      (table) =>
        sqlite
          .prepare(`SELECT * FROM ${table}`)
          .all()
          .map((value) => {
            const row = { ...(value as Record<string, unknown>) }
            delete row.provider_account_id
            delete row.operation_id
            delete row.hidden
            return row
          })
    )
  const before = snapshot()
  migrate(db, { migrationsFolder })
  expect(snapshot()).toEqual(before)
  expect(db.select().from(manualTimeEntries).all()).toHaveLength(3)
  expect(db.select().from(manualEntryProvenanceImports).all()).toHaveLength(3)
  const parentEntry = getManualTimeEntry(db, parent.id)!
  expect(parentEntry).toMatchObject({ deviceId: null, basis: 'imported', parentId: null })
  for (const child of [first, second])
    expect(getManualTimeEntry(db, child.id)?.parentId).toBe(parentEntry.id)
  initializeManualEntryProvenance(db, { deviceId: deviceA, machineName: 'Desktop' })
  const entries = db.select().from(manualTimeEntries).all()
  const copy = sqlite.serialize()
  sqlite.close()
  sqlite = new Database(copy)
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder })
  initializeManualEntryProvenance(db, { deviceId: deviceB, machineName: 'Laptop' })
  expect(db.select().from(manualTimeEntries).all()).toEqual(entries)
  expect(entries.every((entry) => entry.deviceId === deviceA && entry.basis === 'imported')).toBe(
    true
  )
  expect(snapshot()).toEqual(before)
  expect(sqlite.pragma('foreign_key_check')).toEqual([])
})

it('keeps the upgrade attribution queue retryable after a write failure', () => {
  reopenBeforeMigration()
  db.insert(sessions)
    .values({ ...data, source: 'manual' })
    .run()
  migrate(db, { migrationsFolder })
  sqlite.exec(`CREATE TRIGGER fail_manual_import BEFORE DELETE ON manual_entry_provenance_imports
    BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`)
  expect(() =>
    initializeManualEntryProvenance(db, { deviceId: deviceA, machineName: 'Desktop' })
  ).toThrow('DELETE FROM manual_entry_provenance_imports')
  expect(db.select().from(manualTimeEntries).get()?.deviceId).toBeNull()
  expect(db.select().from(manualEntryProvenanceImports).all()).toHaveLength(1)
  sqlite.exec('DROP TRIGGER fail_manual_import')
  initializeManualEntryProvenance(db, { deviceId: deviceA, machineName: 'Desktop' })
  expect(db.select().from(manualTimeEntries).get()?.deviceId).toBe(deviceA)
  expect(db.select().from(manualEntryProvenanceImports).all()).toEqual([])
})

it('keeps copied history stable while offline computers create different entries with the same local row number', () => {
  const original = sessionService.createSession(data)
  const originalEntry = getManualTimeEntry(db, original.id)!
  const copy = sqlite.serialize()
  const firstNew = sessionService.createSession(data)
  const firstIdentity = getManualTimeEntry(db, firstNew.id)!
  sqlite.close()
  sqlite = new Database(copy)
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite)
  deviceId = deviceB
  initializeManualEntryProvenance(db, { deviceId, machineName: 'Laptop' })
  const secondNew = sessionService.createSession(data)
  const secondIdentity = getManualTimeEntry(db, secondNew.id)!
  expect(firstNew.id).toBe(secondNew.id)
  expect(firstIdentity.id).not.toBe(secondIdentity.id)
  expect(firstIdentity.deviceId).toBe(deviceA)
  expect(secondIdentity.deviceId).toBe(deviceB)
  expect(getManualTimeEntry(db, original.id)).toEqual(originalEntry)
})
