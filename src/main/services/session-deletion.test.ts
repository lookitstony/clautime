// @vitest-environment node
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { sessions } from '../db/schema/sessions'
import { sessionDeletions } from '../db/schema/session-deletions'
import { sessionLegacyRecords } from '../db/schema/session-legacy'
import { sessionDerivations } from '../db/schema/session-derivations'
import { rawMessages, progressEvents } from '../db/schema/raw-messages'
import { scanState } from '../db/schema/scan-state'
import {
  activityIdentities,
  activityObservations,
  activitySources
} from '../db/schema/activity-evidence'
import { sessionModelUsage } from '../db/schema/session-model-usage'
import { aiSummaries } from '../db/schema/ai-summaries'
import { gitCommits } from '../db/schema/git-commits'
import { invoices, invoiceLineItems } from '../db/schema/invoices'
import { randomUUID } from 'node:crypto'

let db: ReturnType<typeof drizzle>
let sqlite: Database.Database
const settings: Record<string, string> = {}
vi.mock('../db', () => ({ getDb: () => db }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, Notification: vi.fn(), shell: {} }))
vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
vi.mock('./settings-service', () => ({
  settingsService: { getSetting: (key: string) => settings[key] ?? null }
}))
vi.mock('../providers', () => ({
  enabledProviders: () => [],
  providerForFile: (path: string) => ({ id: path.startsWith('codex/') ? 'codex' : 'claude' })
}))
vi.mock('./credential-service', () => ({
  credentialService: { getApiKey: () => null, isStripeTestMode: () => false }
}))
vi.mock('./stripe-service', () => ({ stripeService: {} }))
vi.mock('./ai-service', () => ({
  aiService: { summarizeSessionGroup: vi.fn().mockResolvedValue(null) }
}))
vi.mock('./widget-service', () => ({ widgetService: {} }))
import { ipcMain } from 'electron'
import { sessionService } from './session-service'
import { clientProjectService } from './client-project-service'
import { reportService } from './report-service'
import { invoiceService } from './invoice-service'
import { liveMonitorService } from './live-monitor-service'
import { gitService } from './git-service'
import { registerSessionHandlers } from '../ipc/session-handlers'
import { retainLegacySession } from './session-legacy'
import { adoptInitialWorkspacePolicy, previewLedgerWorkspacePolicy } from './workspace-policy'
import {
  adoptSessionActivityMappings,
  previewSessionActivityAdoption
} from './session-activity-mappings'

beforeEach(() => {
  sqlite = new Database(':memory:')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  for (const key of Object.keys(settings)) delete settings[key]
})
afterEach(() => {
  vi.restoreAllMocks()
  sqlite.close()
})

function capture(sourceFile: string, minutes: number[], conversationId = sourceFile): void {
  for (const minute of minutes) {
    db.insert(rawMessages)
      .values({
        sourceFile,
        uuid: `${sourceFile}-${minute}`,
        type: 'user',
        timestamp: new Date(Date.UTC(2026, 2, 4, 10, minute)).toISOString(),
        claudeSessionId: conversationId,
        cwd: 'C:\\fixture'
      })
      .run()
  }
}

