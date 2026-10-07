import { randomUUID } from 'node:crypto'
// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { projects } from '../db/schema/projects'
import { sessions } from '../db/schema/sessions'
import { gitCommits } from '../db/schema/git-commits'
import { projectAlertConfig } from '../db/schema/project-alert-config'
import { invoices, invoiceLineItems } from '../db/schema/invoices'
import { getProjectFolderMapping, setProjectFolderMapping } from './project-folder-mappings'
import {
  getLocalProjectSetupStatus,
  completeLocalProjectSetup,
  initializeEmptyLocalProjectSetup
} from './local-project-setup'

let sqlite: Database.Database
let db: ReturnType<typeof drizzle>
const deviceA = '9b95ec41-b3b6-4cbb-b1b6-e7ce607ef222'
const deviceB = '7c8f7eab-af58-4cbb-9e74-d1e47f80d600'
let deviceId = deviceA
const migrationsFolder = join(__dirname, '../db/migrations')
vi.mock('../db', () => ({ getDb: () => db }))
vi.mock('./device-context', () => ({
  getLocalDeviceSession: () => ({ deviceId, machineName: 'Fixture' })
}))
vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
vi.mock('electron', () => ({ Notification: vi.fn(), shell: {} }))
vi.mock('./widget-service', () => ({ widgetService: {} }))
import { clientProjectService } from './client-project-service'
import { gitService } from './git-service'
import { liveMonitorService } from './live-monitor-service'
import { encodeProjectPath } from './session-detector'
import { setMarkedFolderListener } from './project-folder-marker'
import { readRootCommit, resetRootCommitCaches } from './project-root-commit'
import type { MarkedFolderEvent } from '../../shared/types/client-project'

beforeEach(() => {
  deviceId = deviceA
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder })
})
afterEach(() => {
  sqlite.close()
  vi.restoreAllMocks()
})

function legacyProject(name = 'Saved', directoryPath: string | null = 'C:/original') {
  const client = sqlite
    .prepare(
      'INSERT INTO clients (name, color, sync_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id'
    )
    .get(name, 'red', randomUUID(), new Date().toISOString(), new Date().toISOString()) as {
    id: number
  }
  // Raw SQL: only columns that exist before every migration these tests replay.
  const now = new Date().toISOString()
  return sqlite
    .prepare(
      `INSERT INTO projects (client_id, name, directory_path, hourly_rate, sync_id, created_at, updated_at)
       VALUES (?, ?, ?, 150, ?, ?, ?)
       RETURNING id, sync_id AS syncId, client_id AS clientId, name, directory_path AS directoryPath`
    )
    .get(client.id, name, directoryPath, randomUUID(), now, now) as {
    id: number
    syncId: string
    clientId: number
    name: string
    directoryPath: string | null
  }
}
function savedSession(project: ReturnType<typeof legacyProject>) {
  return db
    .insert(sessions)
    .values({
      projectId: project.id,
      clientId: project.clientId,
      projectPath: project.directoryPath!,
      startedAt: '2026-09-25T10:00:00Z',
      endedAt: '2026-09-25T11:00:00Z',
      durationMinutes: 60,
      description: 'Saved work'
    })
    .returning()
    .get()
}
function select(project: ReturnType<typeof legacyProject>) {
  return { projectSyncId: project.syncId, directoryPath: project.directoryPath! }
}

it('requires explicit folder selection and does not treat legacy paths as local scanner targets', () => {
  const first = legacyProject()
  initializeEmptyLocalProjectSetup()
  expect(getLocalProjectSetupStatus().complete).toBe(false)
  const second = legacyProject('Remote', 'D:/other-computer')
  savedSession(first)
  expect(clientProjectService.getLocalProjects()).toEqual([])
  expect(clientProjectService.findProjectByDirectory(first.directoryPath!)).toBeNull()
  expect(clientProjectService.autoCreateProject('C:/discovered')).toBeNull()
  expect(getLocalProjectSetupStatus().candidates).toHaveLength(2)
  const history = db.select().from(sessions).all()
  completeLocalProjectSetup([select(first)])
  expect(getLocalProjectSetupStatus()).toMatchObject({ complete: true, candidates: [] })
  expect(clientProjectService.getProjectById(first.id)?.directoryPath).toBe('C:\\original')
  expect(clientProjectService.getProjectById(second.id)?.directoryPath).toBeNull()
  expect(clientProjectService.autoCreateProject('C:/discovered')).not.toBeNull()
  expect(db.select().from(sessions).all()).toEqual(history)
  clientProjectService.updateProject(first.id, { directoryPath: null })
  expect(() => completeLocalProjectSetup([select(first)])).toThrow('already complete')
  expect(clientProjectService.getProjectById(first.id)?.directoryPath).toBeNull()
})

