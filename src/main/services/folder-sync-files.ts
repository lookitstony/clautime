import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import type { Stats } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  SYNC_LIMITS,
  SyncError,
  createWorkspaceManifest,
  decodeSyncBatch,
  decodeWorkspaceManifest,
  isSyncUuid,
  serializeWorkspaceManifest,
  syncBatchFileName
} from './folder-sync-protocol'
import type { SyncBatch, SyncChangeValidation, WorkspaceManifest } from './folder-sync-protocol'

/*
 * Layout inside the user-selected folder. Only these names are opened: other top-level
 * entries are ignored and unexpected entries under writers/ are reported, never read.
 * Nothing here deletes or prunes sync files, and a missing file is never a deletion.
 *
 *   <folder>/<workspaceId>/workspace.json
 *   <folder>/<workspaceId>/writers/<writerEpochId>/<sequence>-<batchId>.json.gz
 */
const MANIFEST_FILE = 'workspace.json'
const WRITERS_DIRECTORY = 'writers'
const BATCH_SUFFIX = '.json.gz'
const TEMPORARY_SUFFIX = '.tmp'

export interface SyncWorkspaceLocation {
  folder: string
  workspaceId: string
}

export interface SyncWorkspace {
  manifest: WorkspaceManifest
  /** Local absolute path (resolved selected folder); never written to portable data. */
  directory: string
}

export interface SyncFileIssue {
  batchId?: string
  path: string
  error: SyncError
}

export interface ScannedSyncBatch {
  batch: SyncBatch
  /** Every file holding this exact batch, including provider-renamed or moved copies. */
  paths: string[]
}

export interface SyncPublishResult {
  status: 'published' | 'already-published'
  path: string
  batch: SyncBatch
}

function errnoCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' ? code : 'unknown error'
}

function folderUnavailable(error: unknown): SyncError {
  if (error instanceof SyncError) return error
  return new SyncError(
    'SYNC_FOLDER_UNAVAILABLE',
    `The sync folder is unavailable or not writable (${errnoCode(error)}); local history is unchanged`
  )
}

export function fileUnavailable(path: string, error: unknown): SyncError {
  if (error instanceof SyncError) return error
  return new SyncError(
    'SYNC_FILE_UNAVAILABLE',
    `Sync file is missing or unreadable (${errnoCode(error)}): ${path}`
  )
}

function rejected(path: string, reason: string): SyncError {
  return new SyncError('SYNC_PATH_REJECTED', `${reason}: ${path}`)
}

function tooLarge(path: string): SyncError {
  return new SyncError('SYNC_TOO_LARGE', `Sync file is too large: ${path}`)
}

function disappeared(path: string): SyncError {
  return new SyncError('SYNC_FOLDER_UNAVAILABLE', `A sync folder disappeared while in use: ${path}`)
}

function conflict(path: string): SyncError {
  return new SyncError(
    'SYNC_BATCH_CONFLICT',
    `A different, damaged or incomplete file already exists and was not replaced: ${path}`
  )
}

/** OS bookkeeping never carries a protocol record. Do not open it. */
export function isSyncMetadataName(name: string): boolean {
  return name.startsWith('.') || ['desktop.ini', 'thumbs.db'].includes(name.toLowerCase())
}

function isBatchFileName(name: string): boolean {
  return name.toLowerCase().endsWith(BATCH_SUFFIX) && !name.includes(':')
}

/** The selected folder may itself be reached through a link; containment uses its real path. */
function resolveFolder(folder: string): string {
  if (typeof folder !== 'string' || !isAbsolute(folder) || folder.includes('\0')) {
    throw new SyncError('SYNC_INVALID_FOLDER', 'Select an absolute sync folder')
  }
  let real: string
  let stat: Stats
  try {
    real = realpathSync(folder)
    stat = statSync(real)
  } catch (error) {
    throw folderUnavailable(error)
  }
  if (!stat.isDirectory()) {
    throw new SyncError('SYNC_INVALID_FOLDER', 'The selected sync location is not a folder')
  }
  return real
}

/**
 * False only when absent. Links, junctions, files, and paths whose real location differs
 * from the expected child of the resolved folder are rejected.
 */
export function verifiedDirectoryExists(path: string): boolean {
  let stat: Stats
  try {
    stat = lstatSync(path)
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return false
    throw folderUnavailable(error)
  }
  if (!stat.isDirectory()) throw rejected(path, 'Expected a folder, not a link or file')
  let real: string
  try {
    real = realpathSync(path)
  } catch (error) {
    throw folderUnavailable(error)
  }
  if (real !== path) throw rejected(path, 'Folder resolves outside the sync folder')
  return true
}

