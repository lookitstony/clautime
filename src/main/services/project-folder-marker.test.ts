// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { clients } from '../db/schema/clients'
import { projects } from '../db/schema/projects'
import { normalizePath } from '../../shared/paths'
import {
  getProjectFolderMapping,
  isProjectFolderDiscoveryBlocked,
  setProjectFolderMapping
} from './project-folder-mappings'
import {
  MARKER_FILE,
  getProjectMarkerStatus,
  readProjectMarker,
  resetProjectMarkerCaches,
  resolveMarkedFolder,
  setMarkedFolderListener,
  setMarkerKeptInGit,
  writeProjectMarker,
  writeProjectMarkers,
  type MarkedFolder
} from './project-folder-marker'

vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

let sqlite: Database.Database
let db: BetterSQLite3Database
let root: string
const device = randomUUID()
const migrationsFolder = join(__dirname, '../db/migrations')

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder })
  root = mkdtempSync(join(tmpdir(), 'clautime-marker-'))
  resetProjectMarkerCaches()
})
afterEach(() => {
  setMarkedFolderListener(undefined)
  sqlite.close()
  rmSync(root, { recursive: true, force: true })
})

function repo(name: string): string {
  const dir = join(root, name)
  mkdirSync(join(dir, '.git', 'info'), { recursive: true })
  return dir
}

function project(name: string, options: { unassigned?: boolean } = {}) {
  const client = db
    .insert(clients)
    .values({
      name: options.unassigned ? 'Unassigned' : `${name} client`,
      color: 'red',
      ...(options.unassigned && { systemRole: 'unassigned' as const })
    })
    .returning()
    .get()
  return db.insert(projects).values({ clientId: client.id, name }).returning().get()
}

const exclude = (dir: string): string => readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')

it('writes a versioned marker and keeps it out of Git by default', () => {
  const dir = repo('app')
  const id = randomUUID()
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '# local\n*.log')
  expect(writeProjectMarker(dir, id)).toBe('written')
  expect(readProjectMarker(dir)).toBe(id)
  expect(exclude(dir)).toBe('# local\n*.log\n/.clautime\n')
  expect(getProjectMarkerStatus(dir)).toEqual({
    gitRepo: true,
    markerPresent: true,
    keepInGit: false
  })
  expect(writeProjectMarker(dir, id)).toBe('exists')
  expect(exclude(dir)).toBe('# local\n*.log\n/.clautime\n')
})

it('never overwrites a marker naming another project or an unreadable marker', () => {
  const dir = repo('app')
  const other = randomUUID()
  writeProjectMarker(dir, other)
  expect(writeProjectMarker(dir, randomUUID())).toBe('conflict')
  expect(readProjectMarker(dir)).toBe(other)
  writeFileSync(join(dir, MARKER_FILE), 'not json')
  expect(writeProjectMarker(dir, other)).toBe('conflict')
  expect(readFileSync(join(dir, MARKER_FILE), 'utf8')).toBe('not json')
})

