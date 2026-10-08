import { activityIdentities, activityObservations } from '../db/schema/activity-evidence'
import { manualTimeEntries } from '../db/schema/manual-time-entries'
import { sessions } from '../db/schema/sessions'
import { sourceMachines } from '../db/schema/activity-observers'
import { cpSync, statSync, readdirSync, readFileSync } from 'node:fs'
// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep, dirname } from 'node:path'
import { createFolderSyncCoordinator } from './folder-sync-coordinator'
import { getWorkspacePolicy } from './workspace-policy'
import { listSyncSnapshots } from './folder-sync-snapshots'
import { scanSyncBatches } from './folder-sync-files'
import { encodeSyncBatch } from './folder-sync-protocol'
import { clients } from '../db/schema/clients'
import { projects } from '../db/schema/projects'
import { syncChanges } from '../db/schema/folder-sync'
import { planDirectoryExport, directoryRecordsAdapter } from './folder-sync-directory-records'
import { recordLocalSyncChanges } from './folder-sync-store'
import { automaticJoinDecisions } from '../../shared/folder-sync-matching'
import type { FolderSyncIssue } from '../../shared/types/folder-sync'

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
  const project = vi.fn(
    (
      _db: typeof db,
      _workspaceId: string,
      _yieldControl: () => Promise<void>
    ): FolderSyncIssue[] | Promise<FolderSyncIssue[]> => []
  )
  const coordinator = createFolderSyncCoordinator({
    db: () => db,
    device: () => device,
    localDataDirectory: join(root, 'local-data'),
    project
  })
  return { db, coordinator, project }
}

it('yields outside transactions and pauses an unfinished connect without losing its connection', async () => {
  const a = computer()
  const connecting = a.coordinator.connect({ mode: 'create', folder, reportingTimeZone: 'UTC' })
  const cancelled = expect(connecting).rejects.toMatchObject({ code: 'SYNC_CANCELLED' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(a.db.$client.inTransaction).toBe(false)
  expect(a.coordinator.status().progress).toBeDefined()
  const paused = await a.coordinator.setEnabled(false)
  await cancelled
  expect(paused).toMatchObject({ connected: true, enabled: false, status: 'disabled' })
  expect(a.db.$client.inTransaction).toBe(false)
  const resumed = await a.coordinator.setEnabled(true)
  expect(resumed.status).toBe('idle')
  expect(resumed.progress).toBeUndefined()
})
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clautime-coordinator-'))
  folder = join(root, 'shared')
  mkdirSync(folder)
})
afterEach(() => {
  handles.splice(0).forEach((db) => db.close())
  const path = resolve(root)
  if (!path.startsWith(resolve(tmpdir()) + sep) || !path.includes('clautime-coordinator-'))
    throw new Error('Unsafe test cleanup')
  rmSync(path, { recursive: true, force: true })
})

it('creates a shared history and restores its policy from a snapshot without original batches', async () => {
  const a = computer()
  expect(a.coordinator.status().connected).toBe(false)
  const created = await a.coordinator.connect({
    mode: 'create',
    folder,
    name: 'My history',
    reportingTimeZone: 'America/New_York'
  })
  expect(created.status).toBe('idle')
  const location = { folder, workspaceId: created.workspaceId! }
  expect(listSyncSnapshots(location).snapshots).toHaveLength(1)
  const writers = resolve(join(folder, created.workspaceId!, 'writers'))
  if (!writers.startsWith(resolve(folder) + sep)) throw new Error('Unsafe fixture cleanup')
  rmSync(writers, { recursive: true })
  const b = computer()
  const joined = await b.coordinator.connect({ mode: 'join', ...location })
  expect(joined.status).toBe('idle')
  expect(getWorkspacePolicy(b.db)?.policy.reportingTimeZone).toBe('America/New_York')
  expect(scanSyncBatches(location).batches).toHaveLength(1)
  const count = b.db.select().from(syncChanges).all().length
  expect((await b.coordinator.syncNow()).status).toBe('idle')
  expect(b.db.select().from(syncChanges).all()).toHaveLength(count)
})

