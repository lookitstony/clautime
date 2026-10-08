// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { automaticJoinDecisions } from '../../shared/folder-sync-matching'
import { getProjectFolderMapping, setProjectFolderMapping } from './project-folder-mappings'
import type { FolderSyncJoinDecision } from '../../shared/types/folder-sync'
import { clients } from '../db/schema/clients'
import { projects } from '../db/schema/projects'
import { sessions } from '../db/schema/sessions'
import { manualTimeEntries } from '../db/schema/manual-time-entries'
import { sourceMachines } from '../db/schema/activity-observers'
import { syncChanges } from '../db/schema/folder-sync'
import { createFolderSyncCoordinator } from './folder-sync-coordinator'
import { scanSyncBatches } from './folder-sync-files'
import {
  findClientByPortableId,
  getPortableClientId,
  getPortableProjectId
} from './folder-sync-builtin-client'
import { journalDirectoryDelete, journalDirectoryEdit } from './folder-sync-directory-local'

const handles: Database.Database[] = []
let root: string
let folder: string
function computer() {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  handles.push(sqlite)
  const db = drizzle(sqlite)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  const device = { deviceId: randomUUID(), writerEpochId: randomUUID() }
  const coordinator = createFolderSyncCoordinator({
    db: () => db,
    device: () => device,
    localDataDirectory: join(root, 'local-data'),
    project: () => []
  })
  return { db, coordinator, device }
}
type Computer = ReturnType<typeof computer>
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clautime-join-review-'))
  folder = join(root, 'shared')
  mkdirSync(folder)
})
afterEach(() => {
  handles.splice(0).forEach((db) => db.close())
  const path = resolve(root)
  if (!path.startsWith(resolve(tmpdir()) + sep) || !path.includes('clautime-join-review-'))
    throw new Error('Unsafe test cleanup')
  rmSync(path, { recursive: true, force: true })
})

/** Entity IDs of every published change of one type in the shared folder. */
function published(
  location: { folder: string; workspaceId: string },
  entityType: string
): string[] {
  const ids = scanSyncBatches(location)
    .batches.flatMap((row) => row.batch.changes)
    .filter((change) => change.entityType === entityType)
    .map((change) => change.entityId)
  return [...new Set(ids)].sort()
}
const localChanges = (db: Computer['db'], types: string[]) =>
  db
    .select()
    .from(syncChanges)
    .where(eq(syncChanges.origin, 'local'))
    .all()
    .filter((row) => types.includes(row.entityType))

function manualWork(db: Computer['db'], clientId: number, description: string) {
  const deviceId = randomUUID()
  db.insert(sourceMachines).values({ deviceId, initialName: 'Laptop' }).run()
  const row = db
    .insert(sessions)
    .values({
      source: 'manual',
      projectPath: '',
      status: 'completed',
      startedAt: '2025-01-02T10:00:00.000Z',
      endedAt: '2025-01-02T11:00:00.000Z',
      durationMinutes: 60,
      description,
      clientId
    })
    .returning()
    .get()
  db.insert(manualTimeEntries)
    .values({ id: randomUUID(), sessionId: row.id, deviceId, basis: 'created' })
    .run()
  return row
}

