import { ipcMain } from 'electron'
import { AppError, ipcSuccess, ipcError } from '../../shared/types/ipc'
import type { ApplyFolderSyncJoinReview, ConnectFolderSync } from '../../shared/types/folder-sync'
import { getFolderSyncService } from '../services/folder-sync-service'

export function registerFolderSyncHandlers(): void {
  const handle = <A extends unknown[], R>(name: string, action: (...args: A) => R) => {
    ipcMain.handle(`folderSync:${name}`, async (_event, ...args: A) => {
      try {
        return ipcSuccess(await action(...args))
      } catch (error) {
        return ipcError(
          error instanceof AppError ? error.code : 'SYNC_ERROR',
          error instanceof Error ? error.message : String(error)
        )
      }
    })
  }
  handle('status', () => getFolderSyncService().status())
  handle('discover', (folder: string) => getFolderSyncService().discover(folder))
  handle('connect', (input: ConnectFolderSync) => getFolderSyncService().connect(input))
  handle('setEnabled', (enabled: boolean) => getFolderSyncService().setEnabled(enabled))
  handle('syncNow', () => getFolderSyncService().syncNow())
  handle('joinReview', () => getFolderSyncService().joinReview())
  handle('applyJoinReview', (input: ApplyFolderSyncJoinReview) =>
    getFolderSyncService().applyJoinReview(input)
  )
}
