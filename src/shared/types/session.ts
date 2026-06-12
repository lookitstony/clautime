/** Session row shape matching the sessions table schema. */
export interface Session {
  id: number
  projectPath: string
  startedAt: string
  endedAt: string
  durationMinutes: number
  source: 'auto' | 'manual'
  description: string | null
  status: 'active' | 'completed'
  claudeSessionId: string | null
  promptCount: number
  inputTokens: number
  outputTokens: number
  sourceFile: string | null
  billable: boolean
  projectId: number | null
  clientId: number | null
  createdAt: string
  updatedAt: string
}

/** Filters for querying sessions */
export interface SessionFilters {
  projectPath?: string
  startDate?: string
  endDate?: string
  source?: 'auto' | 'manual'
  clientId?: number
  projectId?: number
}

/** Timing data for a single human prompt → assistant response pair */
export interface PromptTiming {
  /** When the human prompt was sent */
  promptAt: string
  /** When the assistant response arrived (null if no response found) */
  responseAt: string | null
  /** Response latency in seconds */
  latencySeconds: number | null
}

/** Result of a scan operation */
export interface ScanResult {
  newSessions: number
  updatedFiles: number
  totalFiles: number
  durationMs: number
  attributedCount: number
}

/** A project discovered during folder scanning */
export interface DiscoveredProject {
  projectPath: string
  projectName: string
  encodedName: string
  hasClaudeDir: boolean
}

/** Fields that can be updated on an existing session */
export interface UpdateSession {
  startedAt?: string
  endedAt?: string
  durationMinutes?: number
  description?: string | null
  billable?: boolean
  projectId?: number | null
  clientId?: number | null
}

/** Daily work vs idle time breakdown */
export interface TimeBreakdownDay {
  date: string
  workMinutes: number
  idleMinutes: number
  totalMinutes: number
}

/** Gap analysis data for visualizing idle timeout impact */
export interface GapAnalysis {
  gaps: { minMinutes: number; maxMinutes: number; count: number }[]
  sessionCounts: {
    timeoutMinutes: number
    estimatedSessions: number
    workMinutes: number
    idleMinutes: number
    totalTrackedMinutes: number
  }[]
  totalMessages: number
}

/** Per-model token usage for a session (session_model_usage table, minus ids) */
export interface SessionModelUsage {
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

/** Aggregated token usage across sessions, grouped by model */
export interface ModelUsageAggregate {
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  sessionCount: number
}

/** Filters for aggregating model usage */
export interface ModelUsageFilters {
  startDate?: string
  endDate?: string
  clientId?: number
  projectId?: number
  /** Restrict to specific sessions (takes care of any client-side filtering, e.g. after-hours) */
  sessionIds?: number[]
}

/** A detected session before DB insertion (output of detection algorithm) */
export interface DetectedSession {
  startedAt: string
  endedAt: string
  durationMinutes: number
  projectPath: string
  claudeSessionId: string
  sourceFile: string
  promptCount: number
  inputTokens: number
  outputTokens: number
  /** Per-model token usage within this session (includes cache tokens) */
  modelUsage: SessionModelUsage[]
}
