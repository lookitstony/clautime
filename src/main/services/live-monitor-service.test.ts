// @vitest-environment node
import { beforeAll, beforeEach, afterAll, afterEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'node:path'
import { sessions } from '../db/schema/sessions'
import { projects } from '../db/schema/projects'
import { clients } from '../db/schema/clients'

let sqlite: Database.Database
let db: ReturnType<typeof drizzle>
vi.mock('../db', () => ({ getDb: () => db }))
vi.mock('electron', () => ({ Notification: vi.fn(), shell: {} }))
vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }
}))
vi.mock('./widget-service', () => ({ widgetService: {} }))
vi.mock('./settings-service', () => ({ settingsService: { getSetting: () => null } }))
const { liveMonitorService } = await import('./live-monitor-service')
const { clientProjectService } = await import('./client-project-service')

beforeAll(() => {
  sqlite = new Database(':memory:')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
})
beforeEach(() => {
  db.delete(sessions).run()
  db.delete(projects).run()
  db.delete(clients).run()
  vi.spyOn(liveMonitorService, 'getLatestPromptTimestamps').mockResolvedValue(new Map())
})
afterEach(() => vi.restoreAllMocks())
afterAll(() => sqlite.close())

it('counts four overlapping worktrees as one hour on the main project', async () => {
  const client = clientProjectService.createClient({ name: 'Client' })
  clientProjectService.createProject({
    clientId: client.id,
    name: 'Trident',
    directoryPath: 'C:\\repo'
  })
  const start = new Date()
  start.setHours(10, 0, 0, 0)
  for (let i = 0; i < 4; i++) {
    db.insert(sessions)
      .values({
        projectPath: `C:\\repo\\.claude\\worktrees\\feature-${i}`,
        startedAt: start.toISOString(),
        endedAt: new Date(+start + 60 * 60_000).toISOString(),
        durationMinutes: 60
      })
      .run()
  }
  clientProjectService.attributeSessions()
  const result = await liveMonitorService.getProjectLiveStatuses()
  expect(result).toHaveLength(1)
  expect(result[0]).toMatchObject({ projectName: 'Trident', totalHours: '1h', sessionCount: 4 })
})

it('clips at local midnight, merges partial overlap, and preserves separate intervals', async () => {
  const client = clientProjectService.createClient({ name: 'Client' })
  const project = clientProjectService.createProject({
    clientId: client.id,
    name: 'Trident',
    directoryPath: 'C:\\repo'
  })
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)
  for (const [start, end] of [
    [-30, 30],
    [15, 60],
    [120, 150]
  ]) {
    db.insert(sessions)
      .values({
        projectPath: 'C:\\repo',
        projectId: project.id,
        startedAt: new Date(+midnight + start * 60_000).toISOString(),
        endedAt: new Date(+midnight + end * 60_000).toISOString(),
        durationMinutes: end - start
      })
      .run()
  }
  expect((await liveMonitorService.getProjectLiveStatuses())[0].totalHours).toBe('1h 30m')
})

it('counts staggered worktrees with an hour of overlap as two hours', async () => {
  const client = clientProjectService.createClient({ name: 'Client' })
  clientProjectService.createProject({
    clientId: client.id,
    name: 'Project',
    directoryPath: 'C:\\repo'
  })
  const start = new Date()
  start.setHours(9, 0, 0, 0)
  for (const offset of [0, 30]) {
    db.insert(sessions)
      .values({
        projectPath: `C:\\repo\\.claude\\worktrees\\feature-${offset}`,
        startedAt: new Date(+start + offset * 60_000).toISOString(),
        endedAt: new Date(+start + (offset + 90) * 60_000).toISOString(),
        durationMinutes: 90
      })
      .run()
  }
  clientProjectService.attributeSessions()
  const result = await liveMonitorService.getProjectLiveStatuses()
  expect(result).toHaveLength(1)
  expect(result[0]).toMatchObject({ totalHours: '2h', sessionCount: 2 })
})
