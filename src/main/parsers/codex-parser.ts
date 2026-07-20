import { open, readdir } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import log from 'electron-log/main.js'
import { readJsonlLines } from './line-reader'
import type { ParsedSessionData, ParsedMessage, TokenUsage } from './types'

/**
 * Parser for OpenAI Codex CLI rollout files.
 *
 * Codex stores one session per file at:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<started-at>-<session-uuid>.jsonl
 *
 * Modern lines are an envelope { timestamp, type, payload } where type is one of
 * session_meta | turn_context | response_item | event_msg | compacted. The
 * payload of a response_item is an OpenAI Responses item (message, reasoning,
 * function_call, function_call_output, local_shell_call, custom_tool_call, ...).
 * Older CLI versions wrote bare response items without the envelope; those lines
 * carry no timestamps we can bill against, so they are skipped defensively.
 *
 * Output is the same ParsedSessionData shape the Claude parser emits, so the
 * whole downstream pipeline (raw storage, gap detection, rebuild) is shared.
 */

/** Non-human user-message wrappers Codex injects into the transcript. */
const SYNTHETIC_USER_PREFIXES = [
  '<environment_context>',
  '<user_instructions>',
  '<ide_context>',
  '<permissions',
  '<turn_aborted',
  '<system_'
]

function emptyTokenUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0
  }
}

/** Default Codex home (~/.codex). No multi-profile convention exists for Codex. */
export function getCodexSessionsDir(): string {
  return join(homedir(), '.codex', 'sessions')
}

/**
 * Enumerate every rollout JSONL under the date-partitioned sessions tree.
 * Structure: {sessionsDir}/YYYY/MM/DD/rollout-*.jsonl
 */
export async function discoverCodexSessionFiles(sessionsDir?: string): Promise<string[]> {
  const root = sessionsDir ?? getCodexSessionsDir()
  const files: string[] = []

  let years: import('node:fs').Dirent<string>[]
  try {
    years = await readdir(root, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return files // No ~/.codex/sessions — Codex not installed
  }

  for (const year of years) {
    if (!year.isDirectory()) continue
    const yearDir = join(root, year.name)
    let months: import('node:fs').Dirent<string>[]
    try {
      months = await readdir(yearDir, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      continue
    }
    for (const month of months) {
      if (!month.isDirectory()) continue
      const monthDir = join(yearDir, month.name)
      let days: import('node:fs').Dirent<string>[]
      try {
        days = await readdir(monthDir, { withFileTypes: true, encoding: 'utf8' })
      } catch {
        continue
      }
      for (const day of days) {
        if (!day.isDirectory()) continue
        const dayDir = join(monthDir, day.name)
        try {
          const entries = await readdir(dayDir, { withFileTypes: true, encoding: 'utf8' })
          for (const entry of entries) {
            if (entry.isFile() && entry.name.endsWith('.jsonl')) {
              files.push(join(dayDir, entry.name))
            }
          }
        } catch {
          continue
        }
      }
    }
  }

  return files
}

interface CodexMeta {
  sessionId: string
  cwd: string | null
}

// A rollout's session_meta never changes once written, so cache by (path, mtime).
// Discovery, project-filtering, and rebuild all read the same heads repeatedly;
// this turns the second-and-later reads within/across scans into a stat + lookup.
const metaCache = new Map<string, { mtime: number; meta: CodexMeta | null }>()

/**
 * Read just the session_meta from the head of a rollout file (first few lines)
 * without parsing the whole file. Used by discovery and project filtering.
 */
export async function readCodexSessionMeta(filePath: string): Promise<CodexMeta | null> {
  let fh: Awaited<ReturnType<typeof open>> | null = null
  try {
    fh = await open(filePath, 'r')
    const { size, mtimeMs } = await fh.stat()
    const cached = metaCache.get(filePath)
    if (cached && cached.mtime === mtimeMs) return cached.meta

    // session_meta is the first line but can be large (embedded base instructions).
    // Grow the read window until we have at least one complete line rather than
    // giving up at a fixed size — a header past the cutoff would otherwise be
    // dropped, losing the cwd. Capped at 4MB as a sanity backstop.
    const MAX = 4 * 1024 * 1024
    let content = ''
    for (let chunk = 262144; ; chunk = Math.min(chunk * 2, MAX)) {
      const readSize = Math.min(chunk, size)
      const buffer = Buffer.alloc(readSize)
      const { bytesRead } = await fh.read(buffer, 0, readSize, 0)
      content = buffer.toString('utf-8', 0, bytesRead)
      if (content.includes('\n') || readSize >= size || readSize >= MAX) break
    }

    const meta = parseMetaFromHead(content, filePath)
    metaCache.set(filePath, { mtime: mtimeMs, meta })
    return meta
  } catch {
    return null
  } finally {
    await fh?.close()
  }
}

/** Scan the first few head lines of a rollout for its session_meta. */
function parseMetaFromHead(content: string, filePath: string): CodexMeta {
  for (const line of content.split('\n').slice(0, 5)) {
    if (!line.trim()) continue
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(line)
    } catch {
      continue // truncated last line or malformed
    }
    const payload = raw.payload as Record<string, unknown> | undefined
    if (raw.type === 'session_meta' && payload) {
      return {
        sessionId:
          (payload.id as string) || (payload.session_id as string) || fallbackSessionId(filePath),
        cwd: (payload.cwd as string) || null
      }
    }
    // Legacy headers: bare meta object with id/cwd at top level
    if (!raw.type && (raw.id || raw.cwd)) {
      return {
        sessionId: (raw.id as string) || fallbackSessionId(filePath),
        cwd: (raw.cwd as string) || null
      }
    }
  }
  return { sessionId: fallbackSessionId(filePath), cwd: null }
}

/** rollout-2026-07-19T14-05-11-<uuid>.jsonl → <uuid> */
function fallbackSessionId(filePath: string): string {
  const name = basename(filePath, '.jsonl')
  const m = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)
  return m ? m[1] : name
}

