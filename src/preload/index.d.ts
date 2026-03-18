import { ElectronAPI } from '@electron-toolkit/preload'
import type { IpcResult } from '../shared/types/ipc'
import type { Session, SessionFilters, ScanResult, DiscoveredProject, PromptTiming, UpdateSession, GapAnalysis, TimeBreakdownDay } from '../shared/types/session'
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
import type { TodayStats, ProjectLiveStatus, ProjectAlertConfig } from '../shared/types/live'
import type { SecretScanResult, SecretFinding, SecretScanSummary, CustomSecretPattern, PatternTestResult } from '../shared/types/secret-scan'

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
  rebuild(): Promise<IpcResult<ScanResult>>
  scanAndRebuild(): Promise<IpcResult<ScanResult>>
  getAll(filters?: SessionFilters): Promise<IpcResult<Session[]>>
  getById(id: number): Promise<IpcResult<Session | null>>
  getPromptTimings(sessionId: number): Promise<IpcResult<PromptTiming[]>>
  update(id: number, data: UpdateSession): Promise<IpcResult<Session>>
  delete(id: number): Promise<IpcResult<void>>
  split(id: number, splitAt: string): Promise<IpcResult<Session[]>>
  getTimeBreakdown(startDate: string, endDate: string): Promise<IpcResult<TimeBreakdownDay[]>>
  getGapAnalysis(): Promise<IpcResult<GapAnalysis>>
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
  }, useAi?: boolean, summaryOptions?: {
    includeOverall?: boolean
    includeDailyBreakdown?: boolean
  }): Promise<IpcResult<string | null>>
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
  exportPdf(html: string, filename?: string): Promise<IpcResult<string | null>>
  exportFile(content: string, defaultFilename: string, filterName: string, extension: string): Promise<IpcResult<string | null>>
  openFile(filePath: string): Promise<IpcResult<boolean>>
}

interface LiveApi {
  getTodayStats(): Promise<IpcResult<TodayStats>>
  getProjectStatuses(): Promise<IpcResult<ProjectLiveStatus[]>>
  setWatching(projectId: number, enabled: boolean): Promise<IpcResult<void>>
  getAlertConfig(projectId: number): Promise<IpcResult<ProjectAlertConfig>>
  setAlertConfig(projectId: number, alertSound: string): Promise<IpcResult<void>>
  getAvailableSounds(): Promise<IpcResult<{ name: string; filename: string }[]>>
  playTestSound(): Promise<IpcResult<void>>
  selectCustomSound(): Promise<IpcResult<string | null>>
  onSessionsUpdated(callback: () => void): void
  onNewProject(callback: (info: { dirName: string; decodedPath: string; projectName: string }) => void): void
  timerStarted(projectName: string, startedAt: string): Promise<IpcResult<void>>
  timerStopped(): Promise<IpcResult<void>>
  toggleWidget(projectId: number): Promise<IpcResult<void>>
  showAllWidgets(projectIds: number[]): Promise<IpcResult<void>>
  hideAllWidgets(): Promise<IpcResult<void>>
  showStopDialog(projectId: number): Promise<IpcResult<void>>
  getWidgetHotkey(): Promise<IpcResult<string>>
  setWidgetHotkey(accelerator: string): Promise<IpcResult<void>>
  onWidgetAlert(callback: (info: { projectName: string }) => void): void
  onOpenStopDialog(callback: (projectId: number) => void): void
}

interface WindowApi {
  minimize(): Promise<void>
  maximize(): Promise<void>
  close(): Promise<void>
  hide(): Promise<void>
  quit(): Promise<void>
  isMaximized(): Promise<boolean>
  onMaximizedChanged(callback: (isMaximized: boolean) => void): void
  onCloseRequested(callback: () => void): void
}

interface ProjectsApi {
  getAll(clientId?: number): Promise<IpcResult<Project[]>>
  create(data: NewProject): Promise<IpcResult<Project>>
  update(id: number, data: UpdateProject): Promise<IpcResult<Project>>
  delete(id: number): Promise<IpcResult<void>>
  attributeSessions(): Promise<IpcResult<number>>
}

interface SecretScanApi {
  run(): Promise<IpcResult<SecretScanResult>>
  cancel(): Promise<IpcResult<void>>
  getFindings(limit?: number, offset?: number): Promise<IpcResult<SecretFinding[]>>
  getSummary(): Promise<IpcResult<SecretScanSummary>>
  ignoreFinding(id: number): Promise<IpcResult<void>>
  redactFinding(id: number): Promise<IpcResult<void>>
  redactAll(): Promise<IpcResult<number>>
  getCustomPatterns(): Promise<IpcResult<CustomSecretPattern[]>>
  upsertCustomPattern(pattern: CustomSecretPattern): Promise<IpcResult<{ success: boolean; warnings: string[] }>>
  deleteCustomPattern(id: string): Promise<IpcResult<void>>
  testPattern(source: string, flags: string, testString: string): Promise<IpcResult<PatternTestResult>>
}

interface Api {
  dialog: DialogApi
  settings: SettingsApi
  sessions: SessionsApi
  clients: ClientsApi
  live: LiveApi
  projects: ProjectsApi
  reports: ReportsApi
  updater: UpdaterApi
  git: GitApi
  ai: AiApi
  secretScan: SecretScanApi
  window: WindowApi
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: Api
  }
}