it('skips worktrees and missing folders', () => {
  const main = repo('app')
  const worktree = join(root, 'app-feature')
  mkdirSync(join(main, '.git', 'worktrees', 'feature'), { recursive: true })
  writeFileSync(join(main, '.git', 'worktrees', 'feature', 'commondir'), '../..')
  mkdirSync(worktree)
  writeFileSync(join(worktree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'feature')}`)
  expect(writeProjectMarker(worktree, randomUUID())).toBe('skipped')
  expect(existsSync(join(worktree, MARKER_FILE))).toBe(false)
  expect(writeProjectMarker(join(root, 'missing'), randomUUID())).toBe('skipped')
})

it('writes a marker without Git metadata for a plain folder', () => {
  const dir = join(root, 'plain')
  mkdirSync(dir)
  expect(writeProjectMarker(dir, randomUUID())).toBe('written')
  expect(getProjectMarkerStatus(dir)).toEqual({
    gitRepo: false,
    markerPresent: true,
    keepInGit: false
  })
})

it('toggles keeping the marker in Git through .git/info/exclude only', () => {
  const dir = repo('app')
  writeProjectMarker(dir, randomUUID())
  setMarkerKeptInGit(dir, true)
  expect(exclude(dir)).not.toContain('.clautime')
  expect(getProjectMarkerStatus(dir).keepInGit).toBe(true)
  setMarkerKeptInGit(dir, false)
  setMarkerKeptInGit(dir, false)
  expect(exclude(dir).match(/\/\.clautime/g)).toHaveLength(1)
  expect(getProjectMarkerStatus(dir).keepInGit).toBe(false)
})

it('marks only assigned projects mapped on this computer', () => {
  const assigned = project('Assigned')
  const unassigned = project('Found', { unassigned: true })
  const elsewhere = project('Elsewhere')
  setProjectFolderMapping(db, device, assigned.syncId, repo('assigned'))
  setProjectFolderMapping(db, device, unassigned.syncId, repo('found'))
  setProjectFolderMapping(db, randomUUID(), elsewhere.syncId, repo('elsewhere'))
  expect(writeProjectMarkers(db, device)).toBe(1)
  expect(readProjectMarker(join(root, 'assigned'))).toBe(assigned.syncId)
  expect(readProjectMarker(join(root, 'found'))).toBeNull()
  expect(readProjectMarker(join(root, 'elsewhere'))).toBeNull()
  expect(writeProjectMarkers(db, device)).toBe(0)
})

it('treats a marked folder whose mapped folder is gone as a move', () => {
  const p = project('App')
  const oldDir = repo('old')
  setProjectFolderMapping(db, device, p.syncId, oldDir)
  writeProjectMarkers(db, device)
  const newDir = join(root, 'new')
  renameSync(oldDir, newDir)
  const events: MarkedFolder[] = []
  setMarkedFolderListener((event) => events.push(event))

  expect(resolveMarkedFolder(db, device, newDir)?.kind).toBe('moved')
  expect(getProjectFolderMapping(db, device, p.syncId)?.directoryPath).toBe(normalizePath(newDir))
  expect(isProjectFolderDiscoveryBlocked(db, device, oldDir)).toBe(true)
  expect(events).toEqual([
    {
      kind: 'moved',
      projectName: 'App',
      directoryPath: normalizePath(newDir),
      previousPath: normalizePath(oldDir)
    }
  ])
})

it('links a marked clone when the project has no folder on this computer', () => {
  const p = project('App')
  const clone = repo('clone')
  writeProjectMarker(clone, p.syncId)
  expect(resolveMarkedFolder(db, device, clone)?.kind).toBe('linked')
  expect(getProjectFolderMapping(db, device, p.syncId)?.directoryPath).toBe(normalizePath(clone))
})

it('reports a copy once and leaves both folders alone while the original exists', () => {
  const p = project('App')
  const original = repo('original')
  setProjectFolderMapping(db, device, p.syncId, original)
  writeProjectMarkers(db, device)
  const copy = repo('copy')
  writeProjectMarker(copy, p.syncId)
  const events: MarkedFolder[] = []
  setMarkedFolderListener((event) => events.push(event))

  expect(resolveMarkedFolder(db, device, copy)?.kind).toBe('copy')
  expect(resolveMarkedFolder(db, device, copy)?.kind).toBe('copy')
  expect(getProjectFolderMapping(db, device, p.syncId)?.directoryPath).toBe(normalizePath(original))
  expect(events.map((event) => event.kind)).toEqual(['copy'])
})

it('ignores folders without a marker or with an unknown project ID', () => {
  const plain = repo('plain')
  expect(resolveMarkedFolder(db, device, plain)).toBeNull()
  const unknown = repo('unknown')
  writeProjectMarker(unknown, randomUUID())
  expect(resolveMarkedFolder(db, device, unknown)).toBeNull()
})

it('writes no marker through a linked .git/info folder, and ignores an oversized marker', () => {
  const dir = join(root, 'linked')
  mkdirSync(join(dir, '.git'), { recursive: true })
  const outside = join(root, 'outside')
  mkdirSync(outside)
  // A junction needs no privileges on Windows; elsewhere it is an ordinary directory symlink.
  symlinkSync(outside, join(dir, '.git', 'info'), 'junction')
  expect(writeProjectMarker(dir, randomUUID())).toBe('failed')
  expect(existsSync(join(dir, MARKER_FILE))).toBe(false)
  expect(existsSync(join(outside, 'exclude'))).toBe(false)

  const plain = join(root, 'plain')
  mkdirSync(plain)
  const id = randomUUID()
  writeFileSync(
    join(plain, MARKER_FILE),
    JSON.stringify({ version: 1, projectSyncId: id }) + ' '.repeat(5000)
  )
  expect(readProjectMarker(plain)).toBeNull()
})

it('excludes the marker through a linked .git folder only when it leads to a git directory', () => {
  const store = join(root, 'store')
  mkdirSync(join(store, 'objects'), { recursive: true })
  writeFileSync(join(store, 'HEAD'), 'ref: refs/heads/main\n')
  const linked = join(root, 'linked-git')
  mkdirSync(linked)
  symlinkSync(store, join(linked, '.git'), 'junction')
  expect(getProjectMarkerStatus(linked).gitRepo).toBe(true)
  expect(writeProjectMarker(linked, randomUUID())).toBe('written')
  expect(readFileSync(join(store, 'info', 'exclude'), 'utf8')).toContain(MARKER_FILE)

  // A link to anything else is not treated as a repository and gets nothing written into it.
  const elsewhere = join(root, 'elsewhere')
  mkdirSync(elsewhere)
  const planted = join(root, 'planted-git')
  mkdirSync(planted)
  symlinkSync(elsewhere, join(planted, '.git'), 'junction')
  expect(getProjectMarkerStatus(planted).gitRepo).toBe(false)
  writeProjectMarker(planted, randomUUID())
  expect(existsSync(join(elsewhere, 'info'))).toBe(false)
})