export function ensureDirectory(path: string): string {
  try {
    mkdirSync(path)
  } catch (error) {
    if (errnoCode(error) !== 'EEXIST') throw folderUnavailable(error)
  }
  if (!verifiedDirectoryExists(path)) throw disappeared(path)
  return path
}

export function readNames(directory: string): string[] {
  try {
    return readdirSync(directory)
  } catch (error) {
    throw folderUnavailable(error)
  }
}

export function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return false
    throw fileUnavailable(path, error)
  }
}

/** Reads a regular file without following links, bounded before allocation. */
export function readBoundedFile(path: string, maxBytes: number): Buffer {
  let expected: Stats
  let fd: number
  try {
    expected = lstatSync(path)
    if (!expected.isFile()) throw rejected(path, 'Expected a regular file, not a link or folder')
    if (expected.size > maxBytes) throw tooLarge(path)
    fd = openSync(path, 'r')
  } catch (error) {
    throw fileUnavailable(path, error)
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.dev !== expected.dev || stat.ino !== expected.ino) {
      throw rejected(path, 'File was replaced while it was being opened')
    }
    if (stat.size > maxBytes) throw tooLarge(path)
    // One spare byte detects a file that is still growing.
    const buffer = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length)
      if (!count) break
      length += count
    }
    if (length > stat.size) {
      throw new SyncError('SYNC_INCOMPLETE', `Sync file changed while it was being read: ${path}`)
    }
    return buffer.subarray(0, length)
  } catch (error) {
    throw fileUnavailable(path, error)
  } finally {
    closeSync(fd)
  }
}

/**
 * Publishes a new name without ever replacing an existing file; returns false when the
 * name already exists so the caller can compare contents. A hard link fails atomically on
 * an existing name. Filesystems without hard links use an exclusive copy instead: unlike
 * check-then-rename this cannot overwrite a concurrent writer's immutable file. A receiver
 * may briefly observe that copy in progress and must validate it before importing.
 */
export function publishImmutable(directory: string, fileName: string, bytes: Uint8Array): boolean {
  const target = join(directory, fileName)
  if (pathExists(target)) return false
  const temporary = join(directory, `.${fileName}.${randomUUID()}${TEMPORARY_SUFFIX}`)
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', flush: true })
    try {
      linkSync(temporary, target)
      return true
    } catch (error) {
      if (errnoCode(error) === 'EEXIST') return false
    }
    try {
      copyFileSync(temporary, target, constants.COPYFILE_EXCL)
      return true
    } catch (error) {
      if (errnoCode(error) === 'EEXIST') return false
      throw error
    }
  } catch (error) {
    throw folderUnavailable(error)
  } finally {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // Scans ignore leftover temporary files.
    }
  }
}

function readManifest(directory: string, workspaceId: string): WorkspaceManifest {
  const bytes = readBoundedFile(join(directory, MANIFEST_FILE), SYNC_LIMITS.maxManifestBytes)
  return decodeWorkspaceManifest(bytes, workspaceId)
}

function readBatchAt(path: string, workspaceId: string, options: SyncChangeValidation): SyncBatch {
  const bytes = readBoundedFile(path, SYNC_LIMITS.maxBatchBytes)
  return decodeSyncBatch(bytes, { ...options, workspaceId })
}

/** Re-resolved on every call because the folder may go offline at any time. */
export function openSyncWorkspace(location: SyncWorkspaceLocation): SyncWorkspace {
  const workspaceId = location?.workspaceId
  if (!isSyncUuid(workspaceId)) throw rejected(String(workspaceId), 'Invalid shared history ID')
  const directory = join(resolveFolder(location.folder), workspaceId)
  if (!verifiedDirectoryExists(directory)) {
    throw new SyncError(
      'SYNC_FOLDER_UNAVAILABLE',
      `Shared history ${workspaceId} is not in the sync folder or has not finished syncing`
    )
  }
  return { manifest: readManifest(directory, workspaceId), directory }
}

/** "Create shared history": always a new random directory, never a merge into an existing one. */
export function createSyncWorkspace(
  folder: string,
  name: string,
  createdAt: Date = new Date()
): SyncWorkspace {
  const manifest = createWorkspaceManifest(name, createdAt)
  const directory = join(resolveFolder(folder), manifest.workspaceId)
  try {
    mkdirSync(directory)
  } catch (error) {
    throw folderUnavailable(error)
  }
  if (!verifiedDirectoryExists(directory)) throw disappeared(directory)
  const bytes = Buffer.from(serializeWorkspaceManifest(manifest))
  if (!publishImmutable(directory, MANIFEST_FILE, bytes)) {
    throw conflict(join(directory, MANIFEST_FILE))
  }
  ensureDirectory(join(directory, WRITERS_DIRECTORY))
  return { manifest: readManifest(directory, manifest.workspaceId), directory }
}

