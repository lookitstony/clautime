import { ipcMain } from 'electron'
import log from 'electron-log/main.js'
import { credentialService } from '../services/credential-service'
import { ipcSuccess, ipcError, type IpcResult } from '../../shared/types/ipc'

export function registerAiHandlers(): void {
  ipcMain.handle(
    'ai:getMethod',
    async (): Promise<IpcResult<string>> => {
      try {
        return ipcSuccess(credentialService.getAiMethod())
      } catch (error) {
        log.error('IPC ai:getMethod failed:', error)
        return ipcError('AI_GET_METHOD_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'ai:setMethod',
    async (_event, method: string): Promise<IpcResult<void>> => {
      try {
        credentialService.setAiMethod(method)
        return ipcSuccess(undefined)
      } catch (error) {
        log.error('IPC ai:setMethod failed:', error)
        return ipcError('AI_SET_METHOD_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'ai:hasApiKey',
    async (): Promise<IpcResult<boolean>> => {
      try {
        return ipcSuccess(credentialService.hasApiKey())
      } catch (error) {
        log.error('IPC ai:hasApiKey failed:', error)
        return ipcError('AI_HAS_KEY_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'ai:storeApiKey',
    async (_event, key: string): Promise<IpcResult<void>> => {
      try {
        credentialService.storeApiKey(key)
        return ipcSuccess(undefined)
      } catch (error) {
        log.error('IPC ai:storeApiKey failed:', error)
        return ipcError('AI_STORE_KEY_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'ai:removeApiKey',
    async (): Promise<IpcResult<void>> => {
      try {
        credentialService.removeApiKey()
        return ipcSuccess(undefined)
      } catch (error) {
        log.error('IPC ai:removeApiKey failed:', error)
        return ipcError('AI_REMOVE_KEY_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'ai:testConnection',
    async (): Promise<IpcResult<boolean>> => {
      try {
        const apiKey = credentialService.getApiKey()
        if (!apiKey) return ipcSuccess(false)

        // Simple validation: check if key looks valid (starts with sk-)
        // Full validation would require an API call
        const isValid = apiKey.startsWith('sk-') && apiKey.length > 20
        return ipcSuccess(isValid)
      } catch (error) {
        log.error('IPC ai:testConnection failed:', error)
        return ipcError('AI_TEST_CONNECTION_ERROR', String(error))
      }
    }
  )
}