it('excludes deleted work from every total and new invoices while retaining invoice and related audit rows', async () => {
  const client = clientProjectService.createClient({ name: 'Fixture', billableRate: 100 })
  const project = clientProjectService.createProject({
    clientId: client.id,
    name: 'Fixture',
    directoryPath: 'C:\\fixture'
  })
  const start = new Date()
  start.setHours(10, 0, 0, 0)
  const original = sessionService.createSession({
    projectPath: 'C:\\fixture',
    startedAt: start.toISOString(),
    endedAt: new Date(+start + 60 * 60_000).toISOString(),
    durationMinutes: 60,
    projectId: project.id,
    clientId: client.id,
    description: 'Invoice work'
  })
  db.insert(sessionModelUsage)
    .values({ sessionId: original.id, model: 'fixture-model', inputTokens: 100, outputTokens: 50 })
    .run()
  db.insert(aiSummaries).values({ sessionId: original.id, summary: 'Saved summary' }).run()
  db.insert(gitCommits)
    .values({
      sessionId: original.id,
      projectId: project.id,
      hash: 'fixture-hash',
      message: 'Saved commit',
      authorName: 'Fixture',
      authorEmail: 'fixture@example.invalid',
      committedAt: original.endedAt
    })
    .run()
  const invoice = db
    .insert(invoices)
    .values({ clientId: client.id, stripeInvoiceId: 'in_fixture', amountDueCents: 10000 })
    .returning()
    .get()
  db.insert(invoiceLineItems)
    .values({
      invoiceId: invoice.id,
      description: 'Saved line',
      amountCents: 10000,
      sessionIds: String(original.id)
    })
    .run()
  const lines = db.select().from(invoiceLineItems).all()
  const usage = db.select().from(sessionModelUsage).all()
  const summaries = db.select().from(aiSummaries).all()
  const commits = db.select().from(gitCommits).all()
  expect(liveMonitorService.getTodayStats().totalSessions).toBe(1)
  expect(
    (await invoiceService.generateLineItems(client.id, '2000-01-01', '2100-01-01')).lineItems
  ).toHaveLength(0) // Already linked to the saved invoice above.

  sessionService.deleteSession(original.id)
  const deletion = db.select().from(sessionDeletions).get()!
  sessionService.deleteSession(original.id)
  expect(db.select().from(sessionDeletions).all()).toEqual([deletion])
  expect(sessionService.getAllSessions()).toEqual([])
  expect(sessionService.getSessionById(original.id)).toBeNull()
  expect(sessionService.getModelUsage({ sessionIds: [original.id] })).toEqual([])
  expect(
    reportService.generateReport(
      { startDate: '2000-01-01', endDate: '2100-01-01' },
      'session-breakdown'
    ).summary.totalSessions
  ).toBe(0)
  expect(liveMonitorService.getTodayStats()).toMatchObject({
    totalSessions: 0,
    totalTokens: 0,
    earnedToday: 0
  })
  vi.spyOn(liveMonitorService, 'getLatestPromptTimestamps').mockResolvedValue(new Map())
  expect(
    (await liveMonitorService.getProjectLiveStatuses()).every((p) => p.sessionCount === 0)
  ).toBe(true)
  expect(
    (await invoiceService.generateLineItems(client.id, '2000-01-01', '2100-01-01')).lineItems
  ).toEqual([])
  expect(() => sessionService.updateSession(original.id, { durationMinutes: 999 })).toThrow(
    'not found'
  )
  expect(() =>
    sessionService.splitSession(original.id, new Date(+start + 30 * 60_000).toISOString())
  ).toThrow('not found')
  clientProjectService.attributeSessions()
  gitService.correlateCommitsWithSessions()
  expect(db.select().from(sessions).all()).toEqual([original])
  expect(db.select().from(sessionModelUsage).all()).toEqual(usage)
  expect(db.select().from(aiSummaries).all()).toEqual(summaries)
  expect(db.select().from(gitCommits).all()).toEqual(commits)
  expect(db.select().from(invoices).all()).toEqual([invoice])
  expect(db.select().from(invoiceLineItems).all()).toEqual(lines)
})

it('uses detector anchors despite edited times and admits independent later intervals', async () => {
  capture('deleted.jsonl', [0, 5])
  await sessionService.rebuildSessionsFromRaw()
  const original = sessionService.getAllSessions()[0]
  sessionService.updateSession(original.id, {
    startedAt: '2026-03-04T08:00:00Z',
    endedAt: '2026-03-04T09:00:00Z',
    durationMinutes: 60
  })
  sessionService.deleteSession(original.id)
  expect(db.select().from(sessionDeletions).get()).toMatchObject({
    startedAt: original.startedAt,
    endedAt: original.endedAt
  })
  capture('deleted.jsonl', [60, 65])
  const result = await sessionService.rebuildSessionsFromRaw()
  expect(result.errors).toBeUndefined()
  expect(result.newSessions).toBe(1)
  expect(sessionService.getAllSessions()).toEqual([
    expect.objectContaining({ startedAt: '2026-03-04T11:00:00.000Z' })
  ])
  expect(
    sessionService
      .getTimeBreakdown('2026-03-04T00:00:00Z', '2026-03-05T00:00:00Z')
      .reduce((sum, day) => sum + day.totalMinutes, 0)
  ).toBe(5)
})

