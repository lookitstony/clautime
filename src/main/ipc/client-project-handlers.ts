import { ipcMain } from 'electron'
import log from 'electron-log/main.js'
import { clientProjectService } from '../services/client-project-service'
import { ipcSuccess, ipcError, type IpcResult } from '../../shared/types/ipc'
import type {
  Client,
  NewClient,
  UpdateClient,
  Project,
  NewProject,
  UpdateProject
} from '../../shared/types/client-project'

export function registerClientProjectHandlers(): void {
  // ── Client handlers ──

  ipcMain.handle('client:getAll', async (): Promise<IpcResult<Client[]>> => {
    try {
      return ipcSuccess(clientProjectService.getClients())
    } catch (error) {
      log.error('IPC client:getAll failed:', error)
      return ipcError('CLIENT_GET_ALL_ERROR', String(error))
    }
  })

  ipcMain.handle(
    'client:create',
    async (_event, data: NewClient): Promise<IpcResult<Client>> => {
      try {
        return ipcSuccess(clientProjectService.createClient(data))
      } catch (error) {
        log.error('IPC client:create failed:', error)
        return ipcError('CLIENT_CREATE_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'client:update',
    async (_event, id: number, data: UpdateClient): Promise<IpcResult<Client>> => {
      try {
        return ipcSuccess(clientProjectService.updateClient(id, data))
      } catch (error) {
        log.error('IPC client:update failed:', error)
        return ipcError('CLIENT_UPDATE_ERROR', String(error))
      }
    }
  )

  ipcMain.handle('client:delete', async (_event, id: number): Promise<IpcResult<void>> => {
    try {
      clientProjectService.deleteClient(id)
      return ipcSuccess(undefined)
    } catch (error) {
      log.error('IPC client:delete failed:', error)
      return ipcError('CLIENT_DELETE_ERROR', String(error))
    }
  })

  // ── Project handlers ──

  ipcMain.handle(
    'project:getAll',
    async (_event, clientId?: number): Promise<IpcResult<Project[]>> => {
      try {
        return ipcSuccess(clientProjectService.getProjects(clientId))
      } catch (error) {
        log.error('IPC project:getAll failed:', error)
        return ipcError('PROJECT_GET_ALL_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'project:create',
    async (_event, data: NewProject): Promise<IpcResult<Project>> => {
      try {
        return ipcSuccess(clientProjectService.createProject(data))
      } catch (error) {
        log.error('IPC project:create failed:', error)
        return ipcError('PROJECT_CREATE_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'project:update',
    async (_event, id: number, data: UpdateProject): Promise<IpcResult<Project>> => {
      try {
        return ipcSuccess(clientProjectService.updateProject(id, data))
      } catch (error) {
        log.error('IPC project:update failed:', error)
        return ipcError('PROJECT_UPDATE_ERROR', String(error))
      }
    }
  )

  ipcMain.handle('project:delete', async (_event, id: number): Promise<IpcResult<void>> => {
    try {
      clientProjectService.deleteProject(id)
      return ipcSuccess(undefined)
    } catch (error) {
      log.error('IPC project:delete failed:', error)
      return ipcError('PROJECT_DELETE_ERROR', String(error))
    }
  })

  ipcMain.handle('project:attributeSessions', async (): Promise<IpcResult<number>> => {
    try {
      return ipcSuccess(clientProjectService.attributeSessions())
    } catch (error) {
      log.error('IPC project:attributeSessions failed:', error)
      return ipcError('PROJECT_ATTRIBUTE_ERROR', String(error))
    }
  })
}
