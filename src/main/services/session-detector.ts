import type { ParsedSessionData, ParsedMessage, TokenUsage } from '../parsers/types'
import type { DetectedSession, SessionModelUsage } from '../../shared/types/session'
import { normalizePath } from '../../shared/paths'

/**
 * Detect individual work sessions from parsed session data by identifying
 * activity gaps exceeding the idle timeout threshold.
 *
 * Pure function — no side effects, no DB, no IPC.
 */
export function detectSessions(
  parsed: ParsedSessionData,
  idleTimeoutMinutes: number
): DetectedSession[] {
  const messages = parsed.messages.filter((m) => m.timestamp)
  if (messages.length === 0) return []

  const projectPath = resolveProjectPath(parsed)
  const results: DetectedSession[] = []
  // Parallel to `results`: true when a segment boundary was clipped to midnight
  // rather than landing on a real message. Such segments are exempt from the
  // noise filter below — their time is real even if they hold few messages.
  const clipped: boolean[] = []
  let segmentStart = 0
  let startOverride: string | null = null

  const pushSegment = (endIdx: number, endOverride: string | null): void => {
    results.push(
      buildDetectedSession(
        parsed,
        messages,
        segmentStart,
        endIdx,
        projectPath,
        startOverride,
        endOverride
      )
    )
    clipped.push(startOverride !== null || endOverride !== null)
  }

  for (let i = 1; i < messages.length; i++) {
    const prevTs = messages[i - 1].timestamp
    const currTs = messages[i].timestamp
    const gapMinutes = (new Date(currTs).getTime() - new Date(prevTs).getTime()) / (1000 * 60)

    if (shouldSplitOnGap(parsed, messages, i, gapMinutes, idleTimeoutMinutes)) {
      // Idle gap — the time between the two messages is not work, so both
      // sides keep their real timestamps and the gap is counted for nobody.
      pushSegment(i - 1, null)
      segmentStart = i
      startOverride = null
      continue
    }

    // Continuous work. If it runs past local midnight, split there and clip
    // both halves to the boundary so each day gets its true share and no
    // minutes are dropped between them.
    const midnight = midnightBetween(prevTs, currTs)
    if (midnight) {
      pushSegment(i - 1, midnight)
      segmentStart = i
      startOverride = midnight
    }
  }

  // Final segment
  pushSegment(messages.length - 1, null)

  // Filter out noise: sessions with 0 human prompts and minimal tokens (< 50) are just init/system messages
  return results.filter(
    (s, i) =>
      (clipped[i] && s.durationMinutes >= MIN_CLIPPED_FRAGMENT_MINUTES) ||
      s.promptCount > 0 ||
      s.inputTokens + s.outputTokens >= 50
  )
}

/**
 * Whether the gap before messages[i] is idle time that should end the session.
 *
 * Extracted from the detection loop so the midnight-boundary logic can ask
 * "would this have split anyway?" without duplicating the heuristics.
 */
function shouldSplitOnGap(
  parsed: ParsedSessionData,
  messages: ParsedMessage[],
  i: number,
  gapMinutes: number,
  idleTimeoutMinutes: number
): boolean {
  if (gapMinutes <= idleTimeoutMinutes) return false

  // Don't split at tool execution gaps when there's evidence of active
  // processing. Requires BOTH sides of the gap to be a tool boundary
  // (tool_use before, tool_result after) to avoid bridging interrupted tools.
  const prevIsToolCall = messages[i - 1].hasToolUse
  const currIsToolResult = messages[i].isToolResult
  if (prevIsToolCall && currIsToolResult) {
    const prevTs = messages[i - 1].timestamp
    const currTs = messages[i].timestamp
    // Hard cap: no single tool execution should bridge more than 2 hours,
    // even with progress events (catches tail -f, npm run dev left overnight)
    if (
      gapMinutes <= MAX_PROGRESS_GAP_MINUTES &&
      hasProgressActivity(parsed.progressTimestamps, prevTs, currTs)
    ) {
      return false
    }
    // Fall back to tool-type heuristic limits for short gaps without progress
    if (gapMinutes <= getMaxToolGap(messages[i - 1].toolNames)) {
      return false
    }
  }

  return true
}

