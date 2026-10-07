// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { clients } from '../db/schema/clients'
import { projects } from '../db/schema/projects'
import { sessions } from '../db/schema/sessions'
import { projectFolderMappings } from '../db/schema/project-folder-mappings'
import { syncChanges } from '../db/schema/folder-sync'
import {
  encodeSyncBatch,
  syncBatchChecksum,
  type SyncBatch,
  type SyncChange
} from './folder-sync-protocol'
import {
  applyReadySyncBatches,
  assembleOutgoingBatch,
  recordLocalSyncChanges,
  retainIncomingBatch
} from './folder-sync-store'
import {
  PRESENT,
  type JsonValue,
  type RecordView,
  type RevisionAction,
  type RevisionChange
} from './folder-sync-revisions'
import {
  CLIENT_SYNC_SCHEMA,
  PROJECT_SYNC_SCHEMA,
  directoryRecordsAdapter as adapter,
  getDirectoryRecordView,
  planDirectoryBootstrap,
  planDirectoryExport,
  planDirectoryRevision,
  readDirectoryRecordState,
  type DirectoryEntityType
} from './folder-sync-directory-records'

const workspaceId = '6a0f8f64-3c1d-4b8e-9f51-2d7c4e9b1a30'
type Db = ReturnType<typeof drizzle>
const opened: Database.Database[] = []
let a: Db
let b: Db

function database(bytes?: Buffer): Db {
  const connection = new Database(bytes ?? ':memory:')
  connection.pragma('foreign_keys = ON')
  opened.push(connection)
  const db = drizzle(connection)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  return db
}
beforeEach(() => {
  a = database()
  b = database()
})
afterEach(() => {
  for (const connection of opened.splice(0)) connection.close()
})

const record = (db: Db, changes: unknown[]): string[] =>
  recordLocalSyncChanges(db, workspaceId, changes, adapter)
const assemble = (db: Db): SyncBatch | null =>
  assembleOutgoingBatch(db, workspaceId, { writerEpochId: randomUUID(), deviceId: randomUUID() })
function publish(db: Db): SyncBatch {
  const batch = assemble(db)
  if (!batch) throw new Error('Nothing to publish')
  return batch
}
function deliver(db: Db, ...batches: SyncBatch[]): ReturnType<typeof applyReadySyncBatches> {
  for (const batch of batches) retainIncomingBatch(db, workspaceId, batch, adapter)
  return applyReadySyncBatches(db, workspaceId, adapter)
}
function exchange(): void {
  const fromA = assemble(a)
  const fromB = assemble(b)
  if (fromA) expect(deliver(b, fromA).errors).toEqual([])
  if (fromB) expect(deliver(a, fromB).errors).toEqual([])
}

const addClient = (db: Db, values: Partial<typeof clients.$inferInsert> = {}) =>
  db
    .insert(clients)
    .values({ name: 'Acme', color: 'var(--project-1)', billableRate: 100, ...values })
    .returning()
    .get()
const addProject = (db: Db, clientId: number, values: Partial<typeof projects.$inferInsert> = {}) =>
  db
    .insert(projects)
    .values({ clientId, name: 'Website', hourlyRate: 100, ...values })
    .returning()
    .get()
const addMapping = (db: Db, projectSyncId: string, directoryPath: string): void => {
  db.insert(projectFolderMappings)
    .values({
      deviceId: 'this-device',
      projectSyncId,
      directoryPath,
      directoryKey: directoryPath.toLowerCase(),
      updatedAt: '2026-09-01T00:00:00.000Z'
    })
    .run()
}
const clientRow = (db: Db, syncId: string) =>
  db.select().from(clients).where(eq(clients.syncId, syncId)).get()
const projectRow = (db: Db, syncId: string) =>
  db.select().from(projects).where(eq(projects.syncId, syncId)).get()
const view = (db: Db, entityType: DirectoryEntityType, entityId: string): RecordView =>
  getDirectoryRecordView(db, workspaceId, entityType, entityId)