it('publishes no duplicate Acme from a joining computer until the user links it, then shares one identity', async () => {
  const a = computer()
  const aAcme = a.db
    .insert(clients)
    .values({ name: 'Acme', color: '#112233', billableRate: 100 })
    .returning()
    .get()
  const aSite = a.db.insert(projects).values({ clientId: aAcme.id, name: 'Site' }).returning().get()
  const created = await a.coordinator.connect({ mode: 'create', folder, reportingTimeZone: 'UTC' })
  const location = { folder, workspaceId: created.workspaceId! }

  const b = computer()
  const bAcme = b.db
    .insert(clients)
    .values({ name: 'Acme', color: '#445566', billableRate: 120 })
    .returning()
    .get()
  const bSite = b.db.insert(projects).values({ clientId: bAcme.id, name: 'Site' }).returning().get()
  const work = manualWork(b.db, bAcme.id, 'Laptop work')
  const joined = await b.coordinator.connect({
    mode: 'join',
    ...location,
    reportingTimeZone: 'UTC'
  })
  expect(joined).toMatchObject({ joinReviewRequired: true, status: 'incomplete' })
  expect(joined.issues.map((issue) => issue.code)).toContain('SYNC_JOIN_REVIEW_REQUIRED')

  // A's records were imported but not projected as twins; nothing identity-bearing left B.
  expect(
    b.db.select().from(syncChanges).where(eq(syncChanges.entityId, aAcme.syncId)).all().length
  ).toBeGreaterThan(0)
  expect(b.db.select().from(clients).all()).toMatchObject([
    { id: bAcme.id, name: 'Acme', color: '#445566' }
  ])
  expect(localChanges(b.db, ['client', 'project', 'manual-entry', 'invoice'])).toEqual([])
  expect(published(location, 'client')).toEqual([aAcme.syncId])
  expect(published(location, 'manual-entry')).toEqual([])
  expect(getPortableClientId(b.db, bAcme.id)).toBe(bAcme.syncId)
  await expect(b.coordinator.assertAvailableForBilling()).rejects.toThrow(/fully checked/)
  expect(() =>
    b.db.transaction((tx) => journalDirectoryDelete(tx, 'client', bAcme.syncId))
  ).toThrow(/Finish matching/)

  const review = b.coordinator.joinReview()
  expect(review.local.map((row) => [row.entityType, row.name])).toEqual([
    ['client', 'Acme'],
    ['project', 'Site']
  ])
  expect(review.local[0].suggestions).toEqual([aAcme.syncId])
  expect(review.local[1]).toMatchObject({
    clientLocalSyncId: bAcme.syncId,
    clientSharedId: null,
    suggestions: [aSite.syncId]
  })
  expect(review.shared.map((row) => row.entityId).sort()).toEqual(
    [aAcme.syncId, aSite.syncId].sort()
  )

  const link: FolderSyncJoinDecision[] = [
    { entityType: 'client', localSyncId: bAcme.syncId, action: 'link', sharedId: aAcme.syncId },
    { entityType: 'project', localSyncId: bSite.syncId, action: 'link', sharedId: aSite.syncId }
  ]
  await expect(
    b.coordinator.applyJoinReview({ fingerprint: 'stale', decisions: link })
  ).rejects.toThrow(/changed since/)
  await expect(
    b.coordinator.applyJoinReview({ fingerprint: review.fingerprint, decisions: [link[0]] })
  ).rejects.toThrow(/every client and project/)
  await expect(
    b.coordinator.applyJoinReview({
      fingerprint: review.fingerprint,
      decisions: [
        {
          entityType: 'client',
          localSyncId: bAcme.syncId,
          action: 'separate',
          name: 'Acme laptop'
        },
        link[1]
      ]
    })
  ).rejects.toThrow(/Link that client/)
  await expect(
    b.coordinator.applyJoinReview({
      fingerprint: review.fingerprint,
      decisions: [
        { entityType: 'client', localSyncId: bAcme.syncId, action: 'separate' },
        { entityType: 'project', localSyncId: bSite.syncId, action: 'separate' }
      ]
    })
  ).rejects.toThrow(/already has a client named "Acme"/)
  expect(b.coordinator.status().joinReviewRequired).toBe(true)
  expect(localChanges(b.db, ['client', 'project'])).toEqual([])

  const applied = await b.coordinator.applyJoinReview({
    fingerprint: review.fingerprint,
    decisions: link
  })
  expect(applied.joinReviewRequired).toBe(false)
  // Local IDs, syncIds and foreign keys are unchanged; the shared values now apply.
  expect(b.db.select().from(clients).all()).toMatchObject([
    { id: bAcme.id, syncId: bAcme.syncId, name: 'Acme', color: '#112233', billableRate: 100 }
  ])
  expect(b.db.select().from(projects).all()).toMatchObject([
    { id: bSite.id, syncId: bSite.syncId, clientId: bAcme.id }
  ])
  expect(b.db.select().from(sessions).where(eq(sessions.id, work.id)).get()).toMatchObject({
    clientId: bAcme.id
  })
  expect(getPortableClientId(b.db, bAcme.id)).toBe(aAcme.syncId)
  expect(getPortableProjectId(b.db, bSite.id)).toBe(aSite.syncId)
  expect(findClientByPortableId(b.db, aAcme.syncId)?.id).toBe(bAcme.id)

  // One Acme and one Site in the folder; B's work is in A's Acme invoice scope.
  expect(published(location, 'client')).toEqual([aAcme.syncId])
  expect(published(location, 'project')).toEqual([aSite.syncId])
  expect(published(location, 'manual-entry')).toHaveLength(1)
  await a.coordinator.syncNow()
  expect(a.db.select().from(clients).all()).toMatchObject([{ id: aAcme.id }])
  expect(
    a.db
      .select()
      .from(sessions)
      .all()
      .find((row) => row.description === 'Laptop work')
  ).toMatchObject({ clientId: aAcme.id })
  await expect(b.coordinator.assertAvailableForBilling()).resolves.toBeUndefined()
})

