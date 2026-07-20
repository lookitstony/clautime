// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'

// Mock electron-log before any imports that use it
vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

// Mock electron app
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/test-clautime') }
}))

// Mock the db module to use our test DB
let testDb: BetterSQLite3Database<any>
let testSqlite: Database.Database

vi.mock('../db', () => ({
  getDb: () => testDb,
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn()
}))

// Mock settings service
const mockSettings: Record<string, string> = {}
vi.mock('./settings-service', () => ({
  settingsService: {
    getSetting: vi.fn((key: string) => mockSettings[key] ?? null),
    setSetting: vi.fn((key: string, value: string) => {
      mockSettings[key] = value
    }),
    getAllSettings: vi.fn(() => ({ ...mockSettings })),
    deleteSetting: vi.fn()
  }
}))

// Mock the parser functions
const mockDiscoverFiles = vi.fn<() => Promise<string[]>>()
const mockParseFile = vi.fn()
// Capture the discover options each provider receives (asserts override routing)
const claudeDiscoverOpts: Array<{ rootOverride?: string }> = []
const codexDiscoverOpts: Array<{ rootOverride?: string }> = []

// Drive the ingestion pipeline through fake providers so these tests stay focused
// on session-service orchestration, not real file discovery. Claude supplies the
// files (via mockDiscoverFiles); Codex returns none, so existing scan expectations
// are unchanged while the Codex adapter's received options can still be asserted.
vi.mock('../providers', () => {
  const claude = {
    id: 'claude',
    ownsFile: () => true,
    discoverFiles: (opts: { rootOverride?: string }) => {
      claudeDiscoverOpts.push(opts)
      return mockDiscoverFiles()
    },
    readMeta: async () => null,
    parseFile: (...args: unknown[]) => mockParseFile(...(args as []))
  }
  const codex = {
    id: 'codex',
    ownsFile: () => false,
    discoverFiles: async (opts: { rootOverride?: string }) => {
      codexDiscoverOpts.push(opts)
      return [] as string[]
    },
    readMeta: async () => null,
    parseFile: (...args: unknown[]) => mockParseFile(...(args as []))
  }
  return {
    providerRegistry: [claude, codex],
    enabledProviders: () => [claude, codex],
    providerForFile: () => claude
  }
})

// Mock fs/promises stat
const mockStat = vi.fn()
vi.mock('node:fs/promises', () => ({
  stat: (...args: unknown[]) => mockStat(...(args as []))
}))

import * as sessionsSchema from '../db/schema/sessions'
import * as sessionModelUsageSchema from '../db/schema/session-model-usage'
import * as appSettingsSchema from '../db/schema/app-settings'
import * as scanStateSchema from '../db/schema/scan-state'
import * as rawMessagesSchema from '../db/schema/raw-messages'
import * as aiSummariesSchema from '../db/schema/ai-summaries'
import * as gitCommitsSchema from '../db/schema/git-commits'
import * as clientsSchema from '../db/schema/clients'
import * as projectsSchema from '../db/schema/projects'
import * as projectAlertConfigSchema from '../db/schema/project-alert-config'
import { sessions } from '../db/schema/sessions'
import { sessionModelUsage } from '../db/schema/session-model-usage'
import { scanState } from '../db/schema/scan-state'
import { clients } from '../db/schema/clients'
import { projects } from '../db/schema/projects'
import { rawMessages } from '../db/schema/raw-messages'
import { sessionService } from './session-service'
import type { ParsedSessionData, ParsedMessage } from '../parsers/types'

const schema = {
  ...sessionsSchema,
  ...sessionModelUsageSchema,
  ...appSettingsSchema,
  ...scanStateSchema,
  ...rawMessagesSchema,
  ...aiSummariesSchema,
  ...gitCommitsSchema,
  ...clientsSchema,
  ...projectsSchema,
  ...projectAlertConfigSchema
}

function setupTestDb(): void {
  testSqlite = new Database(':memory:')
  testSqlite.pragma('journal_mode = WAL')
  testDb = drizzle(testSqlite, { schema })
  migrate(testDb, { migrationsFolder: join(__dirname, '../db/migrations') })
  // Seed a dummy raw_messages row so _backfillIfNeeded skips (avoids consuming mocks)
  testDb
    .insert(rawMessages)
    .values({
      sourceFile: '__seed__',
      type: 'user',
      timestamp: '2026-01-01T00:00:00Z'
    })
    .run()
}

