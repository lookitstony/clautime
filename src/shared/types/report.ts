/** Filters for report generation */
export interface ReportFilters {
  startDate: string
  endDate: string
  clientId?: number
  projectId?: number
  afterHoursOnly?: boolean
  /** Filter by billable status: 'all' (default), 'billable', 'non-billable' */
  billableFilter?: 'all' | 'billable' | 'non-billable'
}

/** Report format type */
export type ReportFormat = 'session-breakdown' | 'daily-summary' | 'period-summary'

/** A single line item in a session breakdown report */
export interface SessionLineItem {
  date: string
  projectName: string
  clientName: string | null
  startedAt: string
  endedAt: string
  durationMinutes: number
  promptCount: number
  inputTokens: number
  outputTokens: number
  description: string | null
  source: 'auto' | 'manual'
}

/** Per-client-per-project breakdown within a day */
export interface DailyProjectBreakdown {
  clientName: string | null
  projectName: string
  sessionCount: number
  totalDurationMinutes: number
  totalPrompts: number
  totalInputTokens: number
  totalOutputTokens: number
}

/** A daily summary entry */
export interface DailySummaryItem {
  date: string
  sessionCount: number
  totalDurationMinutes: number
  totalPrompts: number
  totalInputTokens: number
  totalOutputTokens: number
  projects: string[]
  breakdown: DailyProjectBreakdown[]
}

/** A period summary grouped by project */
export interface PeriodProjectItem {
  projectName: string
  clientName: string | null
  sessionCount: number
  totalDurationMinutes: number
  totalPrompts: number
  totalInputTokens: number
  totalOutputTokens: number
}

/** Period summary */
export interface PeriodSummary {
  startDate: string
  endDate: string
  totalSessions: number
  totalDurationMinutes: number
  totalPrompts: number
  totalInputTokens: number
  totalOutputTokens: number
  projects: PeriodProjectItem[]
}

/** Bottom-line summary included with every report */
export interface ReportSummary {
  totalSessions: number
  totalDurationMinutes: number
  totalPrompts: number
  totalInputTokens: number
  totalOutputTokens: number
  /** Total billed cost (only for sessions under clients with a billable rate) */
  totalBilledCost: number
  /** Breakdown of billed cost per client */
  billedByClient: { clientName: string; hours: number; rate: number; cost: number }[]
  /** Earned = billable human hours × effective (project-or-client) rate, for the filtered period */
  totalEarned: number
}

/** Report result */
export interface ReportResult {
  format: ReportFormat
  filters: ReportFilters
  generatedAt: string
  summary: ReportSummary
  sessionBreakdown?: SessionLineItem[]
  dailySummary?: DailySummaryItem[]
  periodSummary?: PeriodSummary
}
