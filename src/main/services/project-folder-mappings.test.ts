// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { clients } from '../db/schema/clients'
import { projects } from '../db/schema/projects'
import { sessions } from '../db/schema/sessions'
import { invoices, invoiceLineItems } from '../db/schema/invoices'
import { projectFolderMappings } from '../db/schema/project-folder-mappings'
import { removeProjectFolderMappings } from '../db/migration-test-helpers'
import { eq } from 'drizzle-orm'
import {
  findProjectFolderMapping,
  isProjectFolderDiscoveryBlocked,
  getProjectFolderMapping,
  initializeProjectFolderMappings,
  removeProjectFolderMapping,
  setProjectFolderMapping
} from './project-folder-mappings'

let sqlite: Database.Database
let db: BetterSQLite3Database
const deviceA = randomUUID()
const deviceB = randomUUID()
const migrationsFolder = join(__dirname, '../db/migrations')

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder })
})
afterEach(() => sqlite.close())

function createProject(name = 'Project', syncId = randomUUID()) {
  const client = db.insert(clients).values({ name, color: 'red' }).returning().get()
  const project = db
    .insert(projects)
    .values({
      clientId: client.id,
      name,
      syncId,
      directoryPath: `C:/legacy/${name}`,
      hourlyRate: 175
    })
    .returning()
    .get()
  return { ...project, directoryPath: project.directoryPath! }
}

it('adds empty mapping storage on upgrade without guessing devices or changing existing project rows', () => {
  createProject()
  removeProjectFolderMappings(sqlite)
  const before = db.select().from(projects).all()
  migrate(db, { migrationsFolder })
  expect(db.select().from(projects).all()).toEqual(before)
  expect(db.select().from(projectFolderMappings).all()).toEqual([])
  const mapping = setProjectFolderMapping(db, deviceA, before[0].syncId, 'C:/mapping-test/restart')
  migrate(db, { migrationsFolder })
  const reopened = new Database(sqlite.serialize())
  try {
    const reopenedDb = drizzle(reopened)
    migrate(reopenedDb, { migrationsFolder })
    expect(getProjectFolderMapping(reopenedDb, deviceA, before[0].syncId)).toEqual(mapping)
    expect(getProjectFolderMapping(reopenedDb, randomUUID(), before[0].syncId)).toBeNull()
  } finally {
    reopened.close()
  }
})

it('enforces database uniqueness and project references and removes mappings when their project is deleted', () => {
  const first = createProject('First')
  const second = createProject('Second')
  const mapping = setProjectFolderMapping(db, deviceA, first.syncId, 'C:/mapping-test/first')
  expect(() =>
    db
      .insert(projectFolderMappings)
      .values({ ...mapping, projectSyncId: second.syncId })
      .run()
  ).toThrow()
  expect(() =>
    db
      .insert(projectFolderMappings)
      .values({ ...mapping, directoryKey: 'other', directoryPath: 'C:/other' })
      .run()
  ).toThrow()
  expect(() =>
    db
      .insert(projectFolderMappings)
      .values({ ...mapping, projectSyncId: randomUUID(), directoryKey: 'missing' })
      .run()
  ).toThrow()
  setProjectFolderMapping(db, deviceB, first.syncId, '/work/first')
  const unaffected = setProjectFolderMapping(db, deviceA, second.syncId, '/work/second')
  db.delete(projects).where(eq(projects.id, first.id)).run()
  expect(getProjectFolderMapping(db, deviceA, first.syncId)).toBeNull()
  expect(getProjectFolderMapping(db, deviceB, first.syncId)).toBeNull()
  expect(getProjectFolderMapping(db, deviceA, second.syncId)).toEqual(unaffected)
  expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
})

it('keeps mappings separate for two devices and never adopts the legacy path implicitly', () => {
  const project = createProject()
  expect(getProjectFolderMapping(db, deviceA, project.syncId)).toBeNull()
  expect(findProjectFolderMapping(db, deviceA, project.directoryPath)).toBeNull()
  setProjectFolderMapping(db, deviceA, project.syncId, 'C:/mapping-test/one')
  expect(getProjectFolderMapping(db, deviceB, project.syncId)).toBeNull()
  setProjectFolderMapping(db, deviceB, project.syncId, 'D:/mapping-test/two')
  expect(getProjectFolderMapping(db, deviceA, project.syncId)?.directoryPath).toBe(
    'C:\\mapping-test\\one'
  )
  expect(getProjectFolderMapping(db, deviceB, project.syncId)?.directoryPath).toBe(
    'D:\\mapping-test\\two'
  )
  expect(findProjectFolderMapping(db, deviceA, 'D:/mapping-test/two')).toBeNull()
})