it('preserves offline work while paused and publishes it when enabled again', async () => {
  const a = computer()
  const created = await a.coordinator.connect({ mode: 'create', folder, reportingTimeZone: 'UTC' })
  const location = { folder, workspaceId: created.workspaceId! }
  await a.coordinator.setEnabled(false)
  a.db.insert(clients).values({ name: 'Offline client', color: '#123456' }).run()
  recordLocalSyncChanges(
    a.db,
    location.workspaceId,
    planDirectoryExport(a.db, location.workspaceId).changes,
    directoryRecordsAdapter
  )
  expect(await a.coordinator.syncNow()).toMatchObject({ status: 'disabled', pending: 1 })
  expect(scanSyncBatches(location).batches).toHaveLength(1)
  expect(await a.coordinator.setEnabled(true)).toMatchObject({ status: 'idle', pending: 0 })
  const b = computer()
  expect((await b.coordinator.connect({ mode: 'join', ...location })).status).toBe('idle')
  expect(b.db.select().from(clients).all()).toMatchObject([{ name: 'Offline client' }])
})

it('refuses a sync folder containing the live local data directory', async () => {
  const a = computer()
  await expect(a.coordinator.connect({ mode: 'create', folder: root })).rejects.toThrow(
    /live database/
  )
  expect(a.coordinator.status().connected).toBe(false)
})

it('holds conflicting complete batch copies even when a snapshot has an original', async () => {
  const a = computer()
  const created = await a.coordinator.connect({ mode: 'create', folder, reportingTimeZone: 'UTC' })
  const location = { folder, workspaceId: created.workspaceId! }
  const original = scanSyncBatches(location).batches[0]
  const batch = structuredClone(original.batch)
  const policy = batch.changes.find((change) => change.entityType === 'workspace-policy')!
  ;(
    policy.payload.fields as unknown as { policy: { value: { idleTimeoutMinutes: number } } }
  ).policy.value.idleTimeoutMinutes = 30
  const { protocol: _protocol, checksum: _checksum, ...input } = batch
  writeFileSync(
    join(
      dirname(original.paths[0]),
      `${batch.sequence}-${batch.batchId}-recovery-${randomUUID()}.json.gz`
    ),
    encodeSyncBatch(input).bytes
  )
  const b = computer()
  const state = await b.coordinator.connect({ mode: 'join', ...location })
  expect(state.status, JSON.stringify(state)).toBe('incomplete')
  expect(getWorkspacePolicy(b.db)).toBeNull()
  expect(state.issues.some((issue) => issue.code.includes('CONFLICT'))).toBe(true)
})

it('measures retained-history export, blank restore, idle scan and folder growth', async () => {
  const a = computer()
  const deviceId = randomUUID()
  a.db.insert(sourceMachines).values({ deviceId, initialName: 'QA computer' }).run()
  a.db.transaction((tx) => {
    for (let i = 0; i < Math.min(10000, Number(process.env.QA_SYNC_SESSION_COUNT) || 500); i++) {
      const startedAt = new Date(Date.UTC(2025, 0, 1, i)).toISOString()
      const endedAt = new Date(Date.UTC(2025, 0, 1, i, 30)).toISOString()
      const row = tx
        .insert(sessions)
        .values({
          source: 'manual',
          projectPath: '',
          status: 'completed',
          startedAt,
          endedAt,
          durationMinutes: 30,
          description: `Saved entry ${i}`
        })
        .returning()
        .get()
      tx.insert(manualTimeEntries)
        .values({ id: randomUUID(), sessionId: row.id, deviceId, basis: 'created' })
        .run()
    }
  })
  const exportStart = performance.now()
  const created = await a.coordinator.connect({ mode: 'create', folder, reportingTimeZone: 'UTC' })
  const exportMs = performance.now() - exportStart
  expect(created.status, JSON.stringify(created)).toBe('idle')
  const b = computer()
  const restoreStart = performance.now()
  const restored = await b.coordinator.connect({
    mode: 'join',
    folder,
    workspaceId: created.workspaceId!
  })
  const restoreMs = performance.now() - restoreStart
  expect(restored.status, JSON.stringify(restored)).toBe('idle')
  expect(b.db.select().from(sessions).all()).toHaveLength(
    Math.min(10000, Number(process.env.QA_SYNC_SESSION_COUNT) || 500)
  )
  // Settle provenance/bootstrap once after restoration before measuring an unchanged pass.
  expect((await b.coordinator.syncNow()).status).toBe('idle')
  const idleStart = performance.now()
  expect((await b.coordinator.syncNow()).status).toBe('idle')
  const idleMs = performance.now() - idleStart
  function size(path: string): number {
    return readdirSync(path, { withFileTypes: true }).reduce(
      (total, entry) =>
        total +
        (entry.isDirectory()
          ? size(join(path, entry.name))
          : statSync(join(path, entry.name)).size),
      0
    )
  }
  const bytes = size(folder)
  writeFileSync(
    join(
      process.cwd(),
      'review-notes',
      `fs07-history-performance-${Math.min(10000, Number(process.env.QA_SYNC_SESSION_COUNT) || 500)}.json`
    ),
    JSON.stringify(
      {
        sessions: Math.min(10000, Number(process.env.QA_SYNC_SESSION_COUNT) || 500),
        exportMs,
        restoreMs,
        idleMs,
        folderBytes: bytes
      },
      null,
      2
    )
  )
  const count = b.db.select().from(syncChanges).all().length
  expect((await b.coordinator.syncNow()).pending).toBe(0)
  expect(b.db.select().from(syncChanges).all()).toHaveLength(count)
  expect(size(folder)).toBe(bytes)
}, 120_000)

