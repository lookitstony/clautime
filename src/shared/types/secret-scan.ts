/** Secret pattern definition for regex-based detection */
export interface SecretPattern {
  id: string
  label: string
  regex: RegExp
  severity: 'critical' | 'high' | 'medium'
  redactLabel: string
}

/** A detected secret finding stored in the database */
export interface SecretFinding {
  id: number
  sourceFile: string
  lineNumber: number
  secretType: string
  redactedPreview: string
  severity: string
  context: string
  scannedAt: string
  status: 'found' | 'redacted' | 'ignored'
  redactedAt: string | null
  occurrences: number
}

/** Result summary from a scan run */
export interface SecretScanResult {
  filesScanned: number
  filesSkipped: number
  newFindings: number
  redacted: number
  errors: number
}

/** Scan mode configuration */
export type SecretScanMode = 'monitor' | 'monitor-alert' | 'auto-clean'

/** Progress reporting during a scan */
export interface SecretScanProgress {
  phase: 'scanning' | 'redacting' | 'complete'
  filesScanned: number
  totalFiles: number
  currentFile: string
  findingsCount: number
}

/** User-defined custom secret pattern (stored as JSON in app_settings) */
export interface CustomSecretPattern {
  id: string
  label: string
  source: string
  flags: string
  severity: 'critical' | 'high' | 'medium'
  redactLabel: string
  enabled: boolean
}

/** Result of testing a regex pattern against a test string */
export interface PatternTestResult {
  matches: string[]
  matchCount: number
  warnings: string[]
}

/** Summary counts for the findings overview */
export interface SecretScanSummary {
  total: number
  found: number
  redacted: number
  ignored: number
  bySeverity: {
    critical: number
    high: number
    medium: number
  }
}
