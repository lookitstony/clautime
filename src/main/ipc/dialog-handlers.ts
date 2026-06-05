import { ipcMain, dialog } from 'electron'
import log from 'electron-log/main.js'
import { ipcSuccess, ipcError, type IpcResult } from '../../shared/types/ipc'
import { discoveryService } from '../services/discovery-service'
import type { DiscoveredProject } from '../../shared/types/session'

export function registerDialogHandlers(): void {
  ipcMain.handle('dialog:openFolder', async (): Promise<IpcResult<string | null>> => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Select a folder to filter projects'
      })
      if (result.canceled || result.filePaths.length === 0) {
        return ipcSuccess(null)
      }
      return ipcSuccess(result.filePaths[0])
    } catch (error) {
      log.error('IPC dialog:openFolder failed:', error)
      return ipcError('DIALOG_ERROR', String(error))
    }
  })

  ipcMain.handle(
    'dialog:discoverProjects',
    async (_event, folderPath?: string): Promise<IpcResult<DiscoveredProject[]>> => {
      try {
        const projects = folderPath
          ? await discoveryService.discoverProjectsUnderFolder(folderPath)
          : await discoveryService.discoverDefaultProjects()
        return ipcSuccess(projects)
      } catch (error) {
        log.error('IPC dialog:discoverProjects failed:', error)
        return ipcError('DISCOVERY_ERROR', String(error))
      }
    }
  )
}