function makeMessage(timestamp: string, overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    type: 'user',
    timestamp,
    sessionId: 'sess-1',
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

function makeParsedSession(sourceFile: string, messages: ParsedMessage[]): ParsedSessionData {
  const ts = messages.filter((m) => m.timestamp).map((m) => m.timestamp)
  return {
    sessionId: 'sess-1',
    sourceFile,
    projectPathEncoded: 'test-project',
    projectDirectory: '/projects/test',
    messages,
    progressTimestamps: [],
    firstTimestamp: ts[0] ?? null,
    lastTimestamp: ts[ts.length - 1] ?? null,
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
    subagentProgressTimestamps: []
  }
}

describe('sessionService', () => {
  beforeEach(() => {
    setupTestDb()
    vi.clearAllMocks()
    claudeDiscoverOpts.length = 0
    codexDiscoverOpts.length = 0
    Object.keys(mockSettings).forEach((key) => delete mockSettings[key])
  })

  afterEach(() => {
    if (testSqlite) testSqlite.close()
  })

  describe('scanSessions', () => {
    it('passes the Claude dir override only to the Claude provider, not others', async () => {
      mockDiscoverFiles.mockResolvedValue([])
      await sessionService.scanSessions('/home/user/.claude')
      expect(claudeDiscoverOpts.at(-1)?.rootOverride).toBe('/home/user/.claude')
      expect(codexDiscoverOpts.at(-1)?.rootOverride).toBeUndefined()
    })

    it('should detect and store sessions from discovered files', async () => {
      const file1 = '/home/user/.claude/projects/test/session1.jsonl'

      mockDiscoverFiles.mockResolvedValue([file1])
      mockStat.mockResolvedValue({ mtime: new Date('2026-03-04T12:00:00Z') })
      mockParseFile.mockResolvedValue(
        makeParsedSession(file1, [
          makeMessage('2026-03-04T10:00:00Z'),
          makeMessage('2026-03-04T10:05:00Z'),
          makeMessage('2026-03-04T10:08:00Z')
        ])
      )

      const result = await sessionService.scanSessions('/home/user/.claude')

      expect(result.newSessions).toBe(1)
      expect(result.updatedFiles).toBe(1)
      expect(result.totalFiles).toBe(1)
      expect(result.durationMs).toBeGreaterThanOrEqual(0)

      // Verify sessions stored in DB
      const storedSessions = testDb.select().from(sessions).all()
      expect(storedSessions).toHaveLength(1)
      expect(storedSessions[0].projectPath).toBe('/projects/test')
      expect(storedSessions[0].source).toBe('auto')
      expect(storedSessions[0].claudeSessionId).toBe('sess-1')
      expect(storedSessions[0].sourceFile).toBe(file1)
      expect(storedSessions[0].durationMinutes).toBe(8)
    })

    it('should skip already-scanned files (incremental processing)', async () => {
      const file1 = '/home/user/.claude/projects/test/session1.jsonl'

      // Insert a scan_state record indicating file was already scanned
      testDb
        .insert(scanState)
        .values({
          filePath: file1,
          lastModifiedAt: '2026-03-04T12:00:00Z',
          lastScannedAt: '2026-03-04T13:00:00Z', // scanned AFTER mtime
          sessionCount: 1
        })
        .run()

      mockDiscoverFiles.mockResolvedValue([file1])
      // File mtime is BEFORE lastScannedAt
      mockStat.mockResolvedValue({ mtime: new Date('2026-03-04T12:00:00Z') })

      const result = await sessionService.scanSessions('/home/user/.claude')

      expect(result.newSessions).toBe(0)
      expect(result.updatedFiles).toBe(0)
      expect(mockParseFile).not.toHaveBeenCalled()
    })

    it('should re-process changed files and replace stale sessions', async () => {
      const file1 = '/home/user/.claude/projects/test/session1.jsonl'

      // Pre-existing auto session from a previous scan
      testDb
        .insert(sessions)
        .values({
          projectPath: '/projects/test',
          startedAt: '2026-03-04T10:00:00Z',
          endedAt: '2026-03-04T10:05:00Z',
          durationMinutes: 5,
          source: 'auto',
          sourceFile: file1,
          claudeSessionId: 'sess-1',
          status: 'completed'
        })
        .run()

      // Mark as previously scanned
      testDb
        .insert(scanState)
        .values({
          filePath: file1,
          lastModifiedAt: '2026-03-04T11:00:00Z',
          lastScannedAt: '2026-03-04T11:00:00Z',
          sessionCount: 1
        })
        .run()

      mockDiscoverFiles.mockResolvedValue([file1])
      // File has been modified AFTER last scan
      mockStat.mockResolvedValue({ mtime: new Date('2026-03-04T15:00:00Z') })
      mockParseFile.mockResolvedValue(
        makeParsedSession(file1, [
          makeMessage('2026-03-04T10:00:00Z'),
          makeMessage('2026-03-04T10:05:00Z'),
          // New messages added
          makeMessage('2026-03-04T10:30:00Z'),
          makeMessage('2026-03-04T10:35:00Z')
        ])
      )

      const result = await sessionService.scanSessions('/home/user/.claude')

      // Should have replaced old session with 2 new ones (idle gap at 25 min)
      expect(result.newSessions).toBe(2)

      const storedSessions = testDb.select().from(sessions).all()
      expect(storedSessions).toHaveLength(2)
    })

    it('should not delete manual sessions when re-scanning', async () => {
      const file1 = '/home/user/.claude/projects/test/session1.jsonl'

      // Pre-existing manual session (should be preserved)
      testDb
        .insert(sessions)
        .values({
          projectPath: '/projects/test',
          startedAt: '2026-03-04T09:00:00Z',
          endedAt: '2026-03-04T09:30:00Z',
          durationMinutes: 30,
          source: 'manual',
          status: 'completed'
        })
        .run()

      mockDiscoverFiles.mockResolvedValue([file1])
      mockStat.mockResolvedValue({ mtime: new Date('2026-03-04T12:00:00Z') })
      mockParseFile.mockResolvedValue(
        makeParsedSession(file1, [
          makeMessage('2026-03-04T10:00:00Z'),
          makeMessage('2026-03-04T10:05:00Z')
        ])
      )

      await sessionService.scanSessions('/home/user/.claude')

      const allSessions = testDb.select().from(sessions).all()
      expect(allSessions).toHaveLength(2) // 1 manual + 1 auto
      expect(allSessions.find((s) => s.source === 'manual')).toBeDefined()
    })

    it('should use default idle timeout of 15 minutes when not configured', async () => {
      const file1 = '/home/user/.claude/projects/test/session1.jsonl'

      mockDiscoverFiles.mockResolvedValue([file1])
      mockStat.mockResolvedValue({ mtime: new Date('2026-03-04T12:00:00Z') })
      mockParseFile.mockResolvedValue(
        makeParsedSession(file1, [
          makeMessage('2026-03-04T10:00:00Z'),
          // 14 minute gap (< 15 default) — should NOT split
          makeMessage('2026-03-04T10:14:00Z'),
          // 16 minute gap (> 15 default) — should split
          makeMessage('2026-03-04T10:30:00Z')
        ])
      )

      const result = await sessionService.scanSessions('/home/user/.claude')
      expect(result.newSessions).toBe(2)
    })

    it('should use custom idle timeout from settings', async () => {
      mockSettings['idle_timeout_minutes'] = '5'
      const file1 = '/home/user/.claude/projects/test/session1.jsonl'

      mockDiscoverFiles.mockResolvedValue([file1])
      mockStat.mockResolvedValue({ mtime: new Date('2026-03-04T12:00:00Z') })
      mockParseFile.mockResolvedValue(
        makeParsedSession(file1, [
          makeMessage('2026-03-04T10:00:00Z'),
          // 6 minute gap (> 5 custom) — should split
          makeMessage('2026-03-04T10:06:00Z')
        ])
      )

      const result = await sessionService.scanSessions('/home/user/.claude')
      expect(result.newSessions).toBe(2)
    })

    it('should handle empty file discovery gracefully', async () => {
      mockDiscoverFiles.mockResolvedValue([])

      const result = await sessionService.scanSessions('/home/user/.claude')
      expect(result.newSessions).toBe(0)
      expect(result.totalFiles).toBe(0)
    })

    it('should update scan_state for processed files', async () => {
      const file1 = '/home/user/.claude/projects/test/session1.jsonl'

      mockDiscoverFiles.mockResolvedValue([file1])
      mockStat.mockResolvedValue({ mtime: new Date('2026-03-04T12:00:00Z') })
      mockParseFile.mockResolvedValue(
        makeParsedSession(file1, [
          makeMessage('2026-03-04T10:00:00Z'),
          makeMessage('2026-03-04T10:05:00Z')
        ])
      )

      await sessionService.scanSessions('/home/user/.claude')

      const scanRecord = testDb.select().from(scanState).where(eq(scanState.filePath, file1)).get()

      expect(scanRecord).toBeDefined()
      expect(scanRecord!.sessionCount).toBe(1)
      expect(scanRecord!.lastScannedAt).toBeTruthy()
    })
  })

  describe('getAllSessions', () => {
    beforeEach(() => {
      // Insert some test sessions
      testDb
        .insert(sessions)
        .values([
          {
            projectPath: '/projects/alpha',
            startedAt: '2026-03-01T10:00:00Z',
            endedAt: '2026-03-01T10:30:00Z',
            durationMinutes: 30,
            source: 'auto',
            status: 'completed'
          },
          {
            projectPath: '/projects/beta',
            startedAt: '2026-03-02T14:00:00Z',
            endedAt: '2026-03-02T15:00:00Z',
            durationMinutes: 60,
            source: 'manual',
            status: 'completed'
          },
          {
            projectPath: '/projects/alpha',
            startedAt: '2026-03-03T09:00:00Z',
            endedAt: '2026-03-03T09:45:00Z',
            durationMinutes: 45,
            source: 'auto',
            status: 'completed'
          }
        ])
        .run()
    })

    it('should return all sessions when no filters', () => {
      const result = sessionService.getAllSessions()
      expect(result).toHaveLength(3)
    })

    it('should filter by projectPath', () => {
      const result = sessionService.getAllSessions({ projectPath: '/projects/alpha' })
      expect(result).toHaveLength(2)
      expect(result.every((s) => s.projectPath === '/projects/alpha')).toBe(true)
    })

    it('should filter by source', () => {
      const result = sessionService.getAllSessions({ source: 'manual' })
      expect(result).toHaveLength(1)
      expect(result[0].source).toBe('manual')
    })

    it('should filter by date range', () => {
      const result = sessionService.getAllSessions({
        startDate: '2026-03-02T00:00:00Z',
        endDate: '2026-03-03T00:00:00Z'
      })
      expect(result).toHaveLength(1)
      expect(result[0].projectPath).toBe('/projects/beta')
    })

    it('should return sessions ordered by startedAt', () => {
      const result = sessionService.getAllSessions()
      for (let i = 1; i < result.length; i++) {
        expect(result[i].startedAt >= result[i - 1].startedAt).toBe(true)
      }
    })
  })

  describe('getSessionById', () => {
    it('should return session by id', () => {
      testDb
        .insert(sessions)
        .values({
          projectPath: '/projects/test',
          startedAt: '2026-03-04T10:00:00Z',
          endedAt: '2026-03-04T10:30:00Z',
          durationMinutes: 30,
          source: 'auto',
          status: 'completed'
        })
        .run()

      const allSessions = testDb.select().from(sessions).all()
      const result = sessionService.getSessionById(allSessions[0].id)
      expect(result).toBeDefined()
      expect(result!.projectPath).toBe('/projects/test')
    })

    it('should return null for non-existent id', () => {
      const result = sessionService.getSessionById(9999)
      expect(result).toBeNull()
    })
  })

  describe('model usage', () => {
    it('should populate session_model_usage rows during scan', async () => {
      const file1 = '/home/user/.claude/projects/test/session1.jsonl'

      mockDiscoverFiles.mockResolvedValue([file1])
      mockStat.mockResolvedValue({ mtime: new Date('2026-03-04T12:00:00Z') })
      mockParseFile.mockResolvedValue(
        makeParsedSession(file1, [
          makeMessage('2026-03-04T10:00:00Z'),
          makeMessage('2026-03-04T10:01:00Z', {
            type: 'assistant',
            model: 'claude-opus-4-6',
            usage: {
              inputTokens: 100,
              outputTokens: 200,
              cacheCreationInputTokens: 30,
              cacheReadInputTokens: 40
            }
          }),
          makeMessage('2026-03-04T10:02:00Z', {
            type: 'assistant',
            model: 'claude-haiku-4-5',
            usage: {
              inputTokens: 10,
              outputTokens: 20,
              cacheCreationInputTokens: 5,
              cacheReadInputTokens: 15
            }
          })
        ])
      )

      const result = await sessionService.scanSessions('/home/user/.claude')
      expect(result.newSessions).toBe(1)

      const session = testDb.select().from(sessions).all()[0]
      const usageRows = testDb
        .select()
        .from(sessionModelUsage)
        .where(eq(sessionModelUsage.sessionId, session.id))
        .all()

      expect(usageRows).toHaveLength(2)
      const opus = usageRows.find((u) => u.model === 'claude-opus-4-6')
      expect(opus).toMatchObject({
        inputTokens: 100,
        outputTokens: 200,
        cacheCreationInputTokens: 30,
        cacheReadInputTokens: 40
      })
      const haiku = usageRows.find((u) => u.model === 'claude-haiku-4-5')
      expect(haiku).toMatchObject({
        inputTokens: 10,
        outputTokens: 20,
        cacheCreationInputTokens: 5,
        cacheReadInputTokens: 15
      })
    })

    it('should replace stale model usage rows when re-scanning a changed file', async () => {
      const file1 = '/home/user/.claude/projects/test/session1.jsonl'

      mockDiscoverFiles.mockResolvedValue([file1])
      mockStat.mockResolvedValue({ mtime: new Date('2026-03-04T12:00:00Z') })
      mockParseFile.mockResolvedValue(
        makeParsedSession(file1, [
          makeMessage('2026-03-04T10:00:00Z'),
          makeMessage('2026-03-04T10:01:00Z', {
            type: 'assistant',
            model: 'claude-opus-4-6',
            usage: {
              inputTokens: 100,
              outputTokens: 200,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0
            }
          })
        ])
      )
      await sessionService.scanSessions('/home/user/.claude')

      // File modified AFTER the first scan's lastScannedAt (wall clock) — second scan with more tokens
      mockStat.mockResolvedValue({ mtime: new Date(Date.now() + 60_000) })
      mockParseFile.mockResolvedValue(
        makeParsedSession(file1, [
          makeMessage('2026-03-04T10:00:00Z'),
          makeMessage('2026-03-04T10:01:00Z', {
            type: 'assistant',
            model: 'claude-opus-4-6',
            usage: {
              inputTokens: 150,
              outputTokens: 300,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0
            }
          })
        ])
      )
      await sessionService.scanSessions('/home/user/.claude')

      // No orphaned rows from the first scan
      const allUsage = testDb.select().from(sessionModelUsage).all()
      expect(allUsage).toHaveLength(1)
      expect(allUsage[0].inputTokens).toBe(150)
      const sessionIds = testDb
        .select()
        .from(sessions)
        .all()
        .map((s) => s.id)
      expect(sessionIds).toContain(allUsage[0].sessionId)
    })

    it('getModelUsage should aggregate across sessions per model', () => {
      testDb
        .insert(sessions)
        .values([
          {
            projectPath: '/projects/a',
            startedAt: '2026-03-01T10:00:00Z',
            endedAt: '2026-03-01T11:00:00Z',
            durationMinutes: 60,
            source: 'auto',
            status: 'completed'
          },
          {
            projectPath: '/projects/b',
            startedAt: '2026-03-02T10:00:00Z',
            endedAt: '2026-03-02T11:00:00Z',
            durationMinutes: 60,
            source: 'auto',
            status: 'completed'
          }
        ])
        .run()
      const [s1, s2] = testDb.select().from(sessions).all()

      testDb
        .insert(sessionModelUsage)
        .values([
          {
            sessionId: s1.id,
            model: 'claude-opus-4-6',
            inputTokens: 100,
            outputTokens: 200,
            cacheCreationInputTokens: 10,
            cacheReadInputTokens: 20
          },
          {
            sessionId: s2.id,
            model: 'claude-opus-4-6',
            inputTokens: 300,
            outputTokens: 400,
            cacheCreationInputTokens: 30,
            cacheReadInputTokens: 40
          },
          {
            sessionId: s2.id,
            model: 'claude-haiku-4-5',
            inputTokens: 5,
            outputTokens: 6,
            cacheCreationInputTokens: 7,
            cacheReadInputTokens: 8
          }
        ])
        .run()

      const result = sessionService.getModelUsage()
      expect(result).toHaveLength(2)

      const opus = result.find((r) => r.model === 'claude-opus-4-6')
      expect(opus).toEqual({
        model: 'claude-opus-4-6',
        inputTokens: 400,
        outputTokens: 600,
        cacheCreationInputTokens: 40,
        cacheReadInputTokens: 60,
        sessionCount: 2
      })

      const haiku = result.find((r) => r.model === 'claude-haiku-4-5')
      expect(haiku).toEqual({
        model: 'claude-haiku-4-5',
        inputTokens: 5,
        outputTokens: 6,
        cacheCreationInputTokens: 7,
        cacheReadInputTokens: 8,
        sessionCount: 1
      })
    })

    it('getModelUsage should respect date range filters', () => {
      testDb
        .insert(sessions)
        .values([
          {
            projectPath: '/projects/a',
            startedAt: '2026-03-01T10:00:00Z',
            endedAt: '2026-03-01T11:00:00Z',
            durationMinutes: 60,
            source: 'auto',
            status: 'completed'
          },
          {
            projectPath: '/projects/a',
            startedAt: '2026-03-10T10:00:00Z',
            endedAt: '2026-03-10T11:00:00Z',
            durationMinutes: 60,
            source: 'auto',
            status: 'completed'
          }
        ])
        .run()
      const [early, late] = testDb.select().from(sessions).all()

      testDb
        .insert(sessionModelUsage)
        .values([
          {
            sessionId: early.id,
            model: 'claude-opus-4-6',
            inputTokens: 100,
            outputTokens: 100,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0
          },
          {
            sessionId: late.id,
            model: 'claude-opus-4-6',
            inputTokens: 900,
            outputTokens: 900,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0
          }
        ])
        .run()

      const result = sessionService.getModelUsage({
        startDate: '2026-03-05T00:00:00Z',
        endDate: '2026-03-15T00:00:00Z'
      })
      expect(result).toHaveLength(1)
      expect(result[0].inputTokens).toBe(900)
      expect(result[0].sessionCount).toBe(1)
    })

    it('getModelUsage should respect clientId and projectId filters', () => {
      testDb.insert(clients).values({ name: 'Acme', color: '#ff0000' }).run()
      const client = testDb.select().from(clients).all()[0]
      testDb
        .insert(projects)
        .values({ clientId: client.id, name: 'Proj A', directoryPath: '/projects/a' })
        .run()
      const project = testDb.select().from(projects).all()[0]

      testDb
        .insert(sessions)
        .values([
          {
            projectPath: '/projects/a',
            startedAt: '2026-03-01T10:00:00Z',
            endedAt: '2026-03-01T11:00:00Z',
            durationMinutes: 60,
            source: 'auto',
            status: 'completed',
            clientId: client.id,
            projectId: project.id
          },
          {
            projectPath: '/projects/other',
            startedAt: '2026-03-02T10:00:00Z',
            endedAt: '2026-03-02T11:00:00Z',
            durationMinutes: 60,
            source: 'auto',
            status: 'completed'
          }
        ])
        .run()
      const [attributed, unattributed] = testDb.select().from(sessions).all()

      testDb
        .insert(sessionModelUsage)
        .values([
          {
            sessionId: attributed.id,
            model: 'claude-opus-4-6',
            inputTokens: 111,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0
          },
          {
            sessionId: unattributed.id,
            model: 'claude-opus-4-6',
            inputTokens: 999,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0
          }
        ])
        .run()

      const byClient = sessionService.getModelUsage({ clientId: client.id })
      expect(byClient).toHaveLength(1)
      expect(byClient[0].inputTokens).toBe(111)

      const byProject = sessionService.getModelUsage({ projectId: project.id })
      expect(byProject).toHaveLength(1)
      expect(byProject[0].inputTokens).toBe(111)
    })

    it('getModelUsage should return empty array when no usage rows exist', () => {
      expect(sessionService.getModelUsage()).toEqual([])
    })

    it('deleteSession should remove its session_model_usage rows', () => {
      testDb
        .insert(sessions)
        .values([
          {
            projectPath: '/projects/a',
            startedAt: '2026-03-01T10:00:00Z',
            endedAt: '2026-03-01T11:00:00Z',
            durationMinutes: 60,
            source: 'auto',
            status: 'completed'
          },
          {
            projectPath: '/projects/b',
            startedAt: '2026-03-02T10:00:00Z',
            endedAt: '2026-03-02T11:00:00Z',
            durationMinutes: 60,
            source: 'auto',
            status: 'completed'
          }
        ])
        .run()
      const [target, keep] = testDb.select().from(sessions).all()

      testDb
        .insert(sessionModelUsage)
        .values([
          {
            sessionId: target.id,
            model: 'claude-opus-4-6',
            inputTokens: 100,
            outputTokens: 200,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0
          },
          {
            sessionId: keep.id,
            model: 'claude-opus-4-6',
            inputTokens: 300,
            outputTokens: 400,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0
          }
        ])
        .run()

      sessionService.deleteSession(target.id)

      const remaining = testDb.select().from(sessionModelUsage).all()
      expect(remaining).toHaveLength(1)
      expect(remaining[0].sessionId).toBe(keep.id)
    })
  })
})