const state = (db: Db, entityType: DirectoryEntityType, entityId: string) =>
  readDirectoryRecordState(db, workspaceId, entityType, entityId)

function exportAll(db: Db): RevisionChange[] {
  const plan = planDirectoryExport(db, workspaceId)
  expect(plan.blocked).toEqual([])
  expect(plan.invalid).toEqual([])
  if (plan.changes.length) record(db, plan.changes)
  return plan.changes
}
function bootstrap(db: Db, entityType: DirectoryEntityType, syncId: string): RevisionChange {
  const plan = planDirectoryBootstrap(db, workspaceId, entityType, syncId)
  if (plan.status !== 'ready') throw new Error(`Bootstrap is ${plan.status}`)
  record(db, [plan.change])
  return plan.change
}
function revise(
  db: Db,
  entityType: DirectoryEntityType,
  entityId: string,
  action: (current: RecordView) => RevisionAction
): RevisionChange {
  const change = planDirectoryRevision(db, workspaceId, {
    id: randomUUID(),
    entityType,
    entityId,
    action: action(view(db, entityType, entityId))
  })
  record(db, [change])
  return change
}
const edit =
  (values: Record<string, JsonValue>) =>
  (current: RecordView): RevisionAction => ({ type: 'edit', observedHeads: current.heads, values })

/** A client and project created on A, exported and imported by B. */
function shared(): { client: string; project: string } {
  const client = addClient(a)
  const project = addProject(a, client.id)
  exportAll(a)
  expect(deliver(b, publish(a)).errors).toEqual([])
  return { client: client.syncId, project: project.syncId }
}

it('imports a project delivered before its client only after the declared client dependency', () => {
  const client = addClient(a, { stripeCustomerId: 'cus_local_only' })
  const clientChange = bootstrap(a, 'client', client.syncId)
  const clientBatch = publish(a)
  const project = addProject(a, client.id, { directoryPath: 'C:/work/site' })
  addMapping(a, project.syncId, 'C:/work/site')
  const [projectChange] = exportAll(a)
  expect(projectChange.dependencies).toEqual([clientChange.id])
  const projectBatch = publish(a)

  const local = addProject(b, addClient(b, { name: 'Home' }).id, { name: 'Local' })
  addMapping(b, local.syncId, 'D:/code/local')
  const mappings = b.select().from(projectFolderMappings).all()

  expect(deliver(b, projectBatch)).toEqual({
    applied: [],
    waiting: [{ batchId: projectBatch.batchId, missing: [clientChange.id] }],
    errors: []
  })
  expect(projectRow(b, project.syncId)).toBeUndefined()
  expect(deliver(b, clientBatch).applied).toEqual([clientBatch.batchId, projectBatch.batchId])

  const imported = clientRow(b, client.syncId)!
  expect(imported).toMatchObject({
    name: 'Acme',
    color: 'var(--project-1)',
    billableRate: 100,
    stripeCustomerId: null,
    isActive: true
  })
  expect(projectRow(b, project.syncId)).toMatchObject({
    clientId: imported.id,
    name: 'Website',
    directoryPath: null,
    hourlyRate: 100,
    isBillable: true,
    isActive: true
  })
  expect(b.select().from(projectFolderMappings).all()).toEqual(mappings)
  expect(state(b, 'project', project.syncId)).toMatchObject({ view: { lifecycle: 'present' } })
  expect(state(b, 'project', project.syncId)?.projectionIssue).toBeUndefined()
})

it('imports a project created before rootCommit existed, defaulting it to none', () => {
  const client = addClient(a)
  addProject(a, client.id, { rootCommit: 'a'.repeat(40) })
  exportAll(a)
  const batch = publish(a)
  // An older build wrote project creates without the field.
  const legacy = structuredClone(batch)
  for (const change of legacy.changes as unknown as RevisionChange[]) {
    const fields = (change.payload as { fields: Record<string, unknown> }).fields
    if (change.entityType === 'project') delete fields.rootCommit
  }
  legacy.checksum = syncBatchChecksum(legacy)
  expect(deliver(b, legacy).errors).toEqual([])
  const imported = b.select().from(projects).all()
  expect(imported).toHaveLength(1)
  expect(imported[0]).toMatchObject({ name: 'Website', rootCommit: null })
})

