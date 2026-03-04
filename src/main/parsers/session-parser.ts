import { readdir, readFile } from 'node:fs/promises'
import { join, basename, dirname } from 'node:path'
import log from 'electron-log/main.js'
import type {
  ParsedSessionData,
  ParsedMessage,
  TokenUsage,
  SessionParser,
  SessionParserOptions
} from './types'

/** Message types we extract metadata from (skip file-history-snapshot, etc.) */
const RELEVANT_TYPES = new Set(['user', 'assistant', 'system'])

function emptyTokenUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0
  }
}

function parseJsonlLine(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function extractMessage(raw: Record<string, unknown>): ParsedMessage {
  const message = raw.message as Record<string, unknown> | undefined
  const usage = message?.usage as Record<string, number> | undefined

  return {
    type: (raw.type as string) || 'unknown',
    timestamp: (raw.timestamp as string) || '',
    sessionId: (raw.sessionId as string) || '',
    cwd: (raw.cwd as string) || null,
    gitBranch: (raw.gitBranch as string) || null,
    model: (message?.model as string) || null,
    usage: usage
      ? {
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
          cacheCreationInputTokens: usage.cache_creation_input_tokens || 0,
          cacheReadInputTokens: usage.cache_read_input_tokens || 0
        }
      : null,
    uuid: (raw.uuid as string) || null,
    parentUuid: (raw.parentUuid as string) || null
  }
}

/**
 * Discover all .jsonl session files under the claude projects directory.
 * Expects structure: {claudeDir}/projects/{encoded-project-name}/{session-id}.jsonl
 */
export async function discoverSessionFiles(claudeDir: string): Promise<string[]> {
  const projectsDir = join(claudeDir, 'projects')
  const files: string[] = []

  let projectDirs: Awaited<ReturnType<typeof readdir>>
  try {
    projectDirs = await readdir(projectsDir, { withFileTypes: true })
  } catch (err) {
    log.warn(`Failed to read projects directory: ${projectsDir}`, err)
    return files
  }

  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue

    const projectPath = join(projectsDir, dir.name)
    try {
      const entries = await readdir(projectPath, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          files.push(join(projectPath, entry.name))
        }
      }
    } catch (err) {
      log.warn(`Failed to read project directory: ${projectPath}`, err)
    }
  }

  return files
}

/**
 * Parse a single session JSONL file into structured data.
 * Skips malformed lines with a warning (NFR14). Returns null for unreadable files.
 */
export async function parseSessionFile(
  filePath: string
): Promise<ParsedSessionData | null> {
  let content: string
  try {
    content = await readFile(filePath, 'utf-8')
  } catch (err) {
    log.warn(`Failed to read session file: ${filePath}`, err)
    return null
  }

  const lines = content.split('\n').filter((line) => line.trim())
  if (lines.length === 0) {
    log.warn(`Empty session file: ${filePath}`)
    return null
  }

  const messages: ParsedMessage[] = []
  const totalUsage = emptyTokenUsage()
  const modelsSet = new Set<string>()
  let sessionId = ''
  let projectDirectory: string | null = null

  for (const line of lines) {
    const raw = parseJsonlLine(line)
    if (!raw) {
      log.warn(`Malformed JSONL line in ${filePath}, skipping`)
      continue
    }

    const type = raw.type as string
    if (!RELEVANT_TYPES.has(type)) continue

    const msg = extractMessage(raw)
    messages.push(msg)

    if (!sessionId && msg.sessionId) {
      sessionId = msg.sessionId
    }

    if (!projectDirectory && msg.cwd) {
      projectDirectory = msg.cwd
    }

    if (msg.model) {
      modelsSet.add(msg.model)
    }

    if (msg.usage) {
      totalUsage.inputTokens += msg.usage.inputTokens
      totalUsage.outputTokens += msg.usage.outputTokens
      totalUsage.cacheCreationInputTokens += msg.usage.cacheCreationInputTokens
      totalUsage.cacheReadInputTokens += msg.usage.cacheReadInputTokens
    }
  }

  // Sort by timestamp
  messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp))

  // Derive identifiers
  const projectPathEncoded = basename(dirname(filePath))
  if (!sessionId) {
    sessionId = basename(filePath, '.jsonl')
  }

  const timestamps = messages.filter((m) => m.timestamp).map((m) => m.timestamp)

  return {
    sessionId,
    sourceFile: filePath,
    projectPathEncoded,
    projectDirectory,
    messages,
    firstTimestamp: timestamps[0] ?? null,
    lastTimestamp: timestamps[timestamps.length - 1] ?? null,
    totalTokenUsage: totalUsage,
    models: Array.from(modelsSet),
    messageCount: messages.length
  }
}

/**
 * Parse all session files from the claude directory, processing in batches (NFR20).
 */
export async function parseAllSessions(
  claudeDir: string,
  options: SessionParserOptions = {}
): Promise<ParsedSessionData[]> {
  const { batchSize = 20 } = options

  const files = await discoverSessionFiles(claudeDir)
  log.info(`Discovered ${files.length} session files in ${claudeDir}`)

  const results: ParsedSessionData[] = []

  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize)
    const batchResults = await Promise.all(batch.map((file) => parseSessionFile(file)))

    for (const result of batchResults) {
      if (result) {
        results.push(result)
      }
    }
  }

  log.info(`Successfully parsed ${results.length} of ${files.length} session files`)
  return results
}

/** Concrete SessionParser implementation (NFR11). */
export const sessionParser: SessionParser = {
  discoverSessionFiles,
  parseSessionFile,
  parseAllSessions
}
