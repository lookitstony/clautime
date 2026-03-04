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
  sourceFile: string | null
  createdAt: string
  updatedAt: string
}

/** Filters for querying sessions */
export interface SessionFilters {
  projectPath?: string
  startDate?: string
  endDate?: string
  source?: 'auto' | 'manual'
}

/** Result of a scan operation */
export interface ScanResult {
  newSessions: number
  updatedFiles: number
  totalFiles: number
  durationMs: number
}

/** A project discovered during folder scanning */
export interface DiscoveredProject {
  projectPath: string
  projectName: string
  encodedName: string
  hasClaudeDir: boolean
}

/** A detected session before DB insertion (output of detection algorithm) */
export interface DetectedSession {
  startedAt: string
  endedAt: string
  durationMinutes: number
  projectPath: string
  claudeSessionId: string
  sourceFile: string
  messageCount: number
}
