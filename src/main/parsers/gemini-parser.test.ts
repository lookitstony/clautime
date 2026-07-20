// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
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
  discoverGeminiSessionFiles,
  parseGeminiSessionFile,
  readGeminiSessionMeta
} from './gemini-parser'
import { detectSessions } from '../services/session-detector'

const SESSION_ID = 'd70938ea-3bf3-408c-9009-4d386d009afa'
const PROJECT_PATH = 'C:\\projects\\my-app'

function chatFile(messages: Record<string, unknown>[]): string {
  return JSON.stringify(
    {
      sessionId: SESSION_ID,
      projectHash: 'abc123',
      startTime: '2026-07-19T18:00:00.000Z',
      lastUpdated: '2026-07-19T18:30:00.000Z',
      messages
    },
    null,
    2
  )
}

function userMessage(timestamp: string, text = 'do the thing') {
  return { id: `u-${timestamp}`, timestamp, type: 'user', content: [{ text }] }
}

function geminiMessage(
  timestamp: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: `g-${timestamp}`,
    timestamp,
    type: 'gemini',
    content: 'Sure, done.',
    model: 'gemini-3-pro',
    tokens: { input: 1000, output: 50, cached: 400, thoughts: 30, tool: 0, total: 1080 },
    ...overrides
  }
}