it('keeps ordinary local discovery automatic for a blank installation without enabling sync', () => {
  initializeEmptyLocalProjectSetup()
  expect(getLocalProjectSetupStatus().complete).toBe(true)
  const project = clientProjectService.autoCreateProject('C:/new-local-repo')
  expect(project?.directoryPath).toBe('C:\\new-local-repo')
  initializeEmptyLocalProjectSetup()
  expect(clientProjectService.getProjects()).toHaveLength(1)
})

it('remembers declined folders while allowing new discovery and explicit linking', () => {
  const project = legacyProject()
  legacyProject('Invalid legacy path', 'relative/unknown')
  completeLocalProjectSetup([])
  expect(clientProjectService.autoCreateProject('c:/ORIGINAL/')).toBeNull()
  expect(clientProjectService.autoCreateProject('C:/original/.claude/worktrees/task')).toBeNull()
  expect(clientProjectService.getProjectById(project.id)?.directoryPath).toBeNull()
  expect(clientProjectService.autoCreateProject('C:/new-repository')).not.toBeNull()
  clientProjectService.updateProject(project.id, { directoryPath: 'C:/original' })
  expect(clientProjectService.findProjectByDirectory('c:/ORIGINAL')?.id).toBe(project.id)
})

it('remembers disconnected folders after reopening without affecting another computer', () => {
  initializeEmptyLocalProjectSetup()
  const project = clientProjectService.autoCreateProject('C:/local')!
  clientProjectService.updateProject(project.id, { directoryPath: null })
  const copy = sqlite.serialize()
  sqlite.close()
  sqlite = new Database(copy)
  db = drizzle(sqlite)
  expect(clientProjectService.autoCreateProject('c:/LOCAL/')).toBeNull()
  deviceId = deviceB
  completeLocalProjectSetup([])
  expect(clientProjectService.autoCreateProject('C:/local')).not.toBeNull()
  deviceId = deviceA
  expect(clientProjectService.autoCreateProject('C:/local')).toBeNull()
  clientProjectService.updateProject(project.id, { directoryPath: 'C:/local' })
  expect(clientProjectService.findProjectByDirectory('C:/local')?.id).toBe(project.id)
  clientProjectService.updateProject(project.id, { directoryPath: null })
  expect(clientProjectService.autoCreateProject('C:/local')).toBeNull()
})

it('keeps setup atomic when saving the completion marker fails after folder choices', () => {
  const selected = legacyProject('Selected', 'C:/selected')
  legacyProject('Declined', 'C:/declined')
  sqlite.exec(`CREATE TRIGGER fail_setup BEFORE INSERT ON local_project_setup
    BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`)
  expect(() => completeLocalProjectSetup([select(selected)])).toThrow('fixture failure')
  expect(getLocalProjectSetupStatus().complete).toBe(false)
  expect(clientProjectService.getLocalProjects()).toEqual([])
  expect(sqlite.prepare('SELECT * FROM local_folder_discovery_blocks').all()).toEqual([])
  sqlite.exec('DROP TRIGGER fail_setup')
  completeLocalProjectSetup([select(selected)])
  expect(clientProjectService.findProjectByDirectory('C:/selected')?.id).toBe(selected.id)
  expect(clientProjectService.autoCreateProject('C:/declined')).toBeNull()
})