it('moves or removes one mapping without changing shared records, historical paths or invoice links', () => {
  const project = createProject()
  const session = db
    .insert(sessions)
    .values({
      projectId: project.id,
      clientId: project.clientId,
      projectPath: 'C:/mapping-test/old',
      startedAt: '2026-09-01T10:00:00Z',
      endedAt: '2026-09-01T11:00:00Z',
      durationMinutes: 60,
      description: 'Saved work'
    })
    .returning()
    .get()
  const invoice = db
    .insert(invoices)
    .values({ clientId: project.clientId, stripeInvoiceId: 'in_fixture', amountDueCents: 17500 })
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
  const snapshot = () =>
    ['clients', 'projects', 'sessions', 'invoices', 'invoice_line_items'].map((table) =>
      sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all()
    )
  const before = snapshot()
  setProjectFolderMapping(db, deviceA, project.syncId, 'C:/mapping-test/old')
  const other = setProjectFolderMapping(db, deviceB, project.syncId, '/work/other')
  setProjectFolderMapping(db, deviceA, project.syncId, 'C:/mapping-test/new')
  expect(findProjectFolderMapping(db, deviceA, 'C:/mapping-test/old')).toBeNull()
  const replacement = createProject('Unrelated')
  setProjectFolderMapping(db, deviceA, replacement.syncId, 'C:/mapping-test/old')
  expect(findProjectFolderMapping(db, deviceA, 'C:/mapping-test/old')?.projectSyncId).toBe(
    replacement.syncId
  )
  removeProjectFolderMapping(db, deviceA, project.syncId)
  removeProjectFolderMapping(db, deviceA, project.syncId)
  expect(getProjectFolderMapping(db, deviceA, project.syncId)).toBeNull()
  expect(getProjectFolderMapping(db, deviceB, project.syncId)).toEqual(other)
  // The only shared additions were the unrelated client/project created above.
  const after = snapshot()
  expect(after.map((rows, index) => (index < 2 ? rows.slice(0, 1) : rows))).toEqual(before)
  expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
})

it('rejects an occupied folder atomically, including Windows spelling aliases', () => {
  const first = createProject('First')
  const second = createProject('Second')
  const original = setProjectFolderMapping(db, deviceA, first.syncId, 'C:/mapping-test/first')
  setProjectFolderMapping(db, deviceA, second.syncId, 'C:/mapping-test/second')
  for (const path of ['c:\\MAPPING-TEST\\second\\', 'C:/mapping-test/x/../second']) {
    expect(() => setProjectFolderMapping(db, deviceA, first.syncId, path)).toThrow(
      'already linked to another project'
    )
  }
  expect(getProjectFolderMapping(db, deviceA, first.syncId)).toEqual(original)
  expect(isProjectFolderDiscoveryBlocked(db, deviceA, 'C:/mapping-test/first')).toBe(false)
  expect(findProjectFolderMapping(db, deviceA, 'c:/MAPPING-TEST/SECOND')?.projectSyncId).toBe(
    second.syncId
  )
  // The same spelling can refer to a different repository on another computer.
  setProjectFolderMapping(db, deviceB, first.syncId, 'C:/mapping-test/second')
  expect(findProjectFolderMapping(db, deviceB, 'C:/mapping-test/second')?.projectSyncId).toBe(
    first.syncId
  )
})

it('normalizes UNC and worktree folders while preserving POSIX case distinctions', () => {
  const first = createProject('First')
  const second = createProject('Second')
  setProjectFolderMapping(db, deviceA, first.syncId, '\\\\server\\share\\Repo\\')
  expect(findProjectFolderMapping(db, deviceA, '//SERVER/share/repo')?.projectSyncId).toBe(
    first.syncId
  )
  setProjectFolderMapping(db, deviceA, first.syncId, '/work/Repo/')
  setProjectFolderMapping(db, deviceA, second.syncId, '/work/repo')
  expect(findProjectFolderMapping(db, deviceA, '/work/Repo')?.projectSyncId).toBe(first.syncId)
  expect(findProjectFolderMapping(db, deviceA, '/work/repo')?.projectSyncId).toBe(second.syncId)
  setProjectFolderMapping(db, deviceB, first.syncId, '/work/literal\\')
  expect(getProjectFolderMapping(db, deviceB, first.syncId)?.directoryPath).toBe('/work/literal\\')
  expect(findProjectFolderMapping(db, deviceB, '/work/literal')).toBeNull()
  setProjectFolderMapping(db, deviceA, first.syncId, 'C:/mapping-test/main/.claude/worktrees/task')
  expect(findProjectFolderMapping(db, deviceA, 'C:/mapping-test/main')?.projectSyncId).toBe(
    first.syncId
  )
})

