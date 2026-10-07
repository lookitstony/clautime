// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { clients } from '../db/schema/clients'
import { projects } from '../db/schema/projects'
import { setProjectFolderMapping } from './project-folder-mappings'

const runGit = vi.hoisted(() => vi.fn())
vi.mock('./git-exec', () => ({ runGit }))
vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
import { GIT_SPACING_MS, recordRootCommits, resetRootCommitCaches } from './project-root-commit'

let sqlite: Database.Database
let db: BetterSQLite3Database
let root: string
const device = randomUUID()

beforeEach(() => {
  sqlite = new Database(':memory:')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  root = mkdtempSync(join(tmpdir(), 'clautime-record-'))
  resetRootCommitCaches()
  // No history: every folder is spawned for and nothing is recorded.
  runGit.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
})
afterEach(() => {
  vi.useRealTimers()
  sqlite.close()
  rmSync(root, { recursive: true, force: true })
})

function mappedGitProject(name: string, options: { active?: boolean; deviceId?: string } = {}) {
  const client = db
    .insert(clients)
    .values({ name: `${name} client`, color: 'red' })
    .returning()
    .get()
  const project = db
    .insert(projects)
    .values({ clientId: client.id, name, isActive: options.active ?? true })
    .returning()
    .get()
  const directory = join(root, name)
  mkdirSync(join(directory, '.git'), { recursive: true })
  setProjectFolderMapping(db, options.deviceId ?? device, project.syncId, directory)
  return project
}

it('spaces git processes apart and tries each folder once per process', async () => {
  vi.useFakeTimers()
  mappedGitProject('one')
  mappedGitProject('two')
  mappedGitProject('three')
  const done = recordRootCommits(db, device)
  await vi.advanceTimersByTimeAsync(0)
  expect(runGit).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(GIT_SPACING_MS - 1)
  expect(runGit).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(runGit).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(GIT_SPACING_MS)
  expect(runGit).toHaveBeenCalledTimes(3)
  expect(await done).toBe(0)

  // Still no root commit recorded, but already tried in this process.
  await recordRootCommits(db, device)
  expect(runGit).toHaveBeenCalledTimes(3)
})

it('skips inactive projects, other computers’ folders and projects outside syncIds', async () => {
  mappedGitProject('inactive', { active: false })
  mappedGitProject('elsewhere', { deviceId: randomUUID() })
  const wanted = mappedGitProject('wanted')
  mappedGitProject('unwanted')
  await recordRootCommits(db, device, [wanted.syncId])
  expect(runGit).toHaveBeenCalledTimes(1)
  expect(runGit.mock.calls[0][1]).toMatchObject({ cwd: expect.stringContaining('wanted') })
})