/** For "Join existing history": the user picks one; several workspaces are never merged. */
export function listSyncWorkspaces(folder: string): {
  workspaces: SyncWorkspace[]
  issues: SyncFileIssue[]
} {
  const root = resolveFolder(folder)
  const workspaces: SyncWorkspace[] = []
  const issues: SyncFileIssue[] = []
  for (const name of readNames(root)) {
    if (!isSyncUuid(name)) continue
    const directory = join(root, name)
    try {
      if (!verifiedDirectoryExists(directory)) continue
      workspaces.push({ manifest: readManifest(directory, name), directory })
    } catch (error) {
      issues.push({ path: directory, error: fileUnavailable(directory, error) })
    }
  }
  workspaces.sort(
    (a, b) =>
      compareText(a.manifest.createdAt, b.manifest.createdAt) ||
      compareText(a.manifest.workspaceId, b.manifest.workspaceId)
  )
  return { workspaces, issues }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Validates the bytes, then publishes them at the name derived from their contents. A retry
 * of the same logical batch (even recompressed) is already-published; anything else at that
 * name is a conflict and is left untouched.
 */
export function publishSyncBatch(
  location: SyncWorkspaceLocation,
  bytes: Uint8Array,
  recoveryCopy = false
): SyncPublishResult {
  const { manifest, directory } = openSyncWorkspace(location)
  const batch = decodeSyncBatch(bytes, { workspaceId: manifest.workspaceId })
  const writers = ensureDirectory(join(directory, WRITERS_DIRECTORY))
  const writerDirectory = ensureDirectory(join(writers, batch.writerEpochId))
  const fileName = recoveryCopy
    ? `${batch.sequence}-${batch.batchId}-recovery-${randomUUID()}.json.gz`
    : syncBatchFileName(batch)
  const path = join(writerDirectory, fileName)
  const published = publishImmutable(writerDirectory, fileName, bytes)
  // Read back either way: the local rename is only publication on this computer.
  let existing: SyncBatch
  try {
    existing = readBatchAt(path, manifest.workspaceId, {})
  } catch (error) {
    if (published) throw fileUnavailable(path, error)
    throw conflict(path)
  }
  if (existing.checksum !== batch.checksum) throw conflict(path)
  return { status: published ? 'published' : 'already-published', path, batch }
}

function listCandidates(writers: string): { candidates: string[]; issues: SyncFileIssue[] } {
  const candidates: string[] = []
  const issues: SyncFileIssue[] = []
  if (!verifiedDirectoryExists(writers)) return { candidates, issues }
  const unrecognized = (path: string): SyncFileIssue => ({
    path,
    error: new SyncError('SYNC_UNRECOGNIZED_FILE', `Unrecognized sync item was not read: ${path}`)
  })
  for (const name of readNames(writers)) {
    const writerDirectory = join(writers, name)
    if (name.endsWith(TEMPORARY_SUFFIX) || isSyncMetadataName(name)) continue
    if (!isSyncUuid(name)) {
      issues.push(unrecognized(writerDirectory))
      continue
    }
    let names: string[]
    try {
      if (!verifiedDirectoryExists(writerDirectory)) continue
      names = readNames(writerDirectory)
    } catch (error) {
      issues.push({ path: writerDirectory, error: fileUnavailable(writerDirectory, error) })
      continue
    }
    for (const fileName of names) {
      const path = join(writerDirectory, fileName)
      if (fileName.endsWith(TEMPORARY_SUFFIX) || isSyncMetadataName(fileName)) continue
      if (isBatchFileName(fileName)) candidates.push(path)
      else issues.push(unrecognized(path))
    }
  }
  return { candidates: candidates.sort(), issues }
}

/**
 * Read-only listing of files that may hold batches. File names are not trusted: a candidate
 * is identified only by its decoded contents (see readSyncBatchFile/scanSyncBatches).
 */
export function listSyncBatchCandidates(location: SyncWorkspaceLocation): {
  candidates: string[]
  issues: SyncFileIssue[]
} {
  return listCandidates(join(openSyncWorkspace(location).directory, WRITERS_DIRECTORY))
}

/** Accepts a caller path (e.g. a watcher hint) only inside writers/<writerEpochId>/. */
export function readSyncBatchFile(
  location: SyncWorkspaceLocation,
  path: string,
  options: SyncChangeValidation = {}
): SyncBatch {
  const { manifest, directory } = openSyncWorkspace(location)
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
    throw rejected(String(path), 'Batch path must be absolute')
  }
  const name = basename(path)
  if (!isBatchFileName(name)) throw rejected(path, 'Not a sync batch file')
  let parent: string
  try {
    parent = realpathSync(dirname(resolve(path)))
  } catch (error) {
    throw fileUnavailable(path, error)
  }
  const writers = join(directory, WRITERS_DIRECTORY)
  const writerEpochId = relative(writers, parent)
  if (
    !isSyncUuid(writerEpochId) ||
    !verifiedDirectoryExists(writers) ||
    !verifiedDirectoryExists(join(writers, writerEpochId))
  ) {
    throw rejected(path, 'Batch file is outside this shared history')
  }
  return readBatchAt(join(writers, writerEpochId, name), manifest.workspaceId, options)
}