it('exports only allowlisted values and rejects unknown fields, local IDs, facts and undeclared references', () => {
  const client = addClient(a, { email: 'billing@acme.test', stripeCustomerId: 'cus_secret_123' })
  const project = addProject(a, client.id, { directoryPath: 'C:/secret/repo' })
  addMapping(a, project.syncId, 'C:/secret/repo')
  const { changes, blocked, invalid } = planDirectoryExport(a, workspaceId)
  expect(blocked).toEqual([])
  expect(invalid).toEqual([])
  const [clientChange, projectChange] = changes
  expect(Object.keys(clientChange.payload.fields).sort()).toEqual(
    [PRESENT, ...CLIENT_SYNC_SCHEMA.fields].sort()
  )
  expect(Object.keys(projectChange.payload.fields).sort()).toEqual(
    [PRESENT, ...PROJECT_SYNC_SCHEMA.fields].sort()
  )
  const exported = JSON.stringify(changes)
  for (const local of ['cus_secret_123', 'secret/repo', 'stripe', 'directory', 'clientId'])
    expect(exported).not.toContain(local)
  expect(projectChange.payload.fields.clientSyncId.value).toBe(client.syncId)
  expect(projectChange.dependencies).toEqual([clientChange.id])

  const withField = (change: RevisionChange, field: string, value: JsonValue): RevisionChange => {
    const copy = structuredClone(change)
    copy.payload.fields[field] = { value, parents: [] }
    return copy
  }
  const incomplete = structuredClone(clientChange)
  delete incomplete.payload.fields.color
  const rejected: unknown[] = [
    withField(clientChange, 'stripeCustomerId', 'cus_other'),
    withField(projectChange, 'directoryPath', 'C:/elsewhere'),
    withField(projectChange, 'clientSyncId', client.id),
    withField(clientChange, 'billableRate', -5),
    withField(clientChange, 'billableRate', '100'),
    withField(clientChange, 'email', 'x'.repeat(400)),
    withField(clientChange, 'color', 'url(javascript:alert(1))'),
    incomplete,
    { ...clientChange, kind: 'fact' },
    { ...clientChange, entityId: String(client.id) },
    { ...projectChange, dependencies: [] }
  ]
  for (const change of rejected) expect(() => adapter.validate(change as SyncChange)).toThrow()

  const { batch } = encodeSyncBatch({
    workspaceId,
    batchId: randomUUID(),
    writerEpochId: randomUUID(),
    deviceId: randomUUID(),
    sequence: 1,
    changes: [withField(clientChange, 'stripeCustomerId', 'cus_other') as unknown as SyncChange],
    dependencies: []
  })
  expect(() => retainIncomingBatch(b, workspaceId, batch, adapter)).toThrow(/unknown field/)

  record(a, [clientChange])
  const other = bootstrap(a, 'client', addClient(a, { name: 'Other' }).syncId)
  const misdirected = { ...projectChange, id: randomUUID(), dependencies: [other.id] }
  expect(() => record(a, [misdirected])).toThrow(/does not depend on client/)
  expect(
    a.select().from(syncChanges).where(eq(syncChanges.entityId, project.syncId)).all()
  ).toEqual([])
  expect(state(a, 'project', project.syncId)).toBeNull()
})

it('merges concurrent edits of different fields to the same state on both computers', () => {
  const ids = shared()
  revise(a, 'client', ids.client, edit({ name: 'Acme Corp' }))
  revise(b, 'client', ids.client, edit({ billableRate: 140 }))
  revise(b, 'project', ids.project, edit({ isBillable: false }))
  exchange()
  for (const db of [a, b]) {
    expect(clientRow(db, ids.client)).toMatchObject({ name: 'Acme Corp', billableRate: 140 })
    expect(projectRow(db, ids.project)).toMatchObject({ isBillable: false, hourlyRate: 100 })
    expect(view(db, 'client', ids.client).conflicts).toEqual([])
  }
  expect(state(a, 'client', ids.client)).toEqual(state(b, 'client', ids.client))
  expect(state(a, 'project', ids.project)).toEqual(state(b, 'project', ids.project))
})

