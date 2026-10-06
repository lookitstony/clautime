// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { SYNC_LIMITS, SyncError, encodeSyncBatch } from './folder-sync-protocol'
import type { SyncBatch, SyncBatchInput, SyncChange } from './folder-sync-protocol'
import {
  createSyncWorkspace,
  listSyncBatchCandidates,
  listSyncWorkspaces,
  openSyncWorkspace,
  publishSyncBatch,
  readSyncBatchFile,
  scanSyncBatches
} from './folder-sync-files'
import type { SyncFileIssue } from './folder-sync-files'

const publication = vi.hoisted(() => ({
  unsupportedLinks: false,
  beforeCopy: undefined as undefined | ((target: string) => void)
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    linkSync: (...args: Parameters<typeof actual.linkSync>) => {
      if (publication.unsupportedLinks)
        throw Object.assign(new Error('Hard links unavailable'), { code: 'ENOTSUP' })
      return actual.linkSync(...args)
    },
    copyFileSync: (...args: Parameters<typeof actual.copyFileSync>) => {
      const hook = publication.beforeCopy
      publication.beforeCopy = undefined
      hook?.(String(args[1]))
      return actual.copyFileSync(...args)
    }
  }
})

const PREFIX = 'clautime-folder-sync-'
const DEVICE = randomUUID()
let root: string
let folder: string

beforeEach(() => {
  publication.unsupportedLinks = false
  publication.beforeCopy = undefined
  root = mkdtempSync(join(tmpdir(), PREFIX))
  mkdirSync(join(root, 'sync'))
  // Returned paths are real paths (e.g. macOS /var -> /private/var).
  folder = realpathSync(join(root, 'sync'))
})

afterEach(() => {
  const fixture = resolve(root)
  if (dirname(fixture) !== resolve(tmpdir()) || !basename(fixture).startsWith(PREFIX)) {
    throw new Error('Unexpected fixture directory')
  }
  rmSync(fixture, { recursive: true, force: true })
})

function change(): SyncChange {
  return {
    id: randomUUID(),
    kind: 'fact',
    entityType: 'manual-entry',
    entityId: randomUUID(),
    dependencies: [],
    payload: { minutes: 30 }
  }
}

function encode(workspaceId: string, overrides: Partial<SyncBatchInput> = {}) {
  return encodeSyncBatch({
    workspaceId,
    batchId: randomUUID(),
    writerEpochId: randomUUID(),
    sequence: 1,
    deviceId: DEVICE,
    dependencies: [],
    changes: [change()],
    ...overrides
  })
}

function setup(name = 'History') {
  const workspace = createSyncWorkspace(folder, name)
  const location = { folder, workspaceId: workspace.manifest.workspaceId }
  return { workspace, location, writers: join(workspace.directory, 'writers') }
}

function errorCode(action: () => unknown): string {
  try {
    action()
  } catch (error) {
    return error instanceof SyncError ? error.code : `unexpected ${String(error)}`
  }
  return 'no error'
}

function issueCodes(issues: SyncFileIssue[]): Record<string, string> {
  return Object.fromEntries(issues.map((issue) => [issue.path, issue.error.code]))
}

function byBatchId(a: SyncBatch, b: SyncBatch): number {
  return a.batchId < b.batchId ? -1 : 1
}

it('keeps concurrently created workspaces separate and free of local paths', () => {
  const createdAt = new Date('2026-09-01T10:00:00Z')
  const desktop = createSyncWorkspace(folder, ' Consulting ', createdAt)
  // Another computer creates a history offline; the provider later merges both folders.
  const laptopFolder = join(root, 'laptop-sync')
  mkdirSync(laptopFolder)
  const laptop = createSyncWorkspace(laptopFolder, 'Consulting', createdAt)
  cpSync(laptop.directory, join(folder, laptop.manifest.workspaceId), { recursive: true })

  expect(laptop.manifest.workspaceId).not.toBe(desktop.manifest.workspaceId)
  expect(laptop.manifest.creationId).not.toBe(desktop.manifest.creationId)
  const listed = listSyncWorkspaces(folder)
  expect(listed.issues).toEqual([])
  expect(listed.workspaces.map((workspace) => workspace.manifest)).toEqual(
    [desktop.manifest, laptop.manifest].sort((a, b) => (a.workspaceId < b.workspaceId ? -1 : 1))
  )
  const text = readFileSync(join(desktop.directory, 'workspace.json'), 'utf8')
  expect(JSON.parse(text)).toEqual({
    protocol: 1,
    workspaceId: desktop.manifest.workspaceId,
    creationId: desktop.manifest.creationId,
    createdAt: '2026-09-01T10:00:00.000Z',
    name: 'Consulting'
  })
  expect(text).not.toContain(basename(root))
  expect(readdirSync(desktop.directory).sort()).toEqual(['workspace.json', 'writers'])
  const joined = openSyncWorkspace({ folder, workspaceId: laptop.manifest.workspaceId })
  expect(joined.manifest).toEqual(laptop.manifest)
})

