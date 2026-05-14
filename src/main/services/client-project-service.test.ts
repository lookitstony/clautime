// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'path'
import * as sessionsSchema from '../db/schema/sessions'
import * as appSettingsSchema from '../db/schema/app-settings'
import * as scanStateSchema from '../db/schema/scan-state'
import * as clientsSchema from '../db/schema/clients'
import * as projectsSchema from '../db/schema/projects'

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
  // Clean all tables before each test
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
    expect(() => clientProjectService.deleteClient(9999)).toThrow(
      'Client with id 9999 not found'
    )
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
    expect(() => clientProjectService.deleteProject(9999)).toThrow(
      'Project with id 9999 not found'
    )
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
