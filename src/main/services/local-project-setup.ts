import { eq } from 'drizzle-orm'
import { getDb } from '../db'
import { projects } from '../db/schema/projects'
import { localProjectSetup } from '../db/schema/local-project-setup'
import { getLocalDeviceSession } from './device-context'
import {
  blockProjectFolderDiscovery,
  findProjectFolderMapping,
  initializeProjectFolderMappings
} from './project-folder-mappings'
import { AppError } from '../../shared/types/ipc'
import type {
  LegacyFolderSelection,
  LocalProjectSetupStatus
} from '../../shared/types/local-project-setup'

export function isLocalProjectSetupComplete(): boolean {
  return !!getDb()
    .select()
    .from(localProjectSetup)
    .where(eq(localProjectSetup.deviceId, getLocalDeviceSession().deviceId))
    .get()
}

/** A blank installation has no inherited folders to review; keep local tracking automatic. */
export function initializeEmptyLocalProjectSetup(): void {
  if (
    !isLocalProjectSetupComplete() &&
    !getDb().select({ id: projects.id }).from(projects).limit(1).get()
  ) {
    completeLocalProjectSetup([])
  }
}

export function getLocalProjectSetupStatus(): LocalProjectSetupStatus {
  const device = getLocalDeviceSession()
  const complete = isLocalProjectSetupComplete()
  return {
    machineName: device.machineName,
    complete,
    candidates: complete
      ? []
      : getDb()
          .select()
          .from(projects)
          .all()
          .flatMap((project) =>
            project.directoryPath
              ? [
                  {
                    projectSyncId: project.syncId,
                    projectName: project.name,
                    directoryPath: project.directoryPath
                  }
                ]
              : []
          )
  }
}

export function completeLocalProjectSetup(selections: LegacyFolderSelection[]): void {
  if (
    !Array.isArray(selections) ||
    selections.some(
      (selection) =>
        !selection ||
        typeof selection.projectSyncId !== 'string' ||
        typeof selection.directoryPath !== 'string'
    )
  )
    throw new AppError('INVALID_FOLDER_SELECTION', 'Select the folders on this computer')
  const device = getLocalDeviceSession()
  getDb().transaction((tx) => {
    if (
      tx
        .select()
        .from(localProjectSetup)
        .where(eq(localProjectSetup.deviceId, device.deviceId))
        .get()
    ) {
      throw new AppError(
        'SETUP_ALREADY_COMPLETE',
        'Folder setup is already complete; use project settings to change folders'
      )
    }
    initializeProjectFolderMappings(tx, device.deviceId, selections)
    for (const project of tx.select().from(projects).all()) {
      if (!project.directoryPath) continue
      try {
        if (!findProjectFolderMapping(tx, device.deviceId, project.directoryPath)) {
          blockProjectFolderDiscovery(tx, device.deviceId, project.directoryPath)
        }
      } catch (error) {
        // An unselected, invalid legacy suggestion must not prevent setup.
        if (!(error instanceof AppError && error.code === 'INVALID_PROJECT_FOLDER')) throw error
      }
    }
    tx.insert(localProjectSetup)
      .values({ deviceId: device.deviceId, completedAt: new Date().toISOString() })
      .run()
  })
}
