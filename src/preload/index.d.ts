import { ElectronAPI } from '@electron-toolkit/preload'
import type { IpcResult } from '../shared/types/ipc'
import type { Session, SessionFilters, ScanResult, DiscoveredProject } from '../shared/types/session'
import type {
  Client,
  NewClient,
  UpdateClient,
  Project,
  NewProject,
  UpdateProject
} from '../shared/types/client-project'

interface DialogApi {
  openFolder(): Promise<IpcResult<string | null>>
  discoverProjects(folderPath?: string): Promise<IpcResult<DiscoveredProject[]>>
}

interface SettingsApi {
  get(key: string): Promise<IpcResult<string | null>>
  set(key: string, value: string): Promise<IpcResult<void>>
  getAll(): Promise<IpcResult<Record<string, string>>>
}

interface SessionsApi {
  scan(claudeDir?: string, projectFilter?: string[]): Promise<IpcResult<ScanResult>>
  reset(): Promise<IpcResult<void>>
  getAll(filters?: SessionFilters): Promise<IpcResult<Session[]>>
  getById(id: number): Promise<IpcResult<Session | null>>
}

interface ClientsApi {
  getAll(): Promise<IpcResult<Client[]>>
  create(data: NewClient): Promise<IpcResult<Client>>
  update(id: number, data: UpdateClient): Promise<IpcResult<Client>>
  delete(id: number): Promise<IpcResult<void>>
}

interface ProjectsApi {
  getAll(clientId?: number): Promise<IpcResult<Project[]>>
  create(data: NewProject): Promise<IpcResult<Project>>
  update(id: number, data: UpdateProject): Promise<IpcResult<Project>>
  delete(id: number): Promise<IpcResult<void>>
  attributeSessions(): Promise<IpcResult<number>>
}

interface Api {
  dialog: DialogApi
  settings: SettingsApi
  sessions: SessionsApi
  clients: ClientsApi
  projects: ProjectsApi
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: Api
  }
}
