import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import log from 'electron-log/preload.js'
import type { IpcResult } from '../shared/types/ipc'

// Custom APIs for renderer — typed service interfaces
const api = {
  syncConflicts: {
    list: (options?: { presentation?: boolean }) =>
      ipcRenderer.invoke('folderSync:conflicts:list', options),
    resolve: (resolution: import('../shared/types/sync-conflict').SyncConflictResolution) =>
      ipcRenderer.invoke('folderSync:conflicts:resolve', resolution)
  },
  folderSync: {
    status: () => ipcRenderer.invoke('folderSync:status'),
    discover: (folder: string) => ipcRenderer.invoke('folderSync:discover', folder),
    connect: (input: import('../shared/types/folder-sync').ConnectFolderSync) =>
      ipcRenderer.invoke('folderSync:connect', input),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke('folderSync:setEnabled', enabled),
    syncNow: () => ipcRenderer.invoke('folderSync:syncNow'),
    joinReview: () => ipcRenderer.invoke('folderSync:joinReview'),
    applyJoinReview: (input: import('../shared/types/folder-sync').ApplyFolderSyncJoinReview) =>
      ipcRenderer.invoke('folderSync:applyJoinReview', input)
  } satisfies import('../shared/types/folder-sync').FolderSyncApi,
  machines: {
    coverage: () => ipcRenderer.invoke('machine:coverage'),
    list: () => ipcRenderer.invoke('machine:list'),
    rename: (input: import('../shared/types/source-machine').RenameSourceMachineInput) =>
      ipcRenderer.invoke('machine:rename', input)
  } satisfies import('../shared/types/source-machine').SourceMachineApi,
  workspace: {
    getPolicy: (): Promise<
      IpcResult<import('../shared/types/workspace-policy').WorkspacePolicyState | null>
    > => ipcRenderer.invoke('workspace:getPolicy'),
    reviewPolicy: (
      request: import('../shared/types/workspace-policy').WorkspacePolicyReviewRequest
    ): Promise<IpcResult<import('../shared/types/workspace-policy').WorkspacePolicyReview>> =>
      ipcRenderer.invoke('workspace:reviewPolicy', request),
    applyPolicy: (
      request: import('../shared/types/workspace-policy').WorkspacePolicyApplyRequest
    ): Promise<IpcResult<void>> => ipcRenderer.invoke('workspace:applyPolicy', request),
    reviewActivity: (): Promise<
      IpcResult<import('../shared/types/workspace-policy').WorkspaceActivityAdoptionReview>
    > => ipcRenderer.invoke('workspace:reviewActivity'),
    adoptActivity: (fingerprint: string, sessionIds: number[]): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('workspace:adoptActivity', fingerprint, sessionIds)
  },
  dialog: {
    openFolder: (): Promise<IpcResult<string | null>> => ipcRenderer.invoke('dialog:openFolder'),
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
    getAll: (): Promise<IpcResult<Record<string, string>>> => ipcRenderer.invoke('settings:getAll')
  },
  sessions: {
    replaceSavedHistory: (
      sourceFile: string,
      fingerprint: string,
      choices?: import('../shared/types/session').SessionReplacementChoice[]
    ): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('session:replaceSavedHistory', sourceFile, fingerprint, choices),
    mapSavedHistory: (
      sourceFile: string,
      fingerprint: string,
      mappings: import('../shared/types/session').SessionActivityMapping[]
    ): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('session:mapSavedHistory', sourceFile, fingerprint, mappings),
    keepSavedHistory: (sourceFile: string, fingerprint: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('session:keepSavedHistory', sourceFile, fingerprint),
    getReconciliationCases: (): Promise<
      IpcResult<import('../shared/types/session').SessionReconciliationCase[]>
    > => ipcRenderer.invoke('session:getReconciliationCases'),
    recheckReconciliation: (
      sourceFile: string
    ): Promise<IpcResult<import('../shared/types/session').ScanResult>> =>
      ipcRenderer.invoke('session:recheckReconciliation', sourceFile),
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
    getById: (id: number): Promise<IpcResult<import('../shared/types/session').Session | null>> =>
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
    delete: (id: number, expectedSyncVersion?: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('session:delete', id, expectedSyncVersion),
    split: (
      id: number,
      splitAt: string,
      expectedSyncVersion?: string
    ): Promise<IpcResult<import('../shared/types/session').Session[]>> =>
      ipcRenderer.invoke('session:split', id, splitAt, expectedSyncVersion),
    getTimeBreakdown: (
      startDate: string,
      endDate: string
    ): Promise<IpcResult<import('../shared/types/session').TimeBreakdownDay[]>> =>
      ipcRenderer.invoke('session:getTimeBreakdown', startDate, endDate),
    getGapAnalysis: (): Promise<IpcResult<import('../shared/types/session').GapAnalysis>> =>
      ipcRenderer.invoke('session:getGapAnalysis'),
    getModelUsage: (
      filters?: import('../shared/types/session').ModelUsageFilters
    ): Promise<IpcResult<import('../shared/types/session').ModelUsageAggregate[]>> =>
      ipcRenderer.invoke('session:getModelUsage', filters),
    create: (data: {
      projectPath: string
      startedAt: string
      endedAt: string
      durationMinutes: number
      description?: string
      projectId?: number | null
      clientId?: number | null
    }): Promise<IpcResult<import('../shared/types/session').Session>> =>
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
    delete: (id: number, expectedSyncVersion?: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('client:delete', id, expectedSyncVersion)
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
    getSummary: (sessionId: number): Promise<IpcResult<{ summary: string; tier: string }>> =>
      ipcRenderer.invoke('ai:getSummary', sessionId),
    generateSummary: (sessionId: number): Promise<IpcResult<string | null>> =>
      ipcRenderer.invoke('ai:generateSummary', sessionId),
    generateBatch: (sessionIds: number[]): Promise<IpcResult<number>> =>
      ipcRenderer.invoke('ai:generateBatch', sessionIds),
    generateReportSummary: (
      filters: { startDate: string; endDate: string; projectId?: number; clientId?: number },
      useAi?: boolean,
      summaryOptions?: {
        includeOverall?: boolean
        includeDailyBreakdown?: boolean
        brief?: boolean
      }
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
    setIdentity: (name: string, email: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('git:setIdentity', name, email),
    findUnconfiguredEmails: (): Promise<
      IpcResult<import('../shared/types/git').UnconfiguredAuthor[]>
    > => ipcRenderer.invoke('git:findUnconfiguredEmails'),
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
    installAndRestart: (): Promise<import('../shared/types/ipc').IpcResult<void>> =>
      ipcRenderer.invoke('updater:installAndRestart'),
    getVersion: (): Promise<import('../shared/types/ipc').IpcResult<string>> =>
      ipcRenderer.invoke('updater:getVersion'),
    onUpdateAvailable: (callback: (info: { version: string; releaseDate: string }) => void) => {
      ipcRenderer.on('updater:update-available', (_event, info) => callback(info))
    },
    onUpdateNotAvailable: (callback: (info: { version?: string }) => void) => {
      ipcRenderer.on('updater:update-not-available', (_event, info) => callback(info))
    },
    onUpdateDownloaded: (callback: () => void) => {
      ipcRenderer.on('updater:update-downloaded', () => callback())
    },
    onUpdateError: (callback: (info: { message: string }) => void) => {
      ipcRenderer.on('updater:error', (_event, info) => callback(info))
    }
  },
  reports: {
    generate: (
      filters: import('../shared/types/report').ReportFilters,
      format: import('../shared/types/report').ReportFormat
    ): Promise<
      import('../shared/types/ipc').IpcResult<import('../shared/types/report').ReportResult>
    > => ipcRenderer.invoke('report:generate', filters, format),
    exportPdf: (
      html: string,
      filename?: string
    ): Promise<import('../shared/types/ipc').IpcResult<string | null>> =>
      ipcRenderer.invoke('report:exportPdf', html, filename),
    exportFile: (
      content: string,
      defaultFilename: string,
      filterName: string,
      extension: string
    ): Promise<import('../shared/types/ipc').IpcResult<string | null>> =>
      ipcRenderer.invoke('report:exportFile', content, defaultFilename, filterName, extension),
    openFile: (filePath: string): Promise<import('../shared/types/ipc').IpcResult<boolean>> =>
      ipcRenderer.invoke('report:openFile', filePath)
  },
  live: {
    getTodayStats: () => ipcRenderer.invoke('live:getTodayStats'),
    getProjectStatuses: () => ipcRenderer.invoke('live:getProjectStatuses'),
    setWatching: (projectId: number, enabled: boolean) =>
      ipcRenderer.invoke('live:setWatching', projectId, enabled),
    getAlertConfig: (projectId: number) => ipcRenderer.invoke('live:getAlertConfig', projectId),
    setAlertConfig: (projectId: number, alertSound: string) =>
      ipcRenderer.invoke('live:setAlertConfig', projectId, alertSound),
    getAvailableSounds: () => ipcRenderer.invoke('live:getAvailableSounds'),
    playTestSound: () => ipcRenderer.invoke('live:playTestSound'),
    selectCustomSound: () => ipcRenderer.invoke('live:selectCustomSound'),
    onSessionsUpdated: (
      callback: (errors?: import('../shared/types/session').SessionScanError[]) => void
    ) => {
      ipcRenderer.on('watcher:sessionsUpdated', (_event, data) => callback(data?.errors))
    },
    onNewProject: (
      callback: (info: { dirName: string; decodedPath: string; projectName: string }) => void
    ) => {
      ipcRenderer.on('watcher:newProject', (_event, info) => callback(info))
    },
    timerStarted: (projectName: string, startedAt: string) =>
      ipcRenderer.invoke('live:timerStarted', projectName, startedAt),
    timerStopped: () => ipcRenderer.invoke('live:timerStopped'),
    toggleWidget: (projectId: number) => ipcRenderer.invoke('live:toggleWidget', projectId),
    showAllWidgets: (projectIds: number[]) => ipcRenderer.invoke('live:showAllWidgets', projectIds),
    hideAllWidgets: () => ipcRenderer.invoke('live:hideAllWidgets'),
    getVisibleWidgets: () => ipcRenderer.invoke('live:getVisibleWidgets'),
    onWidgetStateChanged: (callback: (projectIds: number[]) => void) => {
      const handler = (_event: unknown, projectIds: number[]): void => callback(projectIds)
      ipcRenderer.on('widget:stateChanged', handler)
      return () => ipcRenderer.removeListener('widget:stateChanged', handler)
    },
    showStopDialog: (projectId: number) => ipcRenderer.invoke('live:showStopDialog', projectId),
    getWidgetHotkey: () => ipcRenderer.invoke('live:getWidgetHotkey'),
    setWidgetHotkey: (accelerator: string) =>
      ipcRenderer.invoke('live:setWidgetHotkey', accelerator),
    onWidgetAlert: (callback: (info: { projectName: string }) => void) => {
      ipcRenderer.on('widget:alert', (_event, info) => callback(info))
    },
    onOpenStopDialog: (callback: (projectId: number) => void) => {
      ipcRenderer.on('live:openStopDialog', (_event, projectId) => callback(projectId))
    }
  },
  invoice: {
    getPendingOperations: (): Promise<
      IpcResult<import('../shared/types/invoice').PendingInvoiceOperation[]>
    > => ipcRenderer.invoke('invoice:getPendingOperations'),
    resumeDraftInvoice: (
      operationId: string
    ): Promise<IpcResult<import('../shared/types/invoice').DraftInvoice>> =>
      ipcRenderer.invoke('invoice:resumeDraftInvoice', operationId),
    cancelInvoiceOperation: (
      operationId: string
    ): Promise<IpcResult<{ basis: 'rejected-before-invoice' | 'draft-deleted' }>> =>
      ipcRenderer.invoke('invoice:cancelInvoiceOperation', operationId),
    hasStripeKey: (): Promise<IpcResult<boolean>> => ipcRenderer.invoke('invoice:hasStripeKey'),
    isTestMode: (): Promise<IpcResult<boolean>> => ipcRenderer.invoke('invoice:isTestMode'),
    storeStripeKey: (key: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('invoice:storeStripeKey', key),
    removeStripeKey: (): Promise<IpcResult<void>> => ipcRenderer.invoke('invoice:removeStripeKey'),
    testConnection: (): Promise<IpcResult<boolean>> => ipcRenderer.invoke('invoice:testConnection'),
    syncCustomer: (
      clientId: number,
      operationId: string
    ): Promise<IpcResult<import('../shared/types/invoice').StripeCustomerInfo>> =>
      ipcRenderer.invoke('invoice:syncCustomer', clientId, operationId),
    createDraftInvoice: (
      request: import('../shared/types/invoice').CreateInvoiceRequest
    ): Promise<IpcResult<import('../shared/types/invoice').DraftInvoice>> =>
      ipcRenderer.invoke('invoice:createDraftInvoice', request),
    sendInvoice: (
      invoiceId: string
    ): Promise<IpcResult<import('../shared/types/invoice').InvoiceStatus>> =>
      ipcRenderer.invoke('invoice:sendInvoice', invoiceId),
    getInvoiceStatus: (
      invoiceId: string
    ): Promise<IpcResult<import('../shared/types/invoice').InvoiceStatus>> =>
      ipcRenderer.invoke('invoice:getInvoiceStatus', invoiceId),
    voidInvoice: (
      invoiceId: string
    ): Promise<IpcResult<import('../shared/types/invoice').InvoiceStatus>> =>
      ipcRenderer.invoke('invoice:voidInvoice', invoiceId),
    generateLineItems: (request: {
      clientId: number
      startDate: string
      endDate: string
      projectId?: number
    }): Promise<IpcResult<import('../shared/types/invoice').GenerateLineItemsResult>> =>
      ipcRenderer.invoke('invoice:generateLineItems', request),
    getAll: (filters?: {
      clientId?: number
      status?: string
    }): Promise<IpcResult<import('../shared/types/invoice').LocalInvoice[]>> =>
      ipcRenderer.invoke('invoice:getAll', filters),
    getById: (
      localId: number
    ): Promise<IpcResult<import('../shared/types/invoice').LocalInvoiceDetail | null>> =>
      ipcRenderer.invoke('invoice:getById', localId),
    syncLocalStatus: (
      localId: number
    ): Promise<IpcResult<import('../shared/types/invoice').LocalInvoice>> =>
      ipcRenderer.invoke('invoice:syncLocalStatus', localId),
    syncAllStatuses: (): Promise<IpcResult<number>> =>
      ipcRenderer.invoke('invoice:syncAllStatuses'),
    delete: (localId: number): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('invoice:delete', localId),
    getStripeMode: (): Promise<IpcResult<'live' | 'test'>> =>
      ipcRenderer.invoke('invoice:getStripeMode'),
    setStripeMode: (mode: 'live' | 'test'): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('invoice:setStripeMode', mode),
    hasStripeKeyForMode: (mode: 'live' | 'test'): Promise<IpcResult<boolean>> =>
      ipcRenderer.invoke('invoice:hasStripeKeyForMode', mode),
    removeStripeKeyForMode: (mode: 'live' | 'test'): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('invoice:removeStripeKeyForMode', mode),
    importFromStripe: (): Promise<IpcResult<number>> =>
      ipcRenderer.invoke('invoice:importFromStripe'),
    getStripeTestEmail: (): Promise<IpcResult<string | null>> =>
      ipcRenderer.invoke('invoice:getStripeTestEmail'),
    setStripeTestEmail: (email: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('invoice:setStripeTestEmail', email),
    checkOverlap: (request: {
      clientId: number
      startDate: string
      endDate: string
    }): Promise<IpcResult<import('../shared/types/invoice').InvoiceOverlap[]>> =>
      ipcRenderer.invoke('invoice:checkOverlap', request)
  },
  secretScan: {
    run: (): Promise<IpcResult<import('../shared/types/secret-scan').SecretScanResult>> =>
      ipcRenderer.invoke('secretScan:run'),
    cancel: (): Promise<IpcResult<void>> => ipcRenderer.invoke('secretScan:cancel'),
    getFindings: (
      limit?: number,
      offset?: number
    ): Promise<IpcResult<import('../shared/types/secret-scan').SecretFinding[]>> =>
      ipcRenderer.invoke('secretScan:getFindings', limit, offset),
    getSummary: (): Promise<IpcResult<import('../shared/types/secret-scan').SecretScanSummary>> =>
      ipcRenderer.invoke('secretScan:getSummary'),
    ignoreFinding: (id: number): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('secretScan:ignoreFinding', id),
    redactFinding: (id: number): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('secretScan:redactFinding', id),
    redactAll: (): Promise<IpcResult<number>> => ipcRenderer.invoke('secretScan:redactAll'),
    getCustomPatterns: (): Promise<
      IpcResult<import('../shared/types/secret-scan').CustomSecretPattern[]>
    > => ipcRenderer.invoke('secretScan:getCustomPatterns'),
    upsertCustomPattern: (
      pattern: import('../shared/types/secret-scan').CustomSecretPattern
    ): Promise<IpcResult<{ success: boolean; warnings: string[] }>> =>
      ipcRenderer.invoke('secretScan:upsertCustomPattern', pattern),
    deleteCustomPattern: (id: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('secretScan:deleteCustomPattern', id),
    testPattern: (
      source: string,
      flags: string,
      testString: string
    ): Promise<IpcResult<import('../shared/types/secret-scan').PatternTestResult>> =>
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
    getLocalSetup: (): Promise<
      IpcResult<import('../shared/types/local-project-setup').LocalProjectSetupStatus>
    > => ipcRenderer.invoke('project:getLocalSetup'),
    completeLocalSetup: (
      selections: import('../shared/types/local-project-setup').LegacyFolderSelection[]
    ): Promise<IpcResult<import('../shared/types/local-project-setup').LocalProjectSetupStatus>> =>
      ipcRenderer.invoke('project:completeLocalSetup', selections),
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
    delete: (id: number, expectedSyncVersion?: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('project:delete', id, expectedSyncVersion),
    attributeSessions: (): Promise<IpcResult<number>> =>
      ipcRenderer.invoke('project:attributeSessions'),
    getMarkerStatus: (
      id: number
    ): Promise<IpcResult<import('../shared/types/client-project').ProjectMarkerStatus | null>> =>
      ipcRenderer.invoke('project:getMarkerStatus', id),
    setMarkerInGit: (
      id: number,
      keep: boolean
    ): Promise<IpcResult<import('../shared/types/client-project').ProjectMarkerStatus | null>> =>
      ipcRenderer.invoke('project:setMarkerInGit', id, keep),
    onFolderMarker: (
      callback: (event: import('../shared/types/client-project').MarkedFolderEvent) => void
    ) => {
      ipcRenderer.on('watcher:projectFolder', (_event, info) => callback(info))
    }
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