it('requires transfers before provider writes and checks retained folder delivery', async () => {
  const a = computer()
  await a.coordinator.connect({ mode: 'create', folder, reportingTimeZone: 'UTC' })
  await expect(a.coordinator.assertAvailableForBilling()).resolves.toBeUndefined()
  await a.coordinator.setEnabled(false)
  await expect(a.coordinator.assertAvailableForBilling()).rejects.toThrow(/Resume shared history/)
  await a.coordinator.setEnabled(true)
  const path = resolve(folder)
  if (!path.startsWith(resolve(root) + sep)) throw new Error('Unsafe fixture cleanup')
  rmSync(path, { recursive: true })
  await expect(a.coordinator.assertAvailableForBilling()).rejects.toThrow(/delivery issues/)
})

it('imports independent remote changes despite an unsupported retained local capture', async () => {
  const a = computer()
  const created = await a.coordinator.connect({ mode: 'create', folder, reportingTimeZone: 'UTC' })
  const b = computer()
  await b.coordinator.connect({ mode: 'join', folder, workspaceId: created.workspaceId! })
  b.db
    .insert(activityIdentities)
    .values({
      eventId: 'unsupported-local-event',
      provider: 'claude',
      identityVersion: 999,
      conversationId: 'saved-future-format',
      basis: 'native',
      nativeEventId: 'event'
    })
    .run()
  b.db
    .insert(activityObservations)
    .values({
      id: 'unsupported-local-observation',
      eventId: 'unsupported-local-event',
      version: 999,
      kind: 'message',
      payloadJson: '{}',
      createdAt: new Date().toISOString()
    })
    .run()
  a.db.insert(clients).values({ name: 'Arrives independently', color: '#123456' }).run()
  await a.coordinator.syncNow()
  const state = await b.coordinator.syncNow()
  expect(state.status).toBe('incomplete')
  expect(state.issues.some((issue) => issue.code === 'SYNC_LOCAL_ACTIVITY_WITHHELD')).toBe(true)
  expect(b.db.select().from(clients).all()).toMatchObject([{ name: 'Arrives independently' }])
  expect(b.db.select().from(activityObservations).all()).toHaveLength(1)
  await expect(b.coordinator.assertAvailableForBilling()).rejects.toThrow(/delivery issues/)
})

it('skips unchanged projections but observes subsequent local writes', async () => {
  const a = computer()
  await a.coordinator.connect({ mode: 'create', folder, reportingTimeZone: 'UTC' })
  await a.coordinator.syncNow()
  await a.coordinator.syncNow()
  a.project.mockClear()
  expect((await a.coordinator.syncNow()).status).toBe('idle')
  expect(a.project).not.toHaveBeenCalled()
  a.db.insert(clients).values({ name: 'New local work', color: '#123456' }).run()
  expect((await a.coordinator.syncNow()).status).toBe('idle')
  expect(a.project).toHaveBeenCalledTimes(1)
})

it('does not repeat full bootstrap immediately after a long successful initial pass', async () => {
  const a = computer()
  let now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  try {
    a.project.mockImplementationOnce(() => {
      now += 6 * 60_000
      return []
    })
    expect(
      (await a.coordinator.connect({ mode: 'create', folder, reportingTimeZone: 'UTC' })).status
    ).toBe('idle')
    a.project.mockClear()
    expect((await a.coordinator.syncNow()).status).toBe('idle')
    expect(a.project).not.toHaveBeenCalled()
    now += 5 * 60_000
    await a.coordinator.syncNow()
    expect(a.project).toHaveBeenCalledOnce()
  } finally {
    clock.mockRestore()
  }
})

