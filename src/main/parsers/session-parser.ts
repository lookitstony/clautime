import { readdir } from 'node:fs/promises'
import { readJsonlLinesFrom, isLineBoundary } from './line-reader'
import { join, basename, dirname } from 'node:path'
import log from 'electron-log/main.js'
import { isExcludedProjectDir } from '../../shared/paths'
import type {
  ParsedSessionData,
  ParsedMessage,
  TokenUsage,
  SessionParser,
  SessionParserOptions
} from './types'

/** Message types we extract full metadata from */
const RELEVANT_TYPES = new Set(['user', 'assistant', 'system'])
/** Additional types we extract lightweight data from */
const PROGRESS_TYPE = 'progress'
const SUMMARY_TYPE = 'summary'

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

  // Detect assistant messages that contain tool_use blocks (Agent, Read, etc.)
  const content = message?.content as Array<{ type?: string; name?: string }> | undefined
  const toolUseBlocks = Array.isArray(content) ? content.filter((b) => b.type === 'tool_use') : []
  const hasToolUse = toolUseBlocks.length > 0
  const toolNames = toolUseBlocks.map((b) => b.name || 'unknown')

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
    parentUuid: (raw.parentUuid as string) || null,
    isToolResult: !!raw.toolUseResult,
    hasToolUse,
    toolNames
  }
}

/**
 * Discover all .jsonl session files under the claude projects directory.
 * Expects structure: {claudeDir}/projects/{encoded-project-name}/{session-id}.jsonl
 */
