// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  detectSessions,
  detectSessionsFromMultiple,
  resolveProjectPath,
  decodeProjectPath
} from './session-detector'
import type { ParsedSessionData, ParsedMessage } from '../parsers/types'

function makeMessage(timestamp: string, overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    type: 'user',
    timestamp,
    sessionId: 'test-session',
    cwd: '/projects/test',
    gitBranch: null,
    model: null,
    usage: null,
    uuid: null,
    parentUuid: null,
    isToolResult: false,
    hasToolUse: false,
    toolNames: [],
    ...overrides
  }
}

function makeParsedSession(
  messages: ParsedMessage[],
  overrides: Partial<ParsedSessionData> = {}
): ParsedSessionData {
  const timestamps = messages.filter((m) => m.timestamp).map((m) => m.timestamp)
  return {
    sessionId: 'test-session-id',
    sourceFile: '/home/user/.claude/projects/test-project/abc123.jsonl',
    projectPathEncoded: 'C--apps-TestProject',
    projectDirectory: '/projects/test',
    messages,
    firstTimestamp: timestamps[0] ?? null,
    lastTimestamp: timestamps[timestamps.length - 1] ?? null,
    progressTimestamps: [],
    totalTokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0
    },
    subagentTokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0
    },
    models: [],
    messageCount: messages.length,
    summary: null,
    subagentMessages: [],
    subagentProgressTimestamps: [],
    ...overrides
  }
}