it('lists only workspace folders and explains damaged, incomplete or newer ones', () => {
  const { workspace } = setup()
  writeFileSync(join(folder, 'notes.txt'), 'unrelated')
  mkdirSync(join(folder, 'Photos'))
  writeFileSync(join(folder, 'Photos', 'workspace.json'), '{')
  const missing = join(folder, randomUUID())
  mkdirSync(missing)
  const damaged = join(folder, randomUUID())
  mkdirSync(damaged)
  writeFileSync(join(damaged, 'workspace.json'), '{"protocol":1,')
  const newerId = randomUUID()
  const newer = join(folder, newerId)
  mkdirSync(newer)
  const future = { ...workspace.manifest, workspaceId: newerId, protocol: 2, region: 'x' }
  writeFileSync(join(newer, 'workspace.json'), JSON.stringify(future))
  // A copied directory under a new name does not match its manifest.
  const copied = join(folder, randomUUID())
  cpSync(workspace.directory, copied, { recursive: true })

  const listed = listSyncWorkspaces(folder)
  expect(listed.workspaces.map((item) => item.directory)).toEqual([workspace.directory])
  expect(issueCodes(listed.issues)).toEqual({
    [missing]: 'SYNC_FILE_UNAVAILABLE',
    [damaged]: 'SYNC_MALFORMED',
    [newer]: 'SYNC_UPDATE_REQUIRED',
    [copied]: 'SYNC_MALFORMED'
  })
})

it('reports an unavailable or invalid folder without creating or deleting anything', () => {
  const missing = join(root, 'missing')
  const offline = { folder: missing, workspaceId: randomUUID() }
  expect(errorCode(() => listSyncWorkspaces(missing))).toBe('SYNC_FOLDER_UNAVAILABLE')
  expect(errorCode(() => createSyncWorkspace(missing, 'History'))).toBe('SYNC_FOLDER_UNAVAILABLE')
  expect(errorCode(() => scanSyncBatches(offline))).toBe('SYNC_FOLDER_UNAVAILABLE')
  const bytes = encode(offline.workspaceId).bytes
  expect(errorCode(() => publishSyncBatch(offline, bytes))).toBe('SYNC_FOLDER_UNAVAILABLE')
  expect(existsSync(missing)).toBe(false)
  expect(errorCode(() => listSyncWorkspaces('relative-sync-folder'))).toBe('SYNC_INVALID_FOLDER')
  writeFileSync(join(root, 'file'), '')
  expect(errorCode(() => createSyncWorkspace(join(root, 'file'), 'History'))).toBe(
    'SYNC_INVALID_FOLDER'
  )
  for (const name of ['', '  ', 'bad\0name']) {
    expect(errorCode(() => createSyncWorkspace(folder, name))).toBe('SYNC_INVALID_NAME')
  }
  expect(readdirSync(folder)).toEqual([])

  // A workspace that goes offline keeps its files and scans again when it returns.
  const { workspace, location } = setup()
  const published = publishSyncBatch(location, encode(location.workspaceId).bytes)
  const away = join(root, 'away')
  renameSync(workspace.directory, away)
  expect(errorCode(() => scanSyncBatches(location))).toBe('SYNC_FOLDER_UNAVAILABLE')
  const next = encode(location.workspaceId).bytes
  expect(errorCode(() => publishSyncBatch(location, next))).toBe('SYNC_FOLDER_UNAVAILABLE')
  renameSync(away, workspace.directory)
  expect(scanSyncBatches(location).batches.map((scanned) => scanned.batch)).toEqual([
    published.batch
  ])
})