it('flags a growing deleted interval without restoring it or blocking another file', async () => {
  capture('deleted.jsonl', [0, 5])
  await sessionService.rebuildSessionsFromRaw()
  sessionService.deleteSession(sessionService.getAllSessions()[0].id)
  const original = db.select().from(sessions).get()
  capture('deleted.jsonl', [10])
  capture('healthy.jsonl', [0, 5])
  const result = await sessionService.rebuildSessionsFromRaw()
  expect(result.errors).toEqual([
    expect.objectContaining({
      sourceFile: 'deleted.jsonl',
      message: expect.stringContaining('overlap deleted history')
    })
  ])
  expect(sessionService.getAllSessions()).toEqual([
    expect.objectContaining({ sourceFile: 'healthy.jsonl' })
  ])
  expect(db.select().from(sessions).all()[0]).toEqual(original)
})

it('keeps all policy-split children of deleted activity suppressed', async () => {
  capture('deleted.jsonl', [0, 8, 16])
  await sessionService.rebuildSessionsFromRaw()
  sessionService.deleteSession(sessionService.getAllSessions()[0].id)
  settings.idle_timeout_minutes = '5'
  const result = await sessionService.rebuildSessionsFromRaw()
  expect(result.errors).toBeUndefined()
  expect(result.newSessions).toBe(0)
  expect(sessionService.getAllSessions()).toEqual([])
})

it('deletes a legacy row without guessing activity boundaries and holds returning logs for review', async () => {
  const original = db
    .insert(sessions)
    .values({
      projectPath: 'C:\\fixture',
      sourceFile: 'legacy.jsonl',
      startedAt: '2026-03-04T08:00:00Z',
      endedAt: '2026-03-04T09:00:00Z',
      durationMinutes: 60
    })
    .returning()
    .get()
  db.insert(sessionModelUsage)
    .values({
      sessionId: original.id,
      model: 'retained-model',
      inputTokens: 321,
      outputTokens: 123,
      cacheCreationInputTokens: 9,
      cacheReadInputTokens: 27
    })
    .run()
  sessionService.deleteSession(original.id)
  expect(sessionService.getAllSessions()).toEqual([])
  expect(db.select().from(sessions).all()).toEqual([original])
  const snapshot = db.select().from(sessionLegacyRecords).get()!
  expect(snapshot).toMatchObject({ sessionId: original.id, version: 1, session: original })
  expect(snapshot.modelUsage).toEqual([
    {
      model: 'retained-model',
      inputTokens: 321,
      outputTokens: 123,
      cacheCreationInputTokens: 9,
      cacheReadInputTokens: 27
    }
  ])
  expect(db.select().from(sessionDeletions).get()?.legacyRecordId).toBe(snapshot.id)
  sessionService.deleteSession(original.id)
  expect(db.select().from(sessionLegacyRecords).all()).toEqual([snapshot])
  expect(db.select().from(sessionDerivations).all()).toEqual([])
  // Saved times may have been edited; returning activity falls outside them.
  capture('legacy.jsonl', [0, 5])
  capture('healthy.jsonl', [0, 5])
  const result = await sessionService.rebuildSessionsFromRaw()
  expect(result.errors).toEqual([expect.objectContaining({ sourceFile: 'legacy.jsonl' })])
  expect(sessionService.getAllSessions()).toEqual([
    expect.objectContaining({ sourceFile: 'healthy.jsonl' })
  ])
  const review = sessionService.getReconciliationCases()[0]
  sessionService.keepSavedHistory(review.sourceFile, review.fingerprint!)
  expect((await sessionService.rebuildSessionsFromRaw()).errors).toBeUndefined()
  expect(sessionService.getAllSessions()).toHaveLength(1)
  expect(db.select().from(sessionLegacyRecords).all()).toEqual([snapshot])
})

