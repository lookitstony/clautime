// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  detectSessions,
  detectSessionsFromMultiple,
  resolveProjectPath,
  decodeProjectPath
} from './session-detector'
import type { ParsedSessionData, ParsedMessage } from '../parsers/types'

function makeMessage(
  timestamp: string,
  overrides: Partial<ParsedMessage> = {}
): ParsedMessage {
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
    totalTokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0
    },
    models: [],
    messageCount: messages.length,
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
    expect(result[0].messageCount).toBe(4)
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
    expect(result[0].messageCount).toBe(2)

    expect(result[1].startedAt).toBe('2026-03-04T10:25:00Z')
    expect(result[1].endedAt).toBe('2026-03-04T10:30:00Z')
    expect(result[1].durationMinutes).toBe(5)
    expect(result[1].messageCount).toBe(2)
  })

  it('should handle single-message session (duration = 0)', () => {
    const messages = [makeMessage('2026-03-04T10:00:00Z')]
    const parsed = makeParsedSession(messages)
    const result = detectSessions(parsed, 10)

    expect(result).toHaveLength(1)
    expect(result[0].durationMinutes).toBe(0)
    expect(result[0].messageCount).toBe(1)
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
    expect(result[0].messageCount).toBe(2)
  })

  it('should count only human prompts in messageCount (excludes assistant and tool results)', () => {
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
    expect(result[0].messageCount).toBe(3)
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
        usage: { inputTokens: 100, outputTokens: 200, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
      }),
      makeMessage('2026-03-04T10:05:00Z', {
        type: 'assistant',
        usage: { inputTokens: 150, outputTokens: 300, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
      }),
      // 20 min gap
      makeMessage('2026-03-04T10:25:00Z', {
        type: 'assistant',
        usage: { inputTokens: 50, outputTokens: 80, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
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
      [
        makeMessage('2026-03-04T10:00:00Z'),
        makeMessage('2026-03-04T10:05:00Z')
      ],
      { sessionId: 'session-1', sourceFile: 'file1.jsonl' }
    )
    const parsed2 = makeParsedSession(
      [
        makeMessage('2026-03-04T11:00:00Z'),
        makeMessage('2026-03-04T11:05:00Z')
      ],
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
    expect(decodeProjectPath('C--apps-ClawdTime')).toBe('C:\\apps\\ClawdTime')
  })

  it('should decode Unix path with leading dash as root', () => {
    expect(decodeProjectPath('-home-user-projects-myapp')).toBe(
      '/home/user/projects/myapp'
    )
  })

  it('should decode plain dashes as forward slashes', () => {
    expect(decodeProjectPath('home-user-projects-myapp')).toBe(
      'home/user/projects/myapp'
    )
  })

  it('should return "unknown" for empty string', () => {
    expect(decodeProjectPath('')).toBe('unknown')
  })
})
