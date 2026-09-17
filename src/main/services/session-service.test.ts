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
import { rawMessages, progressEvents } from '../db/schema/raw-messages'
import { invoices, invoiceLineItems } from '../db/schema/invoices'
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
      type: 'assistant',
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

  describe('getPromptTimings', () => {
    it.each(['database', 'file'] as const)(
      'uses the explicitly mapped activity from the %s while preserving saved times',
      async (storage) => {
        const sourceFile = '/fixtures/mapped-timeline.jsonl'
        const timestamp = (minute: number) =>
          new Date(Date.UTC(2026, 2, 4, 10, minute)).toISOString()
        const messages = [
          ...[0, 10, 40, 45, 50].map((minute) => makeMessage(timestamp(minute))),
          makeMessage(timestamp(41), { type: 'assistant' }),
          makeMessage(timestamp(46), { isToolResult: true })
        ].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
        for (const message of messages)
          testDb
            .insert(rawMessages)
            .values({
              sourceFile,
              claudeSessionId: 'sess-1',
              type: message.type,
              timestamp: message.timestamp,
              isToolResult: Number(message.isToolResult)
            })
            .run()
        const saved = [0, 40].map((minute) =>
          testDb
            .insert(sessions)
            .values({
              sourceFile,
              claudeSessionId: 'sess-1',
              projectPath: '/projects/test',
              startedAt: timestamp(minute),
              endedAt: timestamp(minute + 10),
              durationMinutes: 10,
              promptCount: 100
            })
            .returning()
            .get()
        )
        await sessionService.rebuildSessionsFromRaw()
        const review = sessionService.getReconciliationCases()[0]
        sessionService.mapSavedHistory(sourceFile, review.fingerprint!, [
          { sessionId: saved[0].id, detectedIndex: 1 },
          { sessionId: saved[1].id, detectedIndex: 0 }
        ])
        if (storage === 'file') {
          testDb.delete(rawMessages).where(eq(rawMessages.sourceFile, sourceFile)).run()
          mockParseFile.mockResolvedValue(makeParsedSession(sourceFile, messages))
        }
        expect(await sessionService.getPromptTimings(saved[0].id)).toEqual([
          { promptAt: timestamp(40), responseAt: timestamp(41), latencySeconds: 60 },
          { promptAt: timestamp(45), responseAt: null, latencySeconds: null },
          { promptAt: timestamp(50), responseAt: null, latencySeconds: null }
        ])
        expect((await sessionService.getPromptTimings(saved[1].id)).map((t) => t.promptAt)).toEqual(
          [timestamp(0), timestamp(10)]
        )
        expect(sessionService.getSessionById(saved[0].id)).toMatchObject({
          startedAt: saved[0].startedAt,
          endedAt: saved[0].endedAt,
          durationMinutes: 10,
          promptCount: 3
        })
        if (storage === 'database') expect(mockParseFile).not.toHaveBeenCalled()
        else expect(mockParseFile).toHaveBeenCalledWith(sourceFile)
      }
    )

    it.each(['database', 'file'] as const)(
      'uses saved bounds for legacy sessions without a baseline in the %s',
      async (storage) => {
        const sourceFile = '/fixtures/legacy-timeline.jsonl'
        const messages = [0, 10, 40].map((minute) =>
          makeMessage(new Date(Date.UTC(2026, 2, 4, 10, minute)).toISOString())
        )
        const session = testDb
          .insert(sessions)
          .values({
            sourceFile,
            projectPath: '/projects/test',
            startedAt: messages[0].timestamp,
            endedAt: messages[1].timestamp,
            durationMinutes: 10
          })
          .returning()
          .get()
        if (storage === 'database') {
          for (const message of messages)
            testDb
              .insert(rawMessages)
              .values({ sourceFile, type: message.type, timestamp: message.timestamp })
              .run()
        } else mockParseFile.mockResolvedValue(makeParsedSession(sourceFile, messages))
        expect((await sessionService.getPromptTimings(session.id)).map((t) => t.promptAt)).toEqual(
          messages.slice(0, 2).map((message) => message.timestamp)
        )
      }
    )
  })

  describe('scanSessions', () => {
    it('preserves row identity, edits and invoice references as a transcript grows', async () => {
      const file = '/fixtures/growing.jsonl'
      mockDiscoverFiles.mockResolvedValue([file])
      mockStat.mockResolvedValue({ mtime: new Date('2026-03-04T12:00:00Z'), size: 100 })
      mockParseFile.mockResolvedValue(
        makeParsedSession(file, [
          makeMessage('2026-03-04T10:00:00Z', { uuid: 'first' }),
          makeMessage('2026-03-04T10:05:00Z', { uuid: 'second' })
        ])
      )
      await sessionService.scanSessions()
      const original = testDb.select().from(sessions).get()!
      const client = testDb
        .insert(clients)
        .values({ name: 'Client', color: '#fff' })
        .returning()
        .get()
      sessionService.updateSession(original.id, {
        description: 'Keep me',
        billable: false,
        clientId: client.id
      })
      const invoice = testDb
        .insert(invoices)
        .values({ clientId: client.id, stripeInvoiceId: 'in_fixture' })
        .returning()
        .get()
      testDb
        .insert(invoiceLineItems)
        .values({
          invoiceId: invoice.id,
          description: 'Saved work',
          amountCents: 1234,
          sessionIds: String(original.id)
        })
        .run()
      testDb
        .insert(aiSummariesSchema.aiSummaries)
        .values({ sessionId: original.id, summary: 'Saved summary' })
        .run()
      testDb
        .insert(gitCommitsSchema.gitCommits)
        .values({
          sessionId: original.id,
          hash: 'abc',
          message: 'work',
          authorName: 'Test',
          authorEmail: 'test@example.com',
          committedAt: original.startedAt
        })
        .run()
      const invoiceBefore = testDb.select().from(invoiceLineItems).all()

      mockStat.mockResolvedValue({ mtime: new Date('2026-03-04T12:00:00Z'), size: 200 })
      mockParseFile.mockResolvedValue(
        makeParsedSession(file, [
          makeMessage('2026-03-04T10:10:00Z', {
            uuid: 'third',
            type: 'assistant',
            model: 'test-model',
            usage: {
              inputTokens: 100,
              outputTokens: 50,
              cacheCreationInputTokens: 20,
              cacheReadInputTokens: 30
            }
          })
        ])
      )
      await sessionService.scanSessions()
      await sessionService.rebuildSessionsFromRaw()

      expect(testDb.select().from(sessions).all()).toEqual([
        expect.objectContaining({
          id: original.id,
          createdAt: original.createdAt,
          description: 'Keep me',
          billable: 0,
          clientId: client.id,
          durationMinutes: 10,
          promptCount: 2,
          inputTokens: 100,
          outputTokens: 50
        })
      ])
      expect(testDb.select().from(invoiceLineItems).all()).toEqual(invoiceBefore)
      expect(testDb.select().from(aiSummariesSchema.aiSummaries).get()?.sessionId).toBe(original.id)
      expect(testDb.select().from(gitCommitsSchema.gitCommits).get()?.sessionId).toBe(original.id)
      expect(testDb.select().from(sessionModelUsage).all()).toEqual([
        expect.objectContaining({
          sessionId: original.id,
          inputTokens: 100,
          cacheReadInputTokens: 30
        })
      ])
    })

    it('retains imported and legacy history when files disappear and providers are disabled', async () => {
      const file = '/fixtures/retained.jsonl'
      mockDiscoverFiles.mockResolvedValue([file])
      mockStat.mockResolvedValue({ mtime: new Date('2026-03-04T12:00:00Z'), size: 100 })
      mockParseFile.mockResolvedValue(
        makeParsedSession(file, [
          makeMessage('2026-03-04T10:00:00Z'),
          makeMessage('2026-03-04T10:05:00Z')
        ])
      )
      await sessionService.scanSessions()
      const legacy = testDb
        .insert(sessions)
        .values({
          projectPath: '/legacy',
          sourceFile: '/gone.jsonl',
          startedAt: '2026-01-01T10:00:00Z',
          endedAt: '2026-01-01T11:00:00Z',
          durationMinutes: 60,
          inputTokens: 500,
          description: 'Legacy edit',
          billable: 0
        })
        .returning()
        .get()
      testDb
        .insert(sessionModelUsage)
        .values({ sessionId: legacy.id, model: 'legacy-model', inputTokens: 500 })
        .run()
      const before = testDb.select().from(sessions).all()
      const usageBefore = testDb.select().from(sessionModelUsage).all()
      mockDiscoverFiles.mockResolvedValue([]) // Source files no longer exist.
      mockSettings.track_claude = 'false'
      await sessionService.scanSessions()
      await sessionService.rebuildSessionsFromRaw()
      expect(testDb.select().from(sessions).all()).toEqual(before)
      expect(testDb.select().from(sessionModelUsage).all()).toEqual(usageBefore)
    })

    it('preserves edited time fields during later scans and rebuilds', async () => {
      const file = '/fixtures/edited.jsonl'
      mockDiscoverFiles.mockResolvedValue([file])
      mockStat.mockResolvedValue({ mtime: new Date('2026-03-04T12:00:00Z'), size: 100 })
      mockParseFile.mockResolvedValue(
        makeParsedSession(file, [
          makeMessage('2026-03-04T10:00:00Z'),
          makeMessage('2026-03-04T10:05:00Z')
        ])
      )
      await sessionService.scanSessions()
      const original = testDb.select().from(sessions).get()!
      sessionService.updateSession(original.id, {
        startedAt: '2026-03-04T09:00:00Z',
        endedAt: '2026-03-04T09:30:00Z',
        durationMinutes: 30
      })
      await sessionService.rebuildSessionsFromRaw()
      expect(testDb.select().from(sessions).all()).toEqual([
        expect.objectContaining({
          id: original.id,
          startedAt: '2026-03-04T09:00:00Z',
          endedAt: '2026-03-04T09:30:00Z',
          durationMinutes: 30
        })
      ])
    })

    it.each([
      ['split', '15', '5'],
      ['merge', '5', '15']
    ])(
      'leaves saved history intact and reports an ambiguous policy %s',
      async (_change, beforeTimeout, afterTimeout) => {
        const file = '/fixtures/split.jsonl'
        mockSettings.idle_timeout_minutes = beforeTimeout
        mockDiscoverFiles.mockResolvedValue([file])
        mockStat.mockResolvedValue({ mtime: new Date('2026-03-04T12:00:00Z'), size: 100 })
        mockParseFile.mockResolvedValue(
          makeParsedSession(file, [
            makeMessage('2026-03-04T10:00:00Z'),
            makeMessage('2026-03-04T10:10:00Z')
          ])
        )
        await sessionService.scanSessions()
        const before = testDb.select().from(sessions).all()
        mockSettings.idle_timeout_minutes = afterTimeout
        expect((await sessionService.rebuildSessionsFromRaw()).errors).toEqual([
          expect.objectContaining({
            sourceFile: file,
            message: expect.stringMatching(/reconciliation/i)
          })
        ])
        expect(testDb.select().from(sessions).all()).toEqual(before)
        expect(sessionService._scanInProgress).toBe(false)
      }
    )

    it('keeps legacy edited times when first mapping a saved row to retained activity', async () => {
      const file = '/fixtures/legacy-edited.jsonl'
      const original = testDb
        .insert(sessions)
        .values({
          sourceFile: file,
          claudeSessionId: 'sess-1',
          projectPath: '/projects/test',
          startedAt: '2026-03-04T10:00:00Z',
          endedAt: '2026-03-04T10:30:00Z',
          durationMinutes: 25,
          billable: 0,
          description: 'Existing edit'
        })
        .returning()
        .get()
      mockDiscoverFiles.mockResolvedValue([file])
      mockStat.mockResolvedValue({ mtime: new Date('2026-03-04T12:00:00Z'), size: 100 })
      mockParseFile.mockResolvedValue(
        makeParsedSession(file, [
          makeMessage('2026-03-04T10:00:00Z'),
          makeMessage('2026-03-04T10:05:00Z')
        ])
      )
      await sessionService.scanSessions()
      await sessionService.rebuildSessionsFromRaw()
      expect(testDb.select().from(sessions).all()).toEqual([
        expect.objectContaining({
          id: original.id,
          startedAt: original.startedAt,
          endedAt: original.endedAt,
          durationMinutes: 25,
          billable: 0,
          description: 'Existing edit',
          promptCount: 2
        })
      ])
    })

    it('refuses to replace legacy totals with an incomplete surviving transcript', async () => {
      const file = '/fixtures/partial-legacy.jsonl'
      const original = testDb
        .insert(sessions)
        .values({
          sourceFile: file,
          claudeSessionId: 'sess-1',
          projectPath: '/projects/test',
          startedAt: '2026-03-04T10:00:00Z',
          endedAt: '2026-03-04T10:05:00Z',
          durationMinutes: 5,
          promptCount: 20,
          inputTokens: 1000
        })
        .returning()
        .get()
      testDb
        .insert(sessionModelUsage)
        .values({ sessionId: original.id, model: 'saved-model', inputTokens: 1000 })
        .run()
      const usage = testDb.select().from(sessionModelUsage).all()
      mockDiscoverFiles.mockResolvedValue([file])
      mockStat.mockResolvedValue({ mtime: new Date('2026-03-04T12:00:00Z'), size: 100 })
      mockParseFile.mockResolvedValue(
        makeParsedSession(file, [
          makeMessage('2026-03-04T10:00:00Z'),
          makeMessage('2026-03-04T10:05:00Z')
        ])
      )
      expect((await sessionService.scanSessions()).errors).toEqual([
        expect.objectContaining({
          sourceFile: file,
          message: expect.stringMatching(/legacy.*reconciliation/i)
        })
      ])
      expect(testDb.select().from(sessions).all()).toEqual([original])
      expect(testDb.select().from(sessionModelUsage).all()).toEqual(usage)
      expect(testDb.select().from(scanState).all()).toEqual([])
      expect((await sessionService.scanSessions()).errors).toEqual([
        expect.objectContaining({
          sourceFile: file,
          message: expect.stringMatching(/legacy.*reconciliation/i)
        })
      ])
    })

    it('rescans appended logs even when Windows leaves the modification time unchanged', async () => {
      const file = '/home/user/.claude/projects/test/session1.jsonl'
      testDb
        .insert(scanState)
        .values({
          filePath: file,
          lastModifiedAt: '2026-03-04T10:00:00Z',
          lastScannedAt: '2026-03-04T12:00:00Z',
          sessionCount: 1,
          lastFileSize: 100
        })
        .run()
      mockDiscoverFiles.mockResolvedValue([file])
      mockStat.mockResolvedValue({ mtime: new Date('2026-03-04T10:00:00Z'), size: 200 })
      mockParseFile.mockResolvedValue(
        makeParsedSession(file, [
          makeMessage('2026-03-04T10:00:00Z'),
          makeMessage('2026-03-04T10:10:00Z')
        ])
      )
      expect((await sessionService.scanSessions()).updatedFiles).toBe(1)
      expect(testDb.select().from(sessions).all()[0].durationMinutes).toBe(10)
      mockParseFile.mockClear()
      expect((await sessionService.scanSessions()).updatedFiles).toBe(0)
      expect(mockParseFile).not.toHaveBeenCalled()
    })
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

    it('includes a session ending at midnight without including the next day', () => {
      const midnight = new Date(2026, 8, 15).toISOString()
      const [previous, next, point] = testDb
        .insert(sessions)
        .values([
          {
            projectPath: '/projects/midnight',
            startedAt: new Date(2026, 8, 14, 23, 50).toISOString(),
            endedAt: midnight,
            durationMinutes: 10
          },
          {
            projectPath: '/projects/midnight',
            startedAt: midnight,
            endedAt: new Date(2026, 8, 15, 0, 10).toISOString(),
            durationMinutes: 10
          },
          {
            projectPath: '/projects/midnight',
            startedAt: midnight,
            endedAt: midnight,
            durationMinutes: 0
          }
        ])
        .returning()
        .all()
      for (const s of [previous, next, point]) {
        testDb
          .insert(sessionModelUsage)
          .values({
            sessionId: s.id,
            model: 'test-model',
            inputTokens: 100,
            outputTokens: 50,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0
          })
          .run()
      }
      const filters = {
        startDate: new Date(2026, 8, 14).toISOString(),
        endDate: new Date(2026, 8, 14, 23, 59, 59, 999).toISOString()
      }

      expect(sessionService.getAllSessions(filters).map((s) => s.id)).toEqual([previous.id])
      expect(sessionService.getModelUsage(filters)).toEqual([
        {
          model: 'test-model',
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          sessionCount: 1
        }
      ])
      expect(
        sessionService
          .getAllSessions({
            startDate: midnight,
            endDate: new Date(2026, 8, 15, 23, 59, 59, 999).toISOString()
          })
          .map((s) => s.id)
          .sort()
      ).toEqual([next.id, point.id].sort())
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

    it('deleteSession retains model usage for audit but excludes it from totals', () => {
      testDb
        .insert(sessions)
        .values([
          {
            projectPath: '/projects/a',
            startedAt: '2026-03-01T10:00:00Z',
            endedAt: '2026-03-01T11:00:00Z',
            durationMinutes: 60,
            source: 'manual',
            status: 'completed'
          },
          {
            projectPath: '/projects/b',
            startedAt: '2026-03-02T10:00:00Z',
            endedAt: '2026-03-02T11:00:00Z',
            durationMinutes: 60,
            source: 'manual',
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
      expect(remaining).toHaveLength(2)
      expect(sessionService.getModelUsage()).toEqual([
        expect.objectContaining({ inputTokens: 300, outputTokens: 400, sessionCount: 1 })
      ])
      expect(sessionService.getAllSessions().map((s) => s.id)).toEqual([keep.id])
    })
  })
})

describe('excluded history retention', () => {
  beforeEach(() => {
    setupTestDb()
    vi.clearAllMocks()
    Object.keys(mockSettings).forEach((key) => delete mockSettings[key])
    mockDiscoverFiles.mockResolvedValue([])
  })

  afterEach(() => {
    if (testSqlite) testSqlite.close()
  })

  const EXCLUDED_PATH = 'C:\\piped\\scratch\\scratch\\abc123'
  const EXCLUDED_FILE = 'C:\\Users\\t\\.claude\\projects\\C--piped-scratch-scratch-abc123\\s1.jsonl'

  function insertSession(overrides: Partial<typeof sessions.$inferInsert> = {}): number {
    const now = new Date().toISOString()
    return testDb
      .insert(sessions)
      .values({
        projectPath: EXCLUDED_PATH,
        startedAt: now,
        endedAt: now,
        durationMinutes: 10,
        source: 'auto',
        status: 'completed',
        sourceFile: EXCLUDED_FILE,
        createdAt: now,
        updatedAt: now,
        ...overrides
      })
      .returning({ id: sessions.id })
      .get().id
  }

  it('retains excluded sessions and their captured activity on scan', async () => {
    const excludedId = insertSession()
    const keptId = insertSession({ projectPath: 'C:\\apps\\RealProject', sourceFile: 'real.jsonl' })
    testDb
      .insert(scanState)
      .values({ filePath: EXCLUDED_FILE, lastModifiedAt: '1', lastScannedAt: '1' })
      .run()
    testDb
      .insert(rawMessages)
      .values({ sourceFile: EXCLUDED_FILE, type: 'user', timestamp: '2026-01-01T00:00:00Z' })
      .run()
    testDb
      .insert(progressEvents)
      .values({ sourceFile: EXCLUDED_FILE, timestamp: '2026-01-01T00:00:00Z' })
      .run()

    await sessionService.scanSessions()

    const remaining = testDb.select().from(sessions).all()
    expect(remaining.map((s) => s.id)).toEqual([excludedId, keptId])
    expect(testDb.select().from(scanState).all()).toHaveLength(1)
    expect(
      testDb
        .select()
        .from(rawMessages)
        .all()
        .filter((r) => r.sourceFile === EXCLUDED_FILE)
    ).toHaveLength(1)
    expect(testDb.select().from(progressEvents).all()).toHaveLength(1)
  })

  it('retains manual, described, invoiced and unedited sessions with their file rows', async () => {
    const manualId = insertSession({ source: 'manual' })
    const describedId = insertSession({ description: 'user note' })
    const invoicedId = insertSession()
    const uneditedId = insertSession()

    const client = testDb
      .insert(clients)
      .values({ name: 'C', color: '#fff' })
      .returning({ id: clients.id })
      .get()
    const invoice = testDb
      .insert(invoices)
      .values({ clientId: client.id, stripeInvoiceId: 'in_test' })
      .returning({ id: invoices.id })
      .get()
    testDb
      .insert(invoiceLineItems)
      .values({
        invoiceId: invoice.id,
        description: 'work',
        amountCents: 100,
        // invoice-service stores this comma-separated — mirror the real format
        sessionIds: [invoicedId].join(',')
      })
      .run()
    testDb
      .insert(scanState)
      .values({ filePath: EXCLUDED_FILE, lastModifiedAt: '1', lastScannedAt: '1' })
      .run()

    await sessionService.scanSessions()

    const remainingIds = testDb
      .select({ id: sessions.id })
      .from(sessions)
      .all()
      .map((r) => r.id)
      .sort()
    expect(remainingIds).toEqual([manualId, describedId, invoicedId, uneditedId].sort())
    // Spared sessions still reference the file — file-level rows must survive
    expect(testDb.select().from(scanState).all()).toHaveLength(1)
  })

  it('retains history even with malformed legacy invoice session IDs', async () => {
    insertSession()

    const client = testDb
      .insert(clients)
      .values({ name: 'C', color: '#fff' })
      .returning({ id: clients.id })
      .get()
    const invoice = testDb
      .insert(invoices)
      .values({ clientId: client.id, stripeInvoiceId: 'in_bad' })
      .returning({ id: invoices.id })
      .get()
    testDb
      .insert(invoiceLineItems)
      .values({
        invoiceId: invoice.id,
        description: 'work',
        amountCents: 100,
        sessionIds: 'not,valid,ids'
      })
      .run()

    await sessionService.scanSessions()

    expect(testDb.select().from(sessions).all()).toHaveLength(1)
  })
})