it('keeps the last agreed rate and both alternatives until an explicit resolution', () => {
  const ids = shared()
  const fromA = revise(a, 'project', ids.project, edit({ hourlyRate: 150 }))
  const fromB = revise(b, 'project', ids.project, edit({ hourlyRate: 175 }))
  exchange()
  const alternatives = [
    { id: fromA.id, value: 150 },
    { id: fromB.id, value: 175 }
  ].sort((x, y) => (x.id < y.id ? -1 : 1))
  for (const db of [a, b]) {
    const current = view(db, 'project', ids.project)
    expect(current.conflicts).toEqual(['hourlyRate'])
    expect(current.fields.hourlyRate).toMatchObject({ status: 'conflict', value: 100 })
    expect(current.fields.hourlyRate.heads).toEqual(alternatives)
    expect(state(db, 'project', ids.project)?.view.conflicts).toEqual(['hourlyRate'])
    expect(projectRow(db, ids.project)!.hourlyRate).toBe(100)
  }
  expect(() => revise(a, 'project', ids.project, edit({ hourlyRate: 160 }))).toThrow(/Resolve/)

  revise(b, 'project', ids.project, (current) => ({
    type: 'resolve',
    expectedHeads: current.heads,
    values: { hourlyRate: 160 }
  }))
  exchange()
  for (const db of [a, b]) {
    expect(view(db, 'project', ids.project).conflicts).toEqual([])
    expect(projectRow(db, ids.project)!.hourlyRate).toBe(160)
  }
})

it('deactivates a deleted client without cascading, and only an explicit resolution restores it', () => {
  const ids = shared()
  const client = clientRow(b, ids.client)!
  const project = projectRow(b, ids.project)!
  const session = b
    .insert(sessions)
    .values({
      projectPath: 'C:/work/site',
      startedAt: '2026-09-01T10:00:00.000Z',
      endedAt: '2026-09-01T11:00:00.000Z',
      durationMinutes: 60,
      projectId: project.id,
      clientId: client.id
    })
    .returning()
    .get()

  revise(a, 'client', ids.client, (current) => ({ type: 'delete', observedHeads: current.heads }))
  expect(clientRow(a, ids.client)!.isActive).toBe(false)
  exchange()
  expect(view(b, 'client', ids.client).lifecycle).toBe('deleted')
  expect(clientRow(b, ids.client)).toMatchObject({
    id: client.id,
    createdAt: client.createdAt,
    isActive: false
  })
  expect(projectRow(b, ids.project)).toMatchObject({
    id: project.id,
    clientId: client.id,
    isActive: true
  })
  expect(b.select().from(sessions).where(eq(sessions.id, session.id)).get()).toEqual(session)
  expect(() => revise(b, 'client', ids.client, edit({ name: 'Revived' }))).toThrow(
    /resolve it explicitly/
  )

  revise(b, 'client', ids.client, (current) => ({
    type: 'resolve',
    expectedHeads: current.heads,
    present: true
  }))
  exchange()
  for (const db of [a, b]) {
    expect(view(db, 'client', ids.client).lifecycle).toBe('present')
    expect(clientRow(db, ids.client)!.isActive).toBe(true)
  }
})

it('keeps a concurrent edit and deletion as a visible conflict rather than choosing either', () => {
  const ids = shared()
  revise(a, 'project', ids.project, (current) => ({
    type: 'delete',
    observedHeads: current.heads
  }))
  revise(b, 'project', ids.project, edit({ name: 'Website v2' }))
  exchange()
  for (const db of [a, b]) {
    const current = state(db, 'project', ids.project)!.view
    expect(current.lifecycle).toBe('conflict')
    expect(current.conflicts).toEqual([PRESENT])
    // The row stays visible with its last agreed presence; the conflict blocks billing use.
    expect(projectRow(db, ids.project)).toMatchObject({ name: 'Website v2', isActive: true })
    expect(() => revise(db, 'project', ids.project, edit({ name: 'Other' }))).toThrow(
      /resolve it explicitly/
    )
  }
})