it('publishes immutable batches atomically and accepts identical retries', () => {
  const { workspace, location, writers } = setup()
  const encoded = encode(location.workspaceId, { sequence: 4 })
  const directory = join(writers, encoded.batch.writerEpochId)
  const first = publishSyncBatch(location, encoded.bytes)
  expect(first).toEqual({
    status: 'published',
    path: join(directory, `4-${encoded.batch.batchId}.json.gz`),
    batch: encoded.batch
  })
  expect(readdirSync(directory)).toEqual([encoded.fileName])
  expect(readFileSync(first.path)).toEqual(encoded.bytes)
  expect(publishSyncBatch(location, encoded.bytes).status).toBe('already-published')
  // Another zlib build or level yields different bytes for the same logical batch.
  const recompressed = gzipSync(gunzipSync(encoded.bytes), { level: 1 })
  expect(recompressed.equals(encoded.bytes)).toBe(false)
  expect(publishSyncBatch(location, recompressed).status).toBe('already-published')
  expect(readFileSync(first.path)).toEqual(encoded.bytes)
  expect(readdirSync(directory)).toEqual([encoded.fileName])

  // Bytes are validated before anything is written.
  const foreign = encode(randomUUID()).bytes
  expect(errorCode(() => publishSyncBatch(location, foreign))).toBe('SYNC_WRONG_WORKSPACE')
  const partial = encode(location.workspaceId).bytes.subarray(0, 30)
  expect(errorCode(() => publishSyncBatch(location, partial))).toBe('SYNC_INCOMPLETE')
  expect(readdirSync(writers)).toEqual([encoded.batch.writerEpochId])
  expect(readdirSync(workspace.directory).sort()).toEqual(['workspace.json', 'writers'])
})

it('never replaces a divergent, damaged or partial batch file', () => {
  const { location } = setup()
  const original = encode(location.workspaceId)
  const { writerEpochId } = original.batch
  const published = publishSyncBatch(location, original.bytes)
  const divergent = encode(location.workspaceId, { batchId: original.batch.batchId, writerEpochId })
  expect(errorCode(() => publishSyncBatch(location, divergent.bytes))).toBe('SYNC_BATCH_CONFLICT')
  expect(readFileSync(published.path)).toEqual(original.bytes)

  // A partially delivered file at the target name is left for the provider to finish.
  const next = encode(location.workspaceId, { writerEpochId, sequence: 2 })
  const target = join(dirname(published.path), next.fileName)
  const partial = next.bytes.subarray(0, 20)
  writeFileSync(target, partial)
  expect(errorCode(() => publishSyncBatch(location, next.bytes))).toBe('SYNC_BATCH_CONFLICT')
  expect(readFileSync(target)).toEqual(partial)
  expect(issueCodes(scanSyncBatches(location).issues)).toEqual({ [target]: 'SYNC_INCOMPLETE' })

  // Temporary files from an interrupted publish are neither read nor deleted.
  const leftover = join(dirname(published.path), `.${next.fileName}.${randomUUID()}.tmp`)
  writeFileSync(leftover, partial)
  const later = encode(location.workspaceId, { writerEpochId, sequence: 3 })
  expect(publishSyncBatch(location, later.bytes).status).toBe('published')
  const scan = scanSyncBatches(location)
  expect(scan.batches.map((scanned) => scanned.batch.sequence)).toEqual([1, 3])
  expect(issueCodes(scan.issues)).toEqual({ [target]: 'SYNC_INCOMPLETE' })
  expect(readFileSync(leftover)).toEqual(partial)
})