it('rejects missing projects, invalid device IDs and relative or empty folders without writing', () => {
  const project = createProject()
  expect(() => setProjectFolderMapping(db, deviceA, randomUUID(), 'C:/mapping-test/new')).toThrow(
    'Project not found'
  )
  for (const device of ['', 'computer-name']) {
    expect(() =>
      setProjectFolderMapping(db, device, project.syncId, 'C:/mapping-test/new')
    ).toThrow()
    expect(() => removeProjectFolderMapping(db, device, project.syncId)).toThrow()
  }
  for (const path of ['', '   ', 'relative/folder', 'C:relative', '\\relative', 'C:/bad\0path']) {
    expect(() => setProjectFolderMapping(db, deviceA, project.syncId, path)).toThrow()
  }
  expect(getProjectFolderMapping(db, deviceA, project.syncId)).toBeNull()
})

it('keeps root worktree mappings absolute and discoverable by the repository root', () => {
  const project = createProject()
  setProjectFolderMapping(db, deviceA, project.syncId, 'C:/.claude/worktrees/task')
  expect(getProjectFolderMapping(db, deviceA, project.syncId)?.directoryPath).toBe('C:\\')
  expect(findProjectFolderMapping(db, deviceA, 'C:/')?.projectSyncId).toBe(project.syncId)
  setProjectFolderMapping(db, deviceB, project.syncId, '/.claude/worktrees/task')
  expect(getProjectFolderMapping(db, deviceB, project.syncId)?.directoryPath).toBe('/')
  expect(findProjectFolderMapping(db, deviceB, '/')?.projectSyncId).toBe(project.syncId)
})

it('uses project UUIDs across databases without borrowing another device mapping', () => {
  const project = createProject()
  setProjectFolderMapping(db, deviceA, project.syncId, 'C:/mapping-test/original')
  const otherSqlite = new Database(':memory:')
  try {
    otherSqlite.pragma('foreign_keys = ON')
    const otherDb = drizzle(otherSqlite)
    migrate(otherDb, { migrationsFolder })
    const client = otherDb
      .insert(clients)
      .values({ name: 'Imported client', color: 'blue' })
      .returning()
      .get()
    otherDb
      .insert(projects)
      .values({
        id: project.id + 10,
        clientId: client.id,
        syncId: project.syncId,
        name: project.name,
        directoryPath: '/legacy/informational'
      })
      .run()
    expect(getProjectFolderMapping(otherDb, deviceB, project.syncId)).toBeNull()
    setProjectFolderMapping(otherDb, deviceB, project.syncId, '/home/work/repository')
    expect(getProjectFolderMapping(otherDb, deviceB, project.syncId)?.directoryPath).toBe(
      '/home/work/repository'
    )
    expect(getProjectFolderMapping(db, deviceA, project.syncId)?.directoryPath).toBe(
      'C:\\mapping-test\\original'
    )
    migrate(otherDb, { migrationsFolder })
    expect(
      findProjectFolderMapping(otherDb, deviceB.toUpperCase(), '/home/work/repository')
        ?.projectSyncId
    ).toBe(project.syncId)
  } finally {
    otherSqlite.close()
  }
})

it('initializes only explicitly selected legacy folders and leaves shared records untouched', () => {
  const first = createProject('First')
  const second = createProject('Second')
  const before = db.select().from(projects).all()
  const selection = [{ projectSyncId: first.syncId, directoryPath: first.directoryPath }]
  initializeProjectFolderMappings(db, deviceA, selection)
  const initial = getProjectFolderMapping(db, deviceA, first.syncId)
  expect(initial?.directoryPath).toBe('C:\\legacy\\First')
  expect(getProjectFolderMapping(db, deviceA, second.syncId)).toBeNull()
  expect(getProjectFolderMapping(db, deviceB, first.syncId)).toBeNull()
  initializeProjectFolderMappings(db, deviceA, selection)
  expect(getProjectFolderMapping(db, deviceA, first.syncId)).toEqual(initial)
  expect(db.select().from(projects).all()).toEqual(before)
})

