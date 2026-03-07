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
  app: { getPath: vi.fn(() => '/tmp/test-clawdtime') }
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

vi.mock('../parsers', () => ({
  discoverSessionFiles: (...args: unknown[]) => mockDiscoverFiles(...(args as [])),
  parseSessionFile: (...args: unknown[]) => mockParseFile(...(args as []))
}))

// Mock fs/promises stat
const mockStat = vi.fn()
vi.mock('node:fs/promises', () => ({
  stat: (...args: unknown[]) => mockStat(...(args as []))
}))

import * as sessionsSchema from '../db/schema/sessions'
import * as appSettingsSchema from '../db/schema/app-settings'
import * as scanStateSchema from '../db/schema/scan-state'
import * as rawMessagesSchema from '../db/schema/raw-messages'
import * as aiSummariesSchema from '../db/schema/ai-summaries'
import * as gitCommitsSchema from '../db/schema/git-commits'
import * as clientsSchema from '../db/schema/clients'
import * as projectsSchema from '../db/schema/projects'
import * as projectAlertConfigSchema from '../db/schema/project-alert-config'
import { sessions } from '../db/schema/sessions'
import { scanState } from '../db/schema/scan-state'
import { sessionService } from './session-service'
import type { ParsedSessionData, ParsedMessage } from '../parsers/types'

const schema = {
  ...sessionsSchema,
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
}

function makeMessage(timestamp: string): ParsedMessage {
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
    toolNames: []
  }
}

function makeParsedSession(
  sourceFile: string,
  messages: ParsedMessage[]
): ParsedSessionData {
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
    Object.keys(mockSettings).forEach((key) => delete mockSettings[key])
  })

  afterEach(() => {
    if (testSqlite) testSqlite.close()
  })

  describe('scanSessions', () => {
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

      const scanRecord = testDb
        .select()
        .from(scanState)
        .where(eq(scanState.filePath, file1))
        .get()

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
})
