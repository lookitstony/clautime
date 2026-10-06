// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'node:path'
import { clients } from '../db/schema/clients'
import { removeSharedBuiltinClient } from '../db/migration-test-helpers'
import { isSyncUuid } from './folder-sync-protocol'
import {
  UNASSIGNED_CLIENT_SYNC_ID,
  findClientByPortableId,
  getPortableClientId,
  portableIdOfLocalClient
} from './folder-sync-builtin-client'

const migrationsFolder = join(__dirname, '../db/migrations')
const opened: Database.Database[] = []

function database(): { sqlite: Database.Database; db: ReturnType<typeof drizzle> } {
  const sqlite = new Database(':memory:')
  opened.push(sqlite)
  const db = drizzle(sqlite)
  migrate(db, { migrationsFolder })
  return { sqlite, db }
}
afterEach(() => {
  for (const connection of opened.splice(0)) connection.close()
})

it('reserves one stable version 8 portable ID for the built-in client', () => {
  expect(isSyncUuid(UNASSIGNED_CLIENT_SYNC_ID)).toBe(true)
  expect(UNASSIGNED_CLIENT_SYNC_ID[14]).toBe('8')
  expect('89ab').toContain(UNASSIGNED_CLIENT_SYNC_ID[19])
})

it('upgrades the existing reserved-name client to the built-in role without changing identities', () => {
  const { sqlite, db } = database()
  removeSharedBuiltinClient(sqlite)
  const insert = sqlite.prepare(
    "INSERT INTO clients (sync_id, name, color, created_at, updated_at) VALUES (?, ?, '#6b7280', '2026-01-01', '2026-01-01')"
  )
  insert.run('0f6f5d1e-9a4c-4e7b-8d21-5f3a6c9e2b11', 'Unassigned')
  insert.run('1f6f5d1e-9a4c-4e7b-8d21-5f3a6c9e2b12', 'Acme')
  const before = sqlite.prepare('SELECT id, sync_id, name FROM clients ORDER BY id').all()

  migrate(db, { migrationsFolder })

  expect(sqlite.prepare('SELECT id, sync_id, name FROM clients ORDER BY id').all()).toEqual(before)
  const rows = db.select().from(clients).orderBy(clients.id).all()
  expect(rows.map((row) => row.systemRole)).toEqual(['unassigned', null])
  expect(getPortableClientId(db, rows[0].id)).toBe(UNASSIGNED_CLIENT_SYNC_ID)
  expect(getPortableClientId(db, rows[1].id)).toBe(rows[1].syncId)
  expect(getPortableClientId(db, 9999)).toBeNull()
  expect(findClientByPortableId(db, UNASSIGNED_CLIENT_SYNC_ID)?.id).toBe(rows[0].id)
  expect(findClientByPortableId(db, rows[1].syncId)?.id).toBe(rows[1].id)
  // The built-in's local syncId never names it portably.
  expect(findClientByPortableId(db, rows[0].syncId)).toBeNull()
  expect(portableIdOfLocalClient(db, rows[0].syncId)).toBe(UNASSIGNED_CLIENT_SYNC_ID)
  expect(portableIdOfLocalClient(db, rows[1].syncId)).toBe(rows[1].syncId)
})

it('allows at most one immutable built-in role', () => {
  const { sqlite } = database()
  const insert = sqlite.prepare(
    "INSERT INTO clients (sync_id, name, color, system_role, created_at, updated_at) VALUES (?, ?, '#6b7280', ?, '2026-01-01', '2026-01-01')"
  )
  insert.run('0f6f5d1e-9a4c-4e7b-8d21-5f3a6c9e2b11', 'Unassigned', 'unassigned')
  expect(() => insert.run('1f6f5d1e-9a4c-4e7b-8d21-5f3a6c9e2b12', 'Inbox', 'unassigned')).toThrow(
    /UNIQUE/
  )
  expect(() => insert.run('2f6f5d1e-9a4c-4e7b-8d21-5f3a6c9e2b13', 'Other', 'archive')).toThrow(
    /CHECK/
  )
  const setRole = (role: string | null, name: string): void =>
    void sqlite.prepare('UPDATE clients SET system_role = ? WHERE name = ?').run(role, name)
  expect(() => setRole(null, 'Unassigned')).toThrow(/immutable/)
  insert.run('3f6f5d1e-9a4c-4e7b-8d21-5f3a6c9e2b14', 'Ordinary', null)
  expect(() => setRole('unassigned', 'Ordinary')).toThrow(/immutable/)
})
