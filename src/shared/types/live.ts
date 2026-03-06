export interface TodayStats {
  humanHours: string
  agentHours: string
  totalSessions: number
  totalPrompts: number
  totalTokens: number
  totalCommits: number
}

export interface ProjectLiveStatus {
  projectId: number
  projectName: string
  projectPath: string
  clientName: string | null
  clientId: number | null
  lastPromptAt: string | null
  isProcessing: boolean
  isWatching: boolean
  alertSound: string
  totalHours: string
  sessionCount: number
  totalPrompts: number
  totalTokens: number
  totalCommits: number
}

export interface ProjectAlertConfig {
  projectId: number
  alertSound: string
  isWatching: boolean
}

export interface ManualTimerState {
  projectId: number
  projectName: string
  projectPath: string
  clientId: number | null
  clientName: string | null
  startedAt: string
  description: string | null
  pausedAt: string | null
  totalPausedMs: number
}
