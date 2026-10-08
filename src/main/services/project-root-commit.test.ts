// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { clients } from '../db/schema/clients'
import { projects } from '../db/schema/projects'
import { setProjectFolderMapping } from './project-folder-mappings'
import type { MarkedFolderEvent } from '../../shared/types/client-project'
import {
  confirmRootCommitSuggestion,
  holdForRootCommitMatch,
  openRootCommitSuggestions,
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
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})

// Fixtures ignore the machine's own git config (signing, hooks, fsmonitor).
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=f@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: join(tmpdir(), 'clautime-empty-gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1'
    }
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

  // A fork with an unmapped project: two matches, so no suggestion either (App's folder is
  // gone now, so only the second match prevents it).
  resetRootCommitCaches()
  setProjectFolderMapping(db, device, app.syncId, join(root, 'gone'))
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

it('never runs commands from a planted repository config while reading history', async () => {
  const repo = gitRepo('planted')
  const tip = git(repo, 'rev-parse', 'HEAD')
  const payload = join(root, 'payload-ran').replace(/\\/g, '/')
  // A partial clone lazily fetches a missing object through core.sshCommand.
  git(repo, 'config', 'core.repositoryformatversion', '1')
  git(repo, 'config', 'extensions.partialClone', 'origin')
  git(repo, 'config', 'remote.origin.url', 'ssh://example.invalid/repo')
  git(repo, 'config', 'remote.origin.promisor', 'true')
  git(repo, 'config', 'core.sshCommand', `touch '${payload}'`)
  rmSync(join(repo, '.git', 'objects', tip.slice(0, 2), tip.slice(2)))

  expect(await readRootCommit(repo)).toBeNull()
  expect(existsSync(payload)).toBe(false)
})

it('reads no root commit from a shallow clone, whose cut-off commit only looks like a root', async () => {
  const origin = gitRepo('origin')
  writeFileSync(join(origin, 'second.md'), 'two')
  git(origin, 'add', '.')
  git(origin, 'commit', '-q', '-m', 'second')
  git(root, 'clone', '-q', '--depth', '1', `file://${origin.replace(/\\/g, '/')}`, 'shallow')
  expect(await readRootCommit(join(root, 'shallow'))).toBeNull()
})

it('matches any shared root among active projects only', async () => {
  const origin = gitRepo('origin')
  const rootCommit = (await readRootCommit(origin))!
  // A merged history lists another root too; a deactivated project never competes.
  const app = project('App', [rootCommit, 'f'.repeat(40)].sort().join(' '))
  const retired = project('Retired', rootCommit)
  db.update(projects).set({ isActive: false }).where(eq(projects.id, retired.id)).run()
  git(root, 'clone', '-q', origin, 'clone')
  const suggestion = hold(join(root, 'clone'))
  await suggestion.settled
  expect(suggestion.events).toMatchObject([{ kind: 'suggested', projectId: app.id }])
})

it('confirms a link only for the suggested project while its folder is still missing here', async () => {
  const origin = gitRepo('origin')
  const app = project('App', await readRootCommit(origin))
  const other = project('Other')
  const oldLocation = join(root, 'old-location')
  setProjectFolderMapping(db, device, app.syncId, oldLocation)
  git(root, 'clone', '-q', origin, 'clone')
  const clone = join(root, 'clone')
  await hold(clone).settled
  expect(openRootCommitSuggestions()).toMatchObject([{ projectId: app.id, directoryPath: clone }])

  expect(() => confirmRootCommitSuggestion(db, device, clone, other.id)).toThrow(
    expect.objectContaining({ code: 'SUGGESTION_NOT_FOUND' })
  )
  expect(confirmRootCommitSuggestion(db, device, clone, app.id).project.id).toBe(app.id)
  // The project's own folder came back (or was linked by hand) while the prompt was open.
  mkdirSync(oldLocation)
  expect(() => confirmRootCommitSuggestion(db, device, clone, app.id)).toThrow(
    expect.objectContaining({ code: 'SUGGESTION_OUTDATED' })
  )
  expect(openRootCommitSuggestions()).toEqual([])
  expect(hold(clone).held).toBe(false)
})

it('reads only a folder’s own repository, never a parent one, when its .git is empty', async () => {
  const parent = gitRepo('parent')
  const nested = join(parent, 'nested')
  mkdirSync(join(nested, '.git'), { recursive: true })
  expect(await readRootCommit(parent)).not.toBeNull()
  expect(await readRootCommit(nested)).toBeNull()
})

it('drops a suggestion whose folder was linked another way or deleted while it was open', async () => {
  const origin = gitRepo('origin')
  const app = project('App', await readRootCommit(origin))
  const other = project('Other')
  setProjectFolderMapping(db, device, app.syncId, join(root, 'gone'))
  for (const name of ['linked', 'deleted']) git(root, 'clone', '-q', origin, name)
  await hold(join(root, 'linked')).settled
  await hold(join(root, 'deleted')).settled
  expect(openRootCommitSuggestions()).toHaveLength(2)

  setProjectFolderMapping(db, device, other.syncId, join(root, 'linked'))
  rmSync(join(root, 'deleted'), { recursive: true, force: true, maxRetries: 5 })
  for (const name of ['linked', 'deleted']) {
    expect(() => confirmRootCommitSuggestion(db, device, join(root, name), app.id)).toThrow(
      expect.objectContaining({ code: 'SUGGESTION_OUTDATED' })
    )
  }
  expect(openRootCommitSuggestions()).toEqual([])
})
