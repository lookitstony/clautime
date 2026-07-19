import { toolForSourceFile } from '../../shared/paths'
import { parseSessionFile } from './session-parser'
import { parseCodexSessionFile } from './codex-parser'
import type { ParsedSessionData } from './types'

export {
  sessionParser,
  discoverSessionFiles,
  parseSessionFile,
  parseAllSessions
} from './session-parser'
export {
  discoverCodexSessionFiles,
  parseCodexSessionFile,
  readCodexSessionMeta,
  getCodexSessionsDir
} from './codex-parser'
export type {
  ParsedSessionData,
  ParsedMessage,
  TokenUsage,
  SessionParser,
  SessionParserOptions
} from './types'

/** Parse a session file with the right parser for its source tool. */
export async function parseAnySessionFile(filePath: string): Promise<ParsedSessionData | null> {
  return toolForSourceFile(filePath) === 'codex'
    ? parseCodexSessionFile(filePath)
    : parseSessionFile(filePath)
}