it('rechecks directory edits that arrive during a yield before their journal baseline exists', async () => {
  const a = computer()
  await a.coordinator.connect({ mode: 'create', folder, reportingTimeZone: 'UTC' })
  a.db.insert(clients).values({ name: 'Before the pass', color: '#123456' }).run()
  a.project.mockImplementationOnce(async (_db, _workspaceId, yieldControl) => {
    setImmediate(() =>
      a.db.insert(clients).values({ name: 'During the pass', color: '#123456' }).run()
    )
    await yieldControl()
    return []
  })
  await a.coordinator.syncNow()
  a.project.mockClear()
  await a.coordinator.syncNow()
  expect(a.project).toHaveBeenCalledOnce()
  const changes = a.db.select().from(syncChanges).where(eq(syncChanges.entityType, 'client')).all()
  expect(changes.some((row) => row.changeJson.includes('During the pass'))).toBe(true)
})

it('continues ordinary batch delivery when a snapshot chunk has not arrived', async () => {
  const a = computer()
  a.db.insert(clients).values({ name: 'Available from batches', color: '#123456' }).run()
  const workspaceId = (
    await a.coordinator.connect({
      mode: 'create',
      folder,
      reportingTimeZone: 'UTC'
    })
  ).workspaceId!
  const location = { folder, workspaceId }
  const snapshot = listSyncSnapshots(location).snapshots[0]
  const chunk = resolve(
    join(folder, workspaceId, 'snapshots', snapshot.snapshotId, 'chunk-000000.json.gz')
  )
  if (!chunk.startsWith(resolve(folder) + sep)) throw new Error('Unsafe fixture path')
  const bytes = readFileSync(chunk)
  rmSync(chunk)
  const b = computer()
  const state = await b.coordinator.connect({ mode: 'join', ...location })
  expect(state.status).toBe('incomplete')
  expect(state.issues.some((issue) => issue.source.startsWith('snapshot:'))).toBe(true)
  expect(state.joinReviewRequired).toBe(true)
  expect(state.joinReviewReady).toBe(false)
  expect(b.coordinator.joinReview().shared).toContainEqual(
    expect.objectContaining({ name: 'Available from batches' })
  )
  await expect(b.coordinator.assertAvailableForBilling()).rejects.toThrow()
  writeFileSync(chunk, bytes)
  expect((await b.coordinator.syncNow()).status).toBe('idle')
  await expect(b.coordinator.assertAvailableForBilling()).resolves.toBeUndefined()
})

it.each([false, true])(
  'waits for a complete initial snapshot (local clients: %s)',
  async (hasLocal) => {
    const a = computer()
    a.db.insert(clients).values({ name: 'Acme', color: '#123456' }).run()
    const workspaceId = (await a.coordinator.connect({ mode: 'create', folder })).workspaceId!
    const target = join(root, 'delayed')
    mkdirSync(join(target, workspaceId), { recursive: true })
    for (const item of readdirSync(join(folder, workspaceId), { withFileTypes: true }))
      if (item.isFile())
        cpSync(join(folder, workspaceId, item.name), join(target, workspaceId, item.name))
    const b = computer()
    if (hasLocal) b.db.insert(clients).values({ name: 'Acme', color: '#123456' }).run()
    const joined = await b.coordinator.connect({ mode: 'join', folder: target, workspaceId })
    expect(joined).toMatchObject({ joinReviewReady: false, joinReviewRequired: true })
    const premature = b.coordinator.joinReview()
    await expect(
      b.coordinator.applyJoinReview({
        fingerprint: premature.fingerprint,
        decisions: automaticJoinDecisions(premature)
      })
    ).rejects.toThrow(/shared history.*loading/i)
    expect(scanSyncBatches({ folder: target, workspaceId }).batches).toHaveLength(0)
    // Even complete ordinary batches alone do not prove the initial catalog arrived.
    cpSync(join(folder, workspaceId, 'writers'), join(target, workspaceId, 'writers'), {
      recursive: true
    })
    expect(await b.coordinator.syncNow()).toMatchObject({
      joinReviewReady: false,
      joinReviewRequired: true
    })
    cpSync(join(folder, workspaceId, 'snapshots'), join(target, workspaceId, 'snapshots'), {
      recursive: true
    })
    const loaded = await b.coordinator.syncNow()
    if (hasLocal) {
      expect(loaded.joinReviewReady).toBe(true)
      const review = b.coordinator.joinReview()
      await b.coordinator.applyJoinReview({
        fingerprint: review.fingerprint,
        decisions: automaticJoinDecisions(review)
      })
    }
    expect(b.coordinator.status().joinReviewRequired).toBe(false)
    expect(b.db.select().from(clients).all()).toHaveLength(1)
    const identities = new Set(
      scanSyncBatches({ folder: target, workspaceId })
        .batches.flatMap((row) => row.batch.changes)
        .filter((row) => row.entityType === 'client')
        .map((row) => row.entityId)
    )
    expect(identities.size).toBe(1)
  }
)