describe('detectSessions', () => {
  it('should return empty array for no messages', () => {
    const parsed = makeParsedSession([])
    const result = detectSessions(parsed, 10)
    expect(result).toEqual([])
  })

  it('should return empty array when all messages have no timestamp', () => {
    const parsed = makeParsedSession([
      makeMessage('', { type: 'user' }),
      makeMessage('', { type: 'assistant' })
    ])
    const result = detectSessions(parsed, 10)
    expect(result).toEqual([])
  })

  it('should detect a single continuous session (no idle gaps)', () => {
    const messages = [
      makeMessage('2026-03-04T10:00:00Z'),
      makeMessage('2026-03-04T10:05:00Z'),
      makeMessage('2026-03-04T10:08:00Z'),
      makeMessage('2026-03-04T10:12:00Z')
    ]
    const parsed = makeParsedSession(messages)
    const result = detectSessions(parsed, 10)

    expect(result).toHaveLength(1)
    expect(result[0].startedAt).toBe('2026-03-04T10:00:00Z')
    expect(result[0].endedAt).toBe('2026-03-04T10:12:00Z')
    expect(result[0].durationMinutes).toBe(12)
    expect(result[0].promptCount).toBe(4)
    expect(result[0].projectPath).toBe('/projects/test')
    expect(result[0].claudeSessionId).toBe('test-session-id')
  })

  it('should detect multiple sessions when idle gap exceeds timeout', () => {
    const messages = [
      makeMessage('2026-03-04T10:00:00Z'),
      makeMessage('2026-03-04T10:05:00Z'),
      // 20 minute gap (> 10 minute timeout)
      makeMessage('2026-03-04T10:25:00Z'),
      makeMessage('2026-03-04T10:30:00Z')
    ]
    const parsed = makeParsedSession(messages)
    const result = detectSessions(parsed, 10)

    expect(result).toHaveLength(2)
    expect(result[0].startedAt).toBe('2026-03-04T10:00:00Z')
    expect(result[0].endedAt).toBe('2026-03-04T10:05:00Z')
    expect(result[0].durationMinutes).toBe(5)
    expect(result[0].promptCount).toBe(2)

    expect(result[1].startedAt).toBe('2026-03-04T10:25:00Z')
    expect(result[1].endedAt).toBe('2026-03-04T10:30:00Z')
    expect(result[1].durationMinutes).toBe(5)
    expect(result[1].promptCount).toBe(2)
  })

  it('should NOT split at Agent subagent gaps under 30 minutes', () => {
    const messages = [
      makeMessage('2026-03-04T10:00:00Z', { type: 'user' }),
      makeMessage('2026-03-04T10:01:00Z', {
        type: 'assistant',
        hasToolUse: true,
        toolNames: ['Agent']
      }),
      // 25 min gap — Agent subagent running (under 30 min limit)
      makeMessage('2026-03-04T10:26:00Z', { type: 'user', isToolResult: true }),
      makeMessage('2026-03-04T10:27:00Z', { type: 'assistant' }),
      makeMessage('2026-03-04T10:28:00Z', { type: 'user' })
    ]
    const parsed = makeParsedSession(messages)
    const result = detectSessions(parsed, 10)

    expect(result).toHaveLength(1)
    expect(result[0].durationMinutes).toBe(28)
  })

  it('should split at Agent subagent gaps exceeding 30 minutes', () => {
    const messages = [
      makeMessage('2026-03-04T10:00:00Z', { type: 'user' }),
      makeMessage('2026-03-04T10:01:00Z', {
        type: 'assistant',
        hasToolUse: true,
        toolNames: ['Agent']
      }),
      // 45 min gap — too long even for an Agent
      makeMessage('2026-03-04T10:46:00Z', { type: 'user', isToolResult: true }),
      makeMessage('2026-03-04T10:47:00Z', { type: 'user' })
    ]
    const parsed = makeParsedSession(messages)
    const result = detectSessions(parsed, 10)

    expect(result).toHaveLength(2)
  })

  it('should split at Bash gaps exceeding 10 minutes', () => {
    const messages = [
      makeMessage('2026-03-04T10:00:00Z', { type: 'user' }),
      makeMessage('2026-03-04T10:01:00Z', {
        type: 'assistant',
        hasToolUse: true,
        toolNames: ['Bash']
      }),
      // 15 min gap — Bash shouldn't take this long
      makeMessage('2026-03-04T10:16:00Z', { type: 'user', isToolResult: true }),
      makeMessage('2026-03-04T10:17:00Z', { type: 'user' })
    ]
    const parsed = makeParsedSession(messages)
    const result = detectSessions(parsed, 10)

    expect(result).toHaveLength(2)
  })

  it('should split at fast tool (Read/Write) gaps exceeding 5 minutes', () => {
    const messages = [
      makeMessage('2026-03-04T10:00:00Z', { type: 'user' }),
      makeMessage('2026-03-04T10:01:00Z', {
        type: 'assistant',
        hasToolUse: true,
        toolNames: ['Read']
      }),
      // 8 min gap — Read should complete in seconds
      makeMessage('2026-03-04T10:09:00Z', { type: 'user', isToolResult: true }),
      makeMessage('2026-03-04T10:10:00Z', { type: 'user' })
    ]
    const parsed = makeParsedSession(messages)
    const result = detectSessions(parsed, 4)

    expect(result).toHaveLength(2)
  })

  it('should use the most generous limit when multiple tools called', () => {
    const messages = [
      makeMessage('2026-03-04T10:00:00Z', { type: 'user' }),
      makeMessage('2026-03-04T10:01:00Z', {
        type: 'assistant',
        hasToolUse: true,
        toolNames: ['Read', 'Agent']
      }),
      // 25 min gap — Agent allows up to 30 min
      makeMessage('2026-03-04T10:26:00Z', { type: 'user', isToolResult: true }),
      makeMessage('2026-03-04T10:27:00Z', { type: 'user' })
    ]
    const parsed = makeParsedSession(messages)
    const result = detectSessions(parsed, 10)

    // Should NOT split — Agent's 30-min limit applies
    expect(result).toHaveLength(1)
  })

  it('should split at massive gaps regardless of tool type (7 hours)', () => {
    const messages = [
      makeMessage('2026-03-04T10:00:00Z', { type: 'user' }),
      makeMessage('2026-03-04T10:01:00Z', {
        type: 'assistant',
        hasToolUse: true,
        toolNames: ['Bash']
      }),
      // 7 hour gap — user went to sleep
      makeMessage('2026-03-04T17:01:00Z', { type: 'user', isToolResult: true }),
      makeMessage('2026-03-04T17:02:00Z', { type: 'assistant' }),
      makeMessage('2026-03-04T17:03:00Z', { type: 'user' })
    ]
    const parsed = makeParsedSession(messages)
    const result = detectSessions(parsed, 10)

    expect(result).toHaveLength(2)
    expect(result[0].endedAt).toBe('2026-03-04T10:01:00Z')
    expect(result[1].startedAt).toBe('2026-03-04T17:01:00Z')
  })

  it('should NOT split when progress events prove active processing during gap', () => {
    const messages = [
      makeMessage('2026-03-04T10:00:00Z', { type: 'user' }),
      makeMessage('2026-03-04T10:01:00Z', {
        type: 'assistant',
        hasToolUse: true,
        toolNames: ['Bash']
      }),
      // 45 min gap — exceeds Bash 10-min heuristic, but progress events prove it was running
      makeMessage('2026-03-04T10:46:00Z', { type: 'user', isToolResult: true }),
      makeMessage('2026-03-04T10:47:00Z', { type: 'user' })
    ]
    const parsed = makeParsedSession(messages, {
      progressTimestamps: [
        '2026-03-04T10:05:00Z',
        '2026-03-04T10:15:00Z',
        '2026-03-04T10:30:00Z',
        '2026-03-04T10:44:00Z'
      ]
    })
    const result = detectSessions(parsed, 10)

    // Should NOT split — progress events prove the Bash command was actively running
    expect(result).toHaveLength(1)
  })

  it('should split when no progress events exist during tool gap', () => {
    const messages = [
      makeMessage('2026-03-04T10:00:00Z', { type: 'user' }),
      makeMessage('2026-03-04T10:01:00Z', {
        type: 'assistant',
        hasToolUse: true,
        toolNames: ['Bash']
      }),
      // 45 min gap — no progress events during this gap
      makeMessage('2026-03-04T10:46:00Z', { type: 'user', isToolResult: true }),
      makeMessage('2026-03-04T10:47:00Z', { type: 'user' })
    ]
    const parsed = makeParsedSession(messages, {
      // Progress events exist but BEFORE the gap
      progressTimestamps: ['2026-03-04T09:50:00Z', '2026-03-04T09:55:00Z']
    })
    const result = detectSessions(parsed, 10)

    // Should split — no progress evidence during the gap, and exceeds Bash 10-min limit
    expect(result).toHaveLength(2)
  })

  it('should split long gaps even with progress events (2hr hard cap)', () => {
    const messages = [
      makeMessage('2026-03-04T10:00:00Z', { type: 'user' }),
      makeMessage('2026-03-04T10:01:00Z', {
        type: 'assistant',
        hasToolUse: true,
        toolNames: ['Bash']
      }),
      // 3 hour gap — tail -f or npm run dev left running
      makeMessage('2026-03-04T13:01:00Z', { type: 'user', isToolResult: true }),
      makeMessage('2026-03-04T13:02:00Z', { type: 'user' })
    ]
    const parsed = makeParsedSession(messages, {
      // Progress events throughout — tool was outputting, but 3hrs is clearly not billable
      progressTimestamps: [
        '2026-03-04T10:05:00Z',
        '2026-03-04T10:30:00Z',
        '2026-03-04T11:00:00Z',
        '2026-03-04T11:30:00Z',
        '2026-03-04T12:00:00Z',
        '2026-03-04T12:55:00Z'
      ]
    })
    const result = detectSessions(parsed, 10)

    // Should split — exceeds 2-hour hard cap even though progress events exist
    expect(result).toHaveLength(2)
  })

  it('should split long gap when progress events only exist at start (tool went idle)', () => {
    const messages = [
      makeMessage('2026-03-04T10:00:00Z', { type: 'user' }),
      makeMessage('2026-03-04T10:01:00Z', {
        type: 'assistant',
        hasToolUse: true,
        toolNames: ['Bash']
      }),
      // 45 min gap — progress only at the start, then silence
      makeMessage('2026-03-04T10:46:00Z', { type: 'user', isToolResult: true }),
      makeMessage('2026-03-04T10:47:00Z', { type: 'user' })
    ]
    const parsed = makeParsedSession(messages, {
      // Progress events only in first 5 minutes — tool stopped producing output
      progressTimestamps: ['2026-03-04T10:03:00Z', '2026-03-04T10:05:00Z']
    })
    const result = detectSessions(parsed, 10)

    // Should split — last progress event is 41 min before gap end (> 15 min threshold)
    expect(result).toHaveLength(2)
  })

  it('should NOT bridge gap when tool_use has no matching tool_result (interrupted tool)', () => {
    const messages = [
      makeMessage('2026-03-04T10:00:00Z', { type: 'user' }),
      makeMessage('2026-03-04T10:01:00Z', {
        type: 'assistant',
        hasToolUse: true,
        toolNames: ['Agent']
      }),
      // 25 min gap — but next message is a NEW user prompt, not a tool result
      makeMessage('2026-03-04T10:26:00Z', { type: 'user' })
    ]
    const parsed = makeParsedSession(messages)
    const result = detectSessions(parsed, 10)

    // Should split — tool was interrupted, next message is not a tool_result
    expect(result).toHaveLength(2)
  })

  it('should use exclusive boundaries for progress events (edge timestamps dont count)', () => {
    const messages = [
      makeMessage('2026-03-04T10:00:00Z', { type: 'user' }),
      makeMessage('2026-03-04T10:01:00Z', {
        type: 'assistant',
        hasToolUse: true,
        toolNames: ['Bash']
      }),
      // 20 min gap
      makeMessage('2026-03-04T10:21:00Z', { type: 'user', isToolResult: true }),
      makeMessage('2026-03-04T10:22:00Z', { type: 'user' })
    ]
    const parsed = makeParsedSession(messages, {
      // Progress events AT the boundary timestamps only — not strictly between
      progressTimestamps: ['2026-03-04T10:01:00Z', '2026-03-04T10:21:00Z']
    })
    const result = detectSessions(parsed, 10)

    // Should split — boundary-only progress events are not evidence of activity during the gap
    expect(result).toHaveLength(2)
  })

  it('should include subagent tokens proportionally in segments', () => {
    const messages = [
      makeMessage('2026-03-04T10:00:00Z', {
        type: 'assistant',
        usage: {
          inputTokens: 100,
          outputTokens: 200,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0
        }
      }),
      // 20 min gap
      makeMessage('2026-03-04T10:20:00Z', {
        type: 'assistant',
        usage: {
          inputTokens: 300,
          outputTokens: 600,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0
        }
      })
    ]
    const parsed = makeParsedSession(messages, {
      totalTokenUsage: {
        inputTokens: 400,
        outputTokens: 800,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0
      },
      subagentTokenUsage: {
        inputTokens: 1000,
        outputTokens: 2000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0
      }
    })
    const result = detectSessions(parsed, 10)

    expect(result).toHaveLength(2)
    // First segment: 300 main tokens / 1200 total main = 25% → gets 25% of 3000 subagent = 750
    expect(result[0].inputTokens).toBe(100 + 250) // 100 main + 250 subagent input
    expect(result[0].outputTokens).toBe(200 + 500) // 200 main + 500 subagent output
    // Second segment: 900 main tokens / 1200 total main = 75% → gets 75% of 3000 subagent = 2250
    expect(result[1].inputTokens).toBe(300 + 750)
    expect(result[1].outputTokens).toBe(600 + 1500)
  })

  it('should still split at genuine idle gaps after tool results', () => {
    const messages = [
      makeMessage('2026-03-04T10:00:00Z', { type: 'user' }),
      makeMessage('2026-03-04T10:01:00Z', { type: 'assistant', hasToolUse: true }),
      makeMessage('2026-03-04T10:02:00Z', { type: 'user', isToolResult: true }),
      makeMessage('2026-03-04T10:03:00Z', { type: 'assistant' }), // final response, no tool_use
      // 20 min genuine idle gap
      makeMessage('2026-03-04T10:23:00Z', { type: 'user' })
    ]
    const parsed = makeParsedSession(messages)
    const result = detectSessions(parsed, 10)

    // Should split — the gap is after a completed response, not during tool execution
    expect(result).toHaveLength(2)
    expect(result[0].endedAt).toBe('2026-03-04T10:03:00Z')
    expect(result[1].startedAt).toBe('2026-03-04T10:23:00Z')
  })

  it('should handle single-message session (duration = 0)', () => {
    const messages = [makeMessage('2026-03-04T10:00:00Z')]
    const parsed = makeParsedSession(messages)
    const result = detectSessions(parsed, 10)

    expect(result).toHaveLength(1)
    expect(result[0].durationMinutes).toBe(1) // Math.max(1, 0) enforces minimum 1 minute
    expect(result[0].promptCount).toBe(1)
  })

  it('should detect three sessions with multiple idle gaps', () => {
    const messages = [
      makeMessage('2026-03-04T09:00:00Z'),
      makeMessage('2026-03-04T09:05:00Z'),
      // 30 min gap
      makeMessage('2026-03-04T09:35:00Z'),
      makeMessage('2026-03-04T09:40:00Z'),
      // 60 min gap
      makeMessage('2026-03-04T10:40:00Z'),
      makeMessage('2026-03-04T10:45:00Z')
    ]
    const parsed = makeParsedSession(messages)
    const result = detectSessions(parsed, 10)

    expect(result).toHaveLength(3)
    expect(result[0].durationMinutes).toBe(5)
    expect(result[1].durationMinutes).toBe(5)
    expect(result[2].durationMinutes).toBe(5)
  })

  it('should use exact idle timeout boundary (gap == timeout is NOT a split)', () => {
    const messages = [
      makeMessage('2026-03-04T10:00:00Z'),
      // Exactly 10 minute gap (not > 10)
      makeMessage('2026-03-04T10:10:00Z')
    ]
    const parsed = makeParsedSession(messages)
    const result = detectSessions(parsed, 10)

    expect(result).toHaveLength(1)
    expect(result[0].durationMinutes).toBe(10)
  })

  it('should use projectDirectory for projectPath when available', () => {
    const parsed = makeParsedSession([makeMessage('2026-03-04T10:00:00Z')], {
      projectDirectory: '/home/user/myproject'
    })
    const result = detectSessions(parsed, 10)
    expect(result[0].projectPath).toBe('/home/user/myproject')
  })

  it('should decode projectPathEncoded when projectDirectory is null', () => {
    const parsed = makeParsedSession([makeMessage('2026-03-04T10:00:00Z')], {
      projectDirectory: null,
      projectPathEncoded: 'C--apps-MyProject'
    })
    const result = detectSessions(parsed, 10)
    expect(result[0].projectPath).toBe('C:\\apps\\MyProject')
  })

  it('should filter out messages with empty timestamps', () => {
    const messages = [
      makeMessage('2026-03-04T10:00:00Z'),
      makeMessage(''), // should be filtered
      makeMessage('2026-03-04T10:05:00Z')
    ]
    const parsed = makeParsedSession(messages)
    const result = detectSessions(parsed, 10)

    expect(result).toHaveLength(1)
    expect(result[0].promptCount).toBe(2)
  })

  it('should count only human prompts in promptCount (excludes assistant and tool results)', () => {
    const messages = [
      makeMessage('2026-03-04T10:00:00Z', { type: 'user' }),
      makeMessage('2026-03-04T10:01:00Z', { type: 'assistant' }),
      makeMessage('2026-03-04T10:02:00Z', { type: 'user', isToolResult: true }),
      makeMessage('2026-03-04T10:03:00Z', { type: 'assistant' }),
      makeMessage('2026-03-04T10:04:00Z', { type: 'user' }),
      makeMessage('2026-03-04T10:05:00Z', { type: 'user', isToolResult: true }),
      makeMessage('2026-03-04T10:06:00Z', { type: 'assistant' }),
      makeMessage('2026-03-04T10:07:00Z', { type: 'user' })
    ]
    const parsed = makeParsedSession(messages)
    const result = detectSessions(parsed, 10)

    expect(result).toHaveLength(1)
    // Only 3 human prompts: messages at :00, :04, :07 (user + not tool result)
    expect(result[0].promptCount).toBe(3)
  })

  it('should include sourceFile from parsed data', () => {
    const parsed = makeParsedSession([makeMessage('2026-03-04T10:00:00Z')], {
      sourceFile: '/path/to/session.jsonl'
    })
    const result = detectSessions(parsed, 10)
    expect(result[0].sourceFile).toBe('/path/to/session.jsonl')
  })

  it('should accumulate token usage per segment', () => {
    const messages = [
      makeMessage('2026-03-04T10:00:00Z', {
        type: 'assistant',
        usage: {
          inputTokens: 100,
          outputTokens: 200,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0
        }
      }),
      makeMessage('2026-03-04T10:05:00Z', {
        type: 'assistant',
        usage: {
          inputTokens: 150,
          outputTokens: 300,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0
        }
      }),
      // 20 min gap
      makeMessage('2026-03-04T10:25:00Z', {
        type: 'assistant',
        usage: {
          inputTokens: 50,
          outputTokens: 80,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0
        }
      })
    ]
    const parsed = makeParsedSession(messages)
    const result = detectSessions(parsed, 10)

    expect(result).toHaveLength(2)
    expect(result[0].inputTokens).toBe(250)
    expect(result[0].outputTokens).toBe(500)
    expect(result[1].inputTokens).toBe(50)
    expect(result[1].outputTokens).toBe(80)
  })
})