function isSyntheticUserText(text: string): boolean {
  const trimmed = text.trimStart()
  return SYNTHETIC_USER_PREFIXES.some((p) => trimmed.startsWith(p))
}

/** Extract concatenated text from a Responses-API message content array. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content as Array<{ type?: string; text?: string }>) {
    if (typeof block?.text === 'string') out += block.text
  }
  return out
}

interface CodexUsageTotals {
  input: number
  cached: number
  output: number
}

function readUsageTotals(info: Record<string, unknown> | undefined): CodexUsageTotals | null {
  const total = info?.total_token_usage as Record<string, number> | undefined
  if (!total) return null
  return {
    input: total.input_tokens || 0,
    cached: total.cached_input_tokens || 0,
    output: total.output_tokens || 0
  }
}

/**
 * Parse a Codex rollout file into ParsedSessionData.
 * Returns null for unreadable files; skips malformed/unknown lines with a log.
 */
export async function parseCodexSessionFile(filePath: string): Promise<ParsedSessionData | null> {
  const messages: ParsedMessage[] = []
  const progressTimestamps: string[] = []
  const totalUsage = emptyTokenUsage()
  const modelsSet = new Set<string>()

  let sessionId = ''
  let projectDirectory: string | null = null
  let currentModel: string | null = null
  // token_count events report cumulative session totals — diff consecutive events
  // to get per-turn deltas, robust to how often the CLI emits them.
  let prevTotals: CodexUsageTotals = { input: 0, cached: 0, output: 0 }
  // Usage deltas attach to the most recent assistant message; if none exists yet
  // the delta is carried until one appears.
  let pendingUsage: TokenUsage | null = null
  let lastAssistantIdx = -1

  // Attach a usage delta to the most recent assistant message (or stash it as
  // pending until one appears). Session totals are accumulated by the caller.
  const attachUsage = (usage: TokenUsage): void => {
    const target = lastAssistantIdx >= 0 ? messages[lastAssistantIdx] : null
    if (target) {
      target.usage = target.usage ? mergeUsage(target.usage, usage) : usage
      if (!target.model) target.model = currentModel
    } else {
      pendingUsage = pendingUsage ? mergeUsage(pendingUsage, usage) : usage
    }
  }

  // Stream lines so a large rollout (tens of MB) never loads whole into memory.
  let lineIdx = 0
  const lineIter = readJsonlLines(filePath)
  while (true) {
    let next: IteratorResult<string, void>
    try {
      next = await lineIter.next()
    } catch (err) {
      log.warn(`Failed to read Codex session file: ${filePath}`, err)
      return null
    }
    if (next.done) break
    const line = next.value
    const idx = lineIdx++
    // Yield periodically so parsing large rollouts doesn't block the main process
    if (lineIdx % 2000 === 0) await new Promise((resolve) => setImmediate(resolve))

    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(line)
    } catch {
      log.warn(`Malformed JSONL line in ${filePath}, skipping`)
      continue
    }

    const timestamp = (raw.timestamp as string) || ''
    const envelopeType = raw.type as string | undefined
    const payload = raw.payload as Record<string, unknown> | undefined

    // Legacy bare lines (no envelope) carry no timestamp — nothing billable to extract
    if (!envelopeType || !timestamp) continue

    if (envelopeType === 'session_meta' && payload) {
      sessionId =
        (payload.id as string) || (payload.session_id as string) || fallbackSessionId(filePath)
      if (!projectDirectory && payload.cwd) projectDirectory = payload.cwd as string
      continue
    }

    if (envelopeType === 'turn_context' && payload) {
      if (payload.model) {
        currentModel = payload.model as string
        modelsSet.add(currentModel)
      }
      if (!projectDirectory && payload.cwd) projectDirectory = payload.cwd as string
      continue
    }

    if (envelopeType === 'event_msg' && payload) {
      const evType = payload.type as string
      if (evType === 'token_count') {
        const info = payload.info as Record<string, unknown> | undefined
        const totals = readUsageTotals(info)
        if (totals) {
          // Codex reports cumulative session totals; per-turn deltas come from
          // diffing consecutive token_count events. Context compaction, cache
          // eviction, or a session reset can make a cumulative field DROP, and a
          // naive diff mishandles that two ways: a shrinking `cached` makes
          // `-Δcached` positive and inflates input with phantom tokens, while a
          // reset that lowers `input` below the stale baseline drives Δinput
          // negative and silently undercounts (max(0,·) → 0) for many turns.
          // Guard both: if input/output fall below the prior baseline a reset
          // happened, so re-baseline from zero; and clamp Δcached into
          // [0, Δinput] so a shrinking cache never subtracts more than the input
          // that actually grew this turn.
          const reset = totals.input < prevTotals.input || totals.output < prevTotals.output
          const base = reset ? { input: 0, cached: 0, output: 0 } : prevTotals
          const dInput = Math.max(0, totals.input - base.input)
          const dOutput = Math.max(0, totals.output - base.output)
          // Codex input_tokens INCLUDES cached tokens — split them out
          const dCached = Math.min(Math.max(0, totals.cached - base.cached), dInput)
          const delta: TokenUsage = {
            inputTokens: dInput - dCached,
            outputTokens: dOutput,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: dCached
          }
          prevTotals = totals
          if (delta.inputTokens || delta.outputTokens || delta.cacheReadInputTokens) {
            totalUsage.inputTokens += delta.inputTokens
            totalUsage.outputTokens += delta.outputTokens
            totalUsage.cacheReadInputTokens += delta.cacheReadInputTokens
            attachUsage(delta)
          }
        }
        // Every token_count is proof the agent is actively working — progress evidence
        progressTimestamps.push(timestamp)
        continue
      }
      // Other event_msgs (agent_reasoning deltas, task lifecycle, exec output…)
      // are activity evidence during long turns, not messages.
      progressTimestamps.push(timestamp)
      continue
    }

    if (envelopeType === 'response_item' && payload) {
      const itemType = payload.type as string
      const uuid = `l${idx}` // rollouts are append-only, so the line index is stable

      if (itemType === 'message') {
        const role = payload.role as string
        const text = messageText(payload.content)
        if (role === 'user') {
          const synthetic = isSyntheticUserText(text)
          messages.push({
            // Synthetic context wrappers must not count as human prompts
            type: synthetic ? 'system' : 'user',
            timestamp,
            sessionId,
            cwd: projectDirectory,
            gitBranch: null,
            model: null,
            usage: null,
            uuid,
            parentUuid: null,
            isToolResult: false,
            hasToolUse: false,
            toolNames: []
          })
        } else if (role === 'assistant') {
          messages.push({
            type: 'assistant',
            timestamp,
            sessionId,
            cwd: projectDirectory,
            gitBranch: null,
            model: currentModel,
            usage: null,
            uuid,
            parentUuid: null,
            isToolResult: false,
            hasToolUse: false,
            toolNames: []
          })
          lastAssistantIdx = messages.length - 1
          if (pendingUsage) {
            attachUsage(pendingUsage)
            pendingUsage = null
          }
        }
        continue
      }

      if (
        itemType === 'function_call' ||
        itemType === 'local_shell_call' ||
        itemType === 'custom_tool_call' ||
        itemType === 'web_search_call'
      ) {
        const toolName =
          (payload.name as string) ||
          (itemType === 'local_shell_call' ? 'shell' : itemType.replace(/_call$/, ''))
        messages.push({
          type: 'assistant',
          timestamp,
          sessionId,
          cwd: projectDirectory,
          gitBranch: null,
          model: currentModel,
          usage: null,
          uuid,
          parentUuid: null,
          isToolResult: false,
          hasToolUse: true,
          toolNames: [toolName]
        })
        lastAssistantIdx = messages.length - 1
        if (pendingUsage) {
          attachUsage(pendingUsage)
          pendingUsage = null
        }
        continue
      }

      if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
        messages.push({
          type: 'user',
          timestamp,
          sessionId,
          cwd: projectDirectory,
          gitBranch: null,
          model: null,
          usage: null,
          uuid,
          parentUuid: null,
          isToolResult: true,
          hasToolUse: false,
          toolNames: []
        })
        continue
      }

      // reasoning, ghost snapshots, etc. — activity evidence only
      progressTimestamps.push(timestamp)
      continue
    }

    // compacted / unknown envelope types — ignore
  }

  if (lineIdx === 0) return null // empty (or unreadable) file — nothing to parse

  if (!sessionId) sessionId = fallbackSessionId(filePath)
  // A still-pending usage delta (no assistant message ever appeared) is already
  // counted in totalUsage; there is simply no message row to pin it to.

  messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  progressTimestamps.sort()

  const timestamps = messages.filter((m) => m.timestamp).map((m) => m.timestamp)

  return {
    sessionId,
    sourceFile: filePath,
    tool: 'codex',
    projectPathEncoded: '', // Codex has no encoded-dir convention; cwd is authoritative
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

export interface CodexLiveState {
  lastPromptAt: string | null
  awaitingResponse: boolean
  state: 'idle' | 'awaiting' | 'tool-pending' | 'processing'
}

/**
 * Tail-read a Codex rollout to find the last human prompt and whether the agent
 * is mid-turn. Mirrors the Claude tail reader's state machine, translated to
 * Codex record types. Reads at most the last 512KB.
 */
export async function tailReadCodexState(filePath: string): Promise<CodexLiveState> {
  let fh: Awaited<ReturnType<typeof open>> | null = null
  try {
    fh = await open(filePath, 'r')
    const fileStat = await fh.stat()
    const fileSize = fileStat.size

    let lines: string[] = []
    for (let chunkSize = 65536; chunkSize <= 524288; chunkSize *= 2) {
      const readSize = Math.min(chunkSize, fileSize)
      const position = Math.max(0, fileSize - readSize)
      const buffer = Buffer.alloc(readSize)
      await fh.read(buffer, 0, readSize, position)
      const content = buffer.toString('utf-8')
      const allLines = content.split('\n').filter((l) => l.trim())
      lines = position > 0 ? allLines.slice(1) : allLines

      const hasUserPrompt = lines.some((l) => {
        try {
          const obj = JSON.parse(l)
          return isCodexHumanPrompt(obj)
        } catch {
          return false
        }
      })
      if (hasUserPrompt || readSize >= fileSize) break
    }

    let lastPromptAt: string | null = null
    let state: CodexLiveState['state'] = 'idle'

    for (const line of lines) {
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      const timestamp = obj.timestamp as string | undefined
      const payload = obj.payload as Record<string, unknown> | undefined
      if (!timestamp || !payload) continue

      if (isCodexHumanPrompt(obj)) {
        lastPromptAt = timestamp
        state = 'awaiting'
        continue
      }
      if (obj.type === 'response_item') {
        const t = payload.type as string
        if (t === 'function_call' || t === 'local_shell_call' || t === 'custom_tool_call') {
          state = 'tool-pending'
        } else if (t === 'function_call_output' || t === 'custom_tool_call_output') {
          state = 'processing'
        } else if (t === 'message' && payload.role === 'assistant') {
          state = 'idle'
        }
        continue
      }
      if (obj.type === 'event_msg') {
        const t = payload.type as string
        if (t === 'agent_message') state = 'idle'
        else if (t === 'task_complete' || t === 'turn_aborted') state = 'idle'
        // token_count / reasoning deltas don't change turn state
      }
    }

    return { lastPromptAt, awaitingResponse: state !== 'idle', state }
  } catch (err) {
    log.debug(`tailReadCodexState error for ${filePath}:`, err)
    return { lastPromptAt: null, awaitingResponse: false, state: 'idle' }
  } finally {
    await fh?.close()
  }
}

/** A real human prompt: a user response_item whose text isn't an injected wrapper. */
function isCodexHumanPrompt(obj: Record<string, unknown>): boolean {
  if (obj.type !== 'response_item' || !obj.timestamp) return false
  const payload = obj.payload as Record<string, unknown> | undefined
  if (!payload || payload.type !== 'message' || payload.role !== 'user') return false
  return !isSyntheticUserText(messageText(payload.content))
}

function mergeUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens
  }
}
