// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Mock electron-log before importing parser
vi.mock('electron-log/main.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn()
  }
}))

import {
  discoverCodexSessionFiles,
  parseCodexSessionFile,
  readCodexSessionMeta,
  tailReadCodexState
} from './codex-parser'
import { detectSessions } from '../services/session-detector'

function jsonl(...objects: Record<string, unknown>[]): string {
  return objects.map((o) => JSON.stringify(o)).join('\n') + '\n'
}

const SESSION_ID = '019f7b8d-9ce6-7502-9bc5-014887fbd70e'

function sessionMeta(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: '2026-07-19T18:06:18.256Z',
    type: 'session_meta',
    payload: {
      session_id: SESSION_ID,
      id: SESSION_ID,
      timestamp: '2026-07-19T18:05:11.574Z',
      cwd: 'C:\\projects\\my-app',
      originator: 'codex-tui',
      cli_version: '0.144.6',
      model_provider: 'openai',
      ...overrides
    }
  }
}

function turnContext(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: '2026-07-19T18:06:19.000Z',
    type: 'turn_context',
    payload: {
      cwd: 'C:\\projects\\my-app',
      model: 'gpt-5-codex',
      effort: 'medium',
      ...overrides
    }
  }
}

function userMessage(timestamp: string, text: string) {
  return {
    timestamp,
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
  }
}

function assistantMessage(timestamp: string, text = 'Sure, done.') {
  return {
    timestamp,
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }
  }
}

function functionCall(timestamp: string, name = 'shell') {
  return {
    timestamp,
    type: 'response_item',
    payload: { type: 'function_call', name, arguments: '{"command":["ls"]}', call_id: 'c1' }
  }
}

function functionCallOutput(timestamp: string) {
  return {
    timestamp,
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: 'c1', output: 'file.txt' }
  }
}

function tokenCount(
  timestamp: string,
  totals: { input: number; cached: number; output: number }
) {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: totals.input,
          cached_input_tokens: totals.cached,
          output_tokens: totals.output,
          reasoning_output_tokens: 0,
          total_tokens: totals.input + totals.output
        },
        last_token_usage: {},
        model_context_window: 272000
      }
    }
  }
}

