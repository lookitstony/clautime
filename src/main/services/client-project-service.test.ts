// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'path'
import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { folderSyncSettings, syncChanges } from '../db/schema/folder-sync'
import { recordLocalSyncChanges } from './folder-sync-store'
import type { RevisionChange } from './folder-sync-revisions'
import {
  directoryRecordsAdapter,
  getDirectoryRecordView,
  planDirectoryRevision
} from './folder-sync-directory-records'
import { UNASSIGNED_CLIENT_SYNC_ID } from './folder-sync-builtin-client'
import * as sessionsSchema from '../db/schema/sessions'
import * as appSettingsSchema from '../db/schema/app-settings'
import * as scanStateSchema from '../db/schema/scan-state'
import * as clientsSchema from '../db/schema/clients'
import * as projectsSchema from '../db/schema/projects'
import { completeLocalProjectSetup, isLocalProjectSetupComplete } from './local-project-setup'

const schema = {
  ...sessionsSchema,
  ...appSettingsSchema,
  ...scanStateSchema,
  ...clientsSchema,
  ...projectsSchema
}

let sqlite: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>

// Mock getDb to return our in-memory DB
vi.mock('../db', () => ({
  getDb: () => db
}))

vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

// Import service AFTER mocks are set up
const { clientProjectService } = await import('./client-project-service')

beforeAll(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('journal_mode = WAL')
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
})

beforeEach(() => {
  if (!isLocalProjectSetupComplete()) completeLocalProjectSetup([])
  // Clean all tables before each test
  db.delete(folderSyncSettings).run()
  db.delete(sessionsSchema.sessions).run()
  db.delete(projectsSchema.projects).run()
  db.delete(clientsSchema.clients).run()
})

afterAll(() => {
  sqlite.close()
})

describe('ClientProjectService — Clients', () => {
  it('creates a client with auto-assigned color', () => {
    const client = clientProjectService.createClient({ name: 'Acme Corp' })
    expect(client.id).toBeDefined()
    expect(client.name).toBe('Acme Corp')
    expect(client.color).toBe('var(--project-1)')
    expect(client.isActive).toBe(true)
  })

  it('creates a client with explicit color', () => {
    const client = clientProjectService.createClient({
      name: 'Beta Inc',
      color: 'var(--project-5)'
    })
    expect(client.color).toBe('var(--project-5)')
  })

  it('auto-assigns next available color', () => {
    clientProjectService.createClient({ name: 'Client A', color: 'var(--project-1)' })
    const b = clientProjectService.createClient({ name: 'Client B' })
    expect(b.color).toBe('var(--project-2)')
  })

  it('retrieves all clients ordered by name', () => {
    clientProjectService.createClient({ name: 'Zebra' })
    clientProjectService.createClient({ name: 'Alpha' })
    const all = clientProjectService.getClients()
    expect(all.length).toBe(2)
    expect(all[0].name).toBe('Alpha')
    expect(all[1].name).toBe('Zebra')
  })

  it('retrieves a client by ID', () => {
    const created = clientProjectService.createClient({ name: 'FindMe' })
    const found = clientProjectService.getClientById(created.id)
    expect(found).not.toBeNull()
    expect(found!.name).toBe('FindMe')
  })

  it('returns null for non-existent client ID', () => {
    expect(clientProjectService.getClientById(9999)).toBeNull()
  })

  it('updates a client', () => {
    const created = clientProjectService.createClient({ name: 'Old Name' })
    const updated = clientProjectService.updateClient(created.id, {
      name: 'New Name',
      color: 'var(--project-3)'
    })
    expect(updated.name).toBe('New Name')
    expect(updated.color).toBe('var(--project-3)')
  })

  it('throws when updating non-existent client', () => {
    expect(() => clientProjectService.updateClient(9999, { name: 'X' })).toThrow(
      'Client with id 9999 not found'
    )
  })

  it('deletes a client', () => {
    const created = clientProjectService.createClient({ name: 'ToDelete' })
    clientProjectService.deleteClient(created.id)
    expect(clientProjectService.getClientById(created.id)).toBeNull()
  })

  it('throws when deleting non-existent client', () => {
    expect(() => clientProjectService.deleteClient(9999)).toThrow('Client with id 9999 not found')
  })

  it('enforces unique client name', () => {
    clientProjectService.createClient({ name: 'Unique' })
    expect(() => clientProjectService.createClient({ name: 'Unique' })).toThrow()
  })
})

