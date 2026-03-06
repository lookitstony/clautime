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
      // Don't split at tool execution gaps — when an assistant spawned a tool
      // (e.g. Agent subagent) and we're waiting for the result, the gap is
      // active work time, not idle time.
      const prevIsToolCall = messages[i - 1].hasToolUse
      const currIsToolResult = messages[i].isToolResult
      if (prevIsToolCall || currIsToolResult) {
        continue
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
  return results.filter((s) => s.messageCount > 0 || (s.inputTokens + s.outputTokens) >= 50)
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

  return {
    startedAt,
    endedAt,
    durationMinutes: Math.max(1, durationMinutes), // intentional: minimum 1 minute per session
    projectPath,
    claudeSessionId: parsed.sessionId,
    sourceFile: parsed.sourceFile,
    messageCount: humanPrompts,
    inputTokens,
    outputTokens
  }
}
