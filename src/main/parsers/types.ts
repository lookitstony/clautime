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
}

/** Aggregated data from one session JSONL file. */
export interface ParsedSessionData {
  sessionId: string
  sourceFile: string
  projectPathEncoded: string
  projectDirectory: string | null
  messages: ParsedMessage[]
  firstTimestamp: string | null
  lastTimestamp: string | null
  totalTokenUsage: TokenUsage
  models: string[]
  messageCount: number
}

export interface SessionParserOptions {
  batchSize?: number
}

/** Clean interface for session file parsing (NFR11). */
export interface SessionParser {
  discoverSessionFiles(claudeDir: string): Promise<string[]>
  parseSessionFile(filePath: string): Promise<ParsedSessionData | null>
  parseAllSessions(
    claudeDir: string,
    options?: SessionParserOptions
  ): Promise<ParsedSessionData[]>
}
