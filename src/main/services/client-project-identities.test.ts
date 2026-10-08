// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import { clients } from '../db/schema/clients'
import { projects } from '../db/schema/projects'
import { sessions } from '../db/schema/sessions'
import { invoices, invoiceLineItems } from '../db/schema/invoices'
import { removeClientProjectSyncIds } from '../db/migration-test-helpers'

let directory: string
let sqlite: Database.Database
let db: BetterSQLite3Database
vi.mock('../db', () => ({ getDb: () => db }))
vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
import { clientProjectService } from './client-project-service'
import { completeLocalProjectSetup } from './local-project-setup'

const migrationsFolder = join(__dirname, '../db/migrations')
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
function open() {
  sqlite = new Database(join(directory, 'history.db'))
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder })
  if (!sqlite.prepare('SELECT 1 FROM local_project_setup').get()) completeLocalProjectSetup([])
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'clautime-project-identity-'))
  open()
})
afterEach(async () => {
  sqlite.close()
  const target = resolve(directory)
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('clautime-project-identity-'))
    throw new Error('Unexpected fixture cleanup path')
  await rm(target, { recursive: true, force: true })
})

it('backfills existing clients/projects once while preserving all local IDs, values and invoice links', () => {
  const client = clientProjectService.createClient({ name: 'Saved client', billableRate: 150 })
  const project = clientProjectService.createProject({
    clientId: client.id,
    name: 'Saved project',
    directoryPath: 'C:/original',
    hourlyRate: 175
  })
  clientProjectService.createClient({ name: 'Another client' })
  clientProjectService.createProject({
    clientId: client.id,
    name: 'Another project',
    directoryPath: 'C:/another'
  })
  const session = db
    .insert(sessions)
    .values({
      clientId: client.id,
      projectId: project.id,
      projectPath: project.directoryPath!,
      startedAt: '2026-09-01T10:00:00Z',
      endedAt: '2026-09-01T11:00:00Z',
      durationMinutes: 60,
      description: 'Saved work'
    })
    .returning()
    .get()
  const invoice = db
    .insert(invoices)
    .values({ clientId: client.id, stripeInvoiceId: 'in_fixture', amountDueCents: 17500 })
    .returning()
    .get()
  db.insert(invoiceLineItems)
    .values({
      invoiceId: invoice.id,
      description: 'Saved line',
      amountCents: 17500,
      sessionIds: String(session.id)
    })
    .run()
  removeClientProjectSyncIds(sqlite)
  const tables = ['clients', 'projects', 'sessions', 'invoices', 'invoice_line_items']
  const before = tables.map((table) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all())
  migrate(db, { migrationsFolder })
  const migratedClients = db.select().from(clients).all()
  const migratedProjects = db.select().from(projects).all()
  const identities = [...migratedClients, ...migratedProjects].map((row) => row.syncId)
  expect(identities).toHaveLength(4)
  expect(new Set(identities).size).toBe(4)
  for (const identity of identities) expect(identity).toMatch(uuid)
  const after = tables.map((table) =>
    sqlite
      .prepare(`SELECT * FROM ${table} ORDER BY id`)
      .all()
      .map((row) => {
        const original = { ...(row as Record<string, unknown>) }
        delete original.sync_id
        delete original.system_role
        delete original.provider_account_id
        delete original.operation_id
        delete original.hidden
        delete original.root_commit
        return original
      })
  )
  expect(after).toEqual(before)
  expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  migrate(db, { migrationsFolder })
  sqlite.close()
  open()
  expect(db.select().from(clients).all()).toEqual(migratedClients)
  expect(db.select().from(projects).all()).toEqual(migratedProjects)
})

it('rolls back the additive migration if identity backfill fails', () => {
  clientProjectService.createClient({ name: 'First' })
  clientProjectService.createClient({ name: 'Second' })
  removeClientProjectSyncIds(sqlite)
  const before = sqlite.prepare('SELECT * FROM clients ORDER BY id').all()
  // Force a UUID collision in this disposable connection to exercise migration rollback.
  sqlite.function('randomblob', (size) => Buffer.alloc(Number(size), 1))
  sqlite.function('random', () => 0)
  expect(() => migrate(db, { migrationsFolder })).toThrow()
  expect(sqlite.prepare('SELECT * FROM clients ORDER BY id').all()).toEqual(before)
  for (const table of ['clients', 'projects']) {
    const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).not.toContain('sync_id')
  }
  expect(
    sqlite.prepare('SELECT * FROM __drizzle_migrations WHERE created_at = ?').get(1789603200008)
  ).toBeUndefined()
})