describe('codex-parser', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codex-parser-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  async function writeRollout(content: string, name?: string): Promise<string> {
    const dayDir = join(tempDir, 'sessions', '2026', '07', '19')
    await mkdir(dayDir, { recursive: true })
    const filePath = join(dayDir, name ?? `rollout-2026-07-19T14-05-11-${SESSION_ID}.jsonl`)
    await writeFile(filePath, content, 'utf-8')
    return filePath
  }

  describe('discoverCodexSessionFiles', () => {
    it('finds rollout files in the date-partitioned tree', async () => {
      await writeRollout(jsonl(sessionMeta()))
      const files = await discoverCodexSessionFiles(join(tempDir, 'sessions'))
      expect(files).toHaveLength(1)
      expect(files[0]).toContain('rollout-')
    })

    it('returns empty for a missing sessions dir', async () => {
      const files = await discoverCodexSessionFiles(join(tempDir, 'nope'))
      expect(files).toEqual([])
    })

    it('ignores non-jsonl clutter', async () => {
      const dayDir = join(tempDir, 'sessions', '2026', '07', '19')
      await mkdir(dayDir, { recursive: true })
      await writeFile(join(dayDir, 'notes.txt'), 'x', 'utf-8')
      const files = await discoverCodexSessionFiles(join(tempDir, 'sessions'))
      expect(files).toEqual([])
    })
  })

  describe('readCodexSessionMeta', () => {
    it('reads session id and cwd from session_meta', async () => {
      const fp = await writeRollout(jsonl(sessionMeta()))
      const meta = await readCodexSessionMeta(fp)
      expect(meta?.sessionId).toBe(SESSION_ID)
      expect(meta?.cwd).toBe('C:\\projects\\my-app')
    })

    it('falls back to the filename uuid when no meta line exists', async () => {
      const fp = await writeRollout(jsonl(userMessage('2026-07-19T18:07:00.000Z', 'hi')))
      const meta = await readCodexSessionMeta(fp)
      expect(meta?.sessionId).toBe(SESSION_ID)
      expect(meta?.cwd).toBeNull()
    })

    it('reads a session_meta line larger than the initial 256KB window', async () => {
      // A header past the first read chunk must still yield its cwd, not be dropped.
      const bigMeta = sessionMeta({ user_instructions: 'x'.repeat(300 * 1024) })
      const fp = await writeRollout(jsonl(bigMeta, turnContext()))
      const meta = await readCodexSessionMeta(fp)
      expect(meta?.sessionId).toBe(SESSION_ID)
      expect(meta?.cwd).toBe('C:\\projects\\my-app')
    })

    it('caches meta by mtime and re-reads only when the file changes', async () => {
      const fp = await writeRollout(jsonl(sessionMeta({ cwd: 'C:\\first' })))
      // Pin an integer-ms mtime so it can be restored byte-exact later.
      const t0 = new Date(Math.floor((await stat(fp)).mtimeMs))
      await utimes(fp, t0, t0)

      expect((await readCodexSessionMeta(fp))?.cwd).toBe('C:\\first')

      // Rewrite the content but restore the same mtime — the cache should win.
      await writeFile(fp, jsonl(sessionMeta({ cwd: 'C:\\second' })), 'utf-8')
      await utimes(fp, t0, t0)
      expect((await readCodexSessionMeta(fp))?.cwd).toBe('C:\\first')

      // Advance the mtime — the cache busts and the new cwd is read.
      const t1 = new Date(t0.getTime() + 10_000)
      await utimes(fp, t1, t1)
      expect((await readCodexSessionMeta(fp))?.cwd).toBe('C:\\second')
    })
  })

  describe('parseCodexSessionFile', () => {
    it('parses a basic session with prompts, tools, and assistant replies', async () => {
      const fp = await writeRollout(
        jsonl(
          sessionMeta(),
          turnContext(),
          userMessage('2026-07-19T18:07:00.000Z', 'Fix the login bug'),
          functionCall('2026-07-19T18:07:05.000Z', 'shell'),
          functionCallOutput('2026-07-19T18:07:08.000Z'),
          assistantMessage('2026-07-19T18:07:20.000Z'),
          tokenCount('2026-07-19T18:07:21.000Z', { input: 1000, cached: 600, output: 200 })
        )
      )

      const parsed = await parseCodexSessionFile(fp)
      expect(parsed).not.toBeNull()
      expect(parsed!.tool).toBe('codex')
      expect(parsed!.sessionId).toBe(SESSION_ID)
      expect(parsed!.projectDirectory).toBe('C:\\projects\\my-app')
      expect(parsed!.models).toEqual(['gpt-5-codex'])

      // 1 human prompt + 1 tool call + 1 tool output + 1 assistant reply
      expect(parsed!.messages).toHaveLength(4)
      const humanPrompts = parsed!.messages.filter((m) => m.type === 'user' && !m.isToolResult)
      expect(humanPrompts).toHaveLength(1)
      const toolCalls = parsed!.messages.filter((m) => m.hasToolUse)
      expect(toolCalls).toHaveLength(1)
      expect(toolCalls[0].toolNames).toEqual(['shell'])
      const toolResults = parsed!.messages.filter((m) => m.isToolResult)
      expect(toolResults).toHaveLength(1)
    })

    it('splits cached tokens out of input and attaches usage to the assistant message', async () => {
      const fp = await writeRollout(
        jsonl(
          sessionMeta(),
          turnContext(),
          userMessage('2026-07-19T18:07:00.000Z', 'hello'),
          assistantMessage('2026-07-19T18:07:10.000Z'),
          tokenCount('2026-07-19T18:07:11.000Z', { input: 1000, cached: 600, output: 200 }),
          userMessage('2026-07-19T18:08:00.000Z', 'continue'),
          assistantMessage('2026-07-19T18:08:10.000Z'),
          // Cumulative totals — the parser must diff, not sum
          tokenCount('2026-07-19T18:08:11.000Z', { input: 2500, cached: 1800, output: 500 })
        )
      )

      const parsed = await parseCodexSessionFile(fp)
      // Session totals: input = (1000-600) + (1500-1200) = 700, cached = 1800, output = 500
      expect(parsed!.totalTokenUsage.inputTokens).toBe(700)
      expect(parsed!.totalTokenUsage.cacheReadInputTokens).toBe(1800)
      expect(parsed!.totalTokenUsage.outputTokens).toBe(500)
      expect(parsed!.totalTokenUsage.cacheCreationInputTokens).toBe(0)

      const withUsage = parsed!.messages.filter((m) => m.usage)
      expect(withUsage).toHaveLength(2)
      expect(withUsage[0].usage).toEqual({
        inputTokens: 400,
        outputTokens: 200,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 600
      })
      expect(withUsage[0].model).toBe('gpt-5-codex')
    })

    it('does not count injected context wrappers as human prompts', async () => {
      const fp = await writeRollout(
        jsonl(
          sessionMeta(),
          userMessage('2026-07-19T18:06:30.000Z', '<environment_context>\n<cwd>C:\\x</cwd>'),
          userMessage('2026-07-19T18:06:31.000Z', '<user_instructions>be nice</user_instructions>'),
          userMessage('2026-07-19T18:07:00.000Z', 'a real prompt')
        )
      )

      const parsed = await parseCodexSessionFile(fp)
      const humanPrompts = parsed!.messages.filter((m) => m.type === 'user' && !m.isToolResult)
      expect(humanPrompts).toHaveLength(1)
      // Wrappers still count as timestamped activity (type system)
      expect(parsed!.messages).toHaveLength(3)
    })

    it('collects event timestamps as progress evidence', async () => {
      const fp = await writeRollout(
        jsonl(
          sessionMeta(),
          userMessage('2026-07-19T18:07:00.000Z', 'go'),
          tokenCount('2026-07-19T18:10:00.000Z', { input: 100, cached: 0, output: 50 }),
          tokenCount('2026-07-19T18:15:00.000Z', { input: 200, cached: 0, output: 90 })
        )
      )
      const parsed = await parseCodexSessionFile(fp)
      expect(parsed!.progressTimestamps).toEqual([
        '2026-07-19T18:10:00.000Z',
        '2026-07-19T18:15:00.000Z'
      ])
    })

    it('skips malformed lines without failing the file', async () => {
      const fp = await writeRollout(
        jsonl(sessionMeta(), userMessage('2026-07-19T18:07:00.000Z', 'ok')) + '{not json}\n'
      )
      const parsed = await parseCodexSessionFile(fp)
      expect(parsed).not.toBeNull()
      expect(parsed!.messages).toHaveLength(1)
    })

    it('returns null for an empty file', async () => {
      const fp = await writeRollout('')
      expect(await parseCodexSessionFile(fp)).toBeNull()
    })
  })

  describe('integration with detectSessions', () => {
    it('produces codex-tagged sessions with the right project path', async () => {
      const fp = await writeRollout(
        jsonl(
          sessionMeta(),
          turnContext(),
          userMessage('2026-07-19T18:07:00.000Z', 'start work'),
          assistantMessage('2026-07-19T18:07:30.000Z'),
          userMessage('2026-07-19T18:20:00.000Z', 'more work'),
          assistantMessage('2026-07-19T18:21:00.000Z'),
          tokenCount('2026-07-19T18:21:01.000Z', { input: 500, cached: 0, output: 100 })
        )
      )

      const parsed = await parseCodexSessionFile(fp)
      const detected = detectSessions(parsed!, 15)
      expect(detected).toHaveLength(1)
      expect(detected[0].tool).toBe('codex')
      expect(detected[0].projectPath).toBe('C:\\projects\\my-app')
      expect(detected[0].claudeSessionId).toBe(SESSION_ID)
      expect(detected[0].promptCount).toBe(2)
    })
  })

  describe('tailReadCodexState', () => {
    it('reports awaiting after an unanswered human prompt', async () => {
      const fp = await writeRollout(
        jsonl(sessionMeta(), userMessage('2026-07-19T18:07:00.000Z', 'do the thing'))
      )
      const state = await tailReadCodexState(fp)
      expect(state.lastPromptAt).toBe('2026-07-19T18:07:00.000Z')
      expect(state.awaitingResponse).toBe(true)
      expect(state.state).toBe('awaiting')
    })

    it('reports idle after an assistant reply', async () => {
      const fp = await writeRollout(
        jsonl(
          sessionMeta(),
          userMessage('2026-07-19T18:07:00.000Z', 'do the thing'),
          assistantMessage('2026-07-19T18:07:30.000Z')
        )
      )
      const state = await tailReadCodexState(fp)
      expect(state.awaitingResponse).toBe(false)
      expect(state.state).toBe('idle')
    })

    it('reports tool-pending after a function call with no output yet', async () => {
      const fp = await writeRollout(
        jsonl(
          sessionMeta(),
          userMessage('2026-07-19T18:07:00.000Z', 'run it'),
          functionCall('2026-07-19T18:07:05.000Z')
        )
      )
      const state = await tailReadCodexState(fp)
      expect(state.state).toBe('tool-pending')
      expect(state.awaitingResponse).toBe(true)
    })
  })
})