it('scans independent batches, recognizes renamed duplicates and reports bad files', () => {
  const { location, writers } = setup()
  const { workspaceId } = location
  const firstWriter = randomUUID()
  const secondWriter = randomUUID()
  const a = publishSyncBatch(location, encode(workspaceId, { writerEpochId: firstWriter }).bytes)
  // Sequence 2 never arrives; sequence 3 is still independent and readable.
  const b = publishSyncBatch(
    location,
    encode(workspaceId, { writerEpochId: firstWriter, sequence: 3 }).bytes
  )
  const c = publishSyncBatch(location, encode(workspaceId, { writerEpochId: secondWriter }).bytes)
  const providerCopy = join(writers, firstWriter, `1-${a.batch.batchId} (1).json.gz`)
  const movedCopy = join(writers, secondWriter, 'Renamed.JSON.GZ')
  copyFileSync(a.path, providerCopy)
  copyFileSync(a.path, movedCopy)

  const bad = (name: string, bytes: Uint8Array): string => {
    const path = join(writers, secondWriter, name)
    writeFileSync(path, bytes)
    return path
  }
  const truncated = bad('truncated.json.gz', readFileSync(b.path).subarray(0, 40))
  const foreign = bad('foreign.json.gz', encode(randomUUID()).bytes)
  const bomb = bad('bomb.json.gz', gzipSync(Buffer.alloc(SYNC_LIMITS.maxBatchBytes + 1, ' ')))
  const future = bad('future.json.gz', gzipSync(JSON.stringify({ protocol: 2, format: 'new' })))
  const notes = join(writers, firstWriter, 'notes.txt')
  writeFileSync(notes, 'x')
  const stray = join(writers, 'desktop.ini')
  writeFileSync(stray, '')
  // Two different files claiming one batch ID: neither copy is trusted.
  const disputed = publishSyncBatch(location, encode(workspaceId).bytes)
  const rival = encode(workspaceId, {
    batchId: disputed.batch.batchId,
    writerEpochId: disputed.batch.writerEpochId
  })
  const rivalPath = join(dirname(disputed.path), 'rival.json.gz')
  writeFileSync(rivalPath, rival.bytes)

  const scan = scanSyncBatches(location)
  expect(scan.batches.map((scanned) => scanned.batch).sort(byBatchId)).toEqual(
    [a.batch, b.batch, c.batch].sort(byBatchId)
  )
  const copies = scan.batches.find((scanned) => scanned.batch.batchId === a.batch.batchId)
  expect(copies?.paths.sort()).toEqual([a.path, providerCopy, movedCopy].sort())
  expect(issueCodes(scan.issues)).toEqual({
    [truncated]: 'SYNC_INCOMPLETE',
    [foreign]: 'SYNC_WRONG_WORKSPACE',
    [bomb]: 'SYNC_TOO_LARGE',
    [future]: 'SYNC_UPDATE_REQUIRED',
    [notes]: 'SYNC_UNRECOGNIZED_FILE',
    [disputed.path]: 'SYNC_BATCH_CONFLICT',
    [rivalPath]: 'SYNC_BATCH_CONFLICT'
  })
  const listed = listSyncBatchCandidates(location)
  expect(listed.candidates).toContain(providerCopy)
  expect(listed.candidates).not.toContain(notes)
  expect(listed.candidates).not.toContain(stray)
  expect(readSyncBatchFile(location, movedCopy)).toEqual(a.batch)
})

it('reads caller-supplied paths only inside this workspace writers folder', () => {
  const { workspace, location } = setup()
  const other = setup('Other')
  const published = publishSyncBatch(location, encode(location.workspaceId).bytes)
  expect(readSyncBatchFile(location, published.path)).toEqual(published.batch)

  const otherWriter = join(other.writers, randomUUID())
  mkdirSync(otherWriter)
  const copies = [
    join(root, 'outside.json.gz'),
    join(folder, 'top.json.gz'),
    join(workspace.directory, 'stray.json.gz'),
    join(otherWriter, 'copy.json.gz')
  ]
  for (const path of copies) copyFileSync(published.path, path)
  for (const path of copies) {
    expect(errorCode(() => readSyncBatchFile(location, path))).toBe('SYNC_PATH_REJECTED')
  }
  const writerDirectory = dirname(published.path)
  const traversal = [writerDirectory, '..', '..', '..', '..', 'outside.json.gz'].join(sep)
  expect(errorCode(() => readSyncBatchFile(location, traversal))).toBe('SYNC_PATH_REJECTED')
  const relativePath = join('writers', basename(writerDirectory), basename(published.path))
  expect(errorCode(() => readSyncBatchFile(location, relativePath))).toBe('SYNC_PATH_REJECTED')
  const manifestPath = join(workspace.directory, 'workspace.json')
  expect(errorCode(() => readSyncBatchFile(location, manifestPath))).toBe('SYNC_PATH_REJECTED')
  const absent = join(writerDirectory, `2-${randomUUID()}.json.gz`)
  expect(errorCode(() => readSyncBatchFile(location, absent))).toBe('SYNC_FILE_UNAVAILABLE')

  const bytes = encode(location.workspaceId).bytes
  for (const workspaceId of ['..', `..${sep}outside`, location.workspaceId.toUpperCase()]) {
    expect(errorCode(() => scanSyncBatches({ folder, workspaceId }))).toBe('SYNC_PATH_REJECTED')
    expect(errorCode(() => publishSyncBatch({ folder, workspaceId }, bytes))).toBe(
      'SYNC_PATH_REJECTED'
    )
  }
  expect(readdirSync(root).sort()).toEqual(['outside.json.gz', 'sync'])
})

