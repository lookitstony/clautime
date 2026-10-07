import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import log from 'electron-log/main.js'
import { projects } from '../db/schema/projects'
import { projectFolderMappings } from '../db/schema/project-folder-mappings'
import { normalizePath } from '../../shared/paths'
import type { MarkedFolderEvent } from '../../shared/types/client-project'
import { journalDirectoryEdit } from './folder-sync-directory-local'
import { getProjectFolderMapping } from './project-folder-mappings'

/**
 * Phase 2 fallback for folders without a `.clautime` marker: a project records the root commit(s)
 * of its main folder's git history, and a new unmarked folder with the same history is offered as
 * a link. Never links on its own; several matching projects (forks, templates) offer nothing.
 */

type Db<S extends Record<string, unknown>> = BetterSQLite3Database<S>

const execFileAsync = promisify(execFile)

type Check = 'pending' | 'suggested' | 'none'
/** Per-process state of each unmapped folder looked at during discovery. */
const checks = new Map<string, Check>()
const attempted = new Set<string>()

function hasGitDirectory(directory: string): boolean {
  try {
    return statSync(join(directory, '.git')).isDirectory()
  } catch {
    return false
  }
}

/** Sorted root commit hashes of `directory`'s history, space-separated; null without history. */
export async function readRootCommit(directory: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-list', '--max-parents=0', 'HEAD'], {
      cwd: directory,
      timeout: 10_000,
      windowsHide: true
    })
    const roots = stdout.split(/\s+/).filter(Boolean).sort()
    return roots.length ? roots.join(' ') : null
  } catch {
    return null
  }
}

/**
 * Record root commits for this computer's mapped git folders that have none yet (or only
 * `syncIds`). Each folder is tried once per process; git runs asynchronously, one at a time.
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
  for (const row of rows) {
    const key = `${row.syncId}\n${normalizePath(row.directory).toLowerCase()}`
    if (attempted.has(key) || !hasGitDirectory(row.directory)) continue
    attempted.add(key)
    const rootCommit = await readRootCommit(row.directory)
    if (!rootCommit) continue
    try {
      db.transaction((tx) =>
        journalDirectoryEdit(tx, 'project', row.syncId, () =>
          tx
            .update(projects)
            .set({ rootCommit, updatedAt: new Date().toISOString() })
            .where(and(eq(projects.id, row.id), isNull(projects.rootCommit)))
            .run()
        )
      )
      recorded++
    } catch (error) {
      log.warn(`Could not record the git root commit of ${row.directory}:`, error)
    }
  }
  if (recorded > 0) log.info(`Recorded git root commits for ${recorded} project(s)`)
  return recorded
}

/** The one project with this history and no usable folder here, as a link suggestion. */
function suggestionFor<S extends Record<string, unknown>>(
  db: Db<S>,
  deviceId: string,
  directory: string,
  rootCommit: string
): MarkedFolderEvent | null {
  const matches = db.select().from(projects).where(eq(projects.rootCommit, rootCommit)).all()
  if (matches.length !== 1) return null
  const [project] = matches
  const mapping = getProjectFolderMapping(db, deviceId, project.syncId)
  // A project whose folder still exists here makes this one a separate copy.
  if (mapping && statSync(mapping.directoryPath, { throwIfNoEntry: false })) return null
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
  const key = normalizePath(directory).toLowerCase()
  const check = checks.get(key)
  if (check) return check !== 'none'
  // No spawn unless there is history to match against.
  if (!hasGitDirectory(directory)) return false
  const known = db
    .select({ id: projects.id })
    .from(projects)
    .where(isNotNull(projects.rootCommit))
    .limit(1)
    .get()
  if (!known) return false
  checks.set(key, 'pending')
  void readRootCommit(directory)
    .then((rootCommit) => (rootCommit ? suggestionFor(db, deviceId, directory, rootCommit) : null))
    .catch((error) => {
      log.warn(`Could not compare the git history of ${directory}:`, error)
      return null
    })
    .then((event) => {
      if (event) {
        checks.set(key, 'suggested')
        log.info(`Project root commit: suggest linking ${directory} to ${event.projectName}`)
        notify(event)
      } else {
        checks.set(key, 'none')
        release(directory)
      }
    })
  return true
}

/** The user answered a suggestion: discovery stops holding the folder. */
export function settleRootCommitSuggestion(directory: string): void {
  checks.set(normalizePath(directory).toLowerCase(), 'none')
}

export function isRootCommitSuggestionOpen(directory: string): boolean {
  return checks.get(normalizePath(directory).toLowerCase()) === 'suggested'
}

/** Test hook: forget per-process caches. */
export function resetRootCommitCaches(): void {
  checks.clear()
  attempted.clear()
}
