import { bootstrapFolderSync } from './folder-sync-bootstrap'
import { folderSyncAdapter } from './folder-sync-domains'
import {
  assembleOutgoingBatch,
  retainIncomingBatch,
  applyReadySyncBatches
} from './folder-sync-store'
import { activeSessionCondition } from '../db/schema/session-deletions'
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { folderSyncSettings, syncChanges, syncRecordStates } from '../db/schema/folder-sync'
import { clients } from '../db/schema/clients'
import { projects } from '../db/schema/projects'
import { sessions } from '../db/schema/sessions'
import { manualTimeEntries } from '../db/schema/manual-time-entries'
import { recordLocalSyncChanges } from './folder-sync-store'
import {
  directoryRecordsAdapter,
  getDirectoryRecordView,
  planDirectoryRevision
} from './folder-sync-directory-records'
import {
  getManualEntryView,
  journalManualSyncChanges,
  planManualEntryRevision
} from './folder-sync-manual-records'
import { adoptInitialWorkspacePolicy } from './workspace-policy'
import type { JsonValue } from './folder-sync-revisions'
import {
  assertFreshSyncEdit,
  readSyncEditVersion,
  SYNC_STALE_EDIT
} from './folder-sync-edit-version'
import type { UpdateSession } from '../../shared/types/session'

