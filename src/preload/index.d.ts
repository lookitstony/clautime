import { ElectronAPI } from '@electron-toolkit/preload'
import type { IpcResult } from '../shared/types/ipc'
import type { Session, SessionFilters, ScanResult, DiscoveredProject, PromptTiming, UpdateSession } from '../shared/types/session'
import type { GitCommit, GitScanResult, GitIdentity } from '../shared/types/git'
import type {
  Client,
  NewClient,
  UpdateClient,
  Project,
  NewProject,
  UpdateProject
} from '../shared/types/client-project'
import type { ReportFilters, ReportFormat, ReportResult } from '../shared/types/report'

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
  getPromptTimings(sessionId: number): Promise<IpcResult<PromptTiming[]>>
  update(id: number, data: UpdateSession): Promise<IpcResult<Session>>
  delete(id: number): Promise<IpcResult<void>>
  split(id: number, splitAt: string): Promise<IpcResult<Session[]>>
  create(data: {
    projectPath: string
    startedAt: string
    endedAt: string
    durationMinutes: number
    description?: string
    projectId?: number | null
    clientId?: number | null
  }): Promise<IpcResult<Session>>
}

interface ClientsApi {
  getAll(): Promise<IpcResult<Client[]>>
  create(data: NewClient): Promise<IpcResult<Client>>
  update(id: number, data: UpdateClient): Promise<IpcResult<Client>>
  delete(id: number): Promise<IpcResult<void>>
}

interface AiApi {
  getMethod(): Promise<IpcResult<string>>
  setMethod(method: string): Promise<IpcResult<void>>
  hasApiKey(): Promise<IpcResult<boolean>>
  storeApiKey(key: string): Promise<IpcResult<void>>
  removeApiKey(): Promise<IpcResult<void>>
  testConnection(): Promise<IpcResult<boolean>>
  getSummary(sessionId: number): Promise<IpcResult<{ summary: string; tier: string }>>
  generateSummary(sessionId: number): Promise<IpcResult<string | null>>
  generateBatch(sessionIds: number[]): Promise<IpcResult<number>>
  generateReportSummary(filters: {
    startDate: string
    endDate: string
    projectId?: number
    clientId?: number
  }, useAi?: boolean): Promise<IpcResult<string | null>>
}

interface GitApi {
  scan(projectFilter?: number[]): Promise<IpcResult<GitScanResult>>
  getCommitsForSession(sessionId: number): Promise<IpcResult<GitCommit[]>>
  getCommitsForProject(projectId: number): Promise<IpcResult<GitCommit[]>>
  detectIdentity(): Promise<IpcResult<GitIdentity | null>>
  getIdentity(): Promise<IpcResult<GitIdentity | null>>
  setIdentity(name: string, email: string): Promise<IpcResult<void>>
  correlate(): Promise<IpcResult<number>>
  getSessionIdsWithCommits(): Promise<IpcResult<number[]>>
  getRemoteUrl(projectId: number): Promise<IpcResult<string | null>>
}

interface UpdaterApi {
  checkForUpdates(): Promise<IpcResult<void>>
  downloadAndInstall(): Promise<IpcResult<void>>
  getVersion(): Promise<IpcResult<string>>
  onUpdateAvailable(callback: (info: { version: string; releaseDate: string }) => void): void
  onUpdateDownloaded(callback: () => void): void
}

interface ReportsApi {
  generate(filters: ReportFilters, format: ReportFormat): Promise<IpcResult<ReportResult>>
  exportPdf(html: string, filename?: string): Promise<IpcResult<boolean>>
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
  reports: ReportsApi
  updater: UpdaterApi
  git: GitApi
  ai: AiApi
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: Api
  }
}