it('generates identities for manual and automatic creation and preserves them through edits and reassignment', () => {
  const client = clientProjectService.createClient({ name: 'Original client' })
  const project = clientProjectService.autoCreateProject('C:/automatic')!
  const originalClient = db.select().from(clients).where(eq(clients.id, client.id)).get()!
  const originalProject = db.select().from(projects).where(eq(projects.id, project.id)).get()!
  for (const row of db.select().from(clients).all()) expect(row.syncId).toMatch(uuid)
  expect(originalProject.syncId).toMatch(uuid)
  expect(clientProjectService.autoCreateProject('C:/automatic')).toBeNull()
  const reassigned = clientProjectService.createProject({
    clientId: client.id,
    name: 'Claimed',
    directoryPath: 'C:/automatic'
  })
  expect(reassigned.id).toBe(project.id)
  clientProjectService.updateProject(project.id, {
    name: 'Renamed',
    directoryPath: 'D:/moved',
    hourlyRate: 200,
    isActive: false
  })
  clientProjectService.updateClient(client.id, {
    name: 'Renamed client',
    billableRate: 175,
    isActive: false
  })
  expect(db.select().from(clients).where(eq(clients.id, client.id)).get()?.syncId).toBe(
    originalClient.syncId
  )
  expect(db.select().from(projects).where(eq(projects.id, project.id)).get()?.syncId).toBe(
    originalProject.syncId
  )
  sqlite.close()
  open()
  expect(db.select().from(projects).where(eq(projects.id, project.id)).get()).toMatchObject({
    syncId: originalProject.syncId,
    clientId: client.id,
    name: 'Renamed'
  })
})

it('enforces unique, nonempty, immutable identities for both entity types', () => {
  const client = db.insert(clients).values({ name: 'A', color: 'red' }).returning().get()
  const project = db
    .insert(projects)
    .values({ clientId: client.id, name: 'P', directoryPath: 'C:/a' })
    .returning()
    .get()
  expect(() =>
    db.insert(clients).values({ name: 'B', color: 'blue', syncId: client.syncId }).run()
  ).toThrow()
  expect(() =>
    db
      .insert(projects)
      .values({ clientId: client.id, name: 'Q', directoryPath: 'C:/b', syncId: project.syncId })
      .run()
  ).toThrow()
  expect(() =>
    db.update(clients).set({ syncId: randomUUID() }).where(eq(clients.id, client.id)).run()
  ).toThrow()
  expect(() =>
    db.update(projects).set({ syncId: randomUUID() }).where(eq(projects.id, project.id)).run()
  ).toThrow()
  for (const empty of ['', '   ']) {
    expect(() =>
      db.insert(clients).values({ name: 'Empty', color: 'red', syncId: empty }).run()
    ).toThrow()
    expect(() =>
      db
        .insert(projects)
        .values({ clientId: client.id, name: 'Empty', directoryPath: 'C:/empty', syncId: empty })
        .run()
    ).toThrow()
  }
  expect(() =>
    sqlite
      .prepare(
        "INSERT INTO clients (name,color,created_at,updated_at) VALUES ('Raw','red','now','now')"
      )
      .run()
  ).toThrow()
  expect(() =>
    sqlite
      .prepare(
        "INSERT INTO projects (client_id,name,directory_path,created_at,updated_at) VALUES (?,'Raw','C:/raw','now','now')"
      )
      .run(client.id)
  ).toThrow()
  db.update(clients).set({ syncId: client.syncId }).where(eq(clients.id, client.id)).run()
  db.update(projects).set({ syncId: project.syncId }).where(eq(projects.id, project.id)).run()
  expect(db.select().from(clients).get()).toEqual(client)
  expect(db.select().from(projects).get()).toEqual(project)
})

it('does not reuse identities when a deleted client name and project path are reused', () => {
  const client = clientProjectService.createClient({ name: 'Reusable' })
  const project = clientProjectService.createProject({
    clientId: client.id,
    name: 'Reusable',
    directoryPath: 'C:/reused'
  })
  const oldClientId = db.select().from(clients).get()!.syncId
  const oldProjectId = db.select().from(projects).get()!.syncId
  clientProjectService.deleteProject(project.id)
  clientProjectService.deleteClient(client.id)
  const replacement = clientProjectService.createClient({ name: 'Reusable' })
  clientProjectService.createProject({
    clientId: replacement.id,
    name: 'Reusable',
    directoryPath: 'C:/reused'
  })
  expect(db.select().from(clients).get()!.syncId).not.toBe(oldClientId)
  expect(db.select().from(projects).get()!.syncId).not.toBe(oldProjectId)
})

it('does not infer cross-database identity from identical names, paths or integer IDs', () => {
  const client = db.insert(clients).values({ name: 'Same', color: 'red' }).returning().get()
  const project = db
    .insert(projects)
    .values({ clientId: client.id, name: 'Same', directoryPath: 'C:/same' })
    .returning()
    .get()
  const otherSqlite = new Database(':memory:')
  try {
    const other = drizzle(otherSqlite)
    migrate(other, { migrationsFolder })
    const otherClient = other
      .insert(clients)
      .values({ name: 'Same', color: 'red' })
      .returning()
      .get()
    const otherProject = other
      .insert(projects)
      .values({ clientId: otherClient.id, name: 'Same', directoryPath: 'C:/same' })
      .returning()
      .get()
    expect(otherClient.id).toBe(client.id)
    expect(otherProject.id).toBe(project.id)
    expect(otherClient.syncId).not.toBe(client.syncId)
    expect(otherProject.syncId).not.toBe(project.syncId)
  } finally {
    otherSqlite.close()
  }
})