it('rolls back all selected mappings when legacy path aliases collide', () => {
  const first = createProject('First')
  const second = createProject('Second')
  db.update(projects)
    .set({ directoryPath: 'c:/LEGACY/first/' })
    .where(eq(projects.id, second.id))
    .run()
  expect(() =>
    initializeProjectFolderMappings(db, deviceA, [
      { projectSyncId: first.syncId, directoryPath: first.directoryPath },
      { projectSyncId: second.syncId, directoryPath: 'c:/LEGACY/first/' }
    ])
  ).toThrow('already linked to another project')
  expect(db.select().from(projectFolderMappings).all()).toEqual([])
})

it('rejects stale or removed legacy selections atomically', () => {
  const first = createProject('First')
  const second = createProject('Second')
  const selection = [first, second].map((project) => ({
    projectSyncId: project.syncId,
    directoryPath: project.directoryPath
  }))
  db.update(projects).set({ directoryPath: 'C:/changed' }).where(eq(projects.id, second.id)).run()
  expect(() => initializeProjectFolderMappings(db, deviceA, selection)).toThrow(
    'Project folder changed'
  )
  expect(db.select().from(projectFolderMappings).all()).toEqual([])
  db.delete(projects).where(eq(projects.id, second.id)).run()
  expect(() => initializeProjectFolderMappings(db, deviceA, selection)).toThrow('Project not found')
  expect(db.select().from(projectFolderMappings).all()).toEqual([])
})

it('cannot replay initial setup over a subsequently moved folder or another device mapping', () => {
  const project = createProject()
  const selection = [{ projectSyncId: project.syncId, directoryPath: project.directoryPath }]
  initializeProjectFolderMappings(db, deviceA, selection)
  const other = setProjectFolderMapping(db, deviceB, project.syncId, '/home/work/repo')
  const moved = setProjectFolderMapping(db, deviceA, project.syncId, 'D:/moved/repo')
  expect(() => initializeProjectFolderMappings(db, deviceA, selection)).toThrow(
    'already has a different folder'
  )
  expect(getProjectFolderMapping(db, deviceA, project.syncId)).toEqual(moved)
  expect(getProjectFolderMapping(db, deviceB, project.syncId)).toEqual(other)
})

it('requires explicit initialization after a database clone registers a new device', () => {
  const project = createProject()
  initializeProjectFolderMappings(db, deviceA, [
    { projectSyncId: project.syncId, directoryPath: project.directoryPath }
  ])
  const cloned = new Database(sqlite.serialize())
  try {
    const clonedDb = drizzle(cloned)
    expect(getProjectFolderMapping(clonedDb, deviceB, project.syncId)).toBeNull()
    initializeProjectFolderMappings(clonedDb, deviceB, [])
    expect(getProjectFolderMapping(clonedDb, deviceB, project.syncId)).toBeNull()
    const original = getProjectFolderMapping(clonedDb, deviceA, project.syncId)
    initializeProjectFolderMappings(clonedDb, deviceB, [
      { projectSyncId: project.syncId, directoryPath: project.directoryPath }
    ])
    expect(getProjectFolderMapping(clonedDb, deviceB, project.syncId)?.projectSyncId).toBe(
      project.syncId
    )
    expect(getProjectFolderMapping(clonedDb, deviceA, project.syncId)).toEqual(original)
    expect(getProjectFolderMapping(db, deviceB, project.syncId)).toBeNull()
  } finally {
    cloned.close()
  }
})

it('remembers releases with the same UNC, worktree and POSIX identity rules as folder mappings', () => {
  const project = createProject()
  setProjectFolderMapping(db, deviceA, project.syncId, '//server/share/Repo')
  setProjectFolderMapping(db, deviceA, project.syncId, '/work/Repo')
  expect(isProjectFolderDiscoveryBlocked(db, deviceA, '//SERVER/SHARE/repo/')).toBe(true)
  removeProjectFolderMapping(db, deviceA, project.syncId)
  removeProjectFolderMapping(db, deviceA, project.syncId)
  expect(isProjectFolderDiscoveryBlocked(db, deviceA, '/work/Repo/.claude/worktrees/task')).toBe(
    true
  )
  expect(isProjectFolderDiscoveryBlocked(db, deviceA, '/work/repo')).toBe(false)
  expect(isProjectFolderDiscoveryBlocked(db, deviceB, '/work/Repo')).toBe(false)
  setProjectFolderMapping(db, deviceA, project.syncId, '/work/Repo')
  expect(isProjectFolderDiscoveryBlocked(db, deviceA, '/work/Repo')).toBe(false)
})