it('does not follow links or junctions out of the selected workspace', () => {
  const { workspace, location, writers } = setup()
  const outside = join(root, 'outside')
  mkdirSync(outside)
  const planted = encode(location.workspaceId)
  writeFileSync(join(outside, planted.fileName), planted.bytes)
  const linkedWriter = join(writers, planted.batch.writerEpochId)
  symlinkSync(outside, linkedWriter, 'junction')

  const scan = scanSyncBatches(location)
  expect(scan.batches).toEqual([])
  expect(issueCodes(scan.issues)).toEqual({ [linkedWriter]: 'SYNC_PATH_REJECTED' })
  const viaLink = join(linkedWriter, planted.fileName)
  expect(errorCode(() => readSyncBatchFile(location, viaLink))).toBe('SYNC_PATH_REJECTED')
  const redirected = encode(location.workspaceId, {
    writerEpochId: planted.batch.writerEpochId,
    sequence: 2
  })
  expect(errorCode(() => publishSyncBatch(location, redirected.bytes))).toBe('SYNC_PATH_REJECTED')
  expect(readdirSync(outside)).toEqual([planted.fileName])

  // A workspace folder replaced by a link is reported, not joined.
  const elsewhere = join(root, 'elsewhere')
  mkdirSync(elsewhere)
  const real = createSyncWorkspace(elsewhere, 'Elsewhere')
  const linkedWorkspace = join(folder, real.manifest.workspaceId)
  symlinkSync(real.directory, linkedWorkspace, 'junction')
  expect(issueCodes(listSyncWorkspaces(folder).issues)).toEqual({
    [linkedWorkspace]: 'SYNC_PATH_REJECTED'
  })
  const linkedLocation = { folder, workspaceId: real.manifest.workspaceId }
  expect(errorCode(() => openSyncWorkspace(linkedLocation))).toBe('SYNC_PATH_REJECTED')

  // So is a writers folder replaced by a link.
  const second = setup('Second')
  rmdirSync(second.writers)
  symlinkSync(outside, second.writers, 'junction')
  expect(errorCode(() => scanSyncBatches(second.location))).toBe('SYNC_PATH_REJECTED')
  const secondBytes = encode(second.location.workspaceId).bytes
  expect(errorCode(() => publishSyncBatch(second.location, secondBytes))).toBe('SYNC_PATH_REJECTED')
  expect(readdirSync(outside)).toEqual([planted.fileName])

  // The selected folder itself may be a link; containment uses its real path.
  const alias = join(root, 'alias')
  symlinkSync(folder, alias, 'junction')
  const viaAlias = listSyncWorkspaces(alias).workspaces.map((item) => item.directory)
  expect(viaAlias).toContain(workspace.directory)
})

it('does not read batch files that are symbolic links', (context) => {
  const { location, writers } = setup()
  const planted = encode(location.workspaceId)
  const target = join(root, planted.fileName)
  writeFileSync(target, planted.bytes)
  const directory = join(writers, planted.batch.writerEpochId)
  mkdirSync(directory)
  const link = join(directory, planted.fileName)
  try {
    symlinkSync(target, link, 'file')
  } catch (error) {
    // Windows allows file symlinks only with Developer Mode or elevation.
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return context.skip()
    throw error
  }
  const scan = scanSyncBatches(location)
  expect(scan.batches).toEqual([])
  expect(issueCodes(scan.issues)).toEqual({ [link]: 'SYNC_PATH_REJECTED' })
  expect(errorCode(() => readSyncBatchFile(location, link))).toBe('SYNC_PATH_REJECTED')
  // The link occupies the target name: it is neither followed nor replaced.
  expect(errorCode(() => publishSyncBatch(location, planted.bytes))).toBe('SYNC_BATCH_CONFLICT')
  expect(readFileSync(target)).toEqual(planted.bytes)
})

it('publishes on filesystems without hard links using an exclusive validated copy', () => {
  publication.unsupportedLinks = true
  const { location } = setup()
  const encoded = encode(location.workspaceId)
  expect(publishSyncBatch(location, encoded.bytes).status).toBe('published')
  expect(publishSyncBatch(location, encoded.bytes).status).toBe('already-published')
  expect(scanSyncBatches(location).batches.map((item) => item.batch)).toEqual([encoded.batch])
})

it('never overwrites a file appearing between the fallback check and publication', () => {
  const { location } = setup()
  publication.unsupportedLinks = true
  const encoded = encode(location.workspaceId)
  const competing = encode(location.workspaceId, {
    batchId: encoded.batch.batchId,
    writerEpochId: encoded.batch.writerEpochId
  })
  let target = ''
  publication.beforeCopy = (path) => {
    target = path
    writeFileSync(path, competing.bytes, { flag: 'wx' })
  }
  expect(errorCode(() => publishSyncBatch(location, encoded.bytes))).toBe('SYNC_BATCH_CONFLICT')
  expect(readFileSync(target)).toEqual(competing.bytes)
})