it('keeps a same-named client separate only under another name, rejects stale reviews, and shows both on both computers', async () => {
  const a = computer()
  const aAcme = a.db.insert(clients).values({ name: 'Acme', color: '#112233' }).returning().get()
  const location = {
    folder,
    workspaceId: (await a.coordinator.connect({ mode: 'create', folder, reportingTimeZone: 'UTC' }))
      .workspaceId!
  }
  const b = computer()
  const bAcme = b.db.insert(clients).values({ name: 'Acme', color: '#445566' }).returning().get()
  expect(
    (await b.coordinator.connect({ mode: 'join', ...location, reportingTimeZone: 'UTC' }))
      .joinReviewRequired
  ).toBe(true)

  const shown = b.coordinator.joinReview()
  // A local edit while the review is pending is kept locally, not published, and makes the review stale.
  b.db.transaction((tx) =>
    journalDirectoryEdit(tx, 'client', bAcme.syncId, () =>
      tx.update(clients).set({ email: 'laptop@example.com' }).where(eq(clients.id, bAcme.id)).run()
    )
  )
  expect(localChanges(b.db, ['client'])).toEqual([])
  const separate: FolderSyncJoinDecision[] = [
    { entityType: 'client', localSyncId: bAcme.syncId, action: 'separate', name: 'Acme (laptop)' }
  ]
  await expect(
    b.coordinator.applyJoinReview({ fingerprint: shown.fingerprint, decisions: separate })
  ).rejects.toThrow(/changed since/)

  const current = b.coordinator.joinReview()
  expect(current.local[0].values.email).toBe('laptop@example.com')
  expect(current.sharedClientNames).toContain('Acme')
  await b.coordinator.applyJoinReview({ fingerprint: current.fingerprint, decisions: separate })
  expect(getPortableClientId(b.db, bAcme.id)).toBe(bAcme.syncId)
  expect(b.db.select().from(clients).where(eq(clients.id, bAcme.id)).get()).toMatchObject({
    syncId: bAcme.syncId,
    name: 'Acme (laptop)',
    email: 'laptop@example.com'
  })
  expect(
    b.db
      .select()
      .from(clients)
      .all()
      .map((row) => row.name)
      .sort()
  ).toEqual(['Acme', 'Acme (laptop)'])
  expect(published(location, 'client')).toEqual([aAcme.syncId, bAcme.syncId].sort())

  const state = await a.coordinator.syncNow()
  expect(
    a.db
      .select()
      .from(clients)
      .all()
      .map((row) => row.name)
      .sort()
  ).toEqual(['Acme', 'Acme (laptop)'])
  expect(state.issues.filter((issue) => issue.source.startsWith('client:'))).toEqual([])
  expect(
    (await b.coordinator.syncNow()).issues.filter((issue) => issue.source.startsWith('client:'))
  ).toEqual([])
})

it('does not ask a blank computer to review anything', async () => {
  const a = computer()
  a.db.insert(clients).values({ name: 'Acme', color: '#112233' }).run()
  const location = {
    folder,
    workspaceId: (await a.coordinator.connect({ mode: 'create', folder, reportingTimeZone: 'UTC' }))
      .workspaceId!
  }
  const b = computer()
  expect(await b.coordinator.connect({ mode: 'join', ...location })).toMatchObject({
    joinReviewRequired: false,
    status: 'idle'
  })
  expect(b.db.select().from(clients).all()).toMatchObject([{ name: 'Acme' }])
  expect(b.coordinator.joinReview()).toMatchObject({ required: false, local: [] })
})

