import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { existsSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import log from 'electron-log/main.js'
import { projects, type ProjectRow } from '../db/schema/projects'
import { projectFolderMappings } from '../db/schema/project-folder-mappings'
import { normalizePath } from '../../shared/paths'
import type { MarkedFolderEvent } from '../../shared/types/client-project'
import { AppError } from '../../shared/types/ipc'
import { journalDirectoryEdit } from './folder-sync-directory-local'
import { isPortableRootCommit } from './folder-sync-directory-records'
import { getProjectFolderMapping } from './project-folder-mappings'
import { runGit } from './git-exec'

/**
 * Phase 2 fallback for folders without a `.clautime` marker: a project records the root commit(s)
 * of its main folder's git history, and a new unmarked folder sharing that history is offered as
 * a link. Never links on its own; several matching projects (forks, templates) offer nothing.
 */

type Db<S extends Record<string, unknown>> = BetterSQLite3Database<S>
type SuggestedEvent = Extract<MarkedFolderEvent, { kind: 'suggested' }>

/** Spacing between git processes when recording, so a first run cannot stall the main thread. */
const RECORD_SPACING_MS = 250

type Check =
  | { state: 'pending' }
  | { state: 'none' }
  | { state: 'suggested'; event: SuggestedEvent; rootCommit: string }
/** Per-process state of each unmapped folder looked at during discovery. */
const checks = new Map<string, Check>()
const attempted = new Set<string>()

const keyOf = (directory: string): string => normalizePath(directory).toLowerCase()

function hasGitDirectory(directory: string): boolean {
  try {
    return statSync(join(directory, '.git')).isDirectory()
  } catch {
    return false
  }
}

/**
 * Sorted root commit hashes of `directory`'s history, space-separated. Null without history, for
 * shallow clones (their cut-off commit looks like a root) and beyond what sync accepts.
 */
export async function readRootCommit(directory: string): Promise<string | null> {
  if (existsSync(join(directory, '.git', 'shallow'))) return null
  try {
    const { stdout } = await runGit(['rev-list', '--max-parents=0', 'HEAD'], {
      cwd: directory,
      timeout: 10_000
    })
    const rootCommit = stdout.split(/\s+/).filter(Boolean).sort().join(' ')
    return isPortableRootCommit(rootCommit) ? rootCommit : null
  } catch {
    return null
  }
}

/**
 * Record root commits for this computer's mapped git folders that have none yet (or only
 * `syncIds`). Each folder is tried once per process; git runs one at a time, spaced out.
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
      and(eq(projectFolderMappings.deviceId, deviceId.toLowerCase()), isNull(projects.rootCommit))
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
    if (spawned) await new Promise((resolve) => setTimeout(resolve, RECORD_SPACING_MS))
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
  void (async () => {
    let suggestion: { event: SuggestedEvent; rootCommit: string } | null = null
    try {
      const rootCommit = await readRootCommit(directory)
      const event = rootCommit ? await suggestionFor(db, deviceId, directory, rootCommit) : null
      if (rootCommit && event) suggestion = { event, rootCommit }
    } catch (error) {
      log.warn(`Could not compare the git history of ${directory}:`, error)
    }
    if (suggestion) {
      checks.set(key, { state: 'suggested', ...suggestion })
      log.info(
        `Project root commit: suggest linking ${directory} to ${suggestion.event.projectName}`
      )
      notify(suggestion.event)
    } else {
      checks.set(key, { state: 'none' })
      release(directory)
    }
  })().catch((error) => log.warn(`Discovering ${directory} after its git check failed:`, error))
  return true
}

/** Suggestions still waiting for an answer, e.g. to show them again after a reload. */
export function openRootCommitSuggestions(): SuggestedEvent[] {
  return [...checks.values()].flatMap((check) => (check.state === 'suggested' ? [check.event] : []))
}

/**
 * Before linking: the suggestion must still be open for this project, the project must still be
 * the only match, and its folder here must still be missing.
 */
export function confirmRootCommitSuggestion<S extends Record<string, unknown>>(
  db: Db<S>,
  deviceId: string,
  directory: string,
  projectId: number
): ProjectRow {
  const check = checks.get(keyOf(directory))
  if (check?.state !== 'suggested' || check.event.projectId !== projectId) {
    throw new AppError('SUGGESTION_NOT_FOUND', `No link suggestion is open for ${directory}`)
  }
  const project = soleMatch(db, check.rootCommit)
  const mapping = project && getProjectFolderMapping(db, deviceId, project.syncId)
  if (!project || project.id !== projectId || (mapping && existsSync(mapping.directoryPath))) {
    checks.set(keyOf(directory), { state: 'none' })
    throw new AppError(
      'SUGGESTION_OUTDATED',
      `${check.event.projectName} already has a folder on this computer or is no longer the only match`
    )
  }
  return project
}

/** The user answered a suggestion: discovery stops holding the folder. */
export function settleRootCommitSuggestion(directory: string): void {
  checks.set(keyOf(directory), { state: 'none' })
}

export function isRootCommitSuggestionOpen(directory: string): boolean {
  return checks.get(keyOf(directory))?.state === 'suggested'
}

/** Test hook: forget per-process caches. */
export function resetRootCommitCaches(): void {
  checks.clear()
  attempted.clear()
}
