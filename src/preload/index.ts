import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import log from 'electron-log/preload.js'
import type { IpcResult } from '../shared/types/ipc'

// Custom APIs for renderer — typed service interfaces
const api = {
  settings: {
    get: (key: string): Promise<IpcResult<string | null>> =>
      ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('settings:set', key, value),
    getAll: (): Promise<IpcResult<Record<string, string>>> =>
      ipcRenderer.invoke('settings:getAll')
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
