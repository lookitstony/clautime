import type { ParsedSessionData } from '../parsers/types'
import type { SessionTool } from '../../shared/types/session'

/** Options for a provider's session-file discovery. */
export interface ProviderDiscoverOptions {
  /**
   * Provider-specific root override (a test fixture or user-set path). Claude
   * treats it as a config dir, Codex as a sessions dir. Ignored when absent.
   */
  rootOverride?: string
  /** Encoded project dir names to include; omit for all projects. */
  projectFilter?: string[]
}

/** Cheap head-read of a session file: its id and originating project cwd. */
export interface ProviderSessionMeta {
  sessionId: string
  cwd: string | null
}

/**
 * A coding-agent data source. Everything an ingestion path needs to find and
 * read one provider's sessions lives behind this interface, so scan/backfill/
 * rebuild iterate a registry instead of hardcoding each tool. All providers
 * emit the shared `ParsedSessionData`, so nothing downstream is provider-aware.
 */
export interface SessionProvider {
  /** The tool tag written to sessions.tool. */
  readonly id: SessionTool
  /** Whether this provider owns (knows how to parse) the given file path. */
  ownsFile(filePath: string): boolean
  /** Every session file for this provider, honoring an optional project filter. */
  discoverFiles(opts?: ProviderDiscoverOptions): Promise<string[]>
  /** Session id + project cwd from a head-read, without a full parse. */
  readMeta(filePath: string): Promise<ProviderSessionMeta | null>
  /** Parse a file into the shared ParsedSessionData shape. */
  parseFile(filePath: string): Promise<ParsedSessionData | null>
}