it.each([null, ''])(
  'deletes legacy history with a conversation but no source path (%s)',
  async (sourceFile) => {
    const client = clientProjectService.createClient({ name: 'Legacy', billableRate: 60 })
    const original = db
      .insert(sessions)
      .values({
        projectPath: 'C:\\old-location',
        sourceFile,
        claudeSessionId: 'known-conversation',
        clientId: client.id,
        startedAt: '2026-03-04T08:00:00Z',
        endedAt: '2026-03-04T09:00:00Z',
        durationMinutes: 60,
        inputTokens: 321
      })
      .returning()
      .get()
    db.insert(sessionModelUsage)
      .values({
        sessionId: original.id,
        model: 'retained',
        inputTokens: 321,
        outputTokens: 123,
        cacheCreationInputTokens: 9,
        cacheReadInputTokens: 27
      })
      .run()
    const invoice = db
      .insert(invoices)
      .values({ clientId: client.id, stripeInvoiceId: 'in_sourceless', amountDueCents: 6000 })
      .returning()
      .get()
    db.insert(invoiceLineItems)
      .values({
        invoiceId: invoice.id,
        description: 'Saved',
        amountCents: 6000,
        sessionIds: String(original.id)
      })
      .run()
    const lines = db.select().from(invoiceLineItems).all()
    sessionService.deleteSession(original.id)
    sessionService.deleteSession(original.id)
    const snapshot = db.select().from(sessionLegacyRecords).get()!
    expect(snapshot.session).toEqual(original)
    expect(snapshot.modelUsage[0]).toMatchObject({
      inputTokens: 321,
      outputTokens: 123,
      cacheCreationInputTokens: 9,
      cacheReadInputTokens: 27
    })
    expect(db.select().from(sessionDeletions).all()).toEqual([
      expect.objectContaining({
        legacyRecordId: snapshot.id,
        sourceFile,
        claudeSessionId: 'known-conversation'
      })
    ])
    expect(db.select().from(sessionDerivations).all()).toEqual([])
    expect(db.select().from(rawMessages).all()).toEqual([])
    expect(sessionService.getAllSessions()).toEqual([])
    const serialized = sqlite.serialize()
    sqlite.close()
    sqlite = new Database(serialized)
    db = drizzle(sqlite)
    capture('returned.jsonl', [0, 5], 'known-conversation')
    capture('healthy.jsonl', [0, 5], 'different-conversation')
    capture('codex/same-id.jsonl', [0, 5], 'known-conversation')
    const result = await sessionService.rebuildSessionsFromRaw()
    expect(result.errors).toEqual([expect.objectContaining({ sourceFile: 'returned.jsonl' })])
    expect(
      sessionService
        .getAllSessions()
        .map((row) => row.sourceFile)
        .sort()
    ).toEqual(['codex/same-id.jsonl', 'healthy.jsonl'])
    const review = sessionService.getReconciliationCases()[0]
    expect(review.saved).toEqual([
      expect.objectContaining({ id: original.id, disposition: 'deleted', clientId: client.id })
    ])
    await expect(
      invoiceService.generateLineItems(client.id, '2026-03-01', '2026-03-10')
    ).rejects.toThrow('Review unresolved history')
    sessionService.keepSavedHistory(review.sourceFile, review.fingerprint!)
    expect((await sessionService.rebuildSessionsFromRaw()).errors).toBeUndefined()
    expect(sessionService.getReconciliationCases()).toEqual([])
    expect(
      (await invoiceService.generateLineItems(client.id, '2026-03-01', '2026-03-10')).lineItems
    ).toEqual([])
    capture('returned.jsonl', [10], 'known-conversation')
    expect((await sessionService.rebuildSessionsFromRaw()).errors).toHaveLength(1)
    expect(db.select().from(sessionLegacyRecords).all()).toEqual([snapshot])
    expect(db.select().from(invoiceLineItems).all()).toEqual(lines)
    expect(db.select().from(invoices).all()).toEqual([invoice])
    expect(sessionService.getSessionById(original.id)).toBeNull()
  }
)