export async function discoverSessionFiles(
  claudeDir: string,
  projectFilter?: string[]
): Promise<string[]> {
  const projectsDir = join(claudeDir, 'projects')
  const files: string[] = []

  let projectDirs: import('node:fs').Dirent<string>[]
  try {
    projectDirs = await readdir(projectsDir, { withFileTypes: true, encoding: 'utf8' })
  } catch (err) {
    log.warn(`Failed to read projects directory: ${projectsDir}`, err)
    return files
  }

  const filterSet = projectFilter ? new Set(projectFilter) : null

  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue
    if (isExcludedProjectDir(dir.name)) continue
    if (filterSet && !filterSet.has(dir.name)) continue

    const projectPath = join(projectsDir, dir.name)
    try {
      const entries = await readdir(projectPath, { withFileTypes: true, encoding: 'utf8' })
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
 * Resolve the byte offset to start parsing a file from. A persisted offset is
 * only honored when it still lands on a line boundary (the file can have been
 * rewritten under us); otherwise fall back to a full parse from 0.
 */
async function resolveStartOffset(
  filePath: string,
  offsets: Record<string, number> | undefined
): Promise<number> {
  const candidate = offsets?.[filePath] ?? 0
  if (candidate <= 0) return 0
  return (await isLineBoundary(filePath, candidate)) ? candidate : 0
}

/**
 * Parse a single session JSONL file into structured data.
 * Skips malformed lines with a warning (NFR14). Returns null for unreadable files.
 *
 * `opts.offsets` maps file paths (main and subagent) to previously-consumed byte
 * offsets; files listed there are parsed incrementally from that offset. The
 * result's `fileOffsets` reports the new consumed offset per physical file so
 * the caller can persist them for the next scan.
 */
export async function parseSessionFile(
  filePath: string,
  opts?: { offsets?: Record<string, number> }
): Promise<ParsedSessionData | null> {
  const messages: ParsedMessage[] = []
  const progressTimestamps: string[] = []
  const totalUsage = emptyTokenUsage()
  const modelsSet = new Set<string>()
  let sessionId = ''
  let projectDirectory: string | null = null
  let summary: string | null = null

  const startOffset = await resolveStartOffset(filePath, opts?.offsets)
  let consumedOffset = startOffset

  // Stream lines so a large session file never loads whole into memory.
  let lineIdx = 0
  const lineIter = readJsonlLinesFrom(filePath, startOffset)
  while (true) {
    let next: IteratorResult<string, number>
    try {
      next = await lineIter.next()
    } catch (err) {
      log.warn(`Failed to read session file: ${filePath}`, err)
      return null
    }
    if (next.done) {
      consumedOffset = next.value ?? consumedOffset
      break
    }
    const line = next.value
    // Yield to the event loop periodically so parsing a large (actively-growing)
    // session file doesn't block the main process and freeze the UI.
    if (++lineIdx % 2000 === 0) await new Promise((resolve) => setImmediate(resolve))

    const raw = parseJsonlLine(line)
    if (!raw) {
      log.warn(`Malformed JSONL line in ${filePath}, skipping`)
      continue
    }

    const type = raw.type as string

    // Collect progress event timestamps (lightweight — just the timestamp string)
    if (type === PROGRESS_TYPE) {
      const ts = raw.timestamp as string
      if (ts) progressTimestamps.push(ts)
      continue
    }

    // Extract session summary
    if (type === SUMMARY_TYPE) {
      const s = raw.summary as string
      if (s) summary = s
      continue
    }

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

  // Only a full parse can conclude the file is empty — an incremental tail with
  // no new complete lines still needs to flow through (subagent files may have
  // grown even when the main file's tail hasn't).
  if (lineIdx === 0 && startOffset === 0) {
    log.warn(`Empty session file: ${filePath}`)
    return null
  }

  // Sort by timestamp
  messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  progressTimestamps.sort()

  // Derive identifiers
  const projectPathEncoded = basename(dirname(filePath))
  if (!sessionId) {
    sessionId = basename(filePath, '.jsonl')
  }

  // Collect subagent data (messages, tokens, progress)
  const subagentData = await collectSubagentData(filePath, sessionId, opts?.offsets)

  const timestamps = messages.filter((m) => m.timestamp).map((m) => m.timestamp)

  return {
    sessionId,
    sourceFile: filePath,
    projectPathEncoded,
    projectDirectory,
    messages,
    progressTimestamps,
    firstTimestamp: timestamps[0] ?? null,
    lastTimestamp: timestamps[timestamps.length - 1] ?? null,
    totalTokenUsage: totalUsage,
    subagentTokenUsage: subagentData.tokenUsage,
    models: Array.from(modelsSet),
    messageCount: messages.length,
    summary,
    subagentMessages: subagentData.messages,
    subagentProgressTimestamps: subagentData.progressTimestamps,
    fileOffsets: { [filePath]: consumedOffset, ...subagentData.fileOffsets }
  }
}

interface SubagentData {
  tokenUsage: TokenUsage
  messages: ParsedMessage[]
  progressTimestamps: string[]
  fileOffsets: Record<string, number>
}

/**
 * Collect messages, token usage, and progress timestamps from subagent JSONL files.
 * Subagents are stored in {session-id}/subagents/*.jsonl alongside the main file.
 * Files with a known offset in `offsets` are read incrementally from there.
 */
async function collectSubagentData(
  mainFilePath: string,
  sessionId: string,
  offsets?: Record<string, number>
): Promise<SubagentData> {
  const tokenUsage = emptyTokenUsage()
  const messages: ParsedMessage[] = []
  const progressTimestamps: string[] = []
  const fileOffsets: Record<string, number> = {}
  const sessionDir = join(dirname(mainFilePath), sessionId, 'subagents')

  let entries: import('node:fs').Dirent<string>[]
  try {
    entries = await readdir(sessionDir, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return { tokenUsage, messages, progressTimestamps, fileOffsets }
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    const subagentFilePath = join(sessionDir, entry.name)
    try {
      const startOffset = await resolveStartOffset(subagentFilePath, offsets)
      let lineIdx = 0
      const lineIter = readJsonlLinesFrom(subagentFilePath, startOffset)
      let consumed = startOffset
      while (true) {
        const next = await lineIter.next()
        if (next.done) {
          consumed = next.value ?? consumed
          break
        }
        if (++lineIdx % 2000 === 0) await new Promise((resolve) => setImmediate(resolve))
        const raw = parseJsonlLine(next.value)
        if (!raw) continue

        const type = raw.type as string

        if (type === PROGRESS_TYPE) {
          const ts = raw.timestamp as string
          if (ts) progressTimestamps.push(ts)
          continue
        }

        if (!RELEVANT_TYPES.has(type)) continue

        const msg = extractMessage(raw)
        // Tag with the subagent's own source file for dedup
        ;(msg as ParsedMessage & { sourceFile?: string }).sourceFile = subagentFilePath
        messages.push(msg)

        if (msg.usage) {
          tokenUsage.inputTokens += msg.usage.inputTokens
          tokenUsage.outputTokens += msg.usage.outputTokens
          tokenUsage.cacheCreationInputTokens += msg.usage.cacheCreationInputTokens
          tokenUsage.cacheReadInputTokens += msg.usage.cacheReadInputTokens
        }
      }
      fileOffsets[subagentFilePath] = consumed
    } catch (err) {
      log.debug(`Failed to read subagent file: ${entry.name}`, err)
    }
  }

  progressTimestamps.sort()
  return { tokenUsage, messages, progressTimestamps, fileOffsets }
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