let sqlite: Database.Database
let db: ReturnType<typeof drizzle>
vi.mock('../db', () => ({ getDb: () => db }))
vi.mock('./device-context', () => ({
  getLocalDeviceSession: () => ({
    deviceId: '9b95ec41-b3b6-4cbb-b1b6-e7ce607ef222',
    machineName: 'Fixture'
  })
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
const { clientProjectService } = await import('./client-project-service')
const { sessionService } = await import('./session-service')

const policy = {
  version: 1,
  normalizationVersion: 1,
  detectorVersion: 1,
  idleTimeoutMinutes: 15,
  reportingTimeZone: 'UTC'
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
})
afterEach(() => sqlite.close())

/** A retained workspace; transfer disabled (offline work is still shared later). */
function connect(enabled = 0): string {
  const workspaceId = randomUUID()
  adoptInitialWorkspacePolicy(db, { workspaceId: randomUUID(), revisionId: randomUUID(), policy })
  db.insert(folderSyncSettings)
    .values({ slot: 1, workspaceId, folderPath: 'G:\\My Drive\\ClauTime', enabled })
    .run()
  return workspaceId
}

const journalLength = (): number => db.select().from(syncChanges).all().length
const syncIdOf = (id: number): string =>
  db.select({ syncId: projects.syncId }).from(projects).where(eq(projects.id, id)).get()!.syncId

function errorCode(action: () => unknown): unknown {
  try {
    action()
  } catch (error) {
    return (error as { code?: unknown }).code
  }
  throw new Error('Expected the action to fail')
}

/** Another computer's edit arriving through the journal, superseding the heads it saw. */
function arriveProjectEdit(
  workspaceId: string,
  projectId: number,
  values: Record<string, JsonValue>
): void {
  const entityId = syncIdOf(projectId)
  const view = getDirectoryRecordView(db, workspaceId, 'project', entityId)
  const change = planDirectoryRevision(db, workspaceId, {
    id: randomUUID(),
    entityType: 'project',
    entityId,
    action: { type: 'edit', observedHeads: view.heads, values }
  })
  recordLocalSyncChanges(db, workspaceId, [change], directoryRecordsAdapter)
}

function projectFixture(): { home: number; other: number; projectId: number } {
  const home = clientProjectService.createClient({ name: 'Home client' })
  const other = clientProjectService.createClient({ name: 'Other client' })
  const project = clientProjectService.createProject({
    clientId: home.id,
    name: 'Site',
    hourlyRate: 100,
    directoryPath: 'C:\\apps\\FreshnessSite'
  })
  return { home: home.id, other: other.id, projectId: project.id }
}

describe('client/project edit freshness', () => {
  it('refuses a stale client assignment after a newer assignment arrived, leaving everything unchanged', () => {
    const workspaceId = connect()
    const { other, projectId } = projectFixture()
    const third = clientProjectService.createClient({ name: 'Third client' })
    const opened = clientProjectService.getProjectById(projectId)!
    expect(opened.syncVersion).toMatch(/^[0-9a-f]{64}$/)

    const otherSyncId = db
      .select({ syncId: clients.syncId })
      .from(clients)
      .where(eq(clients.id, other))
      .get()!.syncId
    arriveProjectEdit(workspaceId, projectId, { clientSyncId: otherSyncId })
    const arrived = clientProjectService.getProjectById(projectId)!
    expect(arrived.clientId).toBe(other)
    const recorded = journalLength()

    expect(
      errorCode(() =>
        clientProjectService.updateProject(
          projectId,
          { clientId: third.id, expectedSyncVersion: opened.syncVersion },
          { requireSyncVersion: true }
        )
      )
    ).toBe(SYNC_STALE_EDIT)
    expect(clientProjectService.getProjectById(projectId)).toEqual(arrived)
    expect(journalLength()).toBe(recorded)
  })

  it('conservatively refuses a stale edit of a different field', () => {
    const workspaceId = connect()
    const { projectId } = projectFixture()
    const opened = clientProjectService.getProjectById(projectId)!
    arriveProjectEdit(workspaceId, projectId, { name: 'Renamed elsewhere' })
    const arrived = clientProjectService.getProjectById(projectId)!

    expect(
      errorCode(() =>
        clientProjectService.updateProject(
          projectId,
          { hourlyRate: 150, expectedSyncVersion: opened.syncVersion },
          { requireSyncVersion: true }
        )
      )
    ).toBe(SYNC_STALE_EDIT)
    expect(clientProjectService.getProjectById(projectId)).toEqual(arrived)
  })

  it('accepts the unchanged version, returns the next one, and never stores the token', () => {
    connect()
    const client = clientProjectService.createClient({ name: 'Fresh' })
    const opened = clientProjectService.getClientById(client.id)!
    const recorded = journalLength()

    const saved = clientProjectService.updateClient(
      client.id,
      { billableRate: 120, expectedSyncVersion: opened.syncVersion },
      { requireSyncVersion: true }
    )
    expect(saved).toMatchObject({ billableRate: 120 })
    expect(saved.syncVersion).toBeDefined()
    expect(saved.syncVersion).not.toBe(opened.syncVersion)
    expect(journalLength()).toBe(recorded + 1)
    expect(JSON.stringify(db.select().from(syncChanges).all())).not.toContain(opened.syncVersion!)

    const again = clientProjectService.updateClient(
      client.id,
      { name: 'Fresh again', expectedSyncVersion: saved.syncVersion },
      { requireSyncVersion: true }
    )
    expect(again.name).toBe('Fresh again')
  })

  it('guards while transfer is disabled, requiring a version from user editors only', () => {
    connect(0)
    const client = clientProjectService.createClient({ name: 'Offline' })
    expect(
      errorCode(() =>
        clientProjectService.updateClient(
          client.id,
          { name: 'No version' },
          { requireSyncVersion: true }
        )
      )
    ).toBe(SYNC_STALE_EDIT)
    expect(clientProjectService.getClientById(client.id)!.name).toBe('Offline')
    // Internal automatic writes pass no version and keep working.
    expect(clientProjectService.updateClient(client.id, { name: 'Internal' }).name).toBe('Internal')
  })

  it('keeps the old behavior without a workspace connection', () => {
    const client = clientProjectService.createClient({ name: 'Local only' })
    expect(clientProjectService.getClientById(client.id)).not.toHaveProperty('syncVersion')
    expect(
      clientProjectService.updateClient(client.id, { name: 'Edited' }, { requireSyncVersion: true })
        .name
    ).toBe('Edited')
    expect(
      clientProjectService.updateClient(
        client.id,
        { name: 'Edited again', expectedSyncVersion: 'from-an-old-connection' },
        { requireSyncVersion: true }
      ).name
    ).toBe('Edited again')
    expect(journalLength()).toBe(0)
  })

  it('reads versions without bootstrapping, journaling or projecting', () => {
    const client = clientProjectService.createClient({ name: 'Pre-sync' })
    connect()
    const before = [journalLength(), db.select().from(syncRecordStates).all().length]
    const [listed] = clientProjectService.getClients()
    expect(listed.syncVersion).toBeDefined()
    expect(readSyncEditVersion(db, { kind: 'client', id: client.id })).toBe(listed.syncVersion)
    expect([journalLength(), db.select().from(syncRecordStates).all().length]).toEqual(before)
  })
})

describe('session edit freshness', () => {
  /** Mirrors the session:update handler: the check and the write share one synchronous turn. */
  function saveFromEditor(id: number, data: UpdateSession) {
    const { expectedSyncVersion, ...changes } = data
    assertFreshSyncEdit(db, { kind: 'session', id }, expectedSyncVersion, true)
    return sessionService.updateSession(id, changes)
  }

  const manual = {
    projectPath: 'C:/fixture',
    startedAt: '2026-09-26T10:00:00.000Z',
    endedAt: '2026-09-26T11:00:00.000Z',
    durationMinutes: 60,
    description: 'Opened text'
  }

  it('refuses a stale description after a newer one arrived, leaving the row unchanged', () => {
    const workspaceId = connect()
    const session = sessionService.createSession(manual)
    const opened = readSyncEditVersion(db, { kind: 'session', id: session.id })
    expect(opened).toBeDefined()

    const entryId = db
      .select()
      .from(manualTimeEntries)
      .where(eq(manualTimeEntries.sessionId, session.id))
      .get()!.id
    const view = getManualEntryView(db, workspaceId, entryId)
    journalManualSyncChanges(db, workspaceId, [
      planManualEntryRevision(db, workspaceId, {
        id: randomUUID(),
        entryId,
        action: { type: 'edit', observedHeads: view.heads, values: { description: 'Arrived text' } }
      })
    ])
    const arrived = db.select().from(sessions).where(eq(sessions.id, session.id)).get()
    const recorded = journalLength()

    expect(
      errorCode(() =>
        saveFromEditor(session.id, { description: 'Stale draft', expectedSyncVersion: opened })
      )
    ).toBe(SYNC_STALE_EDIT)
    expect(db.select().from(sessions).where(eq(sessions.id, session.id)).get()).toEqual(arrived)
    expect(journalLength()).toBe(recorded)
  })

  it('accepts the version captured when the editor opened and requires one while connected', () => {
    connect()
    const session = sessionService.createSession(manual)
    expect(errorCode(() => saveFromEditor(session.id, { billable: false }))).toBe(SYNC_STALE_EDIT)
    const opened = readSyncEditVersion(db, { kind: 'session', id: session.id })
    const saved = saveFromEditor(session.id, { billable: false, expectedSyncVersion: opened })
    expect(saved.billable).toBe(0)
    expect(readSyncEditVersion(db, { kind: 'session', id: session.id })).not.toBe(opened)
  })

  it('keeps unsynced session edits unchanged', () => {
    const session = sessionService.createSession(manual)
    expect(readSyncEditVersion(db, { kind: 'session', id: session.id })).toBeUndefined()
    expect(saveFromEditor(session.id, { description: 'Local edit' }).description).toBe('Local edit')
  })
})

it('journals service legacy edits, splits and deletion for a blank second computer', () => {
  const workspaceId = connect()
  const saved = db
    .insert(sessions)
    .values({
      projectPath: 'C:/old/project',
      source: 'auto',
      sourceFile: null,
      tool: 'claude',
      claudeSessionId: 'saved-conversation',
      startedAt: '2026-09-01T10:00:00.000Z',
      endedAt: '2026-09-01T11:00:00.000Z',
      durationMinutes: 60,
      promptCount: 8,
      inputTokens: 100,
      outputTokens: 40,
      status: 'completed',
      description: 'Original'
    })
    .returning()
    .get()
  bootstrapFolderSync(db, workspaceId)
  sessionService.updateSession(saved.id, { description: 'Portable edit', billable: false })
  const children = sessionService.splitSession(saved.id, '2026-09-01T10:30:00.000Z')
  sessionService.deleteSession(children[0].id)
  const otherSqlite = new Database(':memory:')
  try {
    const other = drizzle(otherSqlite)
    migrate(other, { migrationsFolder: join(__dirname, '../db/migrations') })
    let batch
    while (
      (batch = assembleOutgoingBatch(db, workspaceId, {
        writerEpochId: '465f4016-5aa4-4711-8ae5-95c2658b7866',
        deviceId: '9b95ec41-b3b6-4cbb-b1b6-e7ce607ef222'
      }))
    )
      retainIncomingBatch(other, workspaceId, batch, folderSyncAdapter)
    expect(applyReadySyncBatches(other, workspaceId, folderSyncAdapter)).toMatchObject({
      errors: [],
      waiting: []
    })
    const active = other.select().from(sessions).where(activeSessionCondition).all()
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({
      description: 'Portable edit',
      billable: 0,
      durationMinutes: 30,
      promptCount: 4,
      inputTokens: 50,
      outputTokens: 20
    })
    expect(other.select().from(sessions).all()).toHaveLength(3)
  } finally {
    otherSqlite.close()
  }
})

it('keeps edits to running local capture usable while folder transfer is paused', () => {
  connect()
  const row = db
    .insert(sessions)
    .values({
      projectPath: 'C:/active',
      source: 'auto',
      status: 'active',
      sourceFile: 'C:/active/log.jsonl',
      tool: 'claude',
      claudeSessionId: 'running-conversation',
      startedAt: '2026-09-01T10:00:00.000Z',
      endedAt: '2026-09-01T10:01:00.000Z',
      durationMinutes: 1,
      billable: 1
    })
    .returning()
    .get()
  expect(sessionService.updateSession(row.id, { billable: false })).toMatchObject({
    billable: 0,
    status: 'active'
  })
  expect(
    db
      .select()
      .from(syncChanges)
      .all()
      .some(
        (change) => change.entityType === 'legacy-session' || change.entityType === 'session-edit'
      )
  ).toBe(false)
})