describe('ClientProjectService — Projects', () => {
  it('creates a project under a client', () => {
    const client = clientProjectService.createClient({ name: 'TestClient' })
    const project = clientProjectService.createProject({
      clientId: client.id,
      name: 'MyProject',
      directoryPath: 'C:\\apps\\MyProject'
    })
    expect(project.id).toBeDefined()
    expect(project.clientId).toBe(client.id)
    expect(project.name).toBe('MyProject')
    expect(project.directoryPath).toBe('C:\\apps\\MyProject')
    expect(project.isBillable).toBe(true)
    expect(project.isActive).toBe(true)
  })

  it('normalizes directory path on create', () => {
    const client = clientProjectService.createClient({ name: 'NormClient' })
    const project = clientProjectService.createProject({
      clientId: client.id,
      name: 'NormProject',
      directoryPath: 'c:/apps/SomeProject'
    })
    expect(project.directoryPath).toBe('C:\\apps\\SomeProject')
  })

  it('throws when creating project for non-existent client', () => {
    expect(() =>
      clientProjectService.createProject({
        clientId: 9999,
        name: 'Orphan',
        directoryPath: 'C:\\orphan'
      })
    ).toThrow('Client with id 9999 not found')
  })

  it('retrieves all projects', () => {
    const client = clientProjectService.createClient({ name: 'ProjClient' })
    clientProjectService.createProject({
      clientId: client.id,
      name: 'P1',
      directoryPath: 'C:\\p1'
    })
    clientProjectService.createProject({
      clientId: client.id,
      name: 'P2',
      directoryPath: 'C:\\p2'
    })
    const all = clientProjectService.getProjects()
    expect(all.length).toBe(2)
  })

  it('retrieves projects by clientId', () => {
    const c1 = clientProjectService.createClient({ name: 'C1' })
    const c2 = clientProjectService.createClient({ name: 'C2' })
    clientProjectService.createProject({
      clientId: c1.id,
      name: 'C1P',
      directoryPath: 'C:\\c1p'
    })
    clientProjectService.createProject({
      clientId: c2.id,
      name: 'C2P',
      directoryPath: 'C:\\c2p'
    })
    const c1Projects = clientProjectService.getProjects(c1.id)
    expect(c1Projects.length).toBe(1)
    expect(c1Projects[0].name).toBe('C1P')
  })

  it('retrieves a project by ID', () => {
    const client = clientProjectService.createClient({ name: 'GetClient' })
    const created = clientProjectService.createProject({
      clientId: client.id,
      name: 'GetProject',
      directoryPath: 'C:\\getproj'
    })
    const found = clientProjectService.getProjectById(created.id)
    expect(found).not.toBeNull()
    expect(found!.name).toBe('GetProject')
  })

  it('returns null for non-existent project ID', () => {
    expect(clientProjectService.getProjectById(9999)).toBeNull()
  })

  it('updates a project', () => {
    const client = clientProjectService.createClient({ name: 'UpdClient' })
    const created = clientProjectService.createProject({
      clientId: client.id,
      name: 'OldProj',
      directoryPath: 'C:\\oldproj'
    })
    const updated = clientProjectService.updateProject(created.id, {
      name: 'NewProj',
      isBillable: false
    })
    expect(updated.name).toBe('NewProj')
    expect(updated.isBillable).toBe(false)
  })

  it('throws when updating non-existent project', () => {
    expect(() => clientProjectService.updateProject(9999, { name: 'X' })).toThrow(
      'Project with id 9999 not found'
    )
  })

  it('throws when updating project to non-existent client', () => {
    const client = clientProjectService.createClient({ name: 'ReassignClient' })
    const project = clientProjectService.createProject({
      clientId: client.id,
      name: 'ReassignProj',
      directoryPath: 'C:\\reassign'
    })
    expect(() => clientProjectService.updateProject(project.id, { clientId: 9999 })).toThrow(
      'Client with id 9999 not found'
    )
  })

  it('deletes a project', () => {
    const client = clientProjectService.createClient({ name: 'DelProjClient' })
    const project = clientProjectService.createProject({
      clientId: client.id,
      name: 'DelProj',
      directoryPath: 'C:\\delproj'
    })
    clientProjectService.deleteProject(project.id)
    expect(clientProjectService.getProjectById(project.id)).toBeNull()
  })

  it('throws when deleting non-existent project', () => {
    expect(() => clientProjectService.deleteProject(9999)).toThrow('Project with id 9999 not found')
  })

  it('returns the existing project when creating a duplicate directory under the same client', () => {
    const client = clientProjectService.createClient({ name: 'UniqueDir' })
    const first = clientProjectService.createProject({
      clientId: client.id,
      name: 'First',
      directoryPath: 'C:\\unique'
    })
    const second = clientProjectService.createProject({
      clientId: client.id,
      name: 'Second',
      directoryPath: 'C:\\unique'
    })
    expect(second.id).toBe(first.id)
    expect(second.name).toBe('First') // not renamed because already under same client
  })

  it('moves an existing project to a new client when creating with the same directory', () => {
    const clientA = clientProjectService.createClient({ name: 'ClientA' })
    const clientB = clientProjectService.createClient({ name: 'ClientB' })
    const first = clientProjectService.createProject({
      clientId: clientA.id,
      name: 'OriginalName',
      directoryPath: 'C:\\moveable'
    })
    const moved = clientProjectService.createProject({
      clientId: clientB.id,
      name: 'NewName',
      directoryPath: 'C:\\moveable'
    })
    expect(moved.id).toBe(first.id)
    expect(moved.clientId).toBe(clientB.id)
    expect(moved.name).toBe('NewName')
  })
})

