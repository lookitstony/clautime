import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { posix, win32 } from 'node:path'
import { projects } from '../db/schema/projects'
import { projectFolderMappings } from '../db/schema/project-folder-mappings'
import { localFolderDiscoveryBlocks } from '../db/schema/local-folder-discovery-blocks'
import { AppError } from '../../shared/types/ipc'
import { normalizePath } from '../../shared/paths'
import { mainProjectPath } from './worktree-paths'

function deviceKey(deviceId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId)) {
    throw new AppError('INVALID_DEVICE_ID', 'A registered device UUID is required')
  }
  return deviceId.toLowerCase()
}

function folderLocation(directoryPath: string): { directoryPath: string; directoryKey: string } {
  const input = directoryPath.trim()
  const windows = /^[a-z]:[/\\]/i.test(input) || /^(?:\\\\|\/\/)[^/\\]+[/\\][^/\\]+/.test(input)
  if (!input || input.includes('\0') || (!windows && !input.startsWith('/'))) {
    throw new AppError('INVALID_PROJECT_FOLDER', 'An absolute project folder path is required')
  }
  const paths = windows ? win32 : posix
  const normalized = paths.normalize(mainProjectPath(paths.normalize(input)))
  const root = paths.parse(normalized).root
  const directory =
    normalized.length > root.length
      ? normalized.replace(windows ? /[/\\]+$/ : /\/+$/, '')
      : normalized
  const path = normalizePath(directory)
  return { directoryPath: path, directoryKey: windows ? path.toLowerCase() : path }
}

/** All operations require an explicit local device; there is no legacy/remote path fallback. */
export function getProjectFolderMapping<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  deviceId: string,
  projectSyncId: string
) {
  return (
    db
      .select()
      .from(projectFolderMappings)
      .where(
        and(
          eq(projectFolderMappings.deviceId, deviceKey(deviceId)),
          eq(projectFolderMappings.projectSyncId, projectSyncId)
        )
      )
      .get() ?? null
  )
}

export function findProjectFolderMapping<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  deviceId: string,
  directoryPath: string
) {
  return (
    db
      .select()
      .from(projectFolderMappings)
      .where(
        and(
          eq(projectFolderMappings.deviceId, deviceKey(deviceId)),
          eq(projectFolderMappings.directoryKey, folderLocation(directoryPath).directoryKey)
        )
      )
      .get() ?? null
  )
}

/** Remember a declined or released folder so retained logs cannot recreate its mapping. */
export function blockProjectFolderDiscovery<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  deviceId: string,
  directoryPath: string
): void {
  db.insert(localFolderDiscoveryBlocks)
    .values({
      deviceId: deviceKey(deviceId),
      directoryKey: folderLocation(directoryPath).directoryKey
    })
    .onConflictDoNothing()
    .run()
}

export function isProjectFolderDiscoveryBlocked<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  deviceId: string,
  directoryPath: string
): boolean {
  return !!db
    .select()
    .from(localFolderDiscoveryBlocks)
    .where(
      and(
        eq(localFolderDiscoveryBlocks.deviceId, deviceKey(deviceId)),
        eq(localFolderDiscoveryBlocks.directoryKey, folderLocation(directoryPath).directoryKey)
      )
    )
    .get()
}

/** Explicitly link or move a folder. An occupied folder requires caller/user resolution. */
export function setProjectFolderMapping<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  deviceId: string,
  projectSyncId: string,
  directoryPath: string
) {
  const device = deviceKey(deviceId)
  const location = folderLocation(directoryPath)
  return db.transaction((tx) => {
    if (
      !tx.select({ id: projects.id }).from(projects).where(eq(projects.syncId, projectSyncId)).get()
    ) {
      throw new AppError('PROJECT_NOT_FOUND', 'Project not found')
    }
    const occupied = tx
      .select()
      .from(projectFolderMappings)
      .where(
        and(
          eq(projectFolderMappings.deviceId, device),
          eq(projectFolderMappings.directoryKey, location.directoryKey)
        )
      )
      .get()
    if (occupied && occupied.projectSyncId !== projectSyncId) {
      throw new AppError(
        'PROJECT_FOLDER_ALREADY_MAPPED',
        'This folder is already linked to another project on this computer'
      )
    }
    const previous = getProjectFolderMapping(tx, device, projectSyncId)
    if (previous && previous.directoryKey !== location.directoryKey) {
      blockProjectFolderDiscovery(tx, device, previous.directoryPath)
    }
    tx.delete(localFolderDiscoveryBlocks)
      .where(
        and(
          eq(localFolderDiscoveryBlocks.deviceId, device),
          eq(localFolderDiscoveryBlocks.directoryKey, location.directoryKey)
        )
      )
      .run()
    const values = { ...location, updatedAt: new Date().toISOString() }
    return tx
      .insert(projectFolderMappings)
      .values({ deviceId: device, projectSyncId, ...values })
      .onConflictDoUpdate({
        target: [projectFolderMappings.deviceId, projectFolderMappings.projectSyncId],
        set: values
      })
      .returning()
      .get()
  })
}

/**
 * Explicit setup selections from the legacy local project list. Never call this
 * automatically on launch/import: a copied DB's paths may belong to another computer.
 * Validate the reviewed paths and apply the entire selection atomically.
 */
export function initializeProjectFolderMappings<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  deviceId: string,
  selections: readonly { projectSyncId: string; directoryPath: string }[]
): void {
  const device = deviceKey(deviceId)
  db.transaction((tx) => {
    for (const selection of selections) {
      const project = tx
        .select()
        .from(projects)
        .where(eq(projects.syncId, selection.projectSyncId))
        .get()
      if (!project) throw new AppError('PROJECT_NOT_FOUND', 'Project not found')
      if (project.directoryPath !== selection.directoryPath) {
        throw new AppError('PROJECT_FOLDER_CHANGED', 'Project folder changed; reopen setup')
      }
      const existing = getProjectFolderMapping(tx, device, project.syncId)
      if (existing) {
        if (existing.directoryKey !== folderLocation(selection.directoryPath).directoryKey) {
          throw new AppError(
            'PROJECT_FOLDER_ALREADY_INITIALIZED',
            'This project already has a different folder on this computer'
          )
        }
        continue
      }
      setProjectFolderMapping(tx, device, project.syncId, selection.directoryPath)
    }
  })
}

/** Removing a local mapping must never remove the project or its recorded work. */
export function removeProjectFolderMapping<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  deviceId: string,
  projectSyncId: string
): void {
  const device = deviceKey(deviceId)
  db.transaction((tx) => {
    const previous = getProjectFolderMapping(tx, device, projectSyncId)
    if (previous) blockProjectFolderDiscovery(tx, device, previous.directoryPath)
    tx.delete(projectFolderMappings)
      .where(
        and(
          eq(projectFolderMappings.deviceId, device),
          eq(projectFolderMappings.projectSyncId, projectSyncId)
        )
      )
      .run()
  })
}
