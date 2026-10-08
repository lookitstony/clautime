// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq, sql } from 'drizzle-orm'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { clients } from '../db/schema/clients'
import { projects } from '../db/schema/projects'
import { sessions } from '../db/schema/sessions'
import { folderSyncSettings, syncChanges } from '../db/schema/folder-sync'
import {
  applyReadySyncBatches,
  assembleOutgoingBatch,
  recordLocalSyncChanges,
  retainIncomingBatch
} from './folder-sync-store'
import { PRESENT, type RevisionChange } from './folder-sync-revisions'
import {
  directoryRecordsAdapter as adapter,
  getDirectoryRecordView,
  planDirectoryRevision,
  readDirectoryRecordState
} from './folder-sync-directory-records'
import {
  directorySyncWorkspace,
  journalDirectoryCreate,
  journalDirectoryDelete,
  journalDirectoryEdit
} from './folder-sync-directory-local'
import { UNASSIGNED_CLIENT_SYNC_ID } from './folder-sync-builtin-client'

const workspaceId = '0b6f5d1e-9a4c-4e7b-8d21-5f3a6c9e2b10'
type Db = ReturnType<typeof drizzle>
const opened: Database.Database[] = []
let db: Db

function database(): Db {
  const connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  opened.push(connection)
  const created = drizzle(connection)
  migrate(created, { migrationsFolder: join(__dirname, '../db/migrations') })
  return created
}
function connect(target: Db, enabled = 0): void {
  target
    .insert(folderSyncSettings)
    .values({ slot: 1, workspaceId, folderPath: 'G:/My Drive/ClauTime', enabled })
    .run()
}
beforeEach(() => {
  db = database()
})
afterEach(() => {
  for (const connection of opened.splice(0)) connection.close()
})

const addClient = (target: Db, name = 'Acme') =>
  target
    .insert(clients)
    .values({ name, color: 'var(--project-1)', billableRate: 100 })
    .returning()
    .get()
const addProject = (target: Db, clientId: number) =>
  target
    .insert(projects)
    .values({ clientId, name: 'Website', hourlyRate: 100, directoryPath: 'C:/secret/site' })
    .returning()
    .get()
const journal = (target: Db = db) =>
  target
    .select()
    .from(syncChanges)
    .orderBy(sql`rowid`)
    .all()
    .map((row) => JSON.parse(row.changeJson) as RevisionChange)
const view = (entityType: 'client' | 'project', syncId: string) =>
  getDirectoryRecordView(db, workspaceId, entityType, syncId)
function errorCode(action: () => unknown): unknown {
  try {
    action()
  } catch (error) {
    return (error as { code?: unknown }).code
  }
  throw new Error('Expected the action to fail')
}

it('journals nothing and keeps the caller in charge without a workspace connection', () => {
  const client = addClient(db)
  expect(directorySyncWorkspace(db)).toBeNull()
  journalDirectoryCreate(db, 'client', client.syncId)
  expect(journalDirectoryEdit(db, 'client', client.syncId, () => 'edited')).toBe('edited')
  expect(journalDirectoryDelete(db, 'client', client.syncId)).toBe(false)
  expect(journal()).toEqual([])
})

it('bootstraps an unexported client and project from pre-edit values before journaling an edit', () => {
  const client = addClient(db)
  const project = addProject(db, client.id)
  connect(db)

  db.transaction((tx) =>
    journalDirectoryEdit(tx, 'project', project.syncId, () =>
      tx.update(projects).set({ hourlyRate: 150 }).where(eq(projects.id, project.id)).run()
    )
  )
  const [clientRoot, projectRoot, edit] = journal()
  expect(clientRoot).toMatchObject({ entityType: 'client', entityId: client.syncId })
  expect(projectRoot).toMatchObject({ entityType: 'project', dependencies: [clientRoot.id] })
  expect(projectRoot.payload.fields.hourlyRate.value).toBe(100)
  expect(edit.payload.fields).toEqual({
    [PRESENT]: { value: true, parents: [projectRoot.id] },
    hourlyRate: { value: 150, parents: [projectRoot.id] }
  })
  expect(JSON.stringify(journal())).not.toContain('secret')
  expect(view('project', project.syncId).fields.hourlyRate.value).toBe(150)
})