it('rejects stale approvals and mappings when a matching source-less deletion is added', async () => {
  const sourceFile = 'pending.jsonl'
  capture(sourceFile, [0, 5], 'known-conversation')
  const row = db
    .insert(sessions)
    .values({
      sourceFile,
      claudeSessionId: 'known-conversation',
      projectPath: 'C:\\fixture',
      startedAt: '2026-03-04T10:00:00Z',
      endedAt: '2026-03-04T10:05:00Z',
      durationMinutes: 5,
      inputTokens: 1000
    })
    .returning()
    .get()
  await sessionService.rebuildSessionsFromRaw()
  const old = sessionService.getReconciliationCases()[0]
  const legacy = db
    .insert(sessions)
    .values({ ...row, id: undefined, sourceFile: null })
    .returning()
    .get()
  sessionService.deleteSession(legacy.id)
  expect(() => sessionService.keepSavedHistory(sourceFile, old.fingerprint!)).toThrow(
    'comparison changed'
  )
  expect(() =>
    sessionService.mapSavedHistory(sourceFile, old.fingerprint!, [
      { sessionId: row.id, detectedIndex: 0 }
    ])
  ).toThrow('comparison changed')
  await sessionService.recheckReconciliation(sourceFile)
  const refreshed = sessionService.getReconciliationCases()[0]
  expect(() =>
    sessionService.mapSavedHistory(sourceFile, refreshed.fingerprint!, [
      { sessionId: row.id, detectedIndex: 0 }
    ])
  ).toThrow('splits or deletions')
  sessionService.keepSavedHistory(sourceFile, refreshed.fingerprint!)
  const another = db
    .insert(sessions)
    .values({ ...legacy, id: undefined })
    .returning()
    .get()
  sessionService.deleteSession(another.id)
  expect(
    sessionService.getReconciliationCases()[0].saved.filter((s) => s.disposition === 'deleted')
  ).toHaveLength(2)
  expect(db.select().from(sessions).where(eq(sessions.id, row.id)).get()).toEqual(row)
})

it.each(['legacy-rollback.jsonl', null])(
  'rolls back the legacy snapshot if saving its deletion fails (%s)',
  (sourceFile) => {
    const original = db
      .insert(sessions)
      .values({
        projectPath: 'C:\\fixture',
        sourceFile,
        claudeSessionId: 'known-conversation',
        startedAt: '2026-03-04T10:00:00Z',
        endedAt: '2026-03-04T11:00:00Z',
        durationMinutes: 60
      })
      .returning()
      .get()
    sqlite.exec(
      "CREATE TRIGGER fixture_fail_legacy_delete BEFORE INSERT ON session_deletions BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END"
    )
    expect(() => sessionService.deleteSession(original.id)).toThrow('fixture rollback')
    expect(db.select().from(sessionLegacyRecords).all()).toEqual([])
    expect(db.select().from(sessionDeletions).all()).toEqual([])
    expect(sessionService.getAllSessions()).toEqual([original])
  }
)

it.each([null, '', '   '])(
  'keeps unidentifiable legacy rows guarded without inventing a source identity (%s)',
  (claudeSessionId) => {
    const original = db
      .insert(sessions)
      .values({
        projectPath: 'C:\\fixture',
        claudeSessionId,
        startedAt: '2026-03-04T10:00:00Z',
        endedAt: '2026-03-04T11:00:00Z',
        durationMinutes: 60
      })
      .returning()
      .get()
    expect(() => sessionService.deleteSession(original.id)).toThrow('no source identity')
    expect(db.select().from(sessionDeletions).all()).toEqual([])
    expect(sessionService.getAllSessions()).toEqual([original])
  }
)