/**
 * Detect sessions from multiple parsed session files.
 * Calls detectSessions for each, flattens results.
 */
export function detectSessionsFromMultiple(
  parsedSessions: ParsedSessionData[],
  idleTimeoutMinutes: number
): DetectedSession[] {
  const results: DetectedSession[] = []
  for (const parsed of parsedSessions) {
    results.push(...detectSessions(parsed, idleTimeoutMinutes))
  }
  return results
}

/**
 * Resolve the project path from parsed data.
 * Priority: projectDirectory (cwd) > decode projectPathEncoded.
 * Normalizes to consistent path separators (backslashes on Windows).
 */
export function resolveProjectPath(parsed: ParsedSessionData): string {
  const raw = parsed.projectDirectory || decodeProjectPath(parsed.projectPathEncoded)
  return normalizePath(raw)
}

/**
 * Best-effort decode of the encoded project path from .claude folder structure.
 * e.g. "C--apps-ClauTime" -> "C:\apps\ClauTime" (Windows)
 */
/**
 * Encode a filesystem path to the .claude/projects/ directory name format.
 * e.g. "C:\research\ai bots" → "C--research-ai-bots"
 * Used for matching DB paths against encoded directory names.
 */
export function encodeProjectPath(fsPath: string): string {
  if (!fsPath) return ''
  // Windows: C:\foo\bar → C--foo-bar
  const winMatch = fsPath.match(/^([A-Za-z]):[\\/](.*)$/)
  if (winMatch) {
    return `${winMatch[1]}--${winMatch[2].replace(/[\\/\s]/g, '-')}`
  }
  // Unix: /home/user/foo → -home-user-foo
  if (fsPath.startsWith('/')) {
    return fsPath.replace(/[/\s]/g, '-')
  }
  return fsPath.replace(/[/\\\s]/g, '-')
}

export function decodeProjectPath(encoded: string): string {
  if (!encoded) return 'unknown'

  // Windows drive letter pattern: C--apps-Foo → C:\apps\Foo
  const windowsDriveMatch = encoded.match(/^([A-Za-z])-(-?.*)$/)
  if (windowsDriveMatch) {
    const drive = windowsDriveMatch[1]
    const rest = windowsDriveMatch[2]
    return `${drive}:${rest.replace(/-/g, '\\')}`
  }

  // Unix path: leading dash means root /
  if (encoded.startsWith('-')) {
    return encoded.replace(/-/g, '/')
  }

  return encoded.replace(/-/g, '/')
}

/** Hard cap: even with progress events, no tool gap bridges more than 2 hours */
const MAX_PROGRESS_GAP_MINUTES = 120

/** A gap longer than this is never clipped to midnight — see midnightBetween. */
const MAX_CLIPPABLE_GAP_MS = 24 * 60 * 60_000

/**
 * A midnight fragment is spared the noise filter only if it holds at least this
 * much time. Without a floor, init/system lines written just before midnight
 * would be minted as tiny sessions dated to the previous day.
 */
const MIN_CLIPPED_FRAGMENT_MINUTES = 2

/**
 * The local midnight separating two timestamps, or null if they fall on the
 * same calendar day.
 *
 * Returns null for gaps over 24h as well: those can straddle more than one
 * midnight, and clipping to a single boundary would dump the extra days onto
 * one side. Such gaps only survive a wildly large idle timeout, and leaving
 * them unclipped just preserves today's behaviour.
 */
