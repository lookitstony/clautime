import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import log from 'electron-log/preload.js'
import type { IpcResult } from '../shared/types/ipc'

// Custom APIs for renderer — typed service interfaces
const api = {
  dialog: {
    openFolder: (): Promise<IpcResult<string | null>> =>
      ipcRenderer.invoke('dialog:openFolder'),
    discoverProjects: (
      folderPath?: string
    ): Promise<IpcResult<import('../shared/types/session').DiscoveredProject[]>> =>
      ipcRenderer.invoke('dialog:discoverProjects', folderPath)
  },
  settings: {
    get: (key: string): Promise<IpcResult<string | null>> =>
      ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('settings:set', key, value),
    getAll: (): Promise<IpcResult<Record<string, string>>> =>
      ipcRenderer.invoke('settings:getAll')
  },
  sessions: {
    scan: (
      claudeDir?: string,
      projectFilter?: string[]
    ): Promise<IpcResult<import('../shared/types/session').ScanResult>> =>
      ipcRenderer.invoke('session:scan', claudeDir, projectFilter),
    reset: (): Promise<IpcResult<void>> => ipcRenderer.invoke('session:reset'),
    rebuild: (): Promise<IpcResult<import('../shared/types/session').ScanResult>> =>
      ipcRenderer.invoke('session:rebuild'),
    scanAndRebuild: (): Promise<IpcResult<import('../shared/types/session').ScanResult>> =>
      ipcRenderer.invoke('session:scanAndRebuild'),
    getAll: (
      filters?: import('../shared/types/session').SessionFilters
    ): Promise<IpcResult<import('../shared/types/session').Session[]>> =>
      ipcRenderer.invoke('session:getAll', filters),
    getById: (
      id: number
    ): Promise<IpcResult<import('../shared/types/session').Session | null>> =>
      ipcRenderer.invoke('session:getById', id),
    getPromptTimings: (
      sessionId: number
    ): Promise<IpcResult<import('../shared/types/session').PromptTiming[]>> =>
      ipcRenderer.invoke('session:getPromptTimings', sessionId),
    update: (
      id: number,
      data: import('../shared/types/session').UpdateSession
    ): Promise<IpcResult<import('../shared/types/session').Session>> =>
      ipcRenderer.invoke('session:update', id, data),
    delete: (id: number): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('session:delete', id),
    split: (
      id: number,
      splitAt: string
    ): Promise<IpcResult<import('../shared/types/session').Session[]>> =>
      ipcRenderer.invoke('session:split', id, splitAt),
    getTimeBreakdown: (startDate: string, endDate: string): Promise<IpcResult<import('../shared/types/session').TimeBreakdownDay[]>> =>
      ipcRenderer.invoke('session:getTimeBreakdown', startDate, endDate),
    getGapAnalysis: (): Promise<IpcResult<import('../shared/types/session').GapAnalysis>> =>
      ipcRenderer.invoke('session:getGapAnalysis'),
    create: (
      data: {
        projectPath: string
        startedAt: string
        endedAt: string
        durationMinutes: number
        description?: string
        projectId?: number | null
        clientId?: number | null
      }
    ): Promise<IpcResult<import('../shared/types/session').Session>> =>
      ipcRenderer.invoke('session:create', data)
  },
  clients: {
    getAll: (): Promise<IpcResult<import('../shared/types/client-project').Client[]>> =>
      ipcRenderer.invoke('client:getAll'),
    create: (
      data: import('../shared/types/client-project').NewClient
    ): Promise<IpcResult<import('../shared/types/client-project').Client>> =>
      ipcRenderer.invoke('client:create', data),
    update: (
      id: number,
      data: import('../shared/types/client-project').UpdateClient
    ): Promise<IpcResult<import('../shared/types/client-project').Client>> =>
      ipcRenderer.invoke('client:update', id, data),
    delete: (id: number): Promise<IpcResult<void>> => ipcRenderer.invoke('client:delete', id)
  },
  ai: {
    getMethod: (): Promise<IpcResult<string>> => ipcRenderer.invoke('ai:getMethod'),
    setMethod: (method: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('ai:setMethod', method),
    hasApiKey: (): Promise<IpcResult<boolean>> => ipcRenderer.invoke('ai:hasApiKey'),
    storeApiKey: (key: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('ai:storeApiKey', key),
    removeApiKey: (): Promise<IpcResult<void>> => ipcRenderer.invoke('ai:removeApiKey'),
    testConnection: (): Promise<IpcResult<boolean>> => ipcRenderer.invoke('ai:testConnection'),
    getSummary: (
      sessionId: number
    ): Promise<IpcResult<{ summary: string; tier: string }>> =>
      ipcRenderer.invoke('ai:getSummary', sessionId),
    generateSummary: (
      sessionId: number
    ): Promise<IpcResult<string | null>> =>
      ipcRenderer.invoke('ai:generateSummary', sessionId),
    generateBatch: (
      sessionIds: number[]
    ): Promise<IpcResult<number>> => ipcRenderer.invoke('ai:generateBatch', sessionIds),
    generateReportSummary: (
      filters: { startDate: string; endDate: string; projectId?: number; clientId?: number },
      useAi?: boolean,
      summaryOptions?: { includeOverall?: boolean; includeDailyBreakdown?: boolean }
    ): Promise<IpcResult<string | null>> =>
      ipcRenderer.invoke('ai:generateReportSummary', filters, useAi, summaryOptions)
  },
  git: {
    scan: (
      projectFilter?: number[]
    ): Promise<IpcResult<import('../shared/types/git').GitScanResult>> =>
      ipcRenderer.invoke('git:scan', projectFilter),
    getCommitsForSession: (
      sessionId: number
    ): Promise<IpcResult<import('../shared/types/git').GitCommit[]>> =>
      ipcRenderer.invoke('git:getCommitsForSession', sessionId),
    getCommitsForProject: (
      projectId: number
    ): Promise<IpcResult<import('../shared/types/git').GitCommit[]>> =>
      ipcRenderer.invoke('git:getCommitsForProject', projectId),
    detectIdentity: (): Promise<IpcResult<import('../shared/types/git').GitIdentity | null>> =>
      ipcRenderer.invoke('git:detectIdentity'),
    getIdentity: (): Promise<IpcResult<import('../shared/types/git').GitIdentity | null>> =>
      ipcRenderer.invoke('git:getIdentity'),
    setIdentity: (
      name: string,
      email: string
    ): Promise<IpcResult<void>> => ipcRenderer.invoke('git:setIdentity', name, email),
    correlate: (): Promise<IpcResult<number>> => ipcRenderer.invoke('git:correlate'),
    getSessionIdsWithCommits: (): Promise<IpcResult<number[]>> =>
      ipcRenderer.invoke('git:getSessionIdsWithCommits'),
    getRemoteUrl: (projectId: number): Promise<IpcResult<string | null>> =>
      ipcRenderer.invoke('git:getRemoteUrl', projectId)
  },
  updater: {
    checkForUpdates: (): Promise<import('../shared/types/ipc').IpcResult<void>> =>
      ipcRenderer.invoke('updater:checkForUpdates'),
    downloadAndInstall: (): Promise<import('../shared/types/ipc').IpcResult<void>> =>
      ipcRenderer.invoke('updater:downloadAndInstall'),
    getVersion: (): Promise<import('../shared/types/ipc').IpcResult<string>> =>
      ipcRenderer.invoke('updater:getVersion'),
    onUpdateAvailable: (callback: (info: { version: string; releaseDate: string }) => void) => {
      ipcRenderer.on('updater:update-available', (_event, info) => callback(info))
    },
    onUpdateDownloaded: (callback: () => void) => {
      ipcRenderer.on('updater:update-downloaded', () => callback())
    }
  },
  reports: {
    generate: (
      filters: import('../shared/types/report').ReportFilters,
      format: import('../shared/types/report').ReportFormat
    ): Promise<import('../shared/types/ipc').IpcResult<import('../shared/types/report').ReportResult>> =>
      ipcRenderer.invoke('report:generate', filters, format),
    exportPdf: (html: string, filename?: string): Promise<import('../shared/types/ipc').IpcResult<string | null>> =>
      ipcRenderer.invoke('report:exportPdf', html, filename),
    exportFile: (content: string, defaultFilename: string, filterName: string, extension: string): Promise<import('../shared/types/ipc').IpcResult<string | null>> =>
      ipcRenderer.invoke('report:exportFile', content, defaultFilename, filterName, extension),
    openFile: (filePath: string): Promise<import('../shared/types/ipc').IpcResult<boolean>> =>
      ipcRenderer.invoke('report:openFile', filePath)
  },
  live: {
    getTodayStats: () => ipcRenderer.invoke('live:getTodayStats'),
    getProjectStatuses: () => ipcRenderer.invoke('live:getProjectStatuses'),
    setWatching: (projectId: number, enabled: boolean) =>
      ipcRenderer.invoke('live:setWatching', projectId, enabled),
    getAlertConfig: (projectId: number) =>
      ipcRenderer.invoke('live:getAlertConfig', projectId),
    setAlertConfig: (projectId: number, alertSound: string) =>
      ipcRenderer.invoke('live:setAlertConfig', projectId, alertSound),
    getAvailableSounds: () => ipcRenderer.invoke('live:getAvailableSounds'),
    playTestSound: () => ipcRenderer.invoke('live:playTestSound'),
    selectCustomSound: () => ipcRenderer.invoke('live:selectCustomSound'),
    onSessionsUpdated: (callback: () => void) => {
      ipcRenderer.on('watcher:sessionsUpdated', () => callback())
    },
    onNewProject: (callback: (info: { dirName: string; decodedPath: string; projectName: string }) => void) => {
      ipcRenderer.on('watcher:newProject', (_event, info) => callback(info))
    },
    timerStarted: (projectName: string, startedAt: string) =>
      ipcRenderer.invoke('live:timerStarted', projectName, startedAt),
    timerStopped: () => ipcRenderer.invoke('live:timerStopped'),
    toggleWidget: (projectId: number) => ipcRenderer.invoke('live:toggleWidget', projectId),
    showAllWidgets: (projectIds: number[]) => ipcRenderer.invoke('live:showAllWidgets', projectIds),
    hideAllWidgets: () => ipcRenderer.invoke('live:hideAllWidgets'),
    showStopDialog: (projectId: number) => ipcRenderer.invoke('live:showStopDialog', projectId),
    getWidgetHotkey: () => ipcRenderer.invoke('live:getWidgetHotkey'),
    setWidgetHotkey: (accelerator: string) => ipcRenderer.invoke('live:setWidgetHotkey', accelerator),
    onWidgetAlert: (callback: (info: { projectName: string }) => void) => {
      ipcRenderer.on('widget:alert', (_event, info) => callback(info))
    },
    onOpenStopDialog: (callback: (projectId: number) => void) => {
      ipcRenderer.on('live:openStopDialog', (_event, projectId) => callback(projectId))
    }
  },
  secretScan: {
    run: (): Promise<IpcResult<import('../shared/types/secret-scan').SecretScanResult>> =>
      ipcRenderer.invoke('secretScan:run'),
    cancel: (): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('secretScan:cancel'),
    getFindings: (limit?: number, offset?: number): Promise<IpcResult<import('../shared/types/secret-scan').SecretFinding[]>> =>
      ipcRenderer.invoke('secretScan:getFindings', limit, offset),
    getSummary: (): Promise<IpcResult<import('../shared/types/secret-scan').SecretScanSummary>> =>
      ipcRenderer.invoke('secretScan:getSummary'),
    ignoreFinding: (id: number): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('secretScan:ignoreFinding', id),
    redactFinding: (id: number): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('secretScan:redactFinding', id),
    redactAll: (): Promise<IpcResult<number>> =>
      ipcRenderer.invoke('secretScan:redactAll'),
    getCustomPatterns: (): Promise<IpcResult<import('../shared/types/secret-scan').CustomSecretPattern[]>> =>
      ipcRenderer.invoke('secretScan:getCustomPatterns'),
    upsertCustomPattern: (pattern: import('../shared/types/secret-scan').CustomSecretPattern): Promise<IpcResult<{ success: boolean; warnings: string[] }>> =>
      ipcRenderer.invoke('secretScan:upsertCustomPattern', pattern),
    deleteCustomPattern: (id: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('secretScan:deleteCustomPattern', id),
    testPattern: (source: string, flags: string, testString: string): Promise<IpcResult<import('../shared/types/secret-scan').PatternTestResult>> =>
      ipcRenderer.invoke('secretScan:testPattern', source, flags, testString)
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    hide: () => ipcRenderer.invoke('window:hide'),
    quit: () => ipcRenderer.invoke('window:quit'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:isMaximized'),
    onMaximizedChanged: (callback: (isMaximized: boolean) => void) => {
      ipcRenderer.on('window:maximized-changed', (_event, val) => callback(val))
    },
    onCloseRequested: (callback: () => void) => {
      ipcRenderer.on('window:close-requested', () => callback())
    }
  },
  projects: {
    getAll: (
      clientId?: number
    ): Promise<IpcResult<import('../shared/types/client-project').Project[]>> =>
      ipcRenderer.invoke('project:getAll', clientId),
    create: (
      data: import('../shared/types/client-project').NewProject
    ): Promise<IpcResult<import('../shared/types/client-project').Project>> =>
      ipcRenderer.invoke('project:create', data),
    update: (
      id: number,
      data: import('../shared/types/client-project').UpdateProject
    ): Promise<IpcResult<import('../shared/types/client-project').Project>> =>
      ipcRenderer.invoke('project:update', id, data),
    delete: (id: number): Promise<IpcResult<void>> => ipcRenderer.invoke('project:delete', id),
    attributeSessions: (): Promise<IpcResult<number>> =>
      ipcRenderer.invoke('project:attributeSessions')
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    log.error('Failed to expose APIs via contextBridge:', error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