it('blocks reset before any writes when deletion audit records exist', async () => {
  capture('deleted.jsonl', [0, 5])
  await sessionService.rebuildSessionsFromRaw()
  sessionService.deleteSession(sessionService.getAllSessions()[0].id)
  const rows = db.select().from(sessions).all()
  const raw = db.select().from(rawMessages).all()
  registerSessionHandlers()
  const reset = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === 'session:reset')![1]
  expect(await reset({} as never)).toMatchObject({
    success: false,
    error: { message: expect.stringContaining('Reset is unavailable') }
  })
  expect(db.select().from(sessions).all()).toEqual(rows)
  expect(db.select().from(rawMessages).all()).toEqual(raw)
  expect(db.select().from(sessionDeletions).all()).toHaveLength(1)
})

it('blocks reset for a retained legacy snapshot even before a deletion exists', async () => {
  const original = db
    .insert(sessions)
    .values({
      projectPath: 'C:\\fixture',
      sourceFile: 'legacy-reset.jsonl',
      startedAt: '2026-03-04T10:00:00Z',
      endedAt: '2026-03-04T11:00:00Z',
      durationMinutes: 60
    })
    .returning()
    .get()
  db.transaction((tx) => retainLegacySession(tx, original))
  const snapshots = db.select().from(sessionLegacyRecords).all()
  registerSessionHandlers()
  const reset = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === 'session:reset')![1]
  expect(await reset({} as never)).toMatchObject({
    success: false,
    error: { message: expect.stringContaining('legacy history') }
  })
  expect(sessionService.getAllSessions()).toEqual([original])
  expect(db.select().from(sessionLegacyRecords).all()).toEqual(snapshots)
})

it.each(['identity only', 'complete evidence'])(
  'blocks reset before any writes when activity history is retained (%s)',
  async (evidence) => {
    const sourceFile = 'evidence-reset.jsonl'
    const timestamp = '2026-03-04T10:00:00Z'
    capture(sourceFile, [0, 5])
    await sessionService.rebuildSessionsFromRaw()
    const session = sessionService.getAllSessions()[0]
    db.insert(aiSummaries).values({ sessionId: session.id, summary: 'Retained summary' }).run()
    db.insert(sessionModelUsage)
      .values({ sessionId: session.id, model: 'fixture-model', inputTokens: 100 })
      .run()
    db.insert(progressEvents).values({ sourceFile, timestamp }).run()
    db.insert(scanState)
      .values({
        filePath: sourceFile,
        lastModifiedAt: timestamp,
        lastScannedAt: timestamp,
        lastFileSize: 123
      })
      .run()
    db.insert(activityIdentities)
      .values({
        eventId: 'event-a',
        provider: 'claude',
        identityVersion: 1,
        conversationId: 'conversation-a',
        basis: 'native',
        nativeEventId: 'message-a'
      })
      .run()
    if (evidence === 'complete evidence') {
      db.insert(activityObservations)
        .values({
          id: 'observation-a',
          eventId: 'event-a',
          version: 1,
          kind: 'message',
          payloadJson: JSON.stringify({ timestamp, usage: { inputTokens: 100 } }),
          createdAt: timestamp
        })
        .run()
      db.insert(activitySources)
        .values({ observationId: 'observation-a', sourceFile, isSubagent: 0 })
        .run()
    }
    const tables = [
      sessions,
      rawMessages,
      aiSummaries,
      sessionModelUsage,
      progressEvents,
      scanState,
      activityIdentities,
      activityObservations,
      activitySources
    ]
    const before = tables.map((table) => db.select().from(table).all())
    registerSessionHandlers()
    const reset = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([name]) => name === 'session:reset')![1]
    expect(await reset({} as never)).toMatchObject({
      success: false,
      error: { code: 'SESSION_RESET_ERROR', message: expect.stringContaining('activity history') }
    })
    expect(tables.map((table) => db.select().from(table).all())).toEqual(before)
  }
)

it('still permits reset without retained activity or other audit history', async () => {
  capture('reset-allowed.jsonl', [0, 5])
  await sessionService.rebuildSessionsFromRaw()
  expect(sessionService.getAllSessions()).toHaveLength(1)
  registerSessionHandlers()
  const reset = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === 'session:reset')![1]
  expect(await reset({} as never)).toMatchObject({ success: true })
  expect(db.select().from(sessions).all()).toEqual([])
  expect(db.select().from(rawMessages).all()).toEqual([])
  expect(db.select().from(activityIdentities).all()).toEqual([])
})

