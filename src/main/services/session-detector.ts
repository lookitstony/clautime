import type { ParsedSessionData, ParsedMessage } from '../parsers/types'
import type { DetectedSession } from '../../shared/types/session'
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
  let segmentStart = 0

  for (let i = 1; i < messages.length; i++) {
    const prevTime = new Date(messages[i - 1].timestamp).getTime()
    const currTime = new Date(messages[i].timestamp).getTime()
    const gapMinutes = (currTime - prevTime) / (1000 * 60)

    if (gapMinutes > idleTimeoutMinutes) {
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
        if (gapMinutes <= MAX_PROGRESS_GAP_MINUTES &&
            hasProgressActivity(parsed.progressTimestamps, prevTs, currTs)) {
          continue
        }
        // Fall back to tool-type heuristic limits for short gaps without progress
        if (gapMinutes <= getMaxToolGap(messages[i - 1].toolNames)) {
          continue
        }
      }

      results.push(
        buildDetectedSession(parsed, messages, segmentStart, i - 1, projectPath)
      )
      segmentStart = i
    }
  }

  // Final segment
  results.push(
    buildDetectedSession(parsed, messages, segmentStart, messages.length - 1, projectPath)
  )

  // Filter out noise: sessions with 0 human prompts and minimal tokens (< 50) are just init/system messages
  return results.filter((s) => s.promptCount > 0 || (s.inputTokens + s.outputTokens) >= 50)
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
 * e.g. "C--apps-ClawdTime" -> "C:\apps\ClawdTime" (Windows)
 */
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
function hasProgressActivity(progressTimestamps: string[], startTs: string, endTs: string): boolean {
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
  while (lastInRange + 1 < progressTimestamps.length && progressTimestamps[lastInRange + 1] < endTs) {
    lastInRange++
  }
  const lastProgressMs = new Date(progressTimestamps[lastInRange]).getTime()
  const endMs = new Date(endTs).getTime()
  return (endMs - lastProgressMs) < 15 * 60_000
}

/**
 * Maximum gap (in minutes) to tolerate for a tool execution before treating
 * it as idle time. Based on realistic execution times per tool type.
 */
const TOOL_GAP_SLOW = 30  // Agent subagents, complex MCP tools
const TOOL_GAP_MEDIUM = 10 // Bash (builds/tests can take a few minutes)
const TOOL_GAP_FAST = 5    // Read, Write, Edit, Glob, Grep, etc.

const SLOW_TOOLS = new Set(['Agent', 'TaskCreate', 'TaskUpdate', 'TaskGet'])
const FAST_TOOLS = new Set([
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'LSP',
  'NotebookEdit', 'AskUserQuestion', 'TodoWrite',
  'EnterPlanMode', 'ExitPlanMode'
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
  projectPath: string
): DetectedSession {
  const startedAt = messages[startIdx].timestamp
  const endedAt = messages[endIdx].timestamp
  const startMs = new Date(startedAt).getTime()
  const endMs = new Date(endedAt).getTime()
  const durationMinutes = Math.round((endMs - startMs) / (1000 * 60))

  const segment = messages.slice(startIdx, endIdx + 1)

  // Count only human prompts (user messages that are NOT tool results)
  const humanPrompts = segment
    .filter((m) => m.type === 'user' && !m.isToolResult)
    .length

  // Accumulate token usage for this segment
  let inputTokens = 0
  let outputTokens = 0
  for (const m of segment) {
    if (m.usage) {
      inputTokens += m.usage.inputTokens
      outputTokens += m.usage.outputTokens
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
  }

  return {
    startedAt,
    endedAt,
    durationMinutes: Math.max(1, durationMinutes), // intentional: minimum 1 minute per session
    projectPath,
    claudeSessionId: parsed.sessionId,
    sourceFile: parsed.sourceFile,
    promptCount: humanPrompts,
    inputTokens,
    outputTokens
  }
}