it('rechecks delivery before applying a previously ready review', async () => {
  const a = computer()
  a.db.insert(clients).values({ name: 'Acme', color: '#123456' }).run()
  const workspaceId = (await a.coordinator.connect({ mode: 'create', folder })).workspaceId!
  const b = computer()
  b.db.insert(clients).values({ name: 'Acme', color: '#123456' }).run()
  expect((await b.coordinator.connect({ mode: 'join', folder, workspaceId })).joinReviewReady).toBe(
    true
  )
  const review = b.coordinator.joinReview()
  const snapshot = listSyncSnapshots({ folder, workspaceId }).snapshots[0]
  const chunk = resolve(
    folder,
    workspaceId,
    'snapshots',
    snapshot.snapshotId,
    'chunk-000000.json.gz'
  )
  if (!chunk.startsWith(resolve(root) + sep)) throw new Error('Unsafe fixture path')
  const bytes = readFileSync(chunk)
  rmSync(chunk)
  await expect(
    b.coordinator.applyJoinReview({
      fingerprint: review.fingerprint,
      decisions: automaticJoinDecisions(review)
    })
  ).rejects.toThrow(/shared history.*loading/i)
  expect(b.coordinator.status().joinReviewRequired).toBe(true)
  writeFileSync(chunk, bytes)
  expect(
    (
      await b.coordinator.applyJoinReview({
        fingerprint: review.fingerprint,
        decisions: automaticJoinDecisions(review)
      })
    ).joinReviewRequired
  ).toBe(false)
})

it('refuses creation when a history arrived after discovery', async () => {
  const b = computer()
  expect(b.coordinator.discover(folder).workspaces).toHaveLength(0)
  const a = computer()
  const workspaceId = (await a.coordinator.connect({ mode: 'create', folder })).workspaceId!
  await expect(b.coordinator.connect({ mode: 'create', folder })).rejects.toThrow(
    /history.*arrived/i
  )
  expect(b.coordinator.status().connected).toBe(false)
  expect(b.coordinator.discover(folder).workspaces.map((row) => row.workspaceId)).toEqual([
    workspaceId
  ])
})

it('publishes a complete initial snapshot despite unrelated history review items', async () => {
  const a = computer()
  a.db.insert(clients).values({ name: 'Acme', color: '#123456' }).run()
  a.project.mockReturnValue([
    { source: 'history', code: 'SYNC_LEGACY_REVIEW_REQUIRED', message: 'Review old activity.' }
  ])
  const created = await a.coordinator.connect({ mode: 'create', folder })
  expect(created.status).toBe('incomplete')
  expect(created.issues.some((row) => row.code === 'SYNC_LEGACY_REVIEW_REQUIRED')).toBe(true)
  expect(listSyncSnapshots({ folder, workspaceId: created.workspaceId! }).snapshots).toHaveLength(1)
  const b = computer()
  expect(
    (await b.coordinator.connect({ mode: 'join', folder, workspaceId: created.workspaceId! }))
      .joinReviewRequired
  ).toBe(false)
  expect(b.db.select().from(clients).all()).toMatchObject([{ name: 'Acme' }])
})

it('snapshots valid shared records even when an invalid local activity row is withheld', async () => {
  const a = computer()
  a.db.insert(clients).values({ name: 'Acme', color: '#123456' }).run()
  a.db
    .insert(activityIdentities)
    .values({
      eventId: 'future-local-event',
      provider: 'claude',
      identityVersion: 999,
      conversationId: 'future-capture',
      basis: 'native',
      nativeEventId: 'event'
    })
    .run()
  a.db
    .insert(activityObservations)
    .values({
      id: 'future-local-observation',
      eventId: 'future-local-event',
      version: 999,
      kind: 'message',
      payloadJson: '{}',
      createdAt: new Date().toISOString()
    })
    .run()
  const created = await a.coordinator.connect({ mode: 'create', folder })
  expect(created.issues.some((row) => row.code === 'SYNC_LOCAL_ACTIVITY_WITHHELD')).toBe(true)
  expect(listSyncSnapshots({ folder, workspaceId: created.workspaceId! }).snapshots).toHaveLength(1)
  await expect(a.coordinator.assertAvailableForBilling()).rejects.toThrow(/delivery issues/)
  const b = computer()
  expect(
    (await b.coordinator.connect({ mode: 'join', folder, workspaceId: created.workspaceId! }))
      .joinReviewRequired
  ).toBe(false)
  expect(b.db.select().from(clients).all()).toMatchObject([{ name: 'Acme' }])
})

