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
    testConnection: (): Promise<IpcResult<boolean>> => ipcRenderer.invoke('ai:testConnection')
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
    correlate: (): Promise<IpcResult<number>> => ipcRenderer.invoke('git:correlate')
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