it('auto-matches unique client/project names, keeps local IDs and folders, and exports local-only projects', async () => {
  const a = computer()
  const clientA = a.db.insert(clients).values({ name: 'Acme', color: '#112233' }).returning().get()
  const projectA = a.db
    .insert(projects)
    .values({ clientId: clientA.id, name: 'Site' })
    .returning()
    .get()
  const created = await a.coordinator.connect({ mode: 'create', folder, reportingTimeZone: 'UTC' })
  const b = computer()
  const clientB = b.db.insert(clients).values({ name: 'Acme', color: '#445566' }).returning().get()
  const projectB = b.db
    .insert(projects)
    .values({ clientId: clientB.id, name: 'Site' })
    .returning()
    .get()
  const extra = b.db
    .insert(projects)
    .values({ clientId: clientB.id, name: 'Local only' })
    .returning()
    .get()
  const disk = join(root, 'site')
  mkdirSync(disk)
  setProjectFolderMapping(b.db, b.device.deviceId, projectB.syncId, disk)
  const work = manualWork(b.db, clientB.id, 'Retained work')
  await b.coordinator.connect({
    mode: 'join',
    folder,
    workspaceId: created.workspaceId!,
    reportingTimeZone: 'UTC'
  })
  const review = b.coordinator.joinReview()
  expect(
    review.local.find((row) => row.localSyncId === projectB.syncId)?.directoryPath
  ).toBeTruthy()
  const decisions = automaticJoinDecisions(review)
  expect(decisions).toContainEqual({
    entityType: 'project',
    localSyncId: extra.syncId,
    action: 'separate'
  })
  const applied = await b.coordinator.applyJoinReview({
    fingerprint: review.fingerprint,
    decisions
  })
  expect(applied.joinReviewRequired).toBe(false)
  expect(getPortableProjectId(b.db, projectB.id)).toBe(projectA.syncId)
  expect(b.db.select().from(projects).all()).toHaveLength(2)
  expect(
    getProjectFolderMapping(b.db, b.device.deviceId, projectB.syncId)?.directoryPath
  ).toBeTruthy()
  expect(b.db.select().from(sessions).where(eq(sessions.id, work.id)).get()).toMatchObject({
    clientId: clientB.id,
    durationMinutes: 60
  })
  await a.coordinator.syncNow()
  expect(
    a.db
      .select()
      .from(projects)
      .all()
      .map((row) => row.name)
      .sort()
  ).toEqual(['Local only', 'Site'])
})

it('prompts a blank computer for shared project folders and rolls back invalid folder mappings', async () => {
  const a = computer()
  const client = a.db.insert(clients).values({ name: 'Acme', color: '#112233' }).returning().get()
  const project = a.db
    .insert(projects)
    .values({ clientId: client.id, name: 'Site' })
    .returning()
    .get()
  const created = await a.coordinator.connect({ mode: 'create', folder, reportingTimeZone: 'UTC' })
  const b = computer()
  expect(
    (await b.coordinator.connect({ mode: 'join', folder, workspaceId: created.workspaceId! }))
      .joinReviewRequired
  ).toBe(true)
  const review = b.coordinator.joinReview()
  expect(review.shared.some((row) => row.entityId === project.syncId)).toBe(true)
  await expect(
    b.coordinator.applyJoinReview({
      fingerprint: review.fingerprint,
      decisions: [],
      folders: [{ sharedId: project.syncId, directoryPath: join(root, 'missing') }]
    })
  ).rejects.toThrow(/existing project folder/)
  expect(b.coordinator.status().joinReviewRequired).toBe(true)
  const disk = join(root, 'checkout')
  mkdirSync(disk)
  expect(
    (
      await b.coordinator.applyJoinReview({
        fingerprint: review.fingerprint,
        decisions: [],
        folders: [{ sharedId: project.syncId, directoryPath: disk }]
      })
    ).joinReviewRequired
  ).toBe(false)
  expect(
    getProjectFolderMapping(b.db, b.device.deviceId, project.syncId)?.directoryPath
  ).toBeTruthy()
  expect(getProjectFolderMapping(a.db, a.device.deviceId, project.syncId)).toBeNull()
})

it('does not auto-merge ambiguous project names or projects belonging to different clients', () => {
  const review = {
    workspaceId: 'w',
    required: true,
    fingerprint: '',
    sharedClientNames: [],
    local: [
      {
        entityType: 'project' as const,
        localSyncId: 'local',
        name: 'Site',
        values: {},
        suggestions: ['a', 'b'],
        clientSharedId: 'client'
      }
    ],
    shared: ['a', 'b'].map((entityId) => ({
      entityType: 'project' as const,
      entityId,
      name: 'Site',
      clientSyncId: 'client',
      clientName: 'Acme',
      values: {},
      conflicts: []
    }))
  }
  expect(automaticJoinDecisions(review)).toEqual([
    { entityType: 'project', localSyncId: 'local', action: 'separate' }
  ])
  review.shared = [{ ...review.shared[0], clientSyncId: 'other-client' }]
  expect(automaticJoinDecisions(review)[0].action).toBe('separate')
})
