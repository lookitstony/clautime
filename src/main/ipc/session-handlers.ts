import { ipcMain } from 'electron'
import log from 'electron-log/main.js'
import { sessionService } from '../services/session-service'
import { clientProjectService } from '../services/client-project-service'
import { getDb } from '../db'
import { sessions } from '../db/schema/sessions'
import { scanState } from '../db/schema/scan-state'
import { ipcSuccess, ipcError, type IpcResult } from '../../shared/types/ipc'
import type { Session, SessionFilters, ScanResult, PromptTiming, UpdateSession } from '../../shared/types/session'

export function registerSessionHandlers(): void {
  ipcMain.handle(
    'session:scan',
    async (
      _event,
      claudeDir?: string,
      projectFilter?: string[]
    ): Promise<IpcResult<ScanResult>> => {
      try {
        const result = await sessionService.scanSessions(claudeDir, projectFilter)
        const attributedCount = clientProjectService.attributeSessions()
        return ipcSuccess({ ...result, attributedCount })
      } catch (error) {
        log.error('IPC session:scan failed:', error)
        return ipcError('SESSION_SCAN_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'session:getAll',
    async (_event, filters?: SessionFilters): Promise<IpcResult<Session[]>> => {
      try {
        const result = sessionService.getAllSessions(filters)
        return ipcSuccess(result)
      } catch (error) {
        log.error('IPC session:getAll failed:', error)
        return ipcError('SESSION_GET_ALL_ERROR', String(error))
      }
    }
  )

  ipcMain.handle('session:reset', async (): Promise<IpcResult<void>> => {
    try {
      const db = getDb()
      db.delete(sessions).run()
      db.delete(scanState).run()
      log.info('Session data reset')
      return ipcSuccess(undefined)
    } catch (error) {
      log.error('IPC session:reset failed:', error)
      return ipcError('SESSION_RESET_ERROR', String(error))
    }
  })

  ipcMain.handle(
    'session:getById',
    async (_event, id: number): Promise<IpcResult<Session | null>> => {
      try {
        const result = sessionService.getSessionById(id)
        return ipcSuccess(result)
      } catch (error) {
        log.error('IPC session:getById failed:', error)
        return ipcError('SESSION_GET_BY_ID_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'session:getPromptTimings',
    async (_event, sessionId: number): Promise<IpcResult<PromptTiming[]>> => {
      try {
        const result = await sessionService.getPromptTimings(sessionId)
        return ipcSuccess(result)
      } catch (error) {
        log.error('IPC session:getPromptTimings failed:', error)
        return ipcError('SESSION_PROMPT_TIMINGS_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'session:update',
    async (_event, id: number, data: UpdateSession): Promise<IpcResult<Session>> => {
      try {
        const result = sessionService.updateSession(id, data)
        return ipcSuccess(result)
      } catch (error) {
        log.error('IPC session:update failed:', error)
        return ipcError('SESSION_UPDATE_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'session:delete',
    async (_event, id: number): Promise<IpcResult<void>> => {
      try {
        sessionService.deleteSession(id)
        return ipcSuccess(undefined)
      } catch (error) {
        log.error('IPC session:delete failed:', error)
        return ipcError('SESSION_DELETE_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'session:create',
    async (
      _event,
      data: {
        projectPath: string
        startedAt: string
        endedAt: string
        durationMinutes: number
        description?: string
        projectId?: number | null
        clientId?: number | null
      }
    ): Promise<IpcResult<Session>> => {
      try {
        const result = sessionService.createSession(data)
        return ipcSuccess(result)
      } catch (error) {
        log.error('IPC session:create failed:', error)
        return ipcError('SESSION_CREATE_ERROR', String(error))
      }
    }
  )
}
