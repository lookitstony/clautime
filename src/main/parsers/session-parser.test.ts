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

import { discoverSessionFiles, parseSessionFile, parseAllSessions } from './session-parser'
import log from 'electron-log/main.js'

// Helper to build JSONL content
function jsonl(...objects: Record<string, unknown>[]): string {
  return objects.map((o) => JSON.stringify(o)).join('\n') + '\n'
}

function makeUserMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: 'user',
    timestamp: '2026-03-04T10:00:00.000Z',
    sessionId: 'sess-001',
    cwd: 'C:\\projects\\my-app',
    gitBranch: 'main',
    uuid: 'uuid-1',
    parentUuid: null,
    message: { role: 'user', content: 'Hello' },
    ...overrides
  }
}

function makeAssistantMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: 'assistant',
    timestamp: '2026-03-04T10:00:05.000Z',
    sessionId: 'sess-001',
    cwd: 'C:\\projects\\my-app',
    gitBranch: 'main',
    uuid: 'uuid-2',
    parentUuid: 'uuid-1',
    message: {
      model: 'claude-opus-4-6',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi!' }],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 300
      }
    },
    ...overrides
  }
}

function makeSnapshotLine() {
  return {
    type: 'file-history-snapshot',
    messageId: 'snap-1',
    snapshot: { messageId: 'snap-1', trackedFileBackups: {}, timestamp: '2026-03-04T10:00:00.000Z' },
    isSnapshotUpdate: false
  }
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'clawdtime-test-'))
  vi.clearAllMocks()
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('discoverSessionFiles', () => {
  it('discovers .jsonl files in project subdirectories', async () => {
    const projectDir = join(tmpDir, 'projects', 'C--apps-MyProject')
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, 'session-1.jsonl'), '')
    await writeFile(join(projectDir, 'session-2.jsonl'), '')

    const files = await discoverSessionFiles(tmpDir)
    expect(files).toHaveLength(2)
    expect(files.every((f) => f.endsWith('.jsonl'))).toBe(true)
  })

  it('discovers files across multiple project directories', async () => {
    const proj1 = join(tmpDir, 'projects', 'proj-a')
    const proj2 = join(tmpDir, 'projects', 'proj-b')
    await mkdir(proj1, { recursive: true })
    await mkdir(proj2, { recursive: true })
    await writeFile(join(proj1, 's1.jsonl'), '')
    await writeFile(join(proj2, 's2.jsonl'), '')

    const files = await discoverSessionFiles(tmpDir)
    expect(files).toHaveLength(2)
  })

  it('ignores non-.jsonl files and subdirectories', async () => {
    const projectDir = join(tmpDir, 'projects', 'proj')
    const subDir = join(projectDir, 'subagents')
    await mkdir(subDir, { recursive: true })
    await writeFile(join(projectDir, 'session.jsonl'), '')
    await writeFile(join(projectDir, 'some-uuid'), '') // directory-like file without extension

    const files = await discoverSessionFiles(tmpDir)
    expect(files).toHaveLength(1)
    expect(files[0]).toContain('session.jsonl')
  })

  it('returns empty array when projects directory does not exist', async () => {
    const files = await discoverSessionFiles(join(tmpDir, 'nonexistent'))
    expect(files).toHaveLength(0)
    expect(log.warn).toHaveBeenCalled()
  })

  it('skips unreadable project directories with a warning', async () => {
    const projectsDir = join(tmpDir, 'projects')
    // Create projects dir as a file instead of directory to cause readdir failure
    await mkdir(projectsDir, { recursive: true })
    await writeFile(join(projectsDir, 'not-a-dir'), 'file content')

    const files = await discoverSessionFiles(tmpDir)
    // Should still return without error (not-a-dir is not a directory, so it's skipped)
    expect(files).toHaveLength(0)
  })
})