describe('ClientProjectService — Directory Mapping', () => {
  it('finds project by exact directory match', () => {
    const client = clientProjectService.createClient({ name: 'MapClient' })
    clientProjectService.createProject({
      clientId: client.id,
      name: 'MappedProject',
      directoryPath: 'C:\\apps\\MappedProject'
    })

    const found = clientProjectService.findProjectByDirectory('C:\\apps\\MappedProject')
    expect(found).not.toBeNull()
    expect(found!.name).toBe('MappedProject')
  })

  it('case-insensitive match on Windows paths', () => {
    const client = clientProjectService.createClient({ name: 'CaseClient' })
    clientProjectService.createProject({
      clientId: client.id,
      name: 'CaseProject',
      directoryPath: 'C:\\Apps\\CaseProject'
    })

    const found = clientProjectService.findProjectByDirectory('c:\\apps\\caseproject')
    expect(found).not.toBeNull()
    expect(found!.name).toBe('CaseProject')
  })

  it('returns null when no match', () => {
    expect(clientProjectService.findProjectByDirectory('C:\\nonexistent')).toBeNull()
  })
})

describe('ClientProjectService — Session Attribution', () => {
  it('maps unassigned worktrees while preserving already assigned legacy project identities', () => {
    const client = clientProjectService.createClient({ name: 'Trident client' })
    const project = clientProjectService.createProject({
      clientId: client.id,
      name: 'Trident',
      directoryPath: 'C:\\repo'
    })
    const unassigned = clientProjectService.getOrCreateUnassignedClient()
    const oldWorktree = db
      .insert(projectsSchema.projects)
      .values({
        clientId: unassigned.id,
        name: '894',
        directoryPath: 'C:\\repo\\.review-worktrees\\pr-894',
        isBillable: false
      })
      .returning()
      .get()
    for (const [path, projectId] of [
      ['C:\\repo\\.claude\\worktrees\\feature', null],
      [oldWorktree.directoryPath!, oldWorktree.id]
    ] as const) {
      db.insert(sessionsSchema.sessions)
        .values({
          projectPath: path,
          projectId,
          startedAt: '2026-09-08T14:00:00Z',
          endedAt: '2026-09-08T15:00:00Z',
          durationMinutes: 60
        })
        .run()
    }
    expect(clientProjectService.attributeSessions()).toBe(1)
    const history = db.select().from(sessionsSchema.sessions).all()
    expect(history[0]).toMatchObject({ projectId: project.id, clientId: client.id })
    expect(history[1]).toMatchObject({ projectId: oldWorktree.id })
    expect(db.select().from(projectsSchema.projects).all()).toHaveLength(2)
    expect(
      clientProjectService.autoCreateProject('C:\\repo\\.claude\\worktrees\\another')
    ).toBeNull()
    expect(clientProjectService.attributeSessions()).toBe(0)
  })
  it('attributes unassigned sessions to matching projects', () => {
    const client = clientProjectService.createClient({ name: 'AttrClient' })
    const project = clientProjectService.createProject({
      clientId: client.id,
      name: 'AttrProject',
      directoryPath: 'C:\\apps\\AttrProject'
    })

    // Insert an unattributed session
    const now = new Date().toISOString()
    db.insert(sessionsSchema.sessions)
      .values({
        projectPath: 'C:\\apps\\AttrProject',
        startedAt: now,
        endedAt: now,
        durationMinutes: 30,
        source: 'auto',
        status: 'completed',
        createdAt: now,
        updatedAt: now
      })
      .run()

    const count = clientProjectService.attributeSessions()
    expect(count).toBe(1)

    // Verify the session was updated
    const allSessions = db.select().from(sessionsSchema.sessions).all()
    expect(allSessions[0].projectId).toBe(project.id)
    expect(allSessions[0].clientId).toBe(client.id)
  })

  it('skips already-attributed sessions', () => {
    const client = clientProjectService.createClient({ name: 'SkipClient' })
    const project = clientProjectService.createProject({
      clientId: client.id,
      name: 'SkipProject',
      directoryPath: 'C:\\apps\\SkipProject'
    })

    const now = new Date().toISOString()
    db.insert(sessionsSchema.sessions)
      .values({
        projectPath: 'C:\\apps\\SkipProject',
        startedAt: now,
        endedAt: now,
        durationMinutes: 15,
        source: 'auto',
        status: 'completed',
        projectId: project.id,
        clientId: client.id,
        createdAt: now,
        updatedAt: now
      })
      .run()

    const count = clientProjectService.attributeSessions()
    expect(count).toBe(0)
  })

  it('returns 0 when no projects configured', () => {
    const now = new Date().toISOString()
    db.insert(sessionsSchema.sessions)
      .values({
        projectPath: 'C:\\apps\\Lonely',
        startedAt: now,
        endedAt: now,
        durationMinutes: 10,
        source: 'auto',
        status: 'completed',
        createdAt: now,
        updatedAt: now
      })
      .run()

    const count = clientProjectService.attributeSessions()
    expect(count).toBe(0)
  })
})

