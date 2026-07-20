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
  discoverOpencodeSessionFiles,
  discoverOpencodeTranscriptFiles,
  parseOpencodeSessionFile,
  readOpencodeSessionMeta
} from './opencode-parser'
import { detectSessions } from '../services/session-detector'

const SESSION_ID = 'ses_5c728e77effeEV4zPEuEnUS5As'
const PROJECT_PATH = 'C:\\projects\\my-app'

// 2026-07-19T18:00:00.000Z
const T0 = Date.parse('2026-07-19T18:00:00.000Z')

function sessionInfo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SESSION_ID,
    version: '0.15.29',
    projectID: 'global',
    directory: PROJECT_PATH,
    title: 'Fix the login bug',
    time: { created: T0, updated: T0 + 600_000 },
    ...overrides
  }
}

function userMsg(id: string, createdMs: number): Record<string, unknown> {
  return { id, sessionID: SESSION_ID, role: 'user', time: { created: createdMs } }
}

function assistantMsg(
  id: string,
  createdMs: number,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    sessionID: SESSION_ID,
    role: 'assistant',
    time: { created: createdMs, completed: createdMs + 5000 },
    parentID: 'msg_parent',
    modelID: 'claude-sonnet-5',
    providerID: 'anthropic',
    tokens: { input: 1000, output: 50, reasoning: 30, cache: { read: 400, write: 20 } },
    ...overrides
  }
}

