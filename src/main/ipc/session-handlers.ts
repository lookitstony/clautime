import { ipcMain } from 'electron'
import log from 'electron-log/main.js'
import { sessionService } from '../services/session-service'
import { clientProjectService } from '../services/client-project-service'
import { gitService } from '../services/git-service'
import { getDb } from '../db'
import { sessions } from '../db/schema/sessions'
import { scanState } from '../db/schema/scan-state'
import { aiSummaries } from '../db/schema/ai-summaries'
import { gitCommits } from '../db/schema/git-commits'
import { rawMessages, progressEvents } from '../db/schema/raw-messages'
import { ipcSuccess, ipcError, type IpcResult } from '../../shared/types/ipc'
import type { Session, SessionFilters, ScanResult, PromptTiming, UpdateSession, GapAnalysis, TimeBreakdownDay } from '../../shared/types/session'

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
        // Auto-trigger git scan after session scan (non-blocking)
        gitService.scanCommits().then((scanResult) => {
          const correlated = gitService.correlateCommitsWithSessions()
          log.info(`Auto git scan: ${scanResult.newCommits} new commits, ${correlated} correlated`)
        }).catch((err) => {
          log.warn('Auto git scan failed (non-critical):', err)
        })
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
      db.delete(aiSummaries).run()
      db.update(gitCommits).set({ sessionId: null }).run()
      db.delete(sessions).run()
      db.delete(rawMessages).run()
      db.delete(progressEvents).run()
      db.delete(scanState).run()
      log.info('Session data reset (all tables cleared)')
      return ipcSuccess(undefined)
    } catch (error) {
      log.error('IPC session:reset failed:', error)
      return ipcError('SESSION_RESET_ERROR', String(error))
    }
  })

  ipcMain.handle('session:rebuild', async (): Promise<IpcResult<ScanResult>> => {
    try {
      const result = await sessionService.rebuildSessionsFromRaw()
      const attributedCount = clientProjectService.attributeSessions()
      gitService.scanCommits().then((scanResult) => {
        const correlated = gitService.correlateCommitsWithSessions()
        log.info(`Post-rebuild git scan: ${scanResult.newCommits} new commits, ${correlated} correlated`)
      }).catch((err) => {
        log.warn('Post-rebuild git scan failed (non-critical):', err)
      })
      return ipcSuccess({ ...result, attributedCount })
    } catch (error) {
      log.error('IPC session:rebuild failed:', error)
      return ipcError('SESSION_REBUILD_ERROR', String(error))
    }
  })

  ipcMain.handle('session:scanAndRebuild', async (): Promise<IpcResult<ScanResult>> => {
    try {
      const result = await sessionService.scanAndRebuild()
      const attributedCount = clientProjectService.attributeSessions()
      gitService.scanCommits().then((scanResult) => {
        const correlated = gitService.correlateCommitsWithSessions()
        log.info(`Post-rebuild git scan: ${scanResult.newCommits} new commits, ${correlated} correlated`)
      }).catch((err) => {
        log.warn('Post-rebuild git scan failed (non-critical):', err)
      })
      return ipcSuccess({ ...result, attributedCount })
    } catch (error) {
      log.error('IPC session:scanAndRebuild failed:', error)
      return ipcError('SESSION_SCAN_REBUILD_ERROR', String(error))
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
    'session:split',
    async (_event, id: number, splitAt: string): Promise<IpcResult<Session[]>> => {
      try {
        const [s1, s2] = sessionService.splitSession(id, splitAt)
        return ipcSuccess([s1, s2])
      } catch (error) {
        log.error('IPC session:split failed:', error)
        return ipcError('SESSION_SPLIT_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'session:getTimeBreakdown',
    async (_event, startDate: string, endDate: string): Promise<IpcResult<TimeBreakdownDay[]>> => {
      try {
        const result = sessionService.getTimeBreakdown(startDate, endDate)
        return ipcSuccess(result)
      } catch (error) {
        log.error('IPC session:getTimeBreakdown failed:', error)
        return ipcError('SESSION_TIME_BREAKDOWN_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'session:getGapAnalysis',
    async (): Promise<IpcResult<GapAnalysis>> => {
      try {
        const result = sessionService.getGapAnalysis()
        return ipcSuccess(result)
      } catch (error) {
        log.error('IPC session:getGapAnalysis failed:', error)
        return ipcError('SESSION_GAP_ANALYSIS_ERROR', String(error))
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