describe('ClientProjectService — Auto-Detection', () => {
  it('getOrCreateUnassignedClient creates client on first call', () => {
    const client = clientProjectService.getOrCreateUnassignedClient()
    expect(client.name).toBe('Unassigned')
    expect(client.color).toBe('#6b7280')
    expect(client.isActive).toBe(true)
  })

  it('getOrCreateUnassignedClient returns existing on second call', () => {
    const first = clientProjectService.getOrCreateUnassignedClient()
    const second = clientProjectService.getOrCreateUnassignedClient()
    expect(second.id).toBe(first.id)
  })

  const builtInRows = () =>
    db
      .select()
      .from(clientsSchema.clients)
      .where(eq(clientsSchema.clients.systemRole, 'unassigned'))
      .all()

  it('identifies the built-in by role, so a rename never creates a second one', () => {
    const builtIn = clientProjectService.getOrCreateUnassignedClient()
    clientProjectService.updateClient(builtIn.id, { name: 'Inbox' })
    expect(clientProjectService.getOrCreateUnassignedClient()).toMatchObject({
      id: builtIn.id,
      name: 'Inbox'
    })
    const project = clientProjectService.autoCreateProject('C:\\apps\\AfterRename')!
    expect(project.clientId).toBe(builtIn.id)
    expect(builtInRows()).toHaveLength(1)
  })

  it('never promotes an ordinary client that happens to be named Unassigned', () => {
    const ordinary = clientProjectService.createClient({ name: 'Unassigned' })
    const builtIn = clientProjectService.getOrCreateUnassignedClient()
    expect(builtIn.id).not.toBe(ordinary.id)
    expect(builtIn.name).toBe('Unassigned 2')
    expect(builtInRows().map((row) => row.id)).toEqual([builtIn.id])
    expect(clientProjectService.getClientById(ordinary.id)).toMatchObject({ name: 'Unassigned' })
  })

  it('rejects deleting the built-in client instead of stranding auto-created projects', () => {
    const builtIn = clientProjectService.getOrCreateUnassignedClient()
    const project = clientProjectService.autoCreateProject('C:\\apps\\KeepsTarget')!
    expect(() => clientProjectService.deleteClient(builtIn.id)).toThrow(
      /built-in client for auto-created projects/
    )
    expect(clientProjectService.getClientById(builtIn.id)).toMatchObject({ isActive: true })
    expect(clientProjectService.getProjectById(project.id)!.clientId).toBe(builtIn.id)
  })

  it('autoCreateProject creates project with correct fields', () => {
    const project = clientProjectService.autoCreateProject('C:\\apps\\NewAutoProject')
    expect(project).not.toBeNull()
    expect(project!.name).toBe('NewAutoProject')
    expect(project!.isBillable).toBe(false)
    expect(project!.directoryPath).toBe('C:\\apps\\NewAutoProject')

    // Should be under Unassigned client
    const unassigned = clientProjectService.getOrCreateUnassignedClient()
    expect(project!.clientId).toBe(unassigned.id)
  })

  it('autoCreateProject returns null when project already exists', () => {
    const client = clientProjectService.createClient({ name: 'ExistingClient' })
    clientProjectService.createProject({
      clientId: client.id,
      name: 'ExistingProj',
      directoryPath: 'C:\\apps\\ExistingProj'
    })

    const result = clientProjectService.autoCreateProject('C:\\apps\\ExistingProj')
    expect(result).toBeNull()
  })

  it('autoCreateProject handles concurrent calls gracefully', () => {
    const first = clientProjectService.autoCreateProject('C:\\apps\\ConcurrentProj')
    expect(first).not.toBeNull()
    // Second call for same path should return null (already exists)
    const second = clientProjectService.autoCreateProject('C:\\apps\\ConcurrentProj')
    expect(second).toBeNull()
  })
})