describe('opencode-parser', () => {
  let tempDir: string
  let storageDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'opencode-parser-test-'))
    storageDir = join(tempDir, 'storage')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  async function writeSession(
    info: Record<string, unknown> = sessionInfo(),
    projectDirName = 'global'
  ): Promise<string> {
    const sessionDir = join(storageDir, 'session', projectDirName)
    await mkdir(sessionDir, { recursive: true })
    const filePath = join(sessionDir, `${info.id ?? SESSION_ID}.json`)
    await writeFile(filePath, JSON.stringify(info, null, 2), 'utf-8')
    return filePath
  }

  async function writeMessage(msg: Record<string, unknown>): Promise<void> {
    const msgDir = join(storageDir, 'message', SESSION_ID)
    await mkdir(msgDir, { recursive: true })
    await writeFile(join(msgDir, `${msg.id}.json`), JSON.stringify(msg, null, 2), 'utf-8')
  }

  async function writePart(messageId: string, part: Record<string, unknown>): Promise<void> {
    const partDir = join(storageDir, 'part', messageId)
    await mkdir(partDir, { recursive: true })
    await writeFile(join(partDir, `${part.id}.json`), JSON.stringify(part, null, 2), 'utf-8')
  }

  describe('discoverOpencodeSessionFiles', () => {
    it('finds ses_*.json files across project dirs', async () => {
      await writeSession()
      const files = await discoverOpencodeSessionFiles(storageDir)
      expect(files).toHaveLength(1)
      expect(files[0]).toContain('ses_')
    })

    it('returns empty for a missing storage dir', async () => {
      const files = await discoverOpencodeSessionFiles(join(tempDir, 'nope'))
      expect(files).toEqual([])
    })
  })

  describe('readOpencodeSessionMeta', () => {
    it('reads session id and directory as cwd', async () => {
      const fp = await writeSession()
      const meta = await readOpencodeSessionMeta(fp)
      expect(meta).toEqual({ sessionId: SESSION_ID, cwd: PROJECT_PATH })
    })

    it('falls back to the project worktree when directory is absent', async () => {
      const projectDir = join(storageDir, 'project')
      await mkdir(projectDir, { recursive: true })
      await writeFile(
        join(projectDir, 'proj1.json'),
        JSON.stringify({ id: 'proj1', worktree: PROJECT_PATH }),
        'utf-8'
      )
      const fp = await writeSession(sessionInfo({ directory: undefined, projectID: 'proj1' }))
      const meta = await readOpencodeSessionMeta(fp)
      expect(meta?.cwd).toBe(PROJECT_PATH)
    })

    it('treats the global "/" worktree as no cwd', async () => {
      const projectDir = join(storageDir, 'project')
      await mkdir(projectDir, { recursive: true })
      await writeFile(
        join(projectDir, 'global.json'),
        JSON.stringify({ id: 'global', worktree: '/' }),
        'utf-8'
      )
      const fp = await writeSession(sessionInfo({ directory: undefined }))
      const meta = await readOpencodeSessionMeta(fp)
      expect(meta?.cwd).toBeNull()
    })
  })

  describe('parseOpencodeSessionFile', () => {
    it('parses user and assistant messages with ISO timestamps', async () => {
      const fp = await writeSession()
      await writeMessage(userMsg('msg_1', T0))
      await writeMessage(assistantMsg('msg_2', T0 + 10_000))

      const parsed = await parseOpencodeSessionFile(fp)
      expect(parsed).not.toBeNull()
      expect(parsed!.tool).toBe('opencode')
      expect(parsed!.sessionId).toBe(SESSION_ID)
      expect(parsed!.projectDirectory).toBe(PROJECT_PATH)
      expect(parsed!.summary).toBe('Fix the login bug')
      expect(parsed!.messages).toHaveLength(2)
      expect(parsed!.messages[0].type).toBe('user')
      expect(parsed!.messages[0].timestamp).toBe('2026-07-19T18:00:00.000Z')
      expect(parsed!.messages[1].type).toBe('assistant')
      expect(parsed!.messages[1].model).toBe('claude-sonnet-5')
      expect(parsed!.models).toEqual(['claude-sonnet-5'])
    })

    it('bills reasoning as output and excludes cache reads from input', async () => {
      const fp = await writeSession()
      await writeMessage(userMsg('msg_1', T0))
      await writeMessage(assistantMsg('msg_2', T0 + 10_000))

      const parsed = await parseOpencodeSessionFile(fp)
      expect(parsed!.totalTokenUsage).toEqual({
        // input (1000) is inclusive of the 400 cache reads upstream, so the
        // billable non-cached input is 600 — cache reads are counted once, at
        // the cache-read rate, not double-billed at the full input rate.
        inputTokens: 600,
        outputTokens: 80,
        cacheCreationInputTokens: 20,
        cacheReadInputTokens: 400
      })
    })

    it('pulls tool names and execution times from part files', async () => {
      const fp = await writeSession()
      await writeMessage(userMsg('msg_1', T0))
      await writeMessage(assistantMsg('msg_2', T0 + 10_000))
      await writePart('msg_2', {
        id: 'prt_1',
        sessionID: SESSION_ID,
        messageID: 'msg_2',
        type: 'tool',
        tool: 'bash',
        state: { status: 'completed', time: { start: T0 + 11_000, end: T0 + 14_000 } }
      })
      await writePart('msg_2', {
        id: 'prt_2',
        sessionID: SESSION_ID,
        messageID: 'msg_2',
        type: 'text',
        text: 'done'
      })

      const parsed = await parseOpencodeSessionFile(fp)
      const assistant = parsed!.messages[1]
      expect(assistant.hasToolUse).toBe(true)
      expect(assistant.toolNames).toEqual(['bash'])
      expect(parsed!.progressTimestamps).toContain('2026-07-19T18:00:11.000Z')
      expect(parsed!.progressTimestamps).toContain('2026-07-19T18:00:14.000Z')
      // assistant time.completed is progress evidence too
      expect(parsed!.progressTimestamps).toContain('2026-07-19T18:00:15.000Z')
    })

    it('returns null when the session has no messages', async () => {
      const fp = await writeSession()
      expect(await parseOpencodeSessionFile(fp)).toBeNull()
    })

    it('feeds the shared session detector with tool=opencode', async () => {
      const fp = await writeSession()
      await writeMessage(userMsg('msg_1', T0))
      await writeMessage(assistantMsg('msg_2', T0 + 10_000))
      await writeMessage(userMsg('msg_3', T0 + 300_000))
      await writeMessage(assistantMsg('msg_4', T0 + 310_000))

      const parsed = await parseOpencodeSessionFile(fp)
      const detected = detectSessions(parsed!, 15)
      expect(detected).toHaveLength(1)
      expect(detected[0].tool).toBe('opencode')
      expect(detected[0].projectPath).toBe(PROJECT_PATH)
      expect(detected[0].claudeSessionId).toBe(SESSION_ID)
      expect(detected[0].promptCount).toBe(2)
    })
  })

  describe('discoverOpencodeTranscriptFiles', () => {
    it('enumerates message and part files, not session metadata', async () => {
      await writeSession()
      await writeMessage(userMsg('msg_1', T0))
      await writePart('msg_1', { id: 'prt_1', type: 'text', text: 'hi' })

      const files = await discoverOpencodeTranscriptFiles(storageDir)
      expect(files).toHaveLength(2)
      expect(files.some((f) => f.includes('msg_1.json'))).toBe(true)
      expect(files.some((f) => f.includes('prt_1.json'))).toBe(true)
      expect(files.some((f) => f.includes(join('storage', 'session')))).toBe(false)
    })
  })
})
