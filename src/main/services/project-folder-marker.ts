import { and, eq, isNull, ne, or } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import log from 'electron-log/main.js'
import { clients } from '../db/schema/clients'
import { projects } from '../db/schema/projects'
import { projectFolderMappings } from '../db/schema/project-folder-mappings'
import { normalizePath } from '../../shared/paths'
import type { MarkedFolderEvent, ProjectMarkerStatus } from '../../shared/types/client-project'
import { UNASSIGNED_CLIENT_ROLE } from './folder-sync-builtin-client'
import {
  findProjectFolderMapping,
  getProjectFolderMapping,
  setProjectFolderMapping
} from './project-folder-mappings'
import { mainProjectPath } from './worktree-paths'

/**
 * `.clautime` in a project's main folder names its portable project ID, so a moved folder or a
 * fresh clone links to the same project. The marker only proposes device-local mappings; it never
 * moves history. Excluded from Git via `.git/info/exclude` unless the user keeps it in Git.
 */
export const MARKER_FILE = '.clautime'
const EXCLUDE_PATTERN = `/${MARKER_FILE}`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

type Db<S extends Record<string, unknown>> = BetterSQLite3Database<S>

export type MarkerWriteResult = 'written' | 'exists' | 'conflict' | 'skipped' | 'failed'

export type MarkedFolder = MarkedFolderEvent
export type { ProjectMarkerStatus }

let listener: ((event: MarkedFolder) => void) | undefined
const notifiedCopies = new Set<string>()
const unmarkedPaths = new Set<string>()

/** Receives links, moves and copies resolved from markers (the file watcher forwards them). */
export function setMarkedFolderListener(next: ((event: MarkedFolder) => void) | undefined): void {
  listener = next
}

/** Forwards a folder event raised outside marker resolution (root-commit suggestions). */
export function emitMarkedFolder(event: MarkedFolder): void {
  listener?.(event)
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isMainFolder(directory: string): boolean {
  return normalizePath(mainProjectPath(directory)) === normalizePath(directory)
}

/** The project ID in `directory/.clautime`, or null when absent or unreadable. */
export function readProjectMarker(directory: string): string | null {
  try {
    const data = JSON.parse(readFileSync(join(directory, MARKER_FILE), 'utf8'))
    const id = typeof data?.projectSyncId === 'string' ? data.projectSyncId.toLowerCase() : ''
    return data?.version === 1 && UUID.test(id) ? id : null
  } catch {
    return null
  }
}

function excludeFile(directory: string): string | null {
  const gitDir = join(directory, '.git')
  return isDirectory(gitDir) ? join(gitDir, 'info', 'exclude') : null
}

function excludeLines(file: string): string[] {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/)
  } catch {
    return []
  }
}

const isMarkerPattern = (line: string): boolean =>
  line.trim() === EXCLUDE_PATTERN || line.trim() === MARKER_FILE