describe('ClientProjectService — Cascade Behavior', () => {
  it('nullifies session references when deleting a client', () => {
    const client = clientProjectService.createClient({ name: 'CascadeClient' })
    const project = clientProjectService.createProject({
      clientId: client.id,
      name: 'CascadeProject',
      directoryPath: 'C:\\apps\\Cascade'
    })

    const now = new Date().toISOString()
    db.insert(sessionsSchema.sessions)
      .values({
        projectPath: 'C:\\apps\\Cascade',
        startedAt: now,
        endedAt: now,
        durationMinutes: 20,
        source: 'auto',
        status: 'completed',
        projectId: project.id,
        clientId: client.id,
        createdAt: now,
        updatedAt: now
      })
      .run()

    clientProjectService.deleteClient(client.id)

    const allSessions = db.select().from(sessionsSchema.sessions).all()
    expect(allSessions[0].projectId).toBeNull()
    expect(allSessions[0].clientId).toBeNull()

    // Projects should also be deleted
    expect(clientProjectService.getProjectById(project.id)).toBeNull()
  })

  it('nullifies session references when deleting a project', () => {
    const client = clientProjectService.createClient({ name: 'DelProjCasc' })
    const project = clientProjectService.createProject({
      clientId: client.id,
      name: 'DelProjCascProj',
      directoryPath: 'C:\\apps\\DelProjCasc'
    })

    const now = new Date().toISOString()
    db.insert(sessionsSchema.sessions)
      .values({
        projectPath: 'C:\\apps\\DelProjCasc',
        startedAt: now,
        endedAt: now,
        durationMinutes: 25,
        source: 'auto',
        status: 'completed',
        projectId: project.id,
        clientId: client.id,
        createdAt: now,
        updatedAt: now
      })
      .run()

    clientProjectService.deleteProject(project.id)

    const allSessions = db.select().from(sessionsSchema.sessions).all()
    expect(allSessions[0].projectId).toBeNull()
    expect(allSessions[0].clientId).toBeNull()

    // Client should still exist
    expect(clientProjectService.getClientById(client.id)).not.toBeNull()
  })
})