describe('gemini-parser', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gemini-parser-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  /** Build tmp/<dirName>/chats/<file> with an optional .project_root marker. */
  async function writeChat(
    content: string,
    opts: { dirName?: string; fileName?: string; projectRoot?: string | null } = {}
  ): Promise<string> {
    const dirName = opts.dirName ?? 'my-app'
    const projectDir = join(tempDir, dirName)
    const chatsDir = join(projectDir, 'chats')
    await mkdir(chatsDir, { recursive: true })
    if (opts.projectRoot !== null) {
      await writeFile(join(projectDir, '.project_root'), opts.projectRoot ?? PROJECT_PATH, 'utf-8')
    }
    const filePath = join(chatsDir, opts.fileName ?? 'session-2026-07-19T18-00-d70938ea.json')
    await writeFile(filePath, content, 'utf-8')
    return filePath
  }

  describe('discoverGeminiSessionFiles', () => {
    it('finds session json files under project chats dirs', async () => {
      await writeChat(chatFile([userMessage('2026-07-19T18:00:00.000Z')]))
      const files = await discoverGeminiSessionFiles(tempDir)
      expect(files).toHaveLength(1)
      expect(files[0]).toContain('session-')
    })

    it('returns empty for a missing tmp dir', async () => {
      const files = await discoverGeminiSessionFiles(join(tempDir, 'nope'))
      expect(files).toEqual([])
    })

    it('ignores dirs without chats and non-session files', async () => {
      await mkdir(join(tempDir, 'bin'), { recursive: true })
      await writeFile(join(tempDir, 'bin', 'rg.exe'), 'x', 'utf-8')
      await writeChat('{}', { fileName: 'checkpoint-foo.json' })
      const files = await discoverGeminiSessionFiles(tempDir)
      expect(files).toEqual([])
    })
  })

  describe('readGeminiSessionMeta', () => {
    it('reads sessionId from the file head and cwd from .project_root', async () => {
      const fp = await writeChat(chatFile([userMessage('2026-07-19T18:00:00.000Z')]))
      const meta = await readGeminiSessionMeta(fp)
      expect(meta).toEqual({ sessionId: SESSION_ID, cwd: PROJECT_PATH })
    })

    const itWin = process.platform === 'win32' ? it : it.skip
    itWin('restores true filesystem casing of a lowercased .project_root', async () => {
      // Gemini CLI lowercases the recorded path — point it at tempDir, lowercased
      const { realpathSync } = await import('node:fs')
      const fp = await writeChat(chatFile([userMessage('2026-07-19T18:00:00.000Z')]), {
        projectRoot: tempDir.toLowerCase()
      })
      const meta = await readGeminiSessionMeta(fp)
      expect(meta?.cwd).toBe(realpathSync.native(tempDir))
    })

    it('returns null cwd when no .project_root marker exists (hash dirs)', async () => {
      const fp = await writeChat(chatFile([userMessage('2026-07-19T18:00:00.000Z')]), {
        dirName: '044c2c20f95e',
        projectRoot: null
      })
      const meta = await readGeminiSessionMeta(fp)
      expect(meta?.sessionId).toBe(SESSION_ID)
      expect(meta?.cwd).toBeNull()
    })
  })

  describe('parseGeminiSessionFile', () => {
    it('parses user and gemini messages with the session cwd', async () => {
      const fp = await writeChat(
        chatFile([
          userMessage('2026-07-19T18:00:00.000Z'),
          geminiMessage('2026-07-19T18:00:10.000Z')
        ])
      )

      const parsed = await parseGeminiSessionFile(fp)
      expect(parsed).not.toBeNull()
      expect(parsed!.tool).toBe('gemini')
      expect(parsed!.sessionId).toBe(SESSION_ID)
      expect(parsed!.projectDirectory).toBe(PROJECT_PATH)
      expect(parsed!.messages).toHaveLength(2)
      expect(parsed!.messages[0].type).toBe('user')
      expect(parsed!.messages[1].type).toBe('assistant')
      expect(parsed!.messages[1].model).toBe('gemini-3-pro')
      expect(parsed!.models).toEqual(['gemini-3-pro'])
    })

    it('splits cached tokens out of input and bills thoughts as output', async () => {
      const fp = await writeChat(
        chatFile([
          userMessage('2026-07-19T18:00:00.000Z'),
          geminiMessage('2026-07-19T18:00:10.000Z')
        ])
      )

      const parsed = await parseGeminiSessionFile(fp)
      // input 1000 includes 400 cached; output 50 + 30 thoughts
      expect(parsed!.totalTokenUsage).toEqual({
        inputTokens: 600,
        outputTokens: 80,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 400
      })
      expect(parsed!.messages[1].usage?.inputTokens).toBe(600)
    })

    it('extracts tool names from toolCalls and thought timestamps as progress', async () => {
      const fp = await writeChat(
        chatFile([
          userMessage('2026-07-19T18:00:00.000Z'),
          geminiMessage('2026-07-19T18:00:10.000Z', {
            toolCalls: [
              { id: 't1', name: 'read_file', args: {} },
              { id: 't2', name: 'read_file', args: {} },
              { id: 't3', name: 'run_shell_command', args: {} }
            ],
            thoughts: [
              { subject: 'x', description: 'y', timestamp: '2026-07-19T18:00:05.000Z' },
              { subject: 'x', description: 'y', timestamp: '2026-07-19T18:00:08.000Z' }
            ]
          })
        ])
      )

      const parsed = await parseGeminiSessionFile(fp)
      const assistant = parsed!.messages[1]
      expect(assistant.hasToolUse).toBe(true)
      expect(assistant.toolNames).toEqual(['read_file', 'run_shell_command'])
      expect(parsed!.progressTimestamps).toEqual([
        '2026-07-19T18:00:05.000Z',
        '2026-07-19T18:00:08.000Z'
      ])
    })

    it('treats non-user/gemini records as progress evidence, not messages', async () => {
      const fp = await writeChat(
        chatFile([
          userMessage('2026-07-19T18:00:00.000Z'),
          {
            id: 'i1',
            timestamp: '2026-07-19T18:00:02.000Z',
            type: 'info',
            content: 'model switch'
          },
          geminiMessage('2026-07-19T18:00:10.000Z')
        ])
      )

      const parsed = await parseGeminiSessionFile(fp)
      expect(parsed!.messages).toHaveLength(2)
      expect(parsed!.progressTimestamps).toContain('2026-07-19T18:00:02.000Z')
    })

    it('returns null for empty or malformed files', async () => {
      const empty = await writeChat(chatFile([]))
      expect(await parseGeminiSessionFile(empty)).toBeNull()
      const malformed = await writeChat('not json', {
        fileName: 'session-2026-07-19T18-01-deadbeef.json'
      })
      expect(await parseGeminiSessionFile(malformed)).toBeNull()
    })

    it('feeds the shared session detector with tool=gemini', async () => {
      const fp = await writeChat(
        chatFile([
          userMessage('2026-07-19T18:00:00.000Z'),
          geminiMessage('2026-07-19T18:00:10.000Z'),
          userMessage('2026-07-19T18:05:00.000Z'),
          geminiMessage('2026-07-19T18:05:10.000Z')
        ])
      )

      const parsed = await parseGeminiSessionFile(fp)
      const detected = detectSessions(parsed!, 15)
      expect(detected).toHaveLength(1)
      expect(detected[0].tool).toBe('gemini')
      expect(detected[0].projectPath).toBe(PROJECT_PATH)
      expect(detected[0].claudeSessionId).toBe(SESSION_ID)
      expect(detected[0].promptCount).toBe(2)
    })
  })
})