function midnightBetween(prevTs: string, currTs: string): string | null {
  const prev = new Date(prevTs)
  const curr = new Date(currTs)
  if (
    prev.getFullYear() === curr.getFullYear() &&
    prev.getMonth() === curr.getMonth() &&
    prev.getDate() === curr.getDate()
  ) {
    return null
  }
  if (curr.getTime() - prev.getTime() > MAX_CLIPPABLE_GAP_MS) return null

  const midnight = new Date(curr.getFullYear(), curr.getMonth(), curr.getDate())
  // Zones whose DST transition lands on 00:00 (America/Santiago, America/Havana)
  // can rewind past midnight, putting the boundary outside the gap. Clipping to
  // it there would invert the first segment and overlap the second.
  const midnightMs = midnight.getTime()
  if (midnightMs <= prev.getTime() || midnightMs >= curr.getTime()) return null

  return midnight.toISOString()
}

/**
 * Check if progress events show active tool processing during a time range.
 *
 * For short gaps (< 30 min): any progress event strictly between the boundaries
 * is sufficient evidence.
 * For long gaps (>= 30 min): requires the last progress event to be within
 * 15 minutes of the gap end, proving the tool was still actively running
 * near the end (not just at the start before going idle).
 *
 * Uses exclusive boundaries — a progress event at exactly startTs or endTs
 * is not evidence of activity *during* the gap.
 */
function hasProgressActivity(
  progressTimestamps: string[],
  startTs: string,
  endTs: string
): boolean {
  if (progressTimestamps.length === 0) return false

  // Binary search for first timestamp > startTs (exclusive)
  let lo = 0
  let hi = progressTimestamps.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (progressTimestamps[mid] <= startTs) lo = mid + 1
    else hi = mid
  }

  // Check if any progress event falls strictly between start and end
  if (lo >= progressTimestamps.length || progressTimestamps[lo] >= endTs) {
    return false
  }

  // For short gaps, any progress event is sufficient
  const gapMs = new Date(endTs).getTime() - new Date(startTs).getTime()
  if (gapMs < 30 * 60_000) return true

  // For long gaps, find the LAST progress event before endTs and check
  // it's within 15 minutes of the gap end (tool was still running near the end)
  let lastInRange = lo
  while (
    lastInRange + 1 < progressTimestamps.length &&
    progressTimestamps[lastInRange + 1] < endTs
  ) {
    lastInRange++
  }
  const lastProgressMs = new Date(progressTimestamps[lastInRange]).getTime()
  const endMs = new Date(endTs).getTime()
  return endMs - lastProgressMs < 15 * 60_000
}

/**
 * Maximum gap (in minutes) to tolerate for a tool execution before treating
 * it as idle time. Based on realistic execution times per tool type.
 */
const TOOL_GAP_SLOW = 30 // Agent subagents, complex MCP tools
const TOOL_GAP_MEDIUM = 10 // Bash (builds/tests can take a few minutes)
const TOOL_GAP_FAST = 5 // Read, Write, Edit, Glob, Grep, etc.

const SLOW_TOOLS = new Set([
  'Agent',
  'TaskCreate',
  'TaskUpdate',
  'TaskGet',
  // OpenCode's subagent tool
  'task'
])
const FAST_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'LSP',
  'NotebookEdit',
  'AskUserQuestion',
  'TodoWrite',
  'EnterPlanMode',
  'ExitPlanMode',
  // Codex CLI tool names ('shell' intentionally omitted — medium, like Bash)
  'apply_patch',
  'update_plan',
  'view_image',
  // Gemini CLI tool names ('run_shell_command' etc. omitted — medium)
  'read_file',
  'read_many_files',
  'write_file',
  'replace',
  'list_directory',
  'glob',
  'search_file_content',
  // OpenCode tool names ('bash', 'webfetch' omitted — medium)
  'read',
  'write',
  'edit',
  'grep',
  'list',
  'patch',
  'todowrite',
  'todoread'
])