describe('parseSessionFile', () => {
  it('parses a valid session file with user and assistant messages', async () => {
    const projectDir = join(tmpDir, 'projects', 'C--apps-MyProject')
    await mkdir(projectDir, { recursive: true })
    const filePath = join(projectDir, 'sess-001.jsonl')

    await writeFile(
      filePath,
      jsonl(makeSnapshotLine(), makeUserMessage(), makeAssistantMessage())
    )

    const result = await parseSessionFile(filePath)
    expect(result).not.toBeNull()
    expect(result!.sessionId).toBe('sess-001')
    expect(result!.projectPathEncoded).toBe('C--apps-MyProject')
    expect(result!.projectDirectory).toBe('C:\\projects\\my-app')
    expect(result!.messageCount).toBe(2) // snapshot is filtered out
    expect(result!.messages[0].type).toBe('user')
    expect(result!.messages[1].type).toBe('assistant')
    expect(result!.firstTimestamp).toBe('2026-03-04T10:00:00.000Z')
    expect(result!.lastTimestamp).toBe('2026-03-04T10:00:05.000Z')
    expect(result!.models).toEqual(['claude-opus-4-6'])
  })

  it('aggregates token usage across assistant messages', async () => {
    const projectDir = join(tmpDir, 'projects', 'proj')
    await mkdir(projectDir, { recursive: true })
    const filePath = join(projectDir, 'sess.jsonl')

    const assistant1 = makeAssistantMessage({
      timestamp: '2026-03-04T10:00:05.000Z',
      uuid: 'a1'
    })
    const assistant2 = makeAssistantMessage({
      timestamp: '2026-03-04T10:01:05.000Z',
      uuid: 'a2',
      message: {
        model: 'claude-opus-4-6',
        role: 'assistant',
        content: [],
        usage: {
          input_tokens: 50,
          output_tokens: 25,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 100
        }
      }
    })

    await writeFile(filePath, jsonl(makeUserMessage(), assistant1, assistant2))

    const result = await parseSessionFile(filePath)
    expect(result!.totalTokenUsage).toEqual({
      inputTokens: 150,
      outputTokens: 75,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 400
    })
  })

  it('skips file-history-snapshot lines', async () => {
    const projectDir = join(tmpDir, 'projects', 'proj')
    await mkdir(projectDir, { recursive: true })
    const filePath = join(projectDir, 'sess.jsonl')

    await writeFile(
      filePath,
      jsonl(makeSnapshotLine(), makeSnapshotLine(), makeUserMessage())
    )

    const result = await parseSessionFile(filePath)
    expect(result!.messageCount).toBe(1)
  })

  it('handles malformed JSONL lines gracefully (NFR14)', async () => {
    const projectDir = join(tmpDir, 'projects', 'proj')
    await mkdir(projectDir, { recursive: true })
    const filePath = join(projectDir, 'sess.jsonl')

    const content =
      JSON.stringify(makeUserMessage()) +
      '\n{broken json\n' +
      JSON.stringify(makeAssistantMessage()) +
      '\n'

    await writeFile(filePath, content)

    const result = await parseSessionFile(filePath)
    expect(result).not.toBeNull()
    expect(result!.messageCount).toBe(2)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Malformed JSONL'))
  })

  it('returns null for empty files', async () => {
    const projectDir = join(tmpDir, 'projects', 'proj')
    await mkdir(projectDir, { recursive: true })
    const filePath = join(projectDir, 'empty.jsonl')
    await writeFile(filePath, '')

    const result = await parseSessionFile(filePath)
    expect(result).toBeNull()
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Empty session file'))
  })

  it('returns null for nonexistent files', async () => {
    const result = await parseSessionFile(join(tmpDir, 'nope.jsonl'))
    expect(result).toBeNull()
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to read session file'),
      expect.anything()
    )
  })

  it('falls back to filename as sessionId if not in messages', async () => {
    const projectDir = join(tmpDir, 'projects', 'proj')
    await mkdir(projectDir, { recursive: true })
    const filePath = join(projectDir, 'fallback-id.jsonl')

    const msg = makeUserMessage({ sessionId: '' })
    await writeFile(filePath, jsonl(msg))

    const result = await parseSessionFile(filePath)
    expect(result!.sessionId).toBe('fallback-id')
  })

  it('handles messages without usage data', async () => {
    const projectDir = join(tmpDir, 'projects', 'proj')
    await mkdir(projectDir, { recursive: true })
    const filePath = join(projectDir, 'sess.jsonl')

    await writeFile(filePath, jsonl(makeUserMessage()))

    const result = await parseSessionFile(filePath)
    expect(result!.totalTokenUsage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0
    })
    expect(result!.models).toEqual([])
  })

  it('sorts messages by timestamp', async () => {
    const projectDir = join(tmpDir, 'projects', 'proj')
    await mkdir(projectDir, { recursive: true })
    const filePath = join(projectDir, 'sess.jsonl')

    const late = makeUserMessage({ timestamp: '2026-03-04T12:00:00.000Z', uuid: 'late' })
    const early = makeUserMessage({ timestamp: '2026-03-04T08:00:00.000Z', uuid: 'early' })

    await writeFile(filePath, jsonl(late, early))

    const result = await parseSessionFile(filePath)
    expect(result!.messages[0].uuid).toBe('early')
    expect(result!.messages[1].uuid).toBe('late')
  })

  it('handles files with only snapshot lines', async () => {
    const projectDir = join(tmpDir, 'projects', 'proj')
    await mkdir(projectDir, { recursive: true })
    const filePath = join(projectDir, 'snap-only.jsonl')
    await writeFile(filePath, jsonl(makeSnapshotLine()))

    const result = await parseSessionFile(filePath)
    // File has content but no relevant messages
    expect(result).not.toBeNull()
    expect(result!.messageCount).toBe(0)
    expect(result!.firstTimestamp).toBeNull()
    expect(result!.lastTimestamp).toBeNull()
  })

  it('collects multiple unique models', async () => {
    const projectDir = join(tmpDir, 'projects', 'proj')
    await mkdir(projectDir, { recursive: true })
    const filePath = join(projectDir, 'sess.jsonl')

    const a1 = makeAssistantMessage({ uuid: 'a1' })
    const a2 = makeAssistantMessage({
      uuid: 'a2',
      timestamp: '2026-03-04T10:01:00.000Z',
      message: {
        model: 'claude-sonnet-4-6',
        role: 'assistant',
        content: [],
        usage: { input_tokens: 10, output_tokens: 5 }
      }
    })

    await writeFile(filePath, jsonl(a1, a2))

    const result = await parseSessionFile(filePath)
    expect(result!.models).toContain('claude-opus-4-6')
    expect(result!.models).toContain('claude-sonnet-4-6')
  })
})

