import { ipcMain } from 'electron'
import log from 'electron-log/main.js'
import { settingsService } from '../services/settings-service'
import { ipcSuccess, ipcError, type IpcResult } from '../../shared/types/ipc'

export function registerSettingsHandlers(): void {
  ipcMain.handle(
    'settings:get',
    async (_event, key: string): Promise<IpcResult<string | null>> => {
      try {
        const value = settingsService.getSetting(key)
        return ipcSuccess(value)
      } catch (error) {
        log.error('IPC settings:get failed:', error)
        return ipcError('SETTINGS_GET_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'settings:set',
    async (_event, key: string, value: string): Promise<IpcResult<void>> => {
      try {
        settingsService.setSetting(key, value)
        return ipcSuccess(undefined)
      } catch (error) {
        log.error('IPC settings:set failed:', error)
        return ipcError('SETTINGS_SET_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'settings:getAll',
    async (): Promise<IpcResult<Record<string, string>>> => {
      try {
        const settings = settingsService.getAllSettings()
        return ipcSuccess(settings)
      } catch (error) {
        log.error('IPC settings:getAll failed:', error)
        return ipcError('SETTINGS_GETALL_ERROR', String(error))
      }
    }
  )
}
