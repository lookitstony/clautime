import { open, readdir, readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'
import log from 'electron-log/main.js'
import type { ParsedSessionData, ParsedMessage, TokenUsage } from './types'

/**
 * Parser for Google Gemini CLI chat recordings.
 *
 * Gemini CLI stores one JSON file per session at:
 *   ~/.gemini/tmp/<project-dir>/chats/session-<started-at>-<id8>.json
 *
 * <project-dir> is either the project folder's basename (newer CLIs, with a
 * `.project_root` marker file holding the absolute project path) or a hex hash
 * of the project path (older CLIs, no reverse mapping — cwd stays unknown).
 *
 * A session file is a single JSON document:
 *   { sessionId, projectHash, startTime, lastUpdated, messages: [...] }
 * where each message is { id, timestamp, type: 'user' | 'gemini' | ..., content,
 * thoughts?, tokens?, model?, toolCalls? }. Tool calls and their results are
 * embedded in the owning 'gemini' message, not separate records. The file is
 * rewritten in place as the session grows, so lastUpdated/mtime move forward.
 *
 * Note: Gemini CLI prunes session files after its retention window (30 days by
 * default), so rebuilds can only recover what is still on disk — regular scans
 * persist sessions into ClauTime's DB before the CLI deletes them.
 *
 * Output is the same ParsedSessionData shape the Claude parser emits, so the
 * whole downstream pipeline (raw storage, gap detection, rebuild) is shared.
 */

function emptyTokenUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0
  }
}

/** Default Gemini CLI tmp root (~/.gemini/tmp). */
export function getGeminiTmpDir(): string {
  return join(homedir(), '.gemini', 'tmp')
}

/**
 * Enumerate every chat recording under the tmp tree.
 * Structure: {tmpDir}/<project-dir>/chats/session-*.json
 */
export async function discoverGeminiSessionFiles(tmpDir?: string): Promise<string[]> {
  const root = tmpDir ?? getGeminiTmpDir()
  const files: string[] = []

  let projectDirs: import('node:fs').Dirent<string>[]
  try {
    projectDirs = await readdir(root, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return files // No ~/.gemini/tmp — Gemini CLI not installed
  }

  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue
    const chatsDir = join(root, dir.name, 'chats')
    let entries: import('node:fs').Dirent<string>[]
    try {
      entries = await readdir(chatsDir, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      continue // dirs like tmp/bin have no chats/
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.startsWith('session-') && entry.name.endsWith('.json')) {
        files.push(join(chatsDir, entry.name))
      }
    }
  }

  return files
}

interface GeminiMeta {
  sessionId: string
  cwd: string | null
}

// .project_root never changes for a given project dir — cache per directory.
const projectRootCache = new Map<string, string | null>()

/**
 * Restore the filesystem's true casing. Gemini CLI records the project path
 * LOWERCASED (e.g. "c:\apps\clawdtime"), which would key a duplicate project
 * beside the correctly-cased one Claude records — breaking the cross-tool
 * overlap merge that invoicing depends on. Windows-only: paths there are
 * case-insensitive, and elsewhere realpath would also resolve symlinks, which
 * Claude's own records don't.
 */
function canonicalizeCasing(p: string): string {
  if (process.platform !== 'win32') return p
  try {
    return realpathSync.native(p)
  } catch {
    return p // path no longer exists — keep as recorded
  }
}

/** Resolve the project path from the `.project_root` marker beside chats/. */
async function readProjectRoot(projectDir: string): Promise<string | null> {
  const cached = projectRootCache.get(projectDir)
  if (cached !== undefined) return cached
  let root: string | null = null
  try {
    const content = await readFile(join(projectDir, '.project_root'), 'utf-8')
    root = content.trim() ? canonicalizeCasing(content.trim()) : null
  } catch {
    root = null // hash-named dir from an older CLI — no marker
  }
  projectRootCache.set(projectDir, root)
  return root
}

/**
 * Read sessionId + project cwd without parsing the whole (potentially large)
 * session JSON: sessionId sits in the first few lines of the pretty-printed
 * document, and cwd comes from the sibling `.project_root` marker.
 */
export async function readGeminiSessionMeta(filePath: string): Promise<GeminiMeta | null> {
  const projectDir = dirname(dirname(filePath))
  const cwd = await readProjectRoot(projectDir)

  let fh: Awaited<ReturnType<typeof open>> | null = null
  try {
    fh = await open(filePath, 'r')
    const buffer = Buffer.alloc(4096)
    const { bytesRead } = await fh.read(buffer, 0, buffer.length, 0)
    const head = buffer.toString('utf-8', 0, bytesRead)
    const m = head.match(/"sessionId"\s*:\s*"([^"]+)"/)
    return { sessionId: m ? m[1] : basename(filePath, '.json'), cwd }
  } catch {
    return null
  } finally {
    await fh?.close()
  }
}

interface GeminiTokens {
  input?: number
  output?: number
  cached?: number
  thoughts?: number
  tool?: number
}

