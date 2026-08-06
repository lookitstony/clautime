/**
 * Types for the Claude session file parser.
 * Abstracts the .claude JSONL format behind clean interfaces (NFR11).
 */

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

/** Parsed metadata from a single JSONL line. Content is omitted to keep memory low. */
export interface ParsedMessage {
  type: string
  timestamp: string
  sessionId: string
  cwd: string | null
  gitBranch: string | null
  model: string | null
  usage: TokenUsage | null
  uuid: string | null
  parentUuid: string | null
  isToolResult: boolean
  hasToolUse: boolean
  toolNames: string[]
}

/** Aggregated data from one session JSONL file. */
export interface ParsedSessionData {
  sessionId: string
  sourceFile: string
  /** Which coding agent wrote this file. Defaults to 'claude' when absent. */
  tool?: 'claude' | 'codex' | 'gemini' | 'opencode'
  projectPathEncoded: string
  projectDirectory: string | null
  messages: ParsedMessage[]
  /** Timestamps of progress events (bash_progress, hook_progress, agent_progress).
   *  Used to prove active tool processing during gaps between messages. */
  progressTimestamps: string[]
  firstTimestamp: string | null
  lastTimestamp: string | null
  totalTokenUsage: TokenUsage
  /** Token usage from subagent JSONL files (not included in totalTokenUsage) */
  subagentTokenUsage: TokenUsage
  models: string[]
  messageCount: number
  /** Session summary from JSONL `summary` record, if present */
  summary: string | null
  /** Messages from subagent JSONL files (with sourceFile set to the subagent file path) */
  subagentMessages: ParsedMessage[]
  /** Progress event timestamps from subagent JSONL files */
  subagentProgressTimestamps: string[]
  /**
   * Consumed byte offset per physical file (main + subagent) after this parse.
   * Persisted to scan_state so the next scan reads only appended data. Absent
   * for parsers that don't support incremental reads yet.
   */
  fileOffsets?: Record<string, number>
}

export interface SessionParserOptions {
  batchSize?: number
}

/** Clean interface for session file parsing (NFR11). */
export interface SessionParser {
  discoverSessionFiles(claudeDir: string): Promise<string[]>
  parseSessionFile(
    filePath: string,
    opts?: { offsets?: Record<string, number> }
  ): Promise<ParsedSessionData | null>
  parseAllSessions(claudeDir: string, options?: SessionParserOptions): Promise<ParsedSessionData[]>
}