it('allows a selected folder alias without claiming the unselected project identity', () => {
  const selected = legacyProject()
  const declined = legacyProject('Alias', 'c:/ORIGINAL/')
  completeLocalProjectSetup([select(selected)])
  expect(clientProjectService.findProjectByDirectory('c:/ORIGINAL')?.id).toBe(selected.id)
  expect(clientProjectService.getProjectById(declined.id)?.directoryPath).toBeNull()
  expect(sqlite.prepare('SELECT * FROM local_folder_discovery_blocks').all()).toEqual([])
})

it('rejects setup conflicts and stale selections without marking setup complete or partially mapping folders', () => {
  const first = legacyProject()
  const second = legacyProject('Alias', 'c:/ORIGINAL/')
  expect(() => completeLocalProjectSetup([select(first), select(second)])).toThrow('already linked')
  expect(getLocalProjectSetupStatus().complete).toBe(false)
  expect(clientProjectService.getLocalProjects()).toEqual([])
  db.update(projects).set({ directoryPath: 'D:/changed' }).where(eq(projects.id, first.id)).run()
  expect(() => completeLocalProjectSetup([select(first)])).toThrow('changed')
  expect(getLocalProjectSetupStatus().complete).toBe(false)
  completeLocalProjectSetup([])
  expect(getLocalProjectSetupStatus().complete).toBe(true)
})

it('preserves saved work, invoices and other device mappings across move, unlink and path reuse', () => {
  const project = legacyProject()
  const session = savedSession(project)
  const invoice = db
    .insert(invoices)
    .values({ clientId: project.clientId, stripeInvoiceId: 'in_fixture', amountDueCents: 15000 })
    .returning()
    .get()
  db.insert(invoiceLineItems)
    .values({
      invoiceId: invoice.id,
      description: 'Saved invoice',
      amountCents: 15000,
      sessionIds: String(session.id)
    })
    .run()
  completeLocalProjectSetup([select(project)])
  const other = setProjectFolderMapping(db, deviceB, project.syncId, '/home/work/repo')
  const sharedBefore = ['projects', 'sessions', 'invoices', 'invoice_line_items'].map((table) =>
    sqlite.prepare(`SELECT * FROM ${table}`).all()
  )
  clientProjectService.updateProject(project.id, { directoryPath: 'D:/moved' })
  expect(
    ['projects', 'sessions', 'invoices', 'invoice_line_items'].map((table) =>
      sqlite.prepare(`SELECT * FROM ${table}`).all()
    )
  ).toEqual(sharedBefore)
  expect(clientProjectService.findProjectByDirectory('C:/original')).toBeNull()
  expect(clientProjectService.findProjectByDirectory('D:/moved')?.id).toBe(project.id)
  expect(clientProjectService.autoCreateProject('C:/original/.claude/worktrees/task')).toBeNull()
  const replacement = clientProjectService.createProject({
    clientId: project.clientId,
    name: 'Unrelated',
    directoryPath: 'C:/original'
  })
  const fresh = db
    .insert(sessions)
    .values({
      projectPath: 'C:/original',
      startedAt: '2026-09-25T12:00:00Z',
      endedAt: '2026-09-25T13:00:00Z',
      durationMinutes: 60
    })
    .returning()
    .get()
  expect(clientProjectService.attributeSessions()).toBe(1)
  expect(db.select().from(sessions).where(eq(sessions.id, session.id)).get()).toEqual(session)
  expect(db.select().from(sessions).where(eq(sessions.id, fresh.id)).get()?.projectId).toBe(
    replacement.id
  )
  expect(() =>
    clientProjectService.updateProject(project.id, { directoryPath: 'c:/ORIGINAL/', name: 'Wrong' })
  ).toThrow('already linked')
  expect(clientProjectService.getProjectById(project.id)?.name).toBe(project.name)
  expect(clientProjectService.findProjectByDirectory('D:/moved')?.id).toBe(project.id)
  clientProjectService.updateProject(project.id, { directoryPath: null })
  expect(clientProjectService.autoCreateProject('D:/moved')).toBeNull()
  expect(getProjectFolderMapping(db, deviceB, project.syncId)).toEqual(other)
  expect(db.select().from(sessions).where(eq(sessions.id, session.id)).get()).toEqual(session)
  expect(db.select().from(invoiceLineItems).get()?.sessionIds).toBe(String(session.id))
})