it('rejects edits of a conflicted field, rolling back the row, while disjoint edits proceed', () => {
  const client = addClient(db)
  connect(db, 1)
  journalDirectoryCreate(db, 'client', client.syncId)
  const heads = view('client', client.syncId).heads
  // Two computers edited the rate concurrently from the same observed heads.
  const concurrent = [120, 130].map((billableRate) =>
    planDirectoryRevision(db, workspaceId, {
      id: randomUUID(),
      entityType: 'client',
      entityId: client.syncId,
      action: { type: 'edit', observedHeads: heads, values: { billableRate } }
    })
  )
  recordLocalSyncChanges(db, workspaceId, concurrent, adapter)
  expect(view('client', client.syncId).conflicts).toEqual(['billableRate'])
  const recorded = journal().length

  expect(
    errorCode(() =>
      db.transaction((tx) =>
        journalDirectoryEdit(tx, 'client', client.syncId, () =>
          tx.update(clients).set({ billableRate: 140 }).where(eq(clients.id, client.id)).run()
        )
      )
    )
  ).toBe('SYNC_CONFLICT')
  expect(db.select().from(clients).get()!.billableRate).toBe(100)
  expect(journal()).toHaveLength(recorded)

  db.transaction((tx) =>
    journalDirectoryEdit(tx, 'client', client.syncId, () =>
      tx.update(clients).set({ email: 'billing@acme.test' }).where(eq(clients.id, client.id)).run()
    )
  )
  const current = view('client', client.syncId)
  expect(current.fields.email.value).toBe('billing@acme.test')
  expect(current.fields.billableRate.heads.map((head) => head.value).sort()).toEqual([120, 130])
})

it('records a deletion that deactivates without cascading into projects or sessions', () => {
  const client = addClient(db)
  const project = addProject(db, client.id)
  const session = db
    .insert(sessions)
    .values({
      projectPath: 'C:/secret/site',
      startedAt: '2026-09-01T10:00:00.000Z',
      endedAt: '2026-09-01T11:00:00.000Z',
      durationMinutes: 60,
      projectId: project.id,
      clientId: client.id
    })
    .returning()
    .get()
  connect(db)

  expect(db.transaction((tx) => journalDirectoryDelete(tx, 'client', client.syncId))).toBe(true)
  expect(view('client', client.syncId).lifecycle).toBe('deleted')
  expect(db.select().from(clients).get()).toMatchObject({ id: client.id, isActive: false })
  expect(db.select().from(projects).get()).toMatchObject({ clientId: client.id, isActive: true })
  expect(db.select().from(sessions).get()).toEqual(session)
  const recorded = journal().length
  expect(journalDirectoryDelete(db, 'client', client.syncId)).toBe(true)
  expect(journal()).toHaveLength(recorded)
  expect(
    errorCode(() =>
      db.transaction((tx) =>
        journalDirectoryEdit(tx, 'client', client.syncId, () =>
          tx.update(clients).set({ name: 'Revived' }).where(eq(clients.id, client.id)).run()
        )
      )
    )
  ).toBe('SYNC_CONFLICT')
  expect(db.select().from(clients).get()!.name).toBe('Acme')
})

const addBuiltIn = (target: Db, color = '#6b7280') =>
  target
    .insert(clients)
    .values({ name: 'Unassigned', systemRole: 'unassigned', color })
    .returning()
    .get()
const addAutoProject = (target: Db, clientId: number, name: string) =>
  target
    .insert(projects)
    .values({ clientId, name, isBillable: false, directoryPath: `C:/secret/${name}` })
    .returning()
    .get()
function send(from: Db, to: Db): void {
  const batch = assembleOutgoingBatch(from, workspaceId, {
    writerEpochId: randomUUID(),
    deviceId: randomUUID()
  })
  if (!batch) return
  retainIncomingBatch(to, workspaceId, batch, adapter)
  expect(applyReadySyncBatches(to, workspaceId, adapter).errors).toEqual([])
}
const clientRows = (target: Db) => target.select().from(clients).orderBy(clients.id).all()
const projectRows = (target: Db) => target.select().from(projects).orderBy(projects.id).all()

it('shares each install’s built-in client under one reserved ID so auto projects converge', () => {
  const other = database()
  const local = addBuiltIn(db)
  const remote = addBuiltIn(other)
  expect(local.syncId).not.toBe(remote.syncId)
  const alpha = addAutoProject(db, local.id, 'alpha')
  const beta = addAutoProject(other, remote.id, 'beta')
  for (const [target, project] of [
    [db, alpha],
    [other, beta]
  ] as const) {
    connect(target)
    journalDirectoryCreate(target, 'project', project.syncId)
  }
  // Exact default built-ins produce the identical root on both computers.
  const [localRoot] = journal(db)
  expect(localRoot).toMatchObject({ entityType: 'client', entityId: UNASSIGNED_CLIENT_SYNC_ID })
  expect(journal(other)[0]).toEqual(localRoot)
  expect(journal(db)[1].payload.fields.clientSyncId.value).toBe(UNASSIGNED_CLIENT_SYNC_ID)

  send(other, db)
  send(db, other)

  for (const [target, builtIn, own] of [
    [db, local, alpha],
    [other, remote, beta]
  ] as const) {
    // Local IDs and syncIds never change; only the portable ID is shared.
    expect(clientRows(target)).toEqual([builtIn])
    expect(projectRows(target).map((row) => [row.name, row.clientId])).toEqual([
      [own.name, builtIn.id],
      [own === alpha ? 'beta' : 'alpha', builtIn.id]
    ])
    expect(
      readDirectoryRecordState(target, workspaceId, 'client', UNASSIGNED_CLIENT_SYNC_ID)
    ).toEqual({ view: expect.objectContaining({ lifecycle: 'present', conflicts: [] }) })
    expect(target.select().from(syncChanges).all()).toHaveLength(3)
  }
  const exported = JSON.stringify([...journal(db), ...journal(other)])
  expect(exported).not.toContain(local.syncId)
  expect(exported).not.toContain(remote.syncId)
})