function getMaxToolGap(toolNames: string[]): number {
  if (toolNames.length === 0) return TOOL_GAP_MEDIUM
  // Use the most generous limit among the tools called
  let max = TOOL_GAP_FAST
  for (const name of toolNames) {
    if (SLOW_TOOLS.has(name)) return TOOL_GAP_SLOW
    if (!FAST_TOOLS.has(name)) max = Math.max(max, TOOL_GAP_MEDIUM)
  }
  return max
}

function buildDetectedSession(
  parsed: ParsedSessionData,
  messages: ParsedMessage[],
  startIdx: number,
  endIdx: number,
  projectPath: string,
  /** Clip the session start to this instant instead of the first message's time. */
  startOverride: string | null = null,
  /** Clip the session end to this instant instead of the last message's time. */
  endOverride: string | null = null
): DetectedSession {
  const startedAt = startOverride ?? messages[startIdx].timestamp
  const endedAt = endOverride ?? messages[endIdx].timestamp
  const startMs = new Date(startedAt).getTime()
  const endMs = new Date(endedAt).getTime()
  const durationMinutes = Math.round((endMs - startMs) / (1000 * 60))

  const segment = messages.slice(startIdx, endIdx + 1)

  // Count only human prompts (user messages that are NOT tool results)
  const humanPrompts = segment.filter((m) => m.type === 'user' && !m.isToolResult).length

  // Accumulate token usage for this segment, per model (including cache tokens)
  let inputTokens = 0
  let outputTokens = 0
  const usageByModel = new Map<string, SessionModelUsage>()
  for (const m of segment) {
    if (m.usage) {
      inputTokens += m.usage.inputTokens
      outputTokens += m.usage.outputTokens
      addModelUsage(usageByModel, m.model, m.usage)
    }
  }

  // Distribute subagent tokens proportionally across segments by token share.
  // Subagents run within the session but their tokens are in separate files.
  const totalMainTokens = parsed.totalTokenUsage.inputTokens + parsed.totalTokenUsage.outputTokens
  const segmentTokens = inputTokens + outputTokens
  if (totalMainTokens > 0 && segmentTokens > 0) {
    const proportion = segmentTokens / totalMainTokens
    inputTokens += Math.round(parsed.subagentTokenUsage.inputTokens * proportion)
    outputTokens += Math.round(parsed.subagentTokenUsage.outputTokens * proportion)

    // Same proportional split for subagent usage, but attributed to each
    // subagent message's actual model so per-model costs stay accurate.
    for (const sm of parsed.subagentMessages) {
      if (!sm.usage) continue
      addModelUsage(usageByModel, sm.model, {
        inputTokens: Math.round(sm.usage.inputTokens * proportion),
        outputTokens: Math.round(sm.usage.outputTokens * proportion),
        cacheCreationInputTokens: Math.round(sm.usage.cacheCreationInputTokens * proportion),
        cacheReadInputTokens: Math.round(sm.usage.cacheReadInputTokens * proportion)
      })
    }
  }

  return {
    startedAt,
    endedAt,
    durationMinutes: Math.max(1, durationMinutes), // intentional: minimum 1 minute per session
    projectPath,
    tool: parsed.tool ?? 'claude',
    claudeSessionId: parsed.sessionId,
    sourceFile: parsed.sourceFile,
    promptCount: humanPrompts,
    inputTokens,
    outputTokens,
    modelUsage: [...usageByModel.values()]
  }
}

/** Model key for messages without a model string (synthetic, old data). */
const UNKNOWN_MODEL = 'unknown'

function addModelUsage(
  map: Map<string, SessionModelUsage>,
  model: string | null,
  usage: TokenUsage
): void {
  const key = model ?? UNKNOWN_MODEL
  let entry = map.get(key)
  if (!entry) {
    entry = {
      model: key,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0
    }
    map.set(key, entry)
  }
  entry.inputTokens += usage.inputTokens
  entry.outputTokens += usage.outputTokens
  entry.cacheCreationInputTokens += usage.cacheCreationInputTokens
  entry.cacheReadInputTokens += usage.cacheReadInputTokens
}