it('holds a same-name client from another computer visibly instead of merging identities', () => {
  const remote = addClient(a)
  const remoteProject = addProject(a, remote.id)
  const local = addClient(b)
  exportAll(a)
  exportAll(b)
  exchange()

  expect(b.select().from(clients).all()).toHaveLength(1)
  expect(state(b, 'client', remote.syncId)).toMatchObject({
    view: { lifecycle: 'present' },
    projectionIssue: { code: 'name-collision', conflictingSyncId: local.syncId }
  })
  expect(state(b, 'project', remoteProject.syncId)?.projectionIssue).toEqual({
    code: 'client-unavailable',
    clientSyncId: remote.syncId
  })
  expect(projectRow(b, remoteProject.syncId)).toBeUndefined()
  expect(state(a, 'client', local.syncId)?.projectionIssue).toEqual({
    code: 'name-collision',
    conflictingSyncId: remote.syncId
  })
  expect(clientRow(a, local.syncId)).toBeUndefined()

  revise(b, 'client', local.syncId, edit({ name: 'Acme (laptop)' }))
  const imported = clientRow(b, remote.syncId)!
  expect(imported.name).toBe('Acme')
  expect(state(b, 'client', remote.syncId)?.projectionIssue).toBeUndefined()
  expect(projectRow(b, remoteProject.syncId)).toMatchObject({
    clientId: imported.id,
    directoryPath: null
  })
  exchange()
  for (const db of [a, b])
    expect(
      db
        .select()
        .from(clients)
        .all()
        .map((row) => row.name)
        .sort()
    ).toEqual(['Acme', 'Acme (laptop)'])
})

it('deduplicates exact cloned roots and turns differing pre-sync values into a visible conflict', () => {
  const client = addClient(a)
  const project = addProject(a, client.id)
  const second = addClient(a, { name: 'Beta', billableRate: 80 })
  const clone = database(opened[0].serialize())
  clone
    .update(clients)
    .set({ billableRate: 90, stripeCustomerId: 'cus_clone' })
    .where(eq(clients.syncId, second.syncId))
    .run()

  const roots = [bootstrap(a, 'client', client.syncId), bootstrap(a, 'project', project.syncId)]
  expect([
    bootstrap(clone, 'client', client.syncId),
    bootstrap(clone, 'project', project.syncId)
  ]).toEqual(roots)
  const original = bootstrap(a, 'client', second.syncId)

  // Imported before the clone exported its own differing row: held, local row untouched.
  expect(deliver(clone, publish(a)).errors).toEqual([])
  expect(clone.select().from(syncChanges).all()).toHaveLength(3)
  expect(state(clone, 'client', second.syncId)?.projectionIssue).toEqual({
    code: 'unexported-local-values'
  })
  expect(clientRow(clone, second.syncId)).toMatchObject({
    billableRate: 90,
    stripeCustomerId: 'cus_clone'
  })

  const competing = bootstrap(clone, 'client', second.syncId)
  expect(competing.id).not.toBe(original.id)
  expect(state(clone, 'client', second.syncId)?.projectionIssue).toBeUndefined()
  expect(deliver(a, publish(clone)).errors).toEqual([])
  expect(a.select().from(syncChanges).all()).toHaveLength(4)
  for (const [db, rate] of [
    [a, 80],
    [clone, 90]
  ] as const) {
    const current = view(db, 'client', second.syncId)
    expect(current.conflicts).toEqual(['billableRate'])
    expect(current.fields.billableRate.value).toBeUndefined()
    expect(current.fields.billableRate.heads.map((head) => head.value).sort()).toEqual([80, 90])
    expect(clientRow(db, second.syncId)!.billableRate).toBe(rate)
  }
  expect(clientRow(clone, second.syncId)!.stripeCustomerId).toBe('cus_clone')
})