describe('ClientProjectService — purgeExcludedProjects', () => {
  function insertSession(projectId: number, clientId: number, source: 'auto' | 'manual'): void {
    const now = new Date().toISOString()
    db.insert(sessionsSchema.sessions)
      .values({
        projectPath: 'C:\\piped\\scratch\\scratch\\abc123',
        startedAt: now,
        endedAt: now,
        durationMinutes: 10,
        source,
        status: 'completed',
        projectId,
        clientId,
        createdAt: now,
        updatedAt: now
      })
      .run()
  }

  it('retains project identities when a local path is excluded', () => {
    const keeper = clientProjectService.autoCreateProject('C:\\apps\\Keeper')!
    // Simulate a pre-exclusion auto-created row by inserting directly
    const unassigned = clientProjectService.getOrCreateUnassignedClient()
    const now = new Date().toISOString()
    const row = db
      .insert(projectsSchema.projects)
      .values({
        clientId: unassigned.id,
        name: 'abc123',
        directoryPath: 'C:\\piped\\scratch\\scratch\\abc123',
        isBillable: false,
        createdAt: now,
        updatedAt: now
      })
      .returning()
      .get()

    const deleted = clientProjectService.purgeExcludedProjects()
    expect(deleted).toBe(0)
    expect(clientProjectService.getProjectById(row.id)).not.toBeNull()
    // Non-excluded auto project untouched
    expect(clientProjectService.getProjectById(keeper.id)).not.toBeNull()
  })

  it('spares user-configured projects and projects with manual sessions', () => {
    const unassigned = clientProjectService.getOrCreateUnassignedClient()
    const now = new Date().toISOString()
    const configured = db
      .insert(projectsSchema.projects)
      .values({
        clientId: unassigned.id,
        name: 'configured',
        directoryPath: 'C:\\piped\\scratch\\ticket\\1',
        isBillable: false,
        hourlyRate: 150,
        createdAt: now,
        updatedAt: now
      })
      .returning()
      .get()
    const withManual = db
      .insert(projectsSchema.projects)
      .values({
        clientId: unassigned.id,
        name: 'with-manual',
        directoryPath: 'C:\\piped\\scratch\\scratch\\abc123',
        isBillable: false,
        createdAt: now,
        updatedAt: now
      })
      .returning()
      .get()
    insertSession(withManual.id, unassigned.id, 'manual')

    const deleted = clientProjectService.purgeExcludedProjects()
    expect(deleted).toBe(0)
    expect(clientProjectService.getProjectById(configured.id)).not.toBeNull()
    expect(clientProjectService.getProjectById(withManual.id)).not.toBeNull()
  })

  it('treats billable or non-Unassigned client as user-configured', () => {
    const client = clientProjectService.createClient({ name: 'RealClient' })
    // createProject defaults isBillable true and has a real client — both guards
    const project = clientProjectService.createProject({
      clientId: client.id,
      name: 'real-on-excluded-path',
      directoryPath: 'C:\\piped\\scratch\\ticket\\2'
    })

    const deleted = clientProjectService.purgeExcludedProjects()
    expect(deleted).toBe(0)
    expect(clientProjectService.getProjectById(project.id)).not.toBeNull()
  })
})