interface GeminiChatMessage {
  id?: string
  timestamp?: string
  type?: string
  model?: string
  tokens?: GeminiTokens
  thoughts?: Array<{ timestamp?: string }>
  toolCalls?: Array<{ name?: string }>
}

interface GeminiChatFile {
  sessionId?: string
  startTime?: string
  lastUpdated?: string
  messages?: GeminiChatMessage[]
}

/**
 * Map a gemini message's token block to the shared TokenUsage shape.
 * Gemini's `input` (promptTokenCount) INCLUDES cached tokens; `thoughts` are
 * billed as output; `tool` (toolUsePromptTokenCount) is extra prompt input.
 */
function usageFromTokens(tokens: GeminiTokens): TokenUsage | null {
  const input = tokens.input || 0
  const cached = tokens.cached || 0
  const usage: TokenUsage = {
    inputTokens: Math.max(0, input - cached) + (tokens.tool || 0),
    outputTokens: (tokens.output || 0) + (tokens.thoughts || 0),
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: cached
  }
  return usage.inputTokens || usage.outputTokens || usage.cacheReadInputTokens ? usage : null
}

/**
 * Read and parse the whole Gemini session document. The CLI rewrites this file
 * in place as the session grows, so a read that lands mid-rewrite yields
 * truncated JSON; retry once after a short delay before giving up, so an
 * always-active session isn't repeatedly dropped from scans.
 */
async function readGeminiChatFile(filePath: string): Promise<GeminiChatFile> {
  try {
    return JSON.parse(await readFile(filePath, 'utf-8'))
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 50))
    return JSON.parse(await readFile(filePath, 'utf-8'))
  }
}

/**
 * Parse a Gemini CLI session recording into ParsedSessionData.
 * Returns null for unreadable/empty files.
 */
export async function parseGeminiSessionFile(filePath: string): Promise<ParsedSessionData | null> {
  let data: GeminiChatFile
  try {
    data = await readGeminiChatFile(filePath)
  } catch (err) {
    log.warn(`Failed to read Gemini session file: ${filePath}`, err)
    return null
  }
  if (!data || !Array.isArray(data.messages) || data.messages.length === 0) return null

  const projectDirectory = await readProjectRoot(dirname(dirname(filePath)))
  const sessionId = data.sessionId || basename(filePath, '.json')

  const messages: ParsedMessage[] = []
  const progressTimestamps: string[] = []
  const totalUsage = emptyTokenUsage()
  const modelsSet = new Set<string>()

  for (const msg of data.messages) {
    if (!msg || typeof msg !== 'object') continue
    const timestamp = msg.timestamp || ''
    if (!timestamp) continue

    if (msg.type === 'user') {
      messages.push({
        type: 'user',
        timestamp,
        sessionId,
        cwd: projectDirectory,
        gitBranch: null,
        model: null,
        usage: null,
        uuid: msg.id ?? null,
        parentUuid: null,
        isToolResult: false,
        hasToolUse: false,
        toolNames: []
      })
      continue
    }

    if (msg.type === 'gemini') {
      const usage = msg.tokens ? usageFromTokens(msg.tokens) : null
      if (usage) {
        totalUsage.inputTokens += usage.inputTokens
        totalUsage.outputTokens += usage.outputTokens
        totalUsage.cacheReadInputTokens += usage.cacheReadInputTokens
      }
      if (msg.model) modelsSet.add(msg.model)

      const toolNames: string[] = []
      if (Array.isArray(msg.toolCalls)) {
        for (const call of msg.toolCalls) {
          if (call?.name && !toolNames.includes(call.name)) toolNames.push(call.name)
        }
      }

      // Thought summaries carry their own timestamps — evidence the model was
      // actively working between the prompt and the reply.
      if (Array.isArray(msg.thoughts)) {
        for (const thought of msg.thoughts) {
          if (thought?.timestamp) progressTimestamps.push(thought.timestamp)
        }
      }

      messages.push({
        type: 'assistant',
        timestamp,
        sessionId,
        cwd: projectDirectory,
        gitBranch: null,
        model: msg.model ?? null,
        usage,
        uuid: msg.id ?? null,
        parentUuid: null,
        isToolResult: false,
        hasToolUse: toolNames.length > 0,
        toolNames
      })
      continue
    }

    // info / error / compression / etc. — activity evidence, not messages
    progressTimestamps.push(timestamp)
  }

  if (messages.length === 0) return null

  messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  progressTimestamps.sort()

  const timestamps = messages.map((m) => m.timestamp)

  return {
    sessionId,
    sourceFile: filePath,
    tool: 'gemini',
    projectPathEncoded: '', // Gemini has no encoded-dir convention; cwd is authoritative
    projectDirectory,
    messages,
    progressTimestamps,
    firstTimestamp: timestamps[0] ?? null,
    lastTimestamp: timestamps[timestamps.length - 1] ?? null,
    totalTokenUsage: totalUsage,
    subagentTokenUsage: emptyTokenUsage(),
    models: Array.from(modelsSet),
    messageCount: messages.length,
    summary: null,
    subagentMessages: [],
    subagentProgressTimestamps: []
  }
}