it('requires new setup for a copied database and keeps unmapped projects editable', () => {
  const project = legacyProject()
  completeLocalProjectSetup([select(project)])
  const copy = sqlite.serialize()
  sqlite.close()
  sqlite = new Database(copy)
  db = drizzle(sqlite)
  deviceId = deviceB
  expect(getLocalProjectSetupStatus().complete).toBe(false)
  expect(clientProjectService.getProjectById(project.id)?.directoryPath).toBeNull()
  clientProjectService.updateProject(project.id, { name: 'Renamed remotely', hourlyRate: 200 })
  completeLocalProjectSetup([])
  clientProjectService.updateProject(project.id, { directoryPath: '/home/repo' })
  expect(getProjectFolderMapping(db, deviceA, project.syncId)?.directoryPath).toBe('C:\\original')
  expect(clientProjectService.getProjectById(project.id)?.directoryPath).toBe('/home/repo')
})

it('preserves pathless legacy sessions without blocking attribution of valid local work', () => {
  const project = legacyProject()
  completeLocalProjectSetup([select(project)])
  for (const projectPath of ['', 'relative/unknown', 'C:/original']) {
    db.insert(sessions)
      .values({
        projectPath,
        startedAt: '2026-09-25T10:00:00Z',
        endedAt: '2026-09-25T11:00:00Z',
        durationMinutes: 60
      })
      .run()
  }
  expect(clientProjectService.attributeSessions()).toBe(1)
  expect(
    db
      .select()
      .from(sessions)
      .all()
      .map((session) => session.projectId)
  ).toEqual([null, null, project.id])
  expect(clientProjectService.autoCreateProject('relative/unknown')).toBeNull()
})

it('Git and live status use only this computer’s mapping, including after moving a folder', async () => {
  const project = legacyProject()
  legacyProject('Remote', 'D:/remote')
  completeLocalProjectSetup([select(project)])
  clientProjectService.updateProject(project.id, { directoryPath: 'D:/moved' })
  vi.spyOn(gitService, 'isGitAvailable').mockResolvedValue(true)
  const repository = vi.spyOn(gitService, 'isGitRepo').mockResolvedValue(false)
  await gitService.scanCommits()
  expect(repository.mock.calls).toEqual([['D:\\moved']])
  const remote = vi.spyOn(gitService, 'getRemoteUrl').mockResolvedValue('https://example.test/repo')
  await gitService.getRemoteUrlForProject(project.id)
  expect(remote).toHaveBeenCalledWith('D:\\moved')
  vi.spyOn(liveMonitorService, 'getLatestPromptTimestamps').mockResolvedValue(
    new Map([
      [
        encodeProjectPath('D:/moved'),
        { lastPromptAt: new Date().toISOString(), isProcessing: true }
      ],
      [
        encodeProjectPath('D:/remote'),
        { lastPromptAt: new Date().toISOString(), isProcessing: true }
      ]
    ])
  )
  expect(await liveMonitorService.getProjectLiveStatuses()).toMatchObject([
    { projectId: project.id, projectPath: 'D:\\moved', isProcessing: true }
  ])
  clientProjectService.updateProject(project.id, { directoryPath: null })
  expect(await liveMonitorService.getProjectLiveStatuses()).toEqual([])
  expect(await gitService.getRemoteUrlForProject(project.id)).toBeNull()
  expect(remote).toHaveBeenCalledTimes(1)
})

function reopenBeforeMigration() {
  sqlite.close()
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite)
  const previous = readMigrationFiles({ migrationsFolder }).filter(
    (migration) => migration.folderMillis < 1790294400000
  )
  sqlite.transaction(() => {
    for (const migration of previous) for (const statement of migration.sql) sqlite.exec(statement)
    sqlite.exec(
      'CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC)'
    )
    const last = previous[previous.length - 1]
    sqlite
      .prepare('INSERT INTO __drizzle_migrations(hash,created_at) VALUES (?,?)')
      .run(last.hash, last.folderMillis)
  })()
}