it('keeps the built-in role through a synced rename and creates it on a computer without one', () => {
  const other = database()
  const local = addBuiltIn(db)
  const project = addAutoProject(db, local.id, 'alpha')
  connect(db)
  connect(other)
  journalDirectoryCreate(db, 'project', project.syncId)
  db.transaction((tx) =>
    journalDirectoryEdit(tx, 'client', local.syncId, () =>
      tx.update(clients).set({ name: 'Inbox' }).where(eq(clients.id, local.id)).run()
    )
  )
  expect(journal(db).at(-1)).toMatchObject({ entityId: UNASSIGNED_CLIENT_SYNC_ID })

  send(db, other)

  const [created] = clientRows(other)
  expect(clientRows(other)).toHaveLength(1)
  expect(created).toMatchObject({
    name: 'Inbox',
    systemRole: 'unassigned',
    syncId: UNASSIGNED_CLIENT_SYNC_ID
  })
  expect(projectRows(other)).toEqual([
    expect.objectContaining({ syncId: project.syncId, clientId: created.id, directoryPath: null })
  ])
  // Renamed back on the receiving computer, still the one built-in; the sender follows.
  other.transaction((tx) =>
    journalDirectoryEdit(tx, 'client', created.syncId, () =>
      tx.update(clients).set({ name: 'Unassigned' }).where(eq(clients.id, created.id)).run()
    )
  )
  send(other, db)
  expect(clientRows(db)).toEqual([
    expect.objectContaining({ id: local.id, syncId: local.syncId, name: 'Unassigned' })
  ])
})

it('holds an ordinary client named like the built-in as a name collision in both directions', () => {
  const other = database()
  const builtIn = addBuiltIn(db)
  const ordinary = addClient(other, 'Unassigned')
  expect(ordinary.systemRole).toBeNull()
  for (const [target, row] of [
    [db, builtIn],
    [other, ordinary]
  ] as const) {
    connect(target)
    journalDirectoryCreate(target, 'client', row.syncId)
  }

  send(other, db)
  send(db, other)

  expect(clientRows(db)).toEqual([builtIn])
  expect(readDirectoryRecordState(db, workspaceId, 'client', ordinary.syncId)).toMatchObject({
    projectionIssue: { code: 'name-collision', conflictingSyncId: UNASSIGNED_CLIENT_SYNC_ID }
  })
  // The ordinary client is never promoted, and no second built-in row appears.
  expect(clientRows(other)).toEqual([ordinary])
  expect(
    readDirectoryRecordState(other, workspaceId, 'client', UNASSIGNED_CLIENT_SYNC_ID)
  ).toMatchObject({
    projectionIssue: { code: 'name-collision', conflictingSyncId: ordinary.syncId }
  })
})

it('turns differing pre-sync built-in values into a field conflict and follows reassignment', () => {
  const other = database()
  const local = addBuiltIn(db, 'var(--project-3)')
  const remote = addBuiltIn(other)
  const project = addAutoProject(db, local.id, 'alpha')
  const acme = addClient(db)
  connect(db)
  connect(other)
  journalDirectoryCreate(db, 'project', project.syncId)
  journalDirectoryCreate(db, 'client', acme.syncId)
  journalDirectoryCreate(other, 'client', remote.syncId)

  send(db, other)
  send(other, db)
  for (const [target, row, color] of [
    [db, local, 'var(--project-3)'],
    [other, remote, '#6b7280']
  ] as const) {
    const current = getDirectoryRecordView(target, workspaceId, 'client', UNASSIGNED_CLIENT_SYNC_ID)
    expect(current.conflicts).toEqual(['color'])
    // Each computer keeps its own value until the user resolves the conflict.
    expect(clientRows(target)).toContainEqual(expect.objectContaining({ id: row.id, color }))
  }
  const received = projectRows(other)[0]
  expect(received.clientId).toBe(remote.id)

  // Moving the project to an ordinary client stays a normal assignment edit.
  db.transaction((tx) =>
    journalDirectoryEdit(tx, 'project', project.syncId, () =>
      tx.update(projects).set({ clientId: acme.id }).where(eq(projects.id, project.id)).run()
    )
  )
  send(db, other)
  const otherAcme = other.select().from(clients).where(eq(clients.syncId, acme.syncId)).get()!
  expect(projectRows(other)[0]).toMatchObject({ id: received.id, clientId: otherAcme.id })
  expect(getDirectoryRecordView(other, workspaceId, 'project', project.syncId).conflicts).toEqual(
    []
  )
})