it.each(['client', 'project'])(
  'holds the setup snapshot until an invalid %s is repaired, then joins without duplicates',
  async (invalidType) => {
    const a = computer()
    const clientA = a.db
      .insert(clients)
      .values({ name: 'Acme', color: invalidType === 'client' ? 'red' : '#123456' })
      .returning()
      .get()
    const projectA = a.db
      .insert(projects)
      .values({
        clientId: clientA.id,
        name: 'Site',
        hourlyRate: invalidType === 'project' ? -1 : 100
      })
      .returning()
      .get()
    const created = await a.coordinator.connect({ mode: 'create', folder })
    const location = { folder, workspaceId: created.workspaceId! }
    expect(created.issues.some((row) => row.code === 'SYNC_DIRECTORY_INVALID')).toBe(true)
    expect(listSyncSnapshots(location).snapshots).toHaveLength(0)
    // Valid records still transfer as ordinary batches while the source reports the bad row.
    expect(scanSyncBatches(location).batches.length).toBeGreaterThan(0)
    const b = computer()
    const clientB = b.db
      .insert(clients)
      .values({ name: 'Acme', color: '#123456' })
      .returning()
      .get()
    b.db.insert(projects).values({ clientId: clientB.id, name: 'Site', hourlyRate: 100 }).run()
    expect(await b.coordinator.connect({ mode: 'join', ...location })).toMatchObject({
      joinReviewRequired: true,
      joinReviewReady: false
    })
    const premature = b.coordinator.joinReview()
    await expect(
      b.coordinator.applyJoinReview({
        fingerprint: premature.fingerprint,
        decisions: automaticJoinDecisions(premature)
      })
    ).rejects.toThrow(/still loading/)
    a.db.update(clients).set({ color: '#123456' }).where(eq(clients.id, clientA.id)).run()
    a.db.update(projects).set({ hourlyRate: 100 }).where(eq(projects.id, projectA.id)).run()
    await a.coordinator.syncNow()
    expect(listSyncSnapshots(location).snapshots).toHaveLength(1)
    expect((await b.coordinator.syncNow()).joinReviewReady).toBe(true)
    const review = b.coordinator.joinReview()
    await b.coordinator.applyJoinReview({
      fingerprint: review.fingerprint,
      decisions: automaticJoinDecisions(review)
    })
    await a.coordinator.syncNow()
    for (const computer of [a, b]) {
      expect(computer.db.select().from(clients).all()).toHaveLength(1)
      expect(computer.db.select().from(projects).all()).toHaveLength(1)
    }
    const changes = scanSyncBatches(location).batches.flatMap((row) => row.batch.changes)
    for (const entityType of ['client', 'project'])
      expect(
        new Set(changes.filter((row) => row.entityType === entityType).map((row) => row.entityId))
          .size
      ).toBe(1)
  }
)

it('keeps identity matching pending while transfers are paused', async () => {
  const a = computer()
  a.db.insert(clients).values({ name: 'Acme', color: '#123456' }).run()
  const workspaceId = (await a.coordinator.connect({ mode: 'create', folder })).workspaceId!
  const b = computer()
  b.db.insert(clients).values({ name: 'Acme', color: '#123456' }).run()
  await b.coordinator.connect({ mode: 'join', folder, workspaceId })
  const review = b.coordinator.joinReview()
  expect((await b.coordinator.setEnabled(false)).joinReviewReady).toBe(false)
  await expect(
    b.coordinator.applyJoinReview({
      fingerprint: review.fingerprint,
      decisions: automaticJoinDecisions(review)
    })
  ).rejects.toThrow(/shared history.*loading/i)
  expect(b.coordinator.status().joinReviewRequired).toBe(true)
  await b.coordinator.setEnabled(true)
  expect(
    (
      await b.coordinator.applyJoinReview({
        fingerprint: review.fingerprint,
        decisions: automaticJoinDecisions(review)
      })
    ).joinReviewRequired
  ).toBe(false)
})