it('migrates the actual previous schema without losing foreign-key children, invoices, UUIDs or the ID sequence', () => {
  reopenBeforeMigration()
  const project = legacyProject()
  const session = savedSession(project)
  sqlite
    .prepare(
      `INSERT INTO project_folder_mappings
    (device_id, project_sync_id, directory_path, directory_key, updated_at)
    VALUES (?, ?, ?, ?, ?)`
    )
    .run(deviceA, project.syncId, 'C:/original', 'c:/original', session.startedAt)
  db.insert(projectAlertConfig).values({ projectId: project.id, isWatching: 1 }).run()
  db.insert(gitCommits)
    .values({
      projectId: project.id,
      sessionId: session.id,
      hash: 'fixture',
      message: 'Saved',
      authorName: 'Fixture',
      authorEmail: 'fixture@example.test',
      committedAt: session.startedAt
    })
    .run()
  const invoice = sqlite
    .prepare(
      'INSERT INTO invoices (client_id, stripe_invoice_id, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id'
    )
    .get(project.clientId, 'in_saved', new Date().toISOString(), new Date().toISOString()) as {
    id: number
  }
  db.insert(invoiceLineItems)
    .values({
      invoiceId: invoice.id,
      description: 'Saved',
      amountCents: 15000,
      sessionIds: String(session.id)
    })
    .run()
  const deleted = legacyProject('Deleted', 'C:/deleted')
  db.delete(projects).where(eq(projects.id, deleted.id)).run()
  const tables = [
    'projects',
    'sessions',
    'git_commits',
    'project_alert_config',
    'project_folder_mappings',
    'invoices',
    'invoice_line_items'
  ]
  const snapshot = () =>
    tables.map((table) =>
      sqlite
        .prepare(`SELECT * FROM ${table}`)
        .all()
        .map((value) => {
          const row = { ...(value as Record<string, unknown>) }
          delete row.provider_account_id
          delete row.operation_id
          delete row.hidden
          delete row.root_commit
          return row
        })
    )
  const before = snapshot()
  migrate(db, { migrationsFolder })
  expect(snapshot()).toEqual(before)
  expect(sqlite.pragma('foreign_key_check')).toEqual([])
  expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1)
  expect(legacyProject('Pathless', null).id).toBeGreaterThan(deleted.id)
  expect(() =>
    db.update(projects).set({ syncId: deviceB }).where(eq(projects.id, project.id)).run()
  ).toThrow('immutable')
  expect(() => db.delete(projects).where(eq(projects.id, project.id)).run()).toThrow()
})

it('rolls back the migration rather than clearing a genuine foreign-key violation', () => {
  reopenBeforeMigration()
  const project = legacyProject()
  const session = savedSession(project)
  sqlite.pragma('foreign_keys = OFF')
  sqlite.prepare('UPDATE sessions SET project_id = 99999 WHERE id = ?').run(session.id)
  sqlite.pragma('foreign_keys = ON')
  expect(() => migrate(db, { migrationsFolder })).toThrow()
  expect(
    sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'local_project_setup'").get()
  ).toBeUndefined()
  expect(sqlite.prepare('SELECT project_id FROM sessions WHERE id = ?').get(session.id)).toEqual({
    project_id: 99999
  })
  expect(
    sqlite
      .prepare(
        'SELECT id, sync_id AS syncId, client_id AS clientId, name, directory_path AS directoryPath FROM projects'
      )
      .get()
  ).toEqual(project)
  expect(() => legacyProject('Pathless', null)).toThrow()
})

it('does not reuse deleted project IDs when upgrading an empty project table', () => {
  reopenBeforeMigration()
  const project = legacyProject()
  db.delete(projects).run()
  migrate(db, { migrationsFolder })
  expect(legacyProject('New', null).id).toBeGreaterThan(project.id)
})

