import { ipcMain } from 'electron'
import log from 'electron-log/main.js'
import { AppError, ipcSuccess, ipcError } from '../../shared/types/ipc'
import { getDb } from '../db'
import { getLocalDeviceSession } from '../services/device-context'
import { listSyncConflicts, resolveSyncConflict } from '../services/folder-sync-conflicts'

/**
 * Renderer input is untrusted: list options are reduced to one flag, resolutions strictly parsed.
 * Only application errors carry their message back; anything unexpected is logged here and the
 * renderer gets a plain message, so database or file details never reach the page.
 */
export function registerFolderSyncConflictHandlers(): void {
  const handle = <A extends unknown[], R>(name: string, action: (...args: A) => R) => {
    ipcMain.handle(`folderSync:conflicts:${name}`, (_event, ...args: A) => {
      try {
        return ipcSuccess(action(...args))
      } catch (error) {
        if (error instanceof AppError) return ipcError(error.code, error.message)
        log.error(`folderSync:conflicts:${name} failed`, error)
        return ipcError(
          'SYNC_ERROR',
          name === 'list' ? 'Conflicts could not be loaded.' : 'The choice could not be saved.'
        )
      }
    })
  }
  handle('list', (options?: unknown) =>
    listSyncConflicts(getDb(), {
      presentation:
        typeof options === 'object' &&
        options !== null &&
        (options as { presentation?: unknown }).presentation === true
    })
  )
  handle('resolve', (resolution: unknown) =>
    resolveSyncConflict(getDb(), resolution, { deviceId: getLocalDeviceSession().deviceId })
  )
}
