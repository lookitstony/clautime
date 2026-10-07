// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { clients } from '../db/schema/clients'
import { projects } from '../db/schema/projects'
import { setProjectFolderMapping } from './project-folder-mappings'
import type { MarkedFolderEvent } from '../../shared/types/client-project'
import {
  holdForRootCommitMatch,
  readRootCommit,
  recordRootCommits,
  resetRootCommitCaches,
  settleRootCommitSuggestion
} from './project-root-commit'

vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

// Each test creates and clones real repositories; git process startup is slow on Windows.
vi.setConfig({ testTimeout: 60_000 })

let sqlite: Database.Database
let db: BetterSQLite3Database
let root: string
const device = randomUUID()

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  root = mkdtempSync(join(tmpdir(), 'clautime-root-commit-'))
  resetRootCommitCaches()
})
afterEach(() => {
  sqlite.close()
  rmSync(root, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=f@example.com', ...args], {
    cwd,
    encoding: 'utf8'
  }).trim()

function gitRepo(name: string): string {
  const dir = join(root, name)
  mkdirSync(dir)
  git(dir, 'init', '-q')
  writeFileSync(join(dir, 'README.md'), name)
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'first')
  return dir
}

function project(name: string, rootCommit: string | null = null) {
  const client = db
    .insert(clients)
    .values({ name: `${name} client`, color: 'red' })
    .returning()
    .get()
  return db.insert(projects).values({ clientId: client.id, name, rootCommit }).returning().get()
}

function hold(directory: string) {
  const events: MarkedFolderEvent[] = []
  const released: string[] = []
  let settle: () => void
  const settled = new Promise<void>((resolve) => (settle = resolve))
  const held = holdForRootCommitMatch(
    db,
    device,
    directory,
    (event) => {
      events.push(event)
      settle()
    },
    (folder) => {
      released.push(folder)
      settle()
    }
  )
  return { held, events, released, settled }
}

it('reads the root commit a clone shares with its origin, and nothing without history', async () => {
  const origin = gitRepo('origin')
  git(root, 'clone', '-q', origin, 'clone')
  const rootCommit = await readRootCommit(origin)
  expect(rootCommit).toBe(git(origin, 'rev-list', '--max-parents=0', 'HEAD'))
  expect(await readRootCommit(join(root, 'clone'))).toBe(rootCommit)
  const plain = join(root, 'plain')
  mkdirSync(plain)
  expect(await readRootCommit(plain)).toBeNull()
})

it('records root commits for mapped git folders only, once', async () => {
  const app = project('App')
  const docs = project('Docs')
  const appDir = gitRepo('app')
  const docsDir = join(root, 'docs')
  mkdirSync(docsDir)
  setProjectFolderMapping(db, device, app.syncId, appDir)
  setProjectFolderMapping(db, device, docs.syncId, docsDir)

  expect(await recordRootCommits(db, device)).toBe(1)
  const read = (id: number) => db.select().from(projects).where(eq(projects.id, id)).get()!
  expect(read(app.id).rootCommit).toBe(await readRootCommit(appDir))
  expect(read(docs.id).rootCommit).toBeNull()
  expect(await recordRootCommits(db, device)).toBe(0)
})

it('holds an unmarked clone and suggests the one project whose folder is gone', async () => {
  const origin = gitRepo('origin')
  const app = project('App', await readRootCommit(origin))
  setProjectFolderMapping(db, device, app.syncId, join(root, 'old-location'))
  git(root, 'clone', '-q', origin, 'clone')
  const clone = join(root, 'clone')

  const first = hold(clone)
  expect(first.held).toBe(true)
  await first.settled
  expect(first.events).toEqual([
    { kind: 'suggested', projectId: app.id, projectName: 'App', directoryPath: clone }
  ])
  expect(first.released).toEqual([])
  // Still held until the user answers; afterwards discovery proceeds.
  expect(hold(clone).held).toBe(true)
  settleRootCommitSuggestion(clone)
  expect(hold(clone).held).toBe(false)
})

it('releases a clone without suggesting when its project folder still exists or history is shared', async () => {
  const origin = gitRepo('origin')
  const rootCommit = await readRootCommit(origin)
  const app = project('App', rootCommit)
  setProjectFolderMapping(db, device, app.syncId, origin)
  git(root, 'clone', '-q', origin, 'copy')
  const copy = hold(join(root, 'copy'))
  expect(copy.held).toBe(true)
  await copy.settled
  expect(copy.events).toEqual([])
  expect(copy.released).toEqual([join(root, 'copy')])

  // A fork with an unmapped project: two matches, so no suggestion either.
  resetRootCommitCaches()
  project('Fork', rootCommit)
  git(root, 'clone', '-q', origin, 'second')
  const second = hold(join(root, 'second'))
  await second.settled
  expect(second.events).toEqual([])
  expect(second.released).toEqual([join(root, 'second')])
})

it('does not hold folders without git history or when no project has one recorded', () => {
  const plain = join(root, 'plain')
  mkdirSync(plain)
  project('App', 'a'.repeat(40))
  expect(hold(plain).held).toBe(false)
  db.update(projects).set({ rootCommit: null }).run()
  expect(hold(gitRepo('repo')).held).toBe(false)
})