it('deletes adopted activity by its coverage so rebuilds and copies never restore it', async () => {
  const trackingPolicy = {
    version: 1,
    normalizationVersion: 1,
    detectorVersion: 1,
    idleTimeoutMinutes: 15,
    reportingTimeZone: 'UTC'
  }
  adoptInitialWorkspacePolicy(db, {
    workspaceId: randomUUID(),
    revisionId: randomUUID(),
    policy: trackingPolicy
  })
  for (const [index, minute] of [0, 5].entries()) {
    const eventId = `mapped.jsonl-${minute}`
    const timestamp = new Date(Date.UTC(2026, 2, 4, 10, minute)).toISOString()
    db.insert(activityIdentities)
      .values({
        eventId,
        provider: 'claude',
        conversationId: 'mapped',
        identityVersion: 1,
        basis: 'native',
        nativeEventId: eventId
      })
      .run()
    db.insert(activityObservations)
      .values({
        id: `observation-${eventId}`,
        eventId,
        version: 1,
        kind: 'message',
        createdAt: timestamp,
        payloadJson: JSON.stringify({
          type: 'user',
          timestamp,
          parentEventId: index ? 'mapped.jsonl-0' : null,
          model: null,
          usage: null,
          isToolResult: false,
          hasToolUse: false,
          toolNames: []
        })
      })
      .run()
  }
  capture('mapped.jsonl', [0, 5], 'mapped')
  capture('copied.jsonl', [0, 5], 'mapped')
  const conversation = previewLedgerWorkspacePolicy(db, trackingPolicy).conversations[0]
  if (conversation.status !== 'resolved') throw new Error('Unresolved fixture')
  const [interval] = conversation.before
  const original = db
    .insert(sessions)
    .values({
      projectPath: 'C:\\fixture',
      sourceFile: 'mapped.jsonl',
      claudeSessionId: 'mapped',
      startedAt: interval.startedAt,
      endedAt: interval.endedAt,
      durationMinutes: interval.durationMinutes,
      promptCount: interval.promptCount
    })
    .returning()
    .get()
  db.insert(sessionDerivations)
    .values({
      sessionId: original.id,
      startedAt: original.startedAt,
      endedAt: original.endedAt,
      durationMinutes: original.durationMinutes
    })
    .run()
  adoptSessionActivityMappings(db, previewSessionActivityAdoption(db).fingerprint, [original.id])

  sessionService.deleteSession(original.id)
  sessionService.deleteSession(original.id)
  expect(db.select().from(sessionDeletions).all()).toEqual([
    expect.objectContaining({
      sessionId: original.id,
      startedAt: interval.startedAt,
      endedAt: interval.endedAt,
      legacyRecordId: null
    })
  ])
  expect(db.select().from(sessionLegacyRecords).all()).toEqual([])
  expect(sessionService.getAllSessions()).toEqual([])
  const result = await sessionService.rebuildSessionsFromRaw()
  expect(result.errors).toBeUndefined()
  expect(sessionService.getAllSessions()).toEqual([])
  expect(db.select().from(sessions).all()).toEqual([original])
})

it('blocks reset before any writes when manual time identities are retained', async () => {
  const session = sessionService.createSession({
    projectPath: 'C:/manual',
    startedAt: '2026-09-26T10:00:00Z',
    endedAt: '2026-09-26T11:00:00Z',
    durationMinutes: 60
  })
  db.insert(aiSummaries).values({ sessionId: session.id, summary: 'Saved manual summary' }).run()
  const snapshot = () =>
    ['sessions', 'manual_time_entries', 'ai_summaries'].map((table) =>
      sqlite.prepare(`SELECT * FROM ${table}`).all()
    )
  const before = snapshot()
  registerSessionHandlers()
  const reset = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === 'session:reset')![1]
  expect(await reset({} as never)).toMatchObject({
    success: false,
    error: { message: expect.stringContaining('manual time history') }
  })
  expect(snapshot()).toEqual(before)
})
