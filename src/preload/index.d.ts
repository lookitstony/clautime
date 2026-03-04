import { ElectronAPI } from '@electron-toolkit/preload'
import type { IpcResult } from '../shared/types/ipc'

interface SettingsApi {
  get(key: string): Promise<IpcResult<string | null>>
  set(key: string, value: string): Promise<IpcResult<void>>
  getAll(): Promise<IpcResult<Record<string, string>>>
}

interface Api {
  settings: SettingsApi
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: Api
  }
}