describe('detectSessionsFromMultiple', () => {
  it('should combine sessions from multiple parsed files', () => {
    const parsed1 = makeParsedSession(
      [makeMessage('2026-03-04T10:00:00Z'), makeMessage('2026-03-04T10:05:00Z')],
      { sessionId: 'session-1', sourceFile: 'file1.jsonl' }
    )
    const parsed2 = makeParsedSession(
      [makeMessage('2026-03-04T11:00:00Z'), makeMessage('2026-03-04T11:05:00Z')],
      { sessionId: 'session-2', sourceFile: 'file2.jsonl' }
    )

    const result = detectSessionsFromMultiple([parsed1, parsed2], 10)
    expect(result).toHaveLength(2)
    expect(result[0].claudeSessionId).toBe('session-1')
    expect(result[1].claudeSessionId).toBe('session-2')
  })

  it('should return empty array for empty input', () => {
    const result = detectSessionsFromMultiple([], 10)
    expect(result).toEqual([])
  })
})

describe('resolveProjectPath', () => {
  it('should prefer projectDirectory over encoded path and normalize', () => {
    const parsed = makeParsedSession([], {
      projectDirectory: '/actual/path',
      projectPathEncoded: 'encoded-path'
    })
    expect(resolveProjectPath(parsed)).toBe('/actual/path')
  })

  it('should normalize Windows cwd to backslashes', () => {
    const parsed = makeParsedSession([], {
      projectDirectory: 'C:/apps/Test',
      projectPathEncoded: 'C--apps-Test'
    })
    expect(resolveProjectPath(parsed)).toBe('C:\\apps\\Test')
  })

  it('should fall back to decoded encoded path when projectDirectory is null', () => {
    const parsed = makeParsedSession([], {
      projectDirectory: null,
      projectPathEncoded: 'C--apps-Test'
    })
    expect(resolveProjectPath(parsed)).toBe('C:\\apps\\Test')
  })
})

describe('decodeProjectPath', () => {
  it('should decode Windows drive letter path with backslashes', () => {
    expect(decodeProjectPath('C--apps-ClauTime')).toBe('C:\\apps\\ClauTime')
  })

  it('should decode Unix path with leading dash as root', () => {
    expect(decodeProjectPath('-home-user-projects-myapp')).toBe('/home/user/projects/myapp')
  })

  it('should decode plain dashes as forward slashes', () => {
    expect(decodeProjectPath('home-user-projects-myapp')).toBe('home/user/projects/myapp')
  })

  it('should return "unknown" for empty string', () => {
    expect(decodeProjectPath('')).toBe('unknown')
  })
})