/**
 * Reads every complete batch. Bad files are reported without hiding independent batches.
 * Copies sharing a batch ID are grouped; copies whose contents differ are all withheld.
 * Decoding is not applying: the caller imports batches and records receipts transactionally.
 */
export function scanSyncBatches(
  location: SyncWorkspaceLocation,
  options: SyncChangeValidation = {}
): { batches: ScannedSyncBatch[]; issues: SyncFileIssue[] } {
  const inventory = scanSyncBatchInventory(location, options)
  const batches: ScannedSyncBatch[] = []
  for (const entry of inventory.batches) {
    try {
      const batch = readSyncBatchFile(location, entry.paths[0], options)
      if (batch.checksum !== entry.batch.checksum) throw conflict(entry.paths[0])
      batches.push({ batch, paths: entry.paths })
    } catch (error) {
      inventory.issues.push({
        path: entry.paths[0],
        batchId: entry.batch.batchId,
        error: fileUnavailable(entry.paths[0], error)
      })
    }
  }
  return { batches, issues: inventory.issues }
}

/** Validate all copies while retaining only headers, so a large folder fits in memory. */
export function scanSyncBatchInventory(
  location: SyncWorkspaceLocation,
  options: SyncChangeValidation = {}
): {
  batches: Array<{ batch: Omit<SyncBatch, 'changes' | 'dependencies'>; paths: string[] }>
  issues: SyncFileIssue[]
} {
  const { manifest, directory } = openSyncWorkspace(location)
  const { candidates, issues } = listCandidates(join(directory, WRITERS_DIRECTORY))
  type Entry = { batch: Omit<SyncBatch, 'changes' | 'dependencies'>; paths: string[] }
  const found = new Map<string, Entry>()
  const conflicted = new Set<string>()
  for (const path of candidates) {
    let batch: SyncBatch
    try {
      batch = readBatchAt(path, manifest.workspaceId, options)
    } catch (error) {
      issues.push({ path, error: fileUnavailable(path, error) })
      continue
    }
    const known = found.get(batch.batchId)
    if (!known) {
      const { changes: _changes, dependencies: _dependencies, ...header } = batch
      found.set(batch.batchId, { batch: header, paths: [path] })
      continue
    }
    known.paths.push(path)
    if (known.batch.checksum !== batch.checksum) conflicted.add(batch.batchId)
  }
  const batches: Entry[] = []
  for (const [batchId, scanned] of found) {
    if (!conflicted.has(batchId)) {
      batches.push(scanned)
      continue
    }
    for (const path of scanned.paths) {
      const message = `Copies of sync batch ${batchId} differ; none were read`
      issues.push({ path, batchId, error: new SyncError('SYNC_BATCH_CONFLICT', message) })
    }
  }
  batches.sort(
    (a, b) =>
      compareText(a.batch.writerEpochId, b.batch.writerEpochId) ||
      a.batch.sequence - b.batch.sequence ||
      compareText(a.batch.batchId, b.batch.batchId)
  )
  const unresolved = issues.filter((issue) => {
    // Names are a repair hint only. A complete decoded copy supplies all authority.
    // Unsupported or conflicting complete contents are never hidden by a recovery copy.
    if (!['SYNC_INCOMPLETE', 'SYNC_MALFORMED', 'SYNC_CHECKSUM_MISMATCH'].includes(issue.error.code))
      return true
    const match = /^([1-9][0-9]*)-([0-9a-f-]{36})(?:-recovery-[0-9a-f-]{36})?\.json\.gz$/i.exec(
      basename(issue.path)
    )
    if (!match || !isSyncUuid(match[2])) return true
    const good = found.get(match[2])
    return (
      !good ||
      conflicted.has(match[2]) ||
      good.batch.sequence !== Number(match[1]) ||
      good.batch.writerEpochId !== basename(dirname(issue.path))
    )
  })
  return { batches, issues: unresolved }
}
