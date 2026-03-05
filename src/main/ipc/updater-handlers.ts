import { ipcMain } from 'electron'
import { app } from 'electron'
import log from 'electron-log/main.js'
import { updaterService } from '../services/updater-service'
import { ipcSuccess, ipcError } from '../../shared/types/ipc'
import type { IpcResult } from '../../shared/types/ipc'

export function registerUpdaterHandlers(): void {
  ipcMain.handle(
    'updater:checkForUpdates',
    async (): Promise<IpcResult<void>> => {
      try {
        updaterService.checkForUpdates()
        return ipcSuccess(undefined)
      } catch (error) {
        log.error('IPC updater:checkForUpdates failed:', error)
        return ipcError('UPDATER_CHECK_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'updater:downloadAndInstall',
    async (): Promise<IpcResult<void>> => {
      try {
        updaterService.downloadAndInstall()
        return ipcSuccess(undefined)
      } catch (error) {
        log.error('IPC updater:downloadAndInstall failed:', error)
        return ipcError('UPDATER_DOWNLOAD_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'updater:getVersion',
    async (): Promise<IpcResult<string>> => {
      try {
        return ipcSuccess(app.getVersion())
      } catch (error) {
        return ipcError('UPDATER_VERSION_ERROR', String(error))
      }
    }
  )
}