it('relinks a moved, marked project folder instead of creating an Unassigned project', () => {
  initializeEmptyLocalProjectSetup()
  const root = mkdtempSync(join(tmpdir(), 'clautime-move-'))
  try {
    const oldDir = join(root, 'old')
    const newDir = join(root, 'new')
    mkdirSync(oldDir)
    const project = legacyProject('App', null)
    setProjectFolderMapping(db, deviceId, project.syncId, oldDir)
    expect(clientProjectService.writeProjectMarkers()).toBe(1)
    expect(existsSync(join(oldDir, '.clautime'))).toBe(true)
    renameSync(oldDir, newDir)
    const moved = db
      .insert(sessions)
      .values({
        projectPath: newDir,
        startedAt: '2026-10-06T10:00:00Z',
        endedAt: '2026-10-06T11:00:00Z',
        durationMinutes: 60
      })
      .returning()
      .get()

    expect(clientProjectService.attributeSessions()).toBe(1)
    expect(db.select().from(sessions).where(eq(sessions.id, moved.id)).get()?.projectId).toBe(
      project.id
    )
    expect(clientProjectService.autoCreateProject(newDir)).toBeNull()
    expect(clientProjectService.autoCreateProject(oldDir)).toBeNull()
    expect(
      db
        .select()
        .from(projects)
        .all()
        .map((row) => row.id)
    ).toEqual([project.id])
    expect(getProjectFolderMapping(db, deviceId, project.syncId)?.directoryPath).toBe(
      newDir.replace(/^([a-z]):/, (drive) => drive.toUpperCase())
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('asks before linking an unmarked clone of a known project, and links its sessions only when accepted', async () => {
  initializeEmptyLocalProjectSetup()
  resetRootCommitCaches()
  const root = mkdtempSync(join(tmpdir(), 'clautime-clone-'))
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=F', '-c', 'user.email=f@example.com', ...args], { cwd })
  const events: MarkedFolderEvent[] = []
  setMarkedFolderListener((event) => events.push(event))
  const discovered: string[] = []
  clientProjectService.setDiscoveredProjectListener((created) => discovered.push(created.name))
  try {
    const origin = join(root, 'origin')
    mkdirSync(origin)
    git(origin, 'init', '-q')
    writeFileSync(join(origin, 'README.md'), 'app')
    git(origin, 'add', '.')
    git(origin, 'commit', '-q', '-m', 'first')
    // Synced from another computer: known history, no folder on this one.
    const project = legacyProject('App', null)
    db.update(projects)
      .set({ rootCommit: await readRootCommit(origin) })
      .where(eq(projects.id, project.id))
      .run()
    git(root, 'clone', '-q', origin, 'clone')
    const clone = join(root, 'clone')
    const work = db
      .insert(sessions)
      .values({
        projectPath: clone,
        startedAt: '2026-10-06T10:00:00Z',
        endedAt: '2026-10-06T11:00:00Z',
        durationMinutes: 60
      })
      .returning()
      .get()

    expect(clientProjectService.autoCreateProject(clone)).toBeNull()
    await vi.waitFor(() => expect(events).toHaveLength(1), { timeout: 30_000 })
    expect(events[0]).toMatchObject({ kind: 'suggested', projectId: project.id })
    // Unanswered: nothing is created or attributed.
    expect(clientProjectService.autoCreateProject(clone)).toBeNull()
    expect(clientProjectService.attributeSessions()).toBe(0)
    expect(db.select().from(projects).all()).toHaveLength(1)

    clientProjectService.linkSuggestedFolder(project.id, events[0].directoryPath)
    expect(db.select().from(sessions).where(eq(sessions.id, work.id)).get()?.projectId).toBe(
      project.id
    )
    expect(clientProjectService.findProjectByDirectory(clone)?.id).toBe(project.id)
    expect(() => clientProjectService.linkSuggestedFolder(project.id, clone)).toThrow(
      /No link suggestion/
    )

    // Declined elsewhere: the second clone becomes its own Unassigned project as before.
    git(root, 'clone', '-q', origin, 'other')
    const other = join(root, 'other')
    rmSync(clone, { recursive: true, force: true })
    expect(clientProjectService.autoCreateProject(other)).toBeNull()
    await vi.waitFor(() => expect(events).toHaveLength(2), { timeout: 30_000 })
    clientProjectService.declineSuggestedFolder(events[1].directoryPath)
    const created = clientProjectService.findProjectByDirectory(other)
    expect(created?.id).not.toBe(project.id)
    expect(created?.name).toBe('other')
    // The watcher hears about it as it would for an ordinary discovery.
    expect(discovered).toEqual(['other'])
  } finally {
    setMarkedFolderListener(undefined)
    clientProjectService.setDiscoveredProjectListener(undefined)
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)