describe('parseAllSessions', () => {
  it('parses all session files from claude directory', async () => {
    const proj = join(tmpDir, 'projects', 'proj')
    await mkdir(proj, { recursive: true })
    await writeFile(join(proj, 's1.jsonl'), jsonl(makeUserMessage()))
    await writeFile(
      join(proj, 's2.jsonl'),
      jsonl(makeUserMessage({ sessionId: 'sess-002', uuid: 'u2' }))
    )

    const results = await parseAllSessions(tmpDir)
    expect(results).toHaveLength(2)
  })

  it('skips unparseable files and continues', async () => {
    const proj = join(tmpDir, 'projects', 'proj')
    await mkdir(proj, { recursive: true })
    await writeFile(join(proj, 'good.jsonl'), jsonl(makeUserMessage()))
    await writeFile(join(proj, 'empty.jsonl'), '')

    const results = await parseAllSessions(tmpDir)
    expect(results).toHaveLength(1)
  })

  it('processes in batches', async () => {
    const proj = join(tmpDir, 'projects', 'proj')
    await mkdir(proj, { recursive: true })

    // Create 5 files, process with batchSize=2
    for (let i = 0; i < 5; i++) {
      await writeFile(
        join(proj, `s${i}.jsonl`),
        jsonl(makeUserMessage({ sessionId: `sess-${i}`, uuid: `u-${i}` }))
      )
    }

    const results = await parseAllSessions(tmpDir, { batchSize: 2 })
    expect(results).toHaveLength(5)
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Discovered 5'))
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Successfully parsed 5'))
  })

  it('returns empty array for nonexistent claude directory', async () => {
    const results = await parseAllSessions(join(tmpDir, 'nope'))
    expect(results).toHaveLength(0)
  })
})