/** Off: list the marker in `.git/info/exclude`. On: remove it so the user can commit it. */
export function setMarkerKeptInGit(directory: string, keep: boolean): void {
  const file = excludeFile(directory)
  if (!file) return
  const lines = excludeLines(file)
  const listed = lines.some(isMarkerPattern)
  if (keep && listed) {
    writeFileSync(file, lines.filter((line) => !isMarkerPattern(line)).join('\n'))
  } else if (!keep && !listed) {
    mkdirSync(join(file, '..'), { recursive: true })
    const text = lines.join('\n')
    writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${EXCLUDE_PATTERN}\n`)
  }
}

export function getProjectMarkerStatus(directory: string): ProjectMarkerStatus {
  const file = excludeFile(directory)
  return {
    gitRepo: !!file,
    markerPresent: existsSync(join(directory, MARKER_FILE)),
    keepInGit: !!file && !excludeLines(file).some(isMarkerPattern)
  }
}

/**
 * Write the marker into a main project folder. Never into a worktree, never over a marker
 * naming another project, and never changes the Git setting of an existing marker.
 */
export function writeProjectMarker(directory: string, projectSyncId: string): MarkerWriteResult {
  try {
    if (!isDirectory(directory) || !isMainFolder(directory)) return 'skipped'
    const path = join(directory, MARKER_FILE)
    if (existsSync(path)) {
      if (readProjectMarker(directory) === projectSyncId) return 'exists'
      log.warn(`Project marker in ${directory} names another project; left unchanged`)
      return 'conflict'
    }
    // Exclude first: a failed exclude write must not leave an untracked marker in Git status.
    setMarkerKeptInGit(directory, false)
    writeFileSync(path, `${JSON.stringify({ version: 1, projectSyncId }, null, 2)}\n`)
    unmarkedPaths.delete(normalizePath(directory).toLowerCase())
    return 'written'
  } catch (error) {
    log.warn(`Could not write project marker in ${directory}:`, error)
    return 'failed'
  }
}

/**
 * Mark this computer's folders for projects assigned to a real client (or only `syncIds`).
 * Auto-discovered Unassigned projects get no marker.
 */
export function writeProjectMarkers<S extends Record<string, unknown>>(
  db: Db<S>,
  deviceId: string,
  syncIds?: readonly string[]
): number {
  const rows = db
    .select({
      syncId: projectFolderMappings.projectSyncId,
      directoryPath: projectFolderMappings.directoryPath
    })
    .from(projectFolderMappings)
    .innerJoin(projects, eq(projects.syncId, projectFolderMappings.projectSyncId))
    .innerJoin(clients, eq(clients.id, projects.clientId))
    .where(
      and(
        eq(projectFolderMappings.deviceId, deviceId.toLowerCase()),
        or(isNull(clients.systemRole), ne(clients.systemRole, UNASSIGNED_CLIENT_ROLE))
      )
    )
    .all()
    .filter((row) => !syncIds || syncIds.includes(row.syncId))
  let written = 0
  for (const row of rows) {
    if (writeProjectMarker(row.directoryPath, row.syncId) === 'written') written++
  }
  if (written > 0) log.info(`Wrote ${written} project folder marker(s)`)
  return written
}

/**
 * An unmapped folder carrying a known project's marker: link it when the project has no folder
 * here, treat it as a move when the mapped folder is gone, otherwise report a copy and leave
 * both alone. Returns null when the folder has no usable marker (the caller proceeds as before).
 */
export function resolveMarkedFolder<S extends Record<string, unknown>>(
  db: Db<S>,
  deviceId: string,
  directoryPath: string
): MarkedFolder | null {
  // Scans ask about the same unmarked paths repeatedly; skip the worktree walk and read.
  const inputKey = normalizePath(directoryPath).toLowerCase()
  if (unmarkedPaths.has(inputKey)) return null
  const directory = normalizePath(mainProjectPath(directoryPath))
  const key = directory.toLowerCase()
  const syncId = readProjectMarker(directory)
  if (!syncId) {
    unmarkedPaths.add(inputKey)
    return null
  }
  const project = db.select().from(projects).where(eq(projects.syncId, syncId)).get()
  if (!project || findProjectFolderMapping(db, deviceId, directory)) return null
  const mapping = getProjectFolderMapping(db, deviceId, syncId)
  let event: MarkedFolder
  if (!mapping) {
    setProjectFolderMapping(db, deviceId, syncId, directory)
    event = { kind: 'linked', projectName: project.name, directoryPath: directory }
  } else if (!existsSync(mapping.directoryPath)) {
    // setProjectFolderMapping blocks the vacated folder from rediscovery.
    setProjectFolderMapping(db, deviceId, syncId, directory)
    event = {
      kind: 'moved',
      projectName: project.name,
      directoryPath: directory,
      previousPath: mapping.directoryPath
    }
  } else {
    event = {
      kind: 'copy',
      projectName: project.name,
      directoryPath: directory,
      currentPath: mapping.directoryPath
    }
    if (notifiedCopies.has(key)) return event
    notifiedCopies.add(key)
  }
  log.info(`Project marker: ${event.kind} ${project.name} at ${directory}`)
  listener?.(event)
  return event
}

/** Test hook: forget per-process caches. */
export function resetProjectMarkerCaches(): void {
  notifiedCopies.clear()
  unmarkedPaths.clear()
}
