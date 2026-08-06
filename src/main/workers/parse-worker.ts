import { parentPort } from 'node:worker_threads'
import { parseSessionFile } from '../parsers/session-parser'
import { parseCodexSessionFile } from '../parsers/codex-parser'
import { parseGeminiSessionFile } from '../parsers/gemini-parser'
import { parseOpencodeSessionFile } from '../parsers/opencode-parser'
import type { ParsedSessionData } from '../parsers/types'
import type { SessionTool } from '../../shared/types/session'

export interface ParseWorkRequest {
  entries: { path: string; providerId: SessionTool }[]
  offsets: Record<string, number>
}

export interface ParseWorkResponse {
  results: (ParsedSessionData | null)[]
}

/**
 * Worker-thread entry: parses session files off the Electron main thread so a
 * large (multi-hundred-MB) JSONL can never freeze the window. Deliberately
 * imports only parsers — never providers/services, which would drag DB and
 * settings access into the worker. electron-log falls back to its console
 * transport here (no `electron` module in worker threads), which is fine.
 */
const parserFor: Record<
  SessionTool,
  (path: string, opts?: { offsets?: Record<string, number> }) => Promise<ParsedSessionData | null>
> = {
  claude: (path, opts) => parseSessionFile(path, opts),
  codex: (path) => parseCodexSessionFile(path),
  gemini: (path) => parseGeminiSessionFile(path),
  opencode: (path) => parseOpencodeSessionFile(path)
}

parentPort?.on('message', async (req: ParseWorkRequest) => {
  const results: (ParsedSessionData | null)[] = []
  for (const entry of req.entries) {
    try {
      results.push(await parserFor[entry.providerId](entry.path, { offsets: req.offsets }))
    } catch {
      results.push(null)
    }
  }
  const response: ParseWorkResponse = { results }
  parentPort?.postMessage(response)
})
