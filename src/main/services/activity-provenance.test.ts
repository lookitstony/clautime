// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { join } from 'node:path'
import { activityIdentities, activityObservations } from '../db/schema/activity-evidence'
import {
  activityObservers,
  activityProvenanceImports,
  sourceMachines
} from '../db/schema/activity-observers'
import { sessions } from '../db/schema/sessions'
import { initializeActivityProvenance } from './activity-provenance'

let sqlite: Database.Database
let db: ReturnType<typeof drizzle>
const migrationsFolder = join(__dirname, '../db/migrations')
const deviceA = { deviceId: '9b95ec41-b3b6-4cbb-b1b6-e7ce607ef222', machineName: 'Desktop' }
const deviceB = { deviceId: '7c8f7eab-af58-4cbb-9e74-d1e47f80d600', machineName: 'Laptop' }
const timestamp = '2026-09-26T00:00:00Z'

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite)
  // The actual schema before provenance existed, not a current-schema approximation.
  const previous = readMigrationFiles({ migrationsFolder }).filter(
    (migration) => migration.folderMillis < 1790380800000
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
})
afterEach(() => sqlite.close())

function evidence(id = 'fixture-event') {
  db.insert(activityIdentities)
    .values({
      eventId: id,
      provider: 'claude',
      identityVersion: 1,
      conversationId: 'fixture-conversation',
      basis: 'native',
      nativeEventId: id
    })
    .run()
  return db
    .insert(activityObservations)
    .values({
      id: `observation:${id}`,
      eventId: id,
      version: 1,
      kind: 'message',
      payloadJson: '{"usage":{"inputTokens":100}}',
      createdAt: timestamp
    })
    .returning()
    .get()
}

it('queues only pre-upgrade evidence and records its importing computer without rewriting saved history', () => {
  const old = evidence()
  db.insert(sessions)
    .values({
      projectPath: 'C:/missing',
      startedAt: timestamp,
      endedAt: timestamp,
      durationMinutes: 15,
      inputTokens: 100
    })
    .run()
  const history = db.select().from(sessions).all()
  const identities = db.select().from(activityIdentities).all()
  migrate(db, { migrationsFolder })
  expect(db.select().from(activityObservers).all()).toEqual([])
  expect(db.select().from(activityProvenanceImports).all()).toEqual([{ observationId: old.id }])
  evidence('after-upgrade')
  initializeActivityProvenance(db, deviceA)
  expect(db.select().from(activityObservers).all()).toEqual([
    { observationId: old.id, deviceId: deviceA.deviceId, basis: 'imported' }
  ])
  expect(db.select().from(activityProvenanceImports).all()).toEqual([])
  expect(db.select().from(activityObservations).all()).toContainEqual(old)
  expect(db.select().from(activityIdentities).all()).toContainEqual(identities[0])
  expect(db.select().from(sessions).all()).toEqual(history)
  expect(sqlite.pragma('foreign_key_check')).toEqual([])
})

it('preserves original import attribution across restarts and a database copy to a new machine', () => {
  const old = evidence()
  migrate(db, { migrationsFolder })
  initializeActivityProvenance(db, deviceA)
  const copy = sqlite.serialize()
  sqlite.close()
  sqlite = new Database(copy)
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder })
  initializeActivityProvenance(db, deviceB)
  initializeActivityProvenance(db, deviceB)
  expect(db.select().from(activityObservers).all()).toEqual([
    { observationId: old.id, deviceId: deviceA.deviceId, basis: 'imported' }
  ])
})

it('retries an interrupted upgrade attribution without losing pending work or inventing a first machine', () => {
  evidence()
  migrate(db, { migrationsFolder })
  sqlite.exec(`CREATE TRIGGER fail_provenance BEFORE DELETE ON activity_provenance_imports
    BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`)
  expect(() => initializeActivityProvenance(db, deviceA)).toThrow(
    'DELETE FROM activity_provenance_imports'
  )
  expect(db.select().from(activityObservers).all()).toEqual([])
  expect(db.select().from(sourceMachines).all()).toEqual([])
  expect(db.select().from(activityProvenanceImports).all()).toHaveLength(1)
  sqlite.exec('DROP TRIGGER fail_provenance')
  initializeActivityProvenance(db, deviceA)
  expect(db.select().from(activityObservers).all()).toHaveLength(1)
  expect(db.select().from(activityProvenanceImports).all()).toEqual([])
})

it('never claims later remote facts merely because the receiving computer starts', () => {
  migrate(db, { migrationsFolder })
  initializeActivityProvenance(db, deviceA)
  evidence('received-fact')
  initializeActivityProvenance(db, deviceA)
  expect(db.select().from(activityObservers).all()).toEqual([])
  expect(db.select().from(activityProvenanceImports).all()).toEqual([])
})

it('retains imported attribution when the same computer later directly observes that version', () => {
  const old = evidence()
  migrate(db, { migrationsFolder })
  initializeActivityProvenance(db, deviceA)
  db.insert(activityObservers)
    .values({ observationId: old.id, deviceId: deviceA.deviceId, basis: 'observed' })
    .run()
  initializeActivityProvenance(db, deviceA)
  expect(db.select().from(activityObservers).all()).toHaveLength(2)
  expect(db.select().from(activityObservations).all()).toEqual([old])
})
