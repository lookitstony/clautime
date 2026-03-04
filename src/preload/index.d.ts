import { ElectronAPI } from '@electron-toolkit/preload'
import type { IpcResult } from '../shared/types/ipc'
import type { Session, SessionFilters, ScanResult } from '../shared/types/session'

interface SettingsApi {
  get(key: string): Promise<IpcResult<string | null>>
  set(key: string, value: string): Promise<IpcResult<void>>
  getAll(): Promise<IpcResult<Record<string, string>>>
}

interface SessionsApi {
  scan(claudeDir?: string): Promise<IpcResult<ScanResult>>
  getAll(filters?: SessionFilters): Promise<IpcResult<Session[]>>
  getById(id: number): Promise<IpcResult<Session | null>>
}

interface Api {
  settings: SettingsApi
  sessions: SessionsApi
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: Api
  }
}