describe('ClientProjectService — Folder sync journal', () => {
  // Journal rows are immutable, so each test uses its own workspace.
  function connect(enabled = 0): string {
    const workspaceId = randomUUID()
    db.insert(folderSyncSettings)
      .values({ slot: 1, workspaceId, folderPath: 'G:\\My Drive\\ClauTime', enabled })
      .run()
    return workspaceId
  }
  const journal = (workspaceId: string): RevisionChange[] =>
    db
      .select()
      .from(syncChanges)
      .where(eq(syncChanges.workspaceId, workspaceId))
      .orderBy(sql`rowid`)
      .all()
      .map((row) => JSON.parse(row.changeJson) as RevisionChange)
  const syncIdOf = (id: number): string =>
    db
      .select({ syncId: projectsSchema.projects.syncId })
      .from(projectsSchema.projects)
      .where(eq(projectsSchema.projects.id, id))
      .get()!.syncId
  function errorCode(action: () => unknown): unknown {
    try {
      action()
    } catch (error) {
      return (error as { code?: unknown }).code
    }
    throw new Error('Expected the action to fail')
  }

  it('records nothing and hard-deletes as before without a workspace connection', () => {
    const before = db.select().from(syncChanges).all().length
    const client = clientProjectService.createClient({ name: 'Local only' })
    clientProjectService.autoCreateProject('C:\\apps\\LocalOnlyAuto')
    clientProjectService.updateClient(client.id, { billableRate: 90 })
    clientProjectService.deleteClient(client.id)
    expect(clientProjectService.getClientById(client.id)).toBeNull()
    expect(db.select().from(syncChanges).all()).toHaveLength(before)
  })

  it.each([
    ['disabled or offline', 0],
    ['enabled', 1]
  ])(
    'journals manual, moved and auto-detected directory records while transfer is %s',
    (_label, enabled) => {
      const workspaceId = connect(enabled)
      const acme = clientProjectService.createClient({ name: 'Acme' })
      const beta = clientProjectService.createClient({ name: 'Beta' })
      const site = clientProjectService.createProject({
        clientId: acme.id,
        name: 'Site',
        directoryPath: `C:\\apps\\JournalSite${enabled}`
      })
      clientProjectService.updateClient(acme.id, { billableRate: 125 })
      const auto = clientProjectService.autoCreateProject(`C:\\apps\\JournalAuto${enabled}`)!
      // Creating a project for an existing folder moves it to the new client.
      clientProjectService.createProject({
        clientId: beta.id,
        name: 'Site v2',
        directoryPath: `C:\\apps\\JournalSite${enabled}`
      })

      const changes = journal(workspaceId)
      const roots = changes.filter((change) => !change.payload.fields.$present.parents.length)
      expect(roots.map((change) => change.entityType)).toEqual([
        'client',
        'client',
        'project',
        'client',
        'project'
      ])
      const unassigned = clientProjectService.getOrCreateUnassignedClient()
      expect(roots[3].payload.fields.name.value).toBe(unassigned.name)
      // The built-in travels under the reserved ID shared by every computer.
      expect(roots[3].entityId).toBe(UNASSIGNED_CLIENT_SYNC_ID)
      expect(roots[4]).toMatchObject({ entityId: syncIdOf(auto.id), dependencies: [roots[3].id] })
      expect(roots[4].payload.fields.clientSyncId.value).toBe(roots[3].entityId)
      const move = changes.at(-1)!
      expect(move.entityId).toBe(syncIdOf(site.id))
      expect(Object.keys(move.payload.fields).sort()).toEqual(['$present', 'clientSyncId', 'name'])
      expect(move.dependencies).toContain(roots[1].id)
      // Folder paths stay local; only the auto-detected project's name derives from one.
      expect(JSON.stringify(changes)).not.toMatch(/apps|JournalSite/)
      expect(
        getDirectoryRecordView(db, workspaceId, 'client', changes[0].entityId).fields.billableRate
          .value
      ).toBe(125)
    }
  )

  it('rolls back the business change when its journal entry cannot be recorded', () => {
    const workspaceId = connect()
    const client = clientProjectService.createClient({ name: 'Durable' })
    const recorded = journal(workspaceId).length
    sqlite.exec(
      "CREATE TEMP TRIGGER fail_journal BEFORE INSERT ON sync_changes BEGIN SELECT RAISE(ABORT, 'journal unavailable'); END"
    )
    try {
      expect(() => clientProjectService.createClient({ name: 'Lost' })).toThrow(/journal/)
      expect(() => clientProjectService.updateClient(client.id, { name: 'Renamed' })).toThrow(
        /journal/
      )
      expect(() => clientProjectService.autoCreateProject('C:\\apps\\JournalFails')).toThrow(
        /journal/
      )
      expect(() => clientProjectService.deleteClient(client.id)).toThrow(/journal/)
    } finally {
      sqlite.exec('DROP TRIGGER temp.fail_journal')
    }
    expect(clientProjectService.getClients().map((row) => row.name)).toEqual(['Durable'])
    expect(clientProjectService.getClientById(client.id)).toMatchObject({ isActive: true })
    expect(clientProjectService.findProjectByDirectory('C:\\apps\\JournalFails')).toBeNull()
    expect(journal(workspaceId)).toHaveLength(recorded)
  })

  it('deletes causally by deactivating, without cascading into projects or sessions', () => {
    const client = clientProjectService.createClient({ name: 'Causal' })
    const project = clientProjectService.createProject({
      clientId: client.id,
      name: 'Causal site',
      directoryPath: 'C:\\apps\\CausalSite'
    })
    const now = new Date().toISOString()
    const session = db
      .insert(sessionsSchema.sessions)
      .values({
        projectPath: 'C:\\apps\\CausalSite',
        startedAt: now,
        endedAt: now,
        durationMinutes: 45,
        projectId: project.id,
        clientId: client.id
      })
      .returning()
      .get()
    // Rows created before connecting are bootstrapped before their deletion is recorded.
    const workspaceId = connect()

    clientProjectService.deleteProject(project.id)
    expect(clientProjectService.getProjectById(project.id)).toMatchObject({
      isActive: false,
      directoryPath: 'C:\\apps\\CausalSite'
    })
    expect(clientProjectService.getExcludedProjectIds()).toEqual([project.id])
    clientProjectService.deleteClient(client.id)
    expect(clientProjectService.getClientById(client.id)).toMatchObject({ isActive: false })
    expect(db.select().from(sessionsSchema.sessions).all()).toEqual([session])
    expect(getDirectoryRecordView(db, workspaceId, 'project', syncIdOf(project.id)).lifecycle).toBe(
      'deleted'
    )
    expect(
      errorCode(() => clientProjectService.updateProject(project.id, { name: 'Back again' }))
    ).toBe('SYNC_CONFLICT')
    expect(clientProjectService.getProjectById(project.id)!.name).toBe('Causal site')
  })

  it('keeps folder changes local and blocks only edits of conflicted fields', () => {
    const workspaceId = connect(1)
    const client = clientProjectService.createClient({ name: 'Conflicted' })
    const project = clientProjectService.createProject({
      clientId: client.id,
      name: 'Rates',
      hourlyRate: 100,
      directoryPath: 'C:\\apps\\RatesOld'
    })
    const recorded = journal(workspaceId).length
    clientProjectService.updateProject(project.id, { directoryPath: 'D:\\moved\\Rates' })
    expect(clientProjectService.getProjectById(project.id)!.directoryPath).toBe('D:\\moved\\Rates')
    expect(journal(workspaceId)).toHaveLength(recorded)

    const syncId = syncIdOf(project.id)
    const heads = getDirectoryRecordView(db, workspaceId, 'project', syncId).heads
    // Two computers changed the rate concurrently from the same observed heads.
    const concurrent = [150, 175].map((hourlyRate) =>
      planDirectoryRevision(db, workspaceId, {
        id: randomUUID(),
        entityType: 'project',
        entityId: syncId,
        action: { type: 'edit', observedHeads: heads, values: { hourlyRate } }
      })
    )
    recordLocalSyncChanges(db, workspaceId, concurrent, directoryRecordsAdapter)

    expect(
      errorCode(() => clientProjectService.updateProject(project.id, { hourlyRate: 160 }))
    ).toBe('SYNC_CONFLICT')
    expect(clientProjectService.getProjectById(project.id)!.hourlyRate).toBe(100)
    const renamed = clientProjectService.updateProject(project.id, { name: 'Rates v2' })
    expect(renamed).toMatchObject({ name: 'Rates v2', hourlyRate: 100 })
    const current = getDirectoryRecordView(db, workspaceId, 'project', syncId)
    expect(current.conflicts).toEqual(['hourlyRate'])
    expect(current.fields.name.value).toBe('Rates v2')
  })
})
