import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { existsSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import log from 'electron-log/main.js'
import { projects, type ProjectRow } from '../db/schema/projects'
import { projectFolderMappings } from '../db/schema/project-folder-mappings'
import { normalizePath } from '../../shared/paths'
import type { MarkedFolderEvent } from '../../shared/types/client-project'
import { AppError } from '../../shared/types/ipc'
import { journalDirectoryEdit } from './folder-sync-directory-local'
import { isPortableRootCommit } from './folder-sync-directory-records'
import { findProjectFolderMapping, getProjectFolderMapping } from './project-folder-mappings'
import { runGit } from './git-exec'

/**
 * Phase 2 fallback for folders without a `.clautime` marker: a project records the root commit(s)
 * of its main folder's git history, and a new unmarked folder sharing that history is offered as
 * a link. Never links on its own; several matching projects (forks, templates) offer nothing.
 */

type Db<S extends Record<string, unknown>> = BetterSQLite3Database<S>
type SuggestedEvent = Extract<MarkedFolderEvent, { kind: 'suggested' }>

/** Spacing between git processes, so many new folders at once cannot stall the main thread. */
export const GIT_SPACING_MS = 250
/** A timed-out or failed git check is retried this long later, a few times, before giving up. */
const RETRY_DELAY_MS = 30_000
const MAX_ATTEMPTS = 3

type Check =
  | { state: 'pending' }
  | { state: 'none' }
  | { state: 'suggested'; event: SuggestedEvent; rootCommit: string }
/** Per-process state of each unmapped folder looked at during discovery. */
const checks = new Map<string, Check>()
const attempted = new Set<string>()
/** Discovery checks run one after another, spaced out. */
let queue: Promise<void> = Promise.resolve()

/** Same rule as folder mappings: Windows paths ignore case, POSIX paths keep it. */
function keyOf(directory: string): string {
  const path = normalizePath(directory)
  return /^(?:[a-z]:|\\\\|\/\/)/i.test(path) ? path.toLowerCase() : path
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function hasGitDirectory(directory: string): boolean {
  try {
    return statSync(join(directory, '.git')).isDirectory()
  } catch {
    return false
  }
}

/** 'retry' when git did not finish (timeout, overload); null when there is no usable history. */
async function probeRootCommit(directory: string): Promise<string | null | 'retry'> {
  if (existsSync(join(directory, '.git', 'shallow'))) return null
  try {
    const { stdout } = await runGit(['rev-list', '--max-parents=0', 'HEAD'], {
      cwd: directory,
      timeout: 10_000,
      // Only this folder's own repository: an empty or broken `.git` must not fall back to a
      // parent repository and report its history.
      env: { GIT_DIR: join(directory, '.git'), GIT_CEILING_DIRECTORIES: dirname(directory) }
    })
    const rootCommit = stdout.split(/\s+/).filter(Boolean).sort().join(' ')
    return isPortableRootCommit(rootCommit) ? rootCommit : null
  } catch (error) {
    const failure = error as { killed?: boolean; signal?: string | null }
    return failure.killed || failure.signal ? 'retry' : null
  }
}

/**
 * Sorted root commit hashes of `directory`'s history, space-separated. Null without history, for
 * shallow clones (their cut-off commit looks like a root) and beyond what sync accepts.
 */
export async function readRootCommit(directory: string): Promise<string | null> {
  const result = await probeRootCommit(directory)
  return result === 'retry' ? null : result
}

/**
 * Record root commits for this computer's mapped folders of active projects that have none yet
 * (or only `syncIds`). Each folder is tried once per process; git runs one at a time, spaced out.
 */
export async function recordRootCommits<S extends Record<string, unknown>>(
  db: Db<S>,
  deviceId: string,
  syncIds?: readonly string[]
): Promise<number> {
  const rows = db
    .select({
      id: projects.id,
      syncId: projects.syncId,
      directory: projectFolderMappings.directoryPath
    })
    .from(projectFolderMappings)
    .innerJoin(projects, eq(projects.syncId, projectFolderMappings.projectSyncId))
    .where(
      and(
        eq(projectFolderMappings.deviceId, deviceId.toLowerCase()),
        isNull(projects.rootCommit),
        eq(projects.isActive, true)
      )
    )
    .all()
    .filter((row) => !syncIds || syncIds.includes(row.syncId))
  let recorded = 0
  let spawned = false
  for (const row of rows) {
    const key = `${row.syncId}\n${keyOf(row.directory)}`
    if (attempted.has(key)) continue
    attempted.add(key)
    if (!hasGitDirectory(row.directory)) continue
    if (spawned) await sleep(GIT_SPACING_MS)
    spawned = true
    const rootCommit = await readRootCommit(row.directory)
    if (!rootCommit) continue
    try {
      const changed = db.transaction((tx) =>
        journalDirectoryEdit(
          tx,
          'project',
          row.syncId,
          () =>
            tx
              .update(projects)
              .set({ rootCommit, updatedAt: new Date().toISOString() })
              .where(and(eq(projects.id, row.id), isNull(projects.rootCommit)))
              .run().changes
        )
      )
      if (changed) recorded++
    } catch (error) {
      log.warn(`Could not record the git root commit of ${row.directory}:`, error)
    }
  }
  if (recorded > 0) log.info(`Recorded git root commits for ${recorded} project(s)`)
  return recorded
}

/** The single active project sharing a root with `rootCommit`, if exactly one does. */
function soleMatch<S extends Record<string, unknown>>(
  db: Db<S>,
  rootCommit: string
): ProjectRow | null {
  const roots = new Set(rootCommit.split(' '))
  const matches = db
    .select()
    .from(projects)
    .where(and(isNotNull(projects.rootCommit), eq(projects.isActive, true)))
    .all()
    .filter((project) => project.rootCommit!.split(' ').some((root) => roots.has(root)))
  return matches.length === 1 ? matches[0] : null
}

/** The one project with this history and no folder here, as a link suggestion. */
async function suggestionFor<S extends Record<string, unknown>>(
  db: Db<S>,
  deviceId: string,
  directory: string,
  rootCommit: string
): Promise<SuggestedEvent | null> {
  const project = soleMatch(db, rootCommit)
  if (!project) return null
  const mapping = getProjectFolderMapping(db, deviceId, project.syncId)
  // A project whose folder still exists here makes this one a separate copy.
  const mappedExists =
    !!mapping &&
    (await stat(mapping.directoryPath).then(
      () => true,
      () => false
    ))
  if (mappedExists) return null
  return {
    kind: 'suggested',
    projectId: project.id,
    projectName: project.name,
    directoryPath: directory
  }
}

/**
 * Discovery asks before creating a project for an unmapped main folder. Returns true while the
 * folder must wait: its root commit is being compared, or a link suggestion awaits an answer.
 * When the comparison finds nothing, `release` runs so discovery can create it as before.
 */
export function holdForRootCommitMatch<S extends Record<string, unknown>>(
  db: Db<S>,
  deviceId: string,
  directory: string,
  notify: (event: MarkedFolderEvent) => void,
  release: (directory: string) => void
): boolean {
  const key = keyOf(directory)
  const check = checks.get(key)
  if (check) return check.state !== 'none'
  // No spawn unless there is history to match against.
  const known = db
    .select({ id: projects.id })
    .from(projects)
    .where(isNotNull(projects.rootCommit))
    .limit(1)
    .get()
  if (!known || !hasGitDirectory(directory)) return false
  checks.set(key, { state: 'pending' })

  const settle = (suggestion: { event: SuggestedEvent; rootCommit: string } | null): void => {
    if (suggestion) {
      checks.set(key, { state: 'suggested', ...suggestion })
      const { projectName } = suggestion.event
      log.info(`Project root commit: suggest linking ${directory} to ${projectName}`)
      notify(suggestion.event)
    } else {
      checks.set(key, { state: 'none' })
      release(directory)
    }
  }
  const attempt = (attempts: number): void => {
    queue = queue
      .then(async () => {
        const rootCommit = await probeRootCommit(directory)
        if (rootCommit === 'retry' && attempts < MAX_ATTEMPTS) {
          // Under load a timeout says nothing about the history; never conclude "no match".
          setTimeout(() => attempt(attempts + 1), RETRY_DELAY_MS)
          return
        }
        if (rootCommit === 'retry') log.warn(`Gave up comparing the git history of ${directory}`)
        const found = rootCommit === 'retry' ? null : rootCommit
        const event = found ? await suggestionFor(db, deviceId, directory, found) : null
        settle(event && found ? { event, rootCommit: found } : null)
      })
      .catch((error) => {
        log.warn(`Comparing the git history of ${directory} failed:`, error)
        if (checks.get(key)?.state === 'pending') {
          checks.set(key, { state: 'none' })
          try {
            release(directory)
          } catch (releaseError) {
            log.warn(`Discovering ${directory} failed:`, releaseError)
          }
        }
      })
      .then(() => sleep(GIT_SPACING_MS))
  }
  attempt(1)
  return true
}

/** Suggestions still waiting for an answer, e.g. to show them again after a reload. */
export function openRootCommitSuggestions(): SuggestedEvent[] {
  return [...checks.values()].flatMap((check) => (check.state === 'suggested' ? [check.event] : []))
}

/**
 * Before linking: the suggestion must still be open for this project, the folder must still be
 * unlinked and present, the project must still be the only match, and its folder here must still
 * be missing. Returns the project and the folder as main discovered it.
 */
export function confirmRootCommitSuggestion<S extends Record<string, unknown>>(
  db: Db<S>,
  deviceId: string,
  directory: string,
  projectId: number
): { project: ProjectRow; directoryPath: string } {
  const key = keyOf(directory)
  const check = checks.get(key)
  if (check?.state !== 'suggested' || check.event.projectId !== projectId) {
    throw new AppError('SUGGESTION_NOT_FOUND', `No link suggestion is open for ${directory}`)
  }
  const { directoryPath, projectName } = check.event
  const project = soleMatch(db, check.rootCommit)
  const mapping = project && getProjectFolderMapping(db, deviceId, project.syncId)
  const stale =
    !project ||
    project.id !== projectId ||
    (mapping && existsSync(mapping.directoryPath)) ||
    !existsSync(directoryPath) ||
    findProjectFolderMapping(db, deviceId, directoryPath)
  if (stale) {
    checks.set(key, { state: 'none' })
    throw new AppError(
      'SUGGESTION_OUTDATED',
      `${projectName} or this folder changed since the suggestion; nothing was linked`
    )
  }
  return { project, directoryPath }
}

/** The user answered a suggestion: discovery stops holding the folder. */
export function settleRootCommitSuggestion(directory: string): void {
  checks.set(keyOf(directory), { state: 'none' })
}

/** The folder of an open suggestion, as main discovered it, or null. */
export function openRootCommitSuggestion(directory: string): string | null {
  const check = checks.get(keyOf(directory))
  return check?.state === 'suggested' ? check.event.directoryPath : null
}

/** Test hook: forget per-process caches. */
export function resetRootCommitCaches(): void {
  checks.clear()
  attempted.clear()
  queue = Promise.resolve()
}
