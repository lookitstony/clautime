import { getDb } from '../db'
import { assertFreshSyncEdit } from '../services/folder-sync-edit-version'
import { ipcMain } from 'electron'
import log from 'electron-log/main.js'
import { clientProjectService } from '../services/client-project-service'
import {
  getLocalProjectSetupStatus,
  completeLocalProjectSetup
} from '../services/local-project-setup'
import { fileWatcherService } from '../services/file-watcher-service'
import type { LegacyFolderSelection } from '../../shared/types/local-project-setup'
import { AppError, ipcSuccess, ipcError, type IpcResult } from '../../shared/types/ipc'
import type {
  Client,
  NewClient,
  UpdateClient,
  Project,
  NewProject,
  UpdateProject
} from '../../shared/types/client-project'

export function registerClientProjectHandlers(): void {
  ipcMain.handle('project:getLocalSetup', async () => {
    try {
      return ipcSuccess(getLocalProjectSetupStatus())
    } catch (error) {
      return ipcError('LOCAL_SETUP_ERROR', String(error))
    }
  })
  ipcMain.handle(
    'project:completeLocalSetup',
    async (_event, selections: LegacyFolderSelection[]) => {
      try {
        completeLocalProjectSetup(selections)
        await fileWatcherService._runStartupScan()
        return ipcSuccess(getLocalProjectSetupStatus())
      } catch (error) {
        return ipcError('LOCAL_SETUP_ERROR', String(error))
      }
    }
  )
  // ── Client handlers ──

  ipcMain.handle('client:getAll', async (): Promise<IpcResult<Client[]>> => {
    try {
      return ipcSuccess(clientProjectService.getClients())
    } catch (error) {
      log.error('IPC client:getAll failed:', error)
      return ipcError('CLIENT_GET_ALL_ERROR', String(error))
    }
  })

  ipcMain.handle('client:create', async (_event, data: NewClient): Promise<IpcResult<Client>> => {
    try {
      return ipcSuccess(clientProjectService.createClient(data))
    } catch (error) {
      log.error('IPC client:create failed:', error)
      return ipcError('CLIENT_CREATE_ERROR', String(error))
    }
  })

  ipcMain.handle(
    'client:update',
    async (_event, id: number, data: UpdateClient): Promise<IpcResult<Client>> => {
      try {
        return ipcSuccess(clientProjectService.updateClient(id, data, { requireSyncVersion: true }))
      } catch (error) {
        log.error('IPC client:update failed:', error)
        return ipcError(
          error instanceof AppError ? error.code : 'CLIENT_UPDATE_ERROR',
          error instanceof Error ? error.message : String(error)
        )
      }
    }
  )

  ipcMain.handle(
    'client:delete',
    async (_event, id: number, expectedSyncVersion?: string): Promise<IpcResult<void>> => {
      try {
        assertFreshSyncEdit(getDb(), { kind: 'client', id }, expectedSyncVersion, true)
        clientProjectService.deleteClient(id)
        return ipcSuccess(undefined)
      } catch (error) {
        log.error('IPC client:delete failed:', error)
        return ipcError('CLIENT_DELETE_ERROR', String(error))
      }
    }
  )

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
        return ipcSuccess(
          clientProjectService.updateProject(id, data, { requireSyncVersion: true })
        )
      } catch (error) {
        log.error('IPC project:update failed:', error)
        return ipcError(
          error instanceof AppError ? error.code : 'PROJECT_UPDATE_ERROR',
          error instanceof Error ? error.message : String(error)
        )
      }
    }
  )

  ipcMain.handle(
    'project:delete',
    async (_event, id: number, expectedSyncVersion?: string): Promise<IpcResult<void>> => {
      try {
        assertFreshSyncEdit(getDb(), { kind: 'project', id }, expectedSyncVersion, true)
        clientProjectService.deleteProject(id)
        return ipcSuccess(undefined)
      } catch (error) {
        log.error('IPC project:delete failed:', error)
        return ipcError('PROJECT_DELETE_ERROR', String(error))
      }
    }
  )

  ipcMain.handle('project:getMarkerStatus', async (_event, id: number) => {
    try {
      return ipcSuccess(clientProjectService.getProjectMarkerStatus(id))
    } catch (error) {
      log.error('IPC project:getMarkerStatus failed:', error)
      return ipcError('PROJECT_MARKER_ERROR', String(error))
    }
  })

  ipcMain.handle('project:setMarkerInGit', async (_event, id: number, keep: boolean) => {
    try {
      return ipcSuccess(clientProjectService.setProjectMarkerInGit(id, keep === true))
    } catch (error) {
      log.error('IPC project:setMarkerInGit failed:', error)
      return ipcError('PROJECT_MARKER_ERROR', String(error))
    }
  })

  ipcMain.handle('project:getFolderSuggestions', async () => {
    try {
      return ipcSuccess(clientProjectService.getFolderSuggestions())
    } catch (error) {
      log.error('IPC project:getFolderSuggestions failed:', error)
      return ipcError('PROJECT_LINK_ERROR', String(error))
    }
  })

  ipcMain.handle(
    'project:linkSuggestedFolder',
    async (_event, projectId: unknown, directoryPath: unknown): Promise<IpcResult<void>> => {
      try {
        if (typeof projectId !== 'number' || typeof directoryPath !== 'string')
          return ipcError('INVALID_ARGUMENTS', 'A project ID and folder path are required')
        clientProjectService.linkSuggestedFolder(projectId, directoryPath)
        return ipcSuccess(undefined)
      } catch (error) {
        log.error('IPC project:linkSuggestedFolder failed:', error)
        return ipcError(
          error instanceof AppError ? error.code : 'PROJECT_LINK_ERROR',
          error instanceof AppError ? error.message : String(error)
        )
      }
    }
  )

  ipcMain.handle(
    'project:declineSuggestedFolder',
    async (_event, directoryPath: unknown): Promise<IpcResult<void>> => {
      try {
        if (typeof directoryPath !== 'string')
          return ipcError('INVALID_ARGUMENTS', 'A folder path is required')
        clientProjectService.declineSuggestedFolder(directoryPath)
        return ipcSuccess(undefined)
      } catch (error) {
        log.error('IPC project:declineSuggestedFolder failed:', error)
        return ipcError(
          error instanceof AppError ? error.code : 'PROJECT_LINK_ERROR',
          error instanceof AppError ? error.message : String(error)
        )
      }
    }
  )

  ipcMain.handle('project:attributeSessions', async (): Promise<IpcResult<number>> => {
    try {
      return ipcSuccess(clientProjectService.attributeSessions())
    } catch (error) {
      log.error('IPC project:attributeSessions failed:', error)
      return ipcError('PROJECT_ATTRIBUTE_ERROR', String(error))
    }
  })
}
