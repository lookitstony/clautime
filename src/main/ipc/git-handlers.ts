import { ipcMain } from 'electron'
import log from 'electron-log/main.js'
import { gitService } from '../services/git-service'
import { ipcSuccess, ipcError, type IpcResult } from '../../shared/types/ipc'
import type {
  GitCommit,
  GitScanResult,
  GitIdentity,
  UnconfiguredAuthor
} from '../../shared/types/git'

export function registerGitHandlers(): void {
  ipcMain.handle(
    'git:scan',
    async (_event, projectFilter?: number[]): Promise<IpcResult<GitScanResult>> => {
      try {
        const scanResult = await gitService.scanCommits(projectFilter)
        const correlated = gitService.correlateCommitsWithSessions()
        return ipcSuccess({
          newCommits: scanResult.newCommits,
          projectsScanned: scanResult.projectsScanned,
          correlated
        })
      } catch (error) {
        log.error('IPC git:scan failed:', error)
        return ipcError('GIT_SCAN_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'git:getCommitsForSession',
    async (_event, sessionId: number): Promise<IpcResult<GitCommit[]>> => {
      try {
        const commits = gitService.getCommitsForSession(sessionId)
        return ipcSuccess(commits)
      } catch (error) {
        log.error('IPC git:getCommitsForSession failed:', error)
        return ipcError('GIT_COMMITS_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'git:getCommitsForProject',
    async (_event, projectId: number): Promise<IpcResult<GitCommit[]>> => {
      try {
        const commits = gitService.getCommitsForProject(projectId)
        return ipcSuccess(commits)
      } catch (error) {
        log.error('IPC git:getCommitsForProject failed:', error)
        return ipcError('GIT_PROJECT_COMMITS_ERROR', String(error))
      }
    }
  )

  ipcMain.handle('git:detectIdentity', async (): Promise<IpcResult<GitIdentity | null>> => {
    try {
      const identity = await gitService.detectGitIdentity()
      return ipcSuccess(identity)
    } catch (error) {
      log.error('IPC git:detectIdentity failed:', error)
      return ipcError('GIT_IDENTITY_ERROR', String(error))
    }
  })

  ipcMain.handle('git:getIdentity', async (): Promise<IpcResult<GitIdentity | null>> => {
    try {
      const identity = await gitService.getGitIdentity()
      return ipcSuccess(identity)
    } catch (error) {
      log.error('IPC git:getIdentity failed:', error)
      return ipcError('GIT_GET_IDENTITY_ERROR', String(error))
    }
  })

  ipcMain.handle(
    'git:setIdentity',
    async (_event, name: string, email: string): Promise<IpcResult<void>> => {
      try {
        const { settingsService } = await import('../services/settings-service')
        settingsService.setSetting('git_author_name', name)
        settingsService.setSetting('git_author_email', email)
        return ipcSuccess(undefined)
      } catch (error) {
        log.error('IPC git:setIdentity failed:', error)
        return ipcError('GIT_SET_IDENTITY_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'git:findUnconfiguredEmails',
    async (): Promise<IpcResult<UnconfiguredAuthor[]>> => {
      try {
        const emails = await gitService.findUnconfiguredAuthorEmails()
        return ipcSuccess(emails)
      } catch (error) {
        log.error('IPC git:findUnconfiguredEmails failed:', error)
        return ipcError('GIT_UNCONFIGURED_EMAILS_ERROR', String(error))
      }
    }
  )

  ipcMain.handle('git:correlate', async (): Promise<IpcResult<number>> => {
    try {
      const count = gitService.correlateCommitsWithSessions()
      return ipcSuccess(count)
    } catch (error) {
      log.error('IPC git:correlate failed:', error)
      return ipcError('GIT_CORRELATE_ERROR', String(error))
    }
  })

  ipcMain.handle(
    'git:getRemoteUrl',
    async (_event, projectId: number): Promise<IpcResult<string | null>> => {
      try {
        const url = await gitService.getRemoteUrlForProject(projectId)
        return ipcSuccess(url)
      } catch (error) {
        log.error('IPC git:getRemoteUrl failed:', error)
        return ipcError('GIT_REMOTE_URL_ERROR', String(error))
      }
    }
  )

  ipcMain.handle('git:getSessionIdsWithCommits', async (): Promise<IpcResult<number[]>> => {
    try {
      const ids = gitService.getSessionIdsWithCommits()
      return ipcSuccess(ids)
    } catch (error) {
      log.error('IPC git:getSessionIdsWithCommits failed:', error)
      return ipcError('GIT_SESSION_IDS_ERROR', String(error))
    }
  })
}
