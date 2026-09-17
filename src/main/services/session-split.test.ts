// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import { sessions } from '../db/schema/sessions'
import { sessionModelUsage } from '../db/schema/session-model-usage'
import { sessionLegacyRecords } from '../db/schema/session-legacy'
import { sessionDerivations, sessionTimeOverrides } from '../db/schema/session-derivations'
import {
  sessionReconciliationCases,
  sessionReconciliationResolutions
} from '../db/schema/session-reconciliation'
import {
  sessionBillingRefs,
  sessionRevisions,
  sessionSplits,
  sessionReplacements
} from '../db/schema/session-history'
import { rawMessages } from '../db/schema/raw-messages'
import { invoices, invoiceLineItems } from '../db/schema/invoices'
import { aiSummaries } from '../db/schema/ai-summaries'
import { gitCommits } from '../db/schema/git-commits'

let sqlite: Database.Database
let db: ReturnType<typeof drizzle>
const settings: Record<string, string> = {}
let testMode = false
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
  providerForFile: () => ({ id: 'claude' })
}))
vi.mock('./credential-service', () => ({
  credentialService: { getApiKey: () => null, isStripeTestMode: () => testMode }
}))
vi.mock('./stripe-service', () => ({ stripeService: {} }))
vi.mock('./ai-service', () => ({
  aiService: { summarizeSessionGroup: vi.fn().mockResolvedValue(null) }
}))
import { sessionService } from './session-service'
import { clientProjectService } from './client-project-service'
import { invoiceService } from './invoice-service'
import { reportService } from './report-service'
import { gitService } from './git-service'
import { ipcMain } from 'electron'
import { registerSessionHandlers } from '../ipc/session-handlers'
import { retainLegacySession } from './session-legacy'

beforeEach(() => {
  sqlite = new Database(':memory:')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  for (const key of Object.keys(settings)) delete settings[key]
  testMode = false
})
afterEach(() => {
  vi.restoreAllMocks()
  sqlite.close()
})

function manual(durationMinutes = 60) {
  return sessionService.createSession({
    projectPath: 'C:\\fixture',
    startedAt: '2026-03-04T10:00:00.000Z',
    endedAt: '2026-03-04T11:00:00.000Z',
    durationMinutes,
    description: 'Saved work'
  })
}
function capture(file: string, minutes: number[]) {
  for (const minute of minutes)
    db.insert(rawMessages)
      .values({
        sourceFile: file,
        uuid: `${file}-${minute}`,
        type: 'user',
        timestamp: new Date(Date.UTC(2026, 2, 4, 10, minute)).toISOString(),
        claudeSessionId: file,
        cwd: 'C:\\fixture'
      })
      .run()
}
function invoice(clientId: number, sessionId: number) {
  return invoiceService.saveInvoice({
    clientId,
    stripeInvoiceId: 'in_fixture',
    status: 'open',
    amountDueCents: 10000,
    amountPaidCents: 0,
    currency: 'usd',
    lineItems: [
      {
        description: 'Original billed work',
        amountCents: 10000,
        sessionIds: [sessionId],
        sortOrder: 0
      }
    ]
  })
}

it('reads applicable predecessor commits through replacements and later splits without rewriting audit links', async () => {
  const sourceFile = '/review/replacement-commits'
  settings.idle_timeout_minutes = '30'
  capture(sourceFile, [0, 5, 20, 25])
  await sessionService.rebuildSessionsFromRaw()
  const client = clientProjectService.createClient({ name: 'Fixture', billableRate: 60 })
  const project = clientProjectService.createProject({
    clientId: client.id,
    name: 'Fixture',
    directoryPath: 'C:\\fixture'
  })
  const otherProject = clientProjectService.createProject({
    clientId: client.id,
    name: 'Other',
    directoryPath: 'C:\\other'
  })
  const original = sessionService.getAllSessions()[0]
  sessionService.updateSession(original.id, { clientId: client.id, projectId: project.id })
  const addCommit = (minute: number, sessionId = original.id) =>
    db
      .insert(gitCommits)
      .values({
        sessionId,
        projectId: project.id,
        hash: `fixture-${minute}`,
        message: `Work at ${minute}`,
        authorName: 'Fixture',
        authorEmail: 'fixture@example.invalid',
        committedAt: new Date(Date.UTC(2026, 2, 4, 10, minute)).toISOString()
      })
      .returning()
      .get()
  const commits = [-1, 2, 8, 15, 22, 31].map((minute) => addCommit(minute))
  settings.idle_timeout_minutes = '10'
  await sessionService.rebuildSessionsFromRaw()
  let review = sessionService.getReconciliationCases()[0]
  sessionService.replaceSavedHistory(sourceFile, review.fingerprint!)
  const [first, second] = sessionService.getAllSessions()
  const ids = (id: number) => gitService.getCommitsForSession(id).map((commit) => commit.id)
  gitService.correlateCommitsWithSessions()
  expect(ids(first.id)).toEqual([commits[1].id, commits[2].id])
  expect(ids(second.id)).toEqual([commits[4].id])
  expect(ids(original.id)).toEqual(commits.map((commit) => commit.id))
  sessionService.updateSession(second.id, { projectId: otherProject.id })
  expect(ids(second.id)).toEqual([])
  sessionService.updateSession(second.id, { projectId: project.id })
  const direct = addCommit(4, first.id)
  expect(ids(first.id)).toEqual([commits[1].id, direct.id, commits[2].id])
  const audit = db.select().from(gitCommits).all()
  settings.idle_timeout_minutes = '30'
  await sessionService.rebuildSessionsFromRaw()
  review = sessionService.getReconciliationCases()[0]
  sessionService.replaceSavedHistory(sourceFile, review.fingerprint!)
  const merged = sessionService.getAllSessions()[0]
  const expected = [commits[1].id, direct.id, commits[2].id, commits[3].id, commits[4].id]
  expect(ids(merged.id)).toEqual(expected)
  const serialized = sqlite.serialize()
  sqlite.close()
  sqlite = new Database(serialized)
  db = drizzle(sqlite)
  expect(ids(merged.id)).toEqual(expected)
  const [, last] = sessionService.splitSession(merged.id, '2026-03-04T10:12:00Z')
  expect(ids(last.id)).toEqual([commits[3].id, commits[4].id])
  sessionService.updateSession(last.id, {
    startedAt: '2026-03-04T08:00:00Z',
    endedAt: '2026-03-04T09:00:00Z',
    durationMinutes: 60
  })
  expect(ids(last.id)).toEqual([commits[3].id, commits[4].id])
  gitService.correlateCommitsWithSessions()
  expect(db.select().from(gitCommits).all()).toEqual(audit)
  expect(ids(99999)).toEqual([])
})

it('uses predecessor commits for session summary fallback and generation context', async () => {
  const sourceFile = '/review/replacement-summary'
  settings.idle_timeout_minutes = '30'
  capture(sourceFile, [0, 5, 20, 25])
  await sessionService.rebuildSessionsFromRaw()
  const original = sessionService.getAllSessions()[0]
  db.insert(gitCommits)
    .values({
      sessionId: original.id,
      hash: 'fixture-summary',
      message: 'Fixed authentication',
      authorName: 'Fixture',
      authorEmail: 'fixture@example.invalid',
      committedAt: '2026-03-04T10:02:00Z'
    })
    .run()
  settings.idle_timeout_minutes = '10'
  await sessionService.rebuildSessionsFromRaw()
  const review = sessionService.getReconciliationCases()[0]
  sessionService.replaceSavedHistory(sourceFile, review.fingerprint!)
  const first = sessionService.getAllSessions()[0]
  const { aiService: actualAi } =
    await vi.importActual<typeof import('./ai-service')>('./ai-service')
  expect(await actualAi.getSessionSummary(first.id)).toEqual({
    summary: 'Fixed authentication',
    tier: 'git'
  })
  const { credentialService } = await import('./credential-service')
  vi.spyOn(credentialService, 'getApiKey').mockReturnValue('fixture-not-a-real-key')
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text: 'Fixture summary' }] })
  })
  vi.stubGlobal('fetch', fetchMock)
  try {
    expect(await actualAi.generateSummary(first.id)).toBe('Fixture summary')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content).toContain(
      'Fixed authentication'
    )
  } finally {
    vi.unstubAllGlobals()
  }
})

it('replaces policy splits and merges while retaining predecessors, billing exclusions and growing identities', async () => {
  const sourceFile = '/review/replace-policy'
  settings.idle_timeout_minutes = '30'
  capture(sourceFile, [0, 5, 20, 25])
  await sessionService.rebuildSessionsFromRaw()
  const client = clientProjectService.createClient({ name: 'Replacement', billableRate: 60 })
  const original = sessionService.getAllSessions()[0]
  sessionService.updateSession(original.id, { clientId: client.id, description: 'Keep assignment' })
  const predecessor = sessionService.getSessionById(original.id)!
  invoice(client.id, original.id)
  const lines = db.select().from(invoiceLineItems).all()
  settings.idle_timeout_minutes = '10'
  await sessionService.rebuildSessionsFromRaw()
  let review = sessionService.getReconciliationCases()[0]
  sessionService.keepSavedHistory(sourceFile, review.fingerprint!)
  settings.idle_timeout_minutes = '11'
  await sessionService.rebuildSessionsFromRaw()
  review = sessionService.getReconciliationCases()[0]
  sessionService.replaceSavedHistory(sourceFile, review.fingerprint!)
  const children = sessionService.getAllSessions()
  expect(children).toHaveLength(2)
  expect(
    children.every(
      (row) =>
        row.id !== original.id &&
        row.clientId === client.id &&
        row.description === 'Keep assignment'
    )
  ).toBe(true)
  expect(db.select().from(sessions).where(eq(sessions.id, original.id)).get()).toEqual(predecessor)
  expect(sessionService.getSessionById(original.id)).toBeNull()
  expect(() => sessionService.updateSession(original.id, { description: 'audit' })).toThrow(
    'not found'
  )
  expect(sessionService.getReconciliationCases()).toEqual([])
  expect(db.select().from(sessionReplacements).all()).toHaveLength(2)
  const resolutions = db.select().from(sessionReconciliationResolutions).all()
  expect(resolutions[1]).toMatchObject({ action: 'replace_saved', parentId: resolutions[0].id })
  expect(
    (await invoiceService.generateLineItems(client.id, '2026-03-01', '2026-03-10')).lineItems
  ).toEqual([])
  const serialized = sqlite.serialize()
  sqlite.close()
  sqlite = new Database(serialized)
  db = drizzle(sqlite)
  capture(sourceFile, [30])
  expect((await sessionService.rebuildSessionsFromRaw()).errors).toBeUndefined()
  expect(sessionService.getAllSessions().map((row) => row.id)).toEqual(
    children.map((row) => row.id)
  )
  settings.idle_timeout_minutes = '30'
  await sessionService.rebuildSessionsFromRaw()
  review = sessionService.getReconciliationCases()[0]
  expect(review.saved.find((row) => row.id === original.id)?.disposition).toBe('replaced')
  sessionService.replaceSavedHistory(sourceFile, review.fingerprint!)
  const merged = sessionService.getAllSessions()[0]
  expect(merged).toMatchObject({
    durationMinutes: 30,
    promptCount: 5,
    clientId: client.id,
    description: 'Keep assignment'
  })
  expect(sessionService.getAllSessions()).toHaveLength(1)
  expect(db.select().from(sessions).all()).toHaveLength(4)
  expect(db.select().from(invoiceLineItems).all()).toEqual(lines)
  const otherClient = clientProjectService.createClient({ name: 'Reassigned', billableRate: 60 })
  sessionService.updateSession(merged.id, { clientId: otherClient.id })
  expect(
    (
      await invoiceService.generateLineItems(otherClient.id, '2026-03-01', '2026-03-10')
    ).lineItems.reduce((sum, line) => sum + line.amountCents, 0)
  ).toBe(500)
  expect((await sessionService.rebuildSessionsFromRaw()).errors).toBeUndefined()
})

it('keeps unaffected session IDs and conserves measured tokens while replacing another interval', async () => {
  const sourceFile = '/review/replace-mixed'
  settings.idle_timeout_minutes = '30'
  capture(sourceFile, [0, 5, 20, 25, 90, 95])
  for (const minute of [1, 21, 91])
    db.insert(rawMessages)
      .values({
        sourceFile,
        claudeSessionId: sourceFile,
        uuid: `usage-${minute}`,
        type: 'assistant',
        timestamp: new Date(Date.UTC(2026, 2, 4, 10, minute)).toISOString(),
        model: 'fixture',
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 7,
        cacheReadInputTokens: 13
      })
      .run()
  await sessionService.rebuildSessionsFromRaw()
  const saved = sessionService.getAllSessions()
  const usage = sessionService.getModelUsage()[0]
  settings.idle_timeout_minutes = '10'
  await sessionService.rebuildSessionsFromRaw()
  const review = sessionService.getReconciliationCases()[0]
  sessionService.replaceSavedHistory(sourceFile, review.fingerprint!)
  expect(sessionService.getAllSessions()).toHaveLength(3)
  expect(sessionService.getSessionById(saved[1].id)).toMatchObject({
    id: saved[1].id,
    createdAt: saved[1].createdAt,
    promptCount: 2
  })
  expect(sessionService.getModelUsage()[0]).toMatchObject({ ...usage, sessionCount: 3 })
  expect(
    db
      .select()
      .from(sessionReplacements)
      .all()
      .map((row) => row.predecessorSessionId)
  ).toEqual([saved[0].id, saved[0].id])
  expect(
    reportService.generateReport(
      { startDate: '2026-03-01', endDate: '2026-03-10' },
      'session-breakdown'
    ).summary.totalSessions
  ).toBe(3)
  expect(
    (await sessionService.getPromptTimings(sessionService.getAllSessions()[0].id)).map(
      (t) => t.promptAt
    )
  ).toEqual(['2026-03-04T10:00:00.000Z', '2026-03-04T10:05:00.000Z'])
})

it.each([false, true])(
  'preserves chosen assignments through attribution, restart and descendants (client-only %s)',
  async (clientOnly) => {
    const sourceFile = '/review/chosen-unassigned'
    settings.idle_timeout_minutes = '10'
    capture(sourceFile, [0, 5, 20, 25])
    await sessionService.rebuildSessionsFromRaw()
    const client = clientProjectService.createClient({ name: 'Default client' })
    const project = clientProjectService.createProject({
      name: 'Default project',
      clientId: client.id,
      directoryPath: 'C:\\fixture'
    })
    const chosenClientId = clientOnly
      ? clientProjectService.createClient({ name: 'Chosen client' }).id
      : null
    const rows = sessionService.getAllSessions()
    sessionService.updateSession(rows[0].id, { projectId: project.id, clientId: client.id })
    sessionService.updateSession(rows[1].id, { projectId: null, clientId: chosenClientId })
    settings.idle_timeout_minutes = '30'
    await sessionService.rebuildSessionsFromRaw()
    let review = sessionService.getReconciliationCases()[0]
    sessionService.replaceSavedHistory(sourceFile, review.fingerprint!, [
      { detectedIndex: 0, sessionId: rows[1].id }
    ])
    const chosen = { projectId: null, clientId: chosenClientId }
    const serialized = sqlite.serialize()
    sqlite.close()
    sqlite = new Database(serialized)
    db = drizzle(sqlite)
    capture(sourceFile, [30])
    capture('/review/new-attribution', [60, 65])
    await sessionService.rebuildSessionsFromRaw()
    const fresh = sessionService.getAllSessions().find((row) => row.sourceFile !== sourceFile)!
    sessionService.updateSession(fresh.id, {
      description: 'Description edits still allow attribution'
    })
    expect(clientProjectService.attributeSessions()).toBe(1)
    expect(sessionService.getSessionById(fresh.id)).toMatchObject({
      projectId: project.id,
      clientId: client.id
    })
    expect(
      sessionService.getAllSessions().find((row) => row.sourceFile === sourceFile)
    ).toMatchObject(chosen)
    settings.idle_timeout_minutes = '10'
    await sessionService.rebuildSessionsFromRaw()
    review = sessionService.getReconciliationCases()[0]
    sessionService.replaceSavedHistory(sourceFile, review.fingerprint!)
    expect(clientProjectService.attributeSessions()).toBe(0)
    const children = sessionService.getAllSessions().filter((row) => row.sourceFile === sourceFile)
    expect(children).toHaveLength(2)
    for (const child of children) expect(child).toMatchObject(chosen)
    sessionService.splitSession(children[0].id, '2026-03-04T10:02:00Z')
    expect(clientProjectService.attributeSessions()).toBe(0)
    for (const child of sessionService
      .getAllSessions()
      .filter((row) => row.sourceFile === sourceFile))
      expect(child).toMatchObject(chosen)
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  }
)

it('resolves conflicting replacement values only with an explicit overlapping saved session choice', async () => {
  const sourceFile = '/review/replace-choice'
  settings.idle_timeout_minutes = '10'
  capture(sourceFile, [0, 5, 20, 25])
  await sessionService.rebuildSessionsFromRaw()
  const client = clientProjectService.createClient({ name: 'Original', billableRate: 60 })
  const other = clientProjectService.createClient({ name: 'Chosen', billableRate: 60 })
  const rows = sessionService.getAllSessions()
  sessionService.updateSession(rows[0].id, { clientId: client.id, description: 'First choice' })
  sessionService.updateSession(rows[1].id, { clientId: other.id, description: 'Chosen values' })
  invoice(client.id, rows[0].id)
  const saved = db.select().from(sessions).all()
  const lines = db.select().from(invoiceLineItems).all()
  settings.idle_timeout_minutes = '30'
  await sessionService.rebuildSessionsFromRaw()
  const review = sessionService.getReconciliationCases()[0]
  expect(review.detected[0]).toMatchObject({
    replacementCandidates: rows.map((row) => row.id),
    requiresReplacementChoice: true
  })
  expect(review.saved[1]).toMatchObject({ description: 'Chosen values', billable: true })
  expect(() => sessionService.replaceSavedHistory(sourceFile, review.fingerprint!)).toThrow(
    'Choose'
  )
  const choices = [{ detectedIndex: 0, sessionId: rows[1].id }]
  sessionService.replaceSavedHistory(sourceFile, review.fingerprint!, choices)
  const merged = sessionService.getAllSessions()[0]
  expect(merged).toMatchObject({
    clientId: other.id,
    description: 'Chosen values',
    durationMinutes: 25
  })
  expect(db.select().from(sessions).all().slice(0, 2)).toEqual(saved)
  expect(db.select().from(invoiceLineItems).all()).toEqual(lines)
  expect(db.select().from(sessionReconciliationResolutions).get()?.comparison).toMatchObject({
    choices
  })
  expect(db.select().from(sessionReplacements).all()).toHaveLength(2)
  expect(
    (await invoiceService.generateLineItems(other.id, '2026-03-01', '2026-03-10')).lineItems.reduce(
      (sum, line) => sum + line.amountCents,
      0
    )
  ).toBe(2000)
  const serialized = sqlite.serialize()
  sqlite.close()
  sqlite = new Database(serialized)
  db = drizzle(sqlite)
  capture(sourceFile, [30])
  expect((await sessionService.rebuildSessionsFromRaw()).errors).toBeUndefined()
  expect(sessionService.getAllSessions()[0]).toMatchObject({
    id: merged.id,
    clientId: other.id,
    description: 'Chosen values',
    durationMinutes: 30
  })
})

it.each(['unrelated', 'duplicate', 'index', 'missing', 'stale', 'malformed'] as const)(
  'rejects %s replacement choices without changing saved history',
  async (reason) => {
    const sourceFile = '/review/replace-invalid-choice'
    settings.idle_timeout_minutes = '10'
    capture(sourceFile, [0, 5, 20, 25, 90, 95])
    await sessionService.rebuildSessionsFromRaw()
    const rows = sessionService.getAllSessions()
    sessionService.updateSession(rows[0].id, { description: 'Different' })
    settings.idle_timeout_minutes = '30'
    await sessionService.rebuildSessionsFromRaw()
    const review = sessionService.getReconciliationCases()[0]
    let choices = [{ detectedIndex: 0, sessionId: rows[1].id }]
    if (reason === 'unrelated') choices[0].sessionId = rows[2].id
    if (reason === 'duplicate') choices.push(choices[0])
    if (reason === 'index') choices[0].detectedIndex = 5
    if (reason === 'missing') choices = []
    if (reason === 'malformed') choices = [null] as never
    if (reason === 'stale') sessionService.updateSession(rows[1].id, { description: 'Changed' })
    const saved = db.select().from(sessions).all()
    const revisions = db.select().from(sessionRevisions).all()
    expect(() =>
      sessionService.replaceSavedHistory(sourceFile, review.fingerprint!, choices)
    ).toThrow()
    expect(db.select().from(sessions).all()).toEqual(saved)
    expect(db.select().from(sessionRevisions).all()).toEqual(revisions)
    expect(db.select().from(sessionReplacements).all()).toEqual([])
    expect(db.select().from(sessionReconciliationResolutions).all()).toEqual([])
  }
)

it('carries the chosen project and non-billable values through IPC and rolls back a failed resolution', async () => {
  const sourceFile = '/review/replace-choice-ipc'
  settings.idle_timeout_minutes = '10'
  capture(sourceFile, [0, 5, 20, 25])
  await sessionService.rebuildSessionsFromRaw()
  const client = clientProjectService.createClient({ name: 'Chosen client' })
  const project = clientProjectService.createProject({
    name: 'Chosen project',
    clientId: client.id,
    directoryPath: 'C:\\chosen'
  })
  const rows = sessionService.getAllSessions()
  sessionService.updateSession(rows[1].id, {
    clientId: client.id,
    projectId: project.id,
    billable: false,
    description: null
  })
  settings.idle_timeout_minutes = '30'
  await sessionService.rebuildSessionsFromRaw()
  const review = sessionService.getReconciliationCases()[0]
  const choices = [{ detectedIndex: 0, sessionId: rows[1].id }]
  const saved = db.select().from(sessions).all()
  const revisions = db.select().from(sessionRevisions).all()
  registerSessionHandlers()
  const handler = vi
    .mocked(ipcMain.handle)
    .mock.calls.find(([name]) => name === 'session:replaceSavedHistory')![1]
  sqlite.exec(
    "CREATE TRIGGER reject_choice BEFORE INSERT ON session_reconciliation_resolutions BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END"
  )
  expect(await handler({} as never, sourceFile, review.fingerprint, choices)).toMatchObject({
    success: false
  })
  expect(db.select().from(sessions).all()).toEqual(saved)
  expect(db.select().from(sessionRevisions).all()).toEqual(revisions)
  expect(db.select().from(sessionReplacements).all()).toEqual([])
  expect(sessionService.getReconciliationCases()).toEqual([review])
  sqlite.exec('DROP TRIGGER reject_choice')
  expect(await handler({} as never, sourceFile, review.fingerprint, choices)).toMatchObject({
    success: true
  })
  expect(sessionService.getAllSessions()).toEqual([
    expect.objectContaining({
      projectId: project.id,
      clientId: client.id,
      billable: 0,
      description: null
    })
  ])
  expect((await sessionService.rebuildSessionsFromRaw()).errors).toBeUndefined()
  expect(sessionService.getAllSessions()[0].billable).toBe(0)
  expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
})

it.each(['explicit', 'inferred', 'caught up', 'changed anchor', 'end only'] as const)(
  'preserves %s time edits on a one-to-one successor while replacing other intervals',
  async (kind) => {
    const sourceFile = '/review/replace-with-time-edits'
    settings.idle_timeout_minutes = '30'
    capture(sourceFile, [0, 5, 20, 25, 90, 95])
    await sessionService.rebuildSessionsFromRaw()
    const original = sessionService
      .getAllSessions()
      .find((row) => row.startedAt === '2026-03-04T11:30:00.000Z')!
    const client = clientProjectService.createClient({ name: 'Edited work', billableRate: 60 })
    sessionService.updateSession(original.id, { clientId: client.id, description: 'Saved edit' })
    const edits =
      kind === 'end only'
        ? { endedAt: '2026-03-04T11:36:00.000Z' }
        : { startedAt: '2026-03-04T11:28:00.000Z', durationMinutes: 12 }
    if (kind === 'inferred') {
      db.update(sessions).set(edits).where(eq(sessions.id, original.id)).run()
    } else {
      sessionService.updateSession(original.id, edits)
      if (kind === 'caught up')
        sessionService.updateSession(original.id, {
          startedAt: original.startedAt,
          durationMinutes: original.durationMinutes
        })
    }
    invoice(client.id, original.id)
    const invoiceSnapshot = db.select().from(invoiceLineItems).all()
    const saved = sessionService.getSessionById(original.id)!
    capture(sourceFile, kind === 'changed anchor' ? [89, 100] : [100])
    settings.idle_timeout_minutes = '10'
    await sessionService.rebuildSessionsFromRaw()
    const review = sessionService.getReconciliationCases()[0]
    sessionService.replaceSavedHistory(sourceFile, review.fingerprint!)
    const successor = sessionService.getAllSessions().find((row) => row.clientId === client.id)!
    expect(successor).toMatchObject({
      startedAt: saved.startedAt,
      endedAt: kind === 'end only' ? saved.endedAt : '2026-03-04T11:40:00.000Z',
      durationMinutes: kind === 'end only' ? 10 : saved.durationMinutes,
      description: 'Saved edit'
    })
    expect(successor.id === original.id).toBe(kind !== 'changed anchor')
    expect(
      db
        .select()
        .from(sessionTimeOverrides)
        .where(eq(sessionTimeOverrides.sessionId, successor.id))
        .get()
    ).toMatchObject(
      kind === 'end only'
        ? { startedAt: 0, endedAt: 1, durationMinutes: 0 }
        : { startedAt: 1, endedAt: 0, durationMinutes: 1 }
    )
    expect(
      db
        .select()
        .from(sessionDerivations)
        .where(eq(sessionDerivations.sessionId, successor.id))
        .get()
    ).toMatchObject({
      startedAt: kind === 'changed anchor' ? '2026-03-04T11:29:00.000Z' : original.startedAt,
      durationMinutes: kind === 'changed anchor' ? 11 : 10
    })
    expect(sessionService.getAllSessions()).toHaveLength(3)
    expect(db.select().from(invoiceLineItems).all()).toEqual(invoiceSnapshot)
    expect(sessionService.getReconciliationCases()).toEqual([])
    const serialized = sqlite.serialize()
    sqlite.close()
    sqlite = new Database(serialized)
    db = drizzle(sqlite)
    capture(sourceFile, [105])
    expect((await sessionService.rebuildSessionsFromRaw()).errors).toBeUndefined()
    expect(sessionService.getSessionById(successor.id)).toMatchObject({
      startedAt: saved.startedAt,
      endedAt: kind === 'end only' ? saved.endedAt : '2026-03-04T11:45:00.000Z',
      durationMinutes: kind === 'end only' ? 15 : saved.durationMinutes
    })
    expect(db.select().from(invoiceLineItems).all()).toEqual(invoiceSnapshot)
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  }
)

it.each(['ambiguous split', 'invalid bounds', 'rollback'] as const)(
  'retains edited replacement history on %s',
  async (reason) => {
    const sourceFile = '/review/replace-time-guard'
    settings.idle_timeout_minutes = '30'
    capture(sourceFile, [0, 5, 20, 25, 90, 95])
    await sessionService.rebuildSessionsFromRaw()
    const rows = sessionService
      .getAllSessions()
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    sessionService.updateSession(
      reason === 'ambiguous split' ? rows[0].id : rows[1].id,
      reason === 'invalid bounds'
        ? { startedAt: '2026-03-04T11:33:00.000Z' }
        : { durationMinutes: 12 }
    )
    if (reason === 'invalid bounds') {
      db.delete(rawMessages)
        .where(eq(rawMessages.uuid, `${sourceFile}-95`))
        .run()
      capture(sourceFile, [92])
    }
    settings.idle_timeout_minutes = '10'
    await sessionService.rebuildSessionsFromRaw()
    const review = sessionService.getReconciliationCases()[0]
    const before = {
      sessions: db.select().from(sessions).all(),
      baselines: db.select().from(sessionDerivations).all(),
      overrides: db.select().from(sessionTimeOverrides).all(),
      revisions: db.select().from(sessionRevisions).all()
    }
    if (reason === 'rollback')
      sqlite.exec(
        "CREATE TRIGGER reject_edited_replacement BEFORE INSERT ON session_reconciliation_resolutions BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END"
      )
    expect(() => sessionService.replaceSavedHistory(sourceFile, review.fingerprint!)).toThrow(
      reason === 'rollback'
        ? 'fixture rollback'
        : reason === 'invalid bounds'
          ? 'time range'
          : 'Edited times'
    )
    expect(db.select().from(sessions).all()).toEqual(before.sessions)
    expect(db.select().from(sessionDerivations).all()).toEqual(before.baselines)
    expect(db.select().from(sessionTimeOverrides).all()).toEqual(before.overrides)
    expect(db.select().from(sessionRevisions).all()).toEqual(before.revisions)
    expect(db.select().from(sessionReplacements).all()).toEqual([])
    expect(sessionService.getReconciliationCases()).toEqual([review])
  }
)

it.each(['time edit', 'assignment', 'legacy', 'stale', 'busy'] as const)(
  'retains history when replacement encounters %s',
  async (reason) => {
    const sourceFile = '/review/replace-guard'
    settings.idle_timeout_minutes = '10'
    capture(sourceFile, [0, 5, 20, 25])
    await sessionService.rebuildSessionsFromRaw()
    const rows = sessionService.getAllSessions()
    if (reason === 'time edit') {
      sessionService.updateSession(rows[0].id, { durationMinutes: rows[0].durationMinutes + 1 })
      sessionService.updateSession(rows[0].id, { durationMinutes: rows[0].durationMinutes })
    }
    if (reason === 'assignment')
      sessionService.updateSession(rows[0].id, { description: 'Different' })
    if (reason === 'legacy') db.delete(sessionDerivations).run()
    settings.idle_timeout_minutes = '30'
    await sessionService.rebuildSessionsFromRaw()
    const review = sessionService.getReconciliationCases()[0]
    if (reason === 'stale')
      sessionService.updateSession(rows[0].id, { description: 'Changed after comparison' })
    const saved = db.select().from(sessions).all()
    if (reason === 'busy') sessionService._scanInProgress = true
    try {
      expect(() => sessionService.replaceSavedHistory(sourceFile, review.fingerprint!)).toThrow()
      if (reason !== 'assignment')
        expect(() =>
          sessionService.replaceSavedHistory(sourceFile, review.fingerprint!, [
            { detectedIndex: 0, sessionId: rows[0].id }
          ])
        ).toThrow()
    } finally {
      sessionService._scanInProgress = false
    }
    expect(db.select().from(sessions).all()).toEqual(saved)
    expect(db.select().from(sessionReconciliationResolutions).all()).toEqual([])
    expect(sessionService.getReconciliationCases()).toHaveLength(1)
  }
)

it.each(['session_reconciliation_resolutions', 'session_replacements'])(
  'rolls back replacement rows and audit revisions if recording %s fails',
  async (table) => {
    const sourceFile = '/review/replace-rollback'
    capture(sourceFile, [0, 5, 10])
    await sessionService.rebuildSessionsFromRaw()
    const saved = db.select().from(sessions).all()
    settings.idle_timeout_minutes = '3'
    await sessionService.rebuildSessionsFromRaw()
    const review = sessionService.getReconciliationCases()[0]
    sqlite.exec(
      `CREATE TRIGGER reject_replacement BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END`
    )
    expect(() => sessionService.replaceSavedHistory(sourceFile, review.fingerprint!)).toThrow(
      'fixture rollback'
    )
    expect(db.select().from(sessions).all()).toEqual(saved)
    expect(db.select().from(sessionRevisions).all()).toEqual([])
    expect(db.select().from(sessionReplacements).all()).toEqual([])
    expect(sessionService.getReconciliationCases()).toEqual([review])
  }
)

it.each([false, true])(
  'keeps other copies pending after source-less adoption (copy discovered later: %s)',
  async (later) => {
    const first = '/review/adopted-first'
    const second = '/review/adopted-copy'
    const row = db
      .insert(sessions)
      .values({
        sourceFile: null,
        claudeSessionId: first,
        projectPath: 'C:\\fixture',
        startedAt: '2026-03-04T10:00:00.000Z',
        endedAt: '2026-03-04T10:10:00.000Z',
        durationMinutes: 10
      })
      .returning()
      .get()
    capture(first, [0, 10])
    const copy = () => {
      capture(second, [0, 10])
      db.update(rawMessages)
        .set({ claudeSessionId: first })
        .where(eq(rawMessages.sourceFile, second))
        .run()
    }
    if (!later) copy()
    expect((await sessionService.rebuildSessionsFromRaw()).errors).toHaveLength(later ? 1 : 2)
    const review = sessionService
      .getReconciliationCases()
      .find((item) => item.sourceFile === first)!
    sessionService.mapSavedHistory(first, review.fingerprint!, [
      { sessionId: row.id, detectedIndex: 0 }
    ])
    if (later) copy()
    expect((await sessionService.rebuildSessionsFromRaw()).errors).toHaveLength(1)
    expect(sessionService.getAllSessions()).toHaveLength(1)
    const pending = sessionService.getReconciliationCases()[0]
    expect(pending).toMatchObject({
      sourceFile: second,
      saved: [expect.objectContaining({ id: row.id, sourceFile: first })]
    })
    expect(() =>
      sessionService.mapSavedHistory(second, pending.fingerprint!, [
        { sessionId: row.id, detectedIndex: 0 }
      ])
    ).toThrow()
    expect(() => sessionService.replaceSavedHistory(second, pending.fingerprint!)).toThrow()
    sessionService.keepSavedHistory(second, pending.fingerprint!)
    expect((await sessionService.rebuildSessionsFromRaw()).errors).toBeUndefined()
    const serialized = sqlite.serialize()
    sqlite.close()
    sqlite = new Database(serialized)
    db = drizzle(sqlite)
    capture(first, [15])
    await sessionService.rebuildSessionsFromRaw()
    expect(sessionService.getReconciliationCases()).toHaveLength(1)
    expect(sessionService.getAllSessions()).toEqual([
      expect.objectContaining({ id: row.id, sourceFile: first, promptCount: 3 })
    ])
    sessionService.deleteSession(row.id)
    await sessionService.rebuildSessionsFromRaw()
    expect(sessionService.getAllSessions()).toEqual([])
    expect(sessionService.getReconciliationCases().some((item) => item.sourceFile === second)).toBe(
      true
    )
  }
)

it.each(['split', 'replacement'] as const)(
  'tracks adopted legacy descendants through %s in pending reviews and keep decisions',
  async (kind) => {
    const first = '/review/adopted-lineage'
    const copy = '/review/adopted-lineage-copy'
    const oldClient = clientProjectService.createClient({ name: 'Original', billableRate: 60 })
    const newClient = clientProjectService.createClient({ name: 'Reassigned', billableRate: 60 })
    const otherClient = clientProjectService.createClient({ name: 'Unrelated', billableRate: 60 })
    const project = clientProjectService.createProject({
      name: 'Reassigned project',
      clientId: newClient.id,
      directoryPath: 'C:\\reassigned'
    })
    const row = db
      .insert(sessions)
      .values({
        sourceFile: null,
        claudeSessionId: first,
        projectPath: 'C:\\fixture',
        clientId: oldClient.id,
        status: 'completed',
        startedAt: '2026-03-04T10:00:00.000Z',
        endedAt: '2026-03-04T10:25:00.000Z',
        durationMinutes: 25
      })
      .returning()
      .get()
    settings.idle_timeout_minutes = '30'
    capture(first, [0, 5, 20, 25])
    capture(copy, [0, 5, 20, 25])
    db.update(rawMessages)
      .set({ claudeSessionId: first })
      .where(eq(rawMessages.sourceFile, copy))
      .run()
    await sessionService.rebuildSessionsFromRaw()
    const adoption = sessionService
      .getReconciliationCases()
      .find((item) => item.sourceFile === first)!
    sessionService.mapSavedHistory(first, adoption.fingerprint!, [
      { sessionId: row.id, detectedIndex: 0 }
    ])
    if (kind === 'replacement') {
      settings.idle_timeout_minutes = '10'
      await sessionService.rebuildSessionsFromRaw()
      const replacement = sessionService
        .getReconciliationCases()
        .find((item) => item.sourceFile === first)!
      sessionService.replaceSavedHistory(first, replacement.fingerprint!)
    } else {
      sessionService.splitSession(row.id, '2026-03-04T10:10:00.000Z')
    }
    const child = sessionService.getAllSessions().find((item) => item.startedAt === row.startedAt)!
    const grandchildren = sessionService.splitSession(child.id, '2026-03-04T10:02:00.000Z')
    const leaf = grandchildren[0]
    sessionService.updateSession(leaf.id, {
      clientId: newClient.id,
      projectId: project.id,
      startedAt: '2026-03-20T10:00:00.000Z',
      endedAt: '2026-03-20T10:02:00.000Z'
    })
    await expect(
      invoiceService.generateLineItems(newClient.id, '2026-03-20', '2026-03-20', project.id)
    ).rejects.toThrow('Review unresolved history')
    await expect(
      invoiceService.generateLineItems(oldClient.id, '2026-03-04', '2026-03-04')
    ).rejects.toThrow('Review unresolved history')
    expect(
      (await invoiceService.generateLineItems(otherClient.id, '2026-03-01', '2026-03-31')).lineItems
    ).toEqual([])
    expect(
      (await invoiceService.generateLineItems(newClient.id, '2026-04-01', '2026-04-30')).lineItems
    ).toEqual([])
    await sessionService.recheckReconciliation(copy)
    let review = sessionService.getReconciliationCases().find((item) => item.sourceFile === copy)!
    expect(review.saved).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: leaf.id, clientId: newClient.id })])
    )
    sessionService.updateSession(leaf.id, { description: 'Changed since comparison' })
    expect(() => sessionService.keepSavedHistory(copy, review.fingerprint!)).toThrow(
      'comparison changed'
    )
    await sessionService.recheckReconciliation(copy)
    review = sessionService.getReconciliationCases().find((item) => item.sourceFile === copy)!
    sessionService.keepSavedHistory(copy, review.fingerprint!)
    expect(sessionService.getReconciliationCases()).toEqual([])
    const serialized = sqlite.serialize()
    sqlite.close()
    sqlite = new Database(serialized)
    db = drizzle(sqlite)
    sessionService.updateSession(leaf.id, { description: 'Changed after restart' })
    expect(sessionService.getReconciliationCases()).toEqual([
      expect.objectContaining({ sourceFile: copy })
    ])
    sessionService.deleteSession(leaf.id)
    await expect(
      invoiceService.generateLineItems(newClient.id, '2026-03-20', '2026-03-20', project.id)
    ).rejects.toThrow('Review unresolved history')
  }
)

it.each([null, ''])(
  'blocks reassigned source-less candidates using their current client, project and dates (path %s)',
  async (sourceFile) => {
    const returning = '/review/invoice-unlinked'
    const oldClient = clientProjectService.createClient({ name: 'Original', billableRate: 60 })
    const newClient = clientProjectService.createClient({ name: 'Reassigned', billableRate: 60 })
    const otherClient = clientProjectService.createClient({ name: 'Unrelated', billableRate: 60 })
    const project = clientProjectService.createProject({
      name: 'Reassigned project',
      clientId: newClient.id,
      directoryPath: 'C:\\new-project'
    })
    const row = db
      .insert(sessions)
      .values({
        sourceFile,
        claudeSessionId: returning,
        projectPath: 'C:\\fixture',
        clientId: oldClient.id,
        startedAt: '2026-03-04T10:00:00.000Z',
        endedAt: '2026-03-04T10:10:00.000Z',
        durationMinutes: 10
      })
      .returning()
      .get()
    capture(returning, [0, 10])
    await sessionService.rebuildSessionsFromRaw()
    sessionService.updateSession(row.id, {
      clientId: newClient.id,
      projectId: project.id,
      startedAt: '2026-03-20T10:00:00Z',
      endedAt: '2026-03-20T10:10:00Z'
    })
    await expect(
      invoiceService.generateLineItems(newClient.id, '2026-03-20', '2026-03-20', project.id)
    ).rejects.toThrow('Review unresolved history')
    await expect(
      invoiceService.generateLineItems(oldClient.id, '2026-03-04', '2026-03-04')
    ).rejects.toThrow('Review unresolved history')
    expect(
      (await invoiceService.generateLineItems(otherClient.id, '2026-03-01', '2026-03-31')).lineItems
    ).toEqual([])
    expect(
      (await invoiceService.generateLineItems(newClient.id, '2026-04-01', '2026-04-30')).lineItems
    ).toEqual([])
    sessionService.deleteSession(row.id)
    await expect(
      invoiceService.generateLineItems(newClient.id, '2026-03-20', '2026-03-20', project.id)
    ).rejects.toThrow('Review unresolved history')
  }
)

it.each([null, ''])(
  'holds source-less legacy history for explicit adoption (path %s)',
  async (sourceFile) => {
    const returning = '/review/legacy-returned'
    const client = clientProjectService.createClient({ name: 'Legacy', billableRate: 60 })
    const defaultClient = clientProjectService.createClient({ name: 'Default' })
    clientProjectService.createProject({
      name: 'Default',
      clientId: defaultClient.id,
      directoryPath: 'C:\\fixture'
    })
    const row = db
      .insert(sessions)
      .values({
        sourceFile,
        claudeSessionId: returning,
        projectPath: 'C:\\fixture',
        clientId: client.id,
        startedAt: '2026-03-04T09:55:00.000Z',
        endedAt: '2026-03-04T10:10:00.000Z',
        durationMinutes: 37,
        inputTokens: 1000,
        description: 'Saved legacy edit'
      })
      .returning()
      .get()
    db.insert(sessionModelUsage)
      .values({ sessionId: row.id, model: 'legacy-model', inputTokens: 1000 })
      .run()
    retainLegacySession(db, row)
    invoice(client.id, row.id)
    const lines = db.select().from(invoiceLineItems).all()
    capture(returning, [0, 10])
    capture('/review/unrelated-returned', [60, 65])
    expect((await sessionService.rebuildSessionsFromRaw()).errors).toHaveLength(1)
    expect(sessionService.getAllSessions()).toHaveLength(2)
    expect(sessionService.getSessionById(row.id)).toEqual(row)
    const review = sessionService.getReconciliationCases()[0]
    expect(review.saved).toEqual([
      expect.objectContaining({ id: row.id, sourceFile, disposition: 'active' })
    ])
    await expect(
      invoiceService.generateLineItems(client.id, '2026-03-01', '2026-03-10')
    ).rejects.toThrow()
    expect(() => sessionService.replaceSavedHistory(returning, review.fingerprint!)).toThrow()
    sessionService.mapSavedHistory(returning, review.fingerprint!, [
      { sessionId: row.id, detectedIndex: 0 }
    ])
    expect(sessionService.getSessionById(row.id)).toMatchObject({
      id: row.id,
      sourceFile: returning,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      durationMinutes: 37,
      description: row.description,
      inputTokens: 0,
      promptCount: 2,
      clientId: client.id
    })
    expect(db.select().from(sessionLegacyRecords).get()).toMatchObject({
      session: row,
      modelUsage: [expect.objectContaining({ inputTokens: 1000 })]
    })
    expect(sessionService.getReconciliationCases()).toEqual([])
    expect(db.select().from(invoiceLineItems).all()).toEqual(lines)
    expect(
      (await invoiceService.generateLineItems(client.id, '2026-03-01', '2026-03-10')).lineItems
    ).toEqual([])
    const serialized = sqlite.serialize()
    sqlite.close()
    sqlite = new Database(serialized)
    db = drizzle(sqlite)
    capture(returning, [15])
    expect((await sessionService.rebuildSessionsFromRaw()).errors).toBeUndefined()
    clientProjectService.attributeSessions()
    expect(sessionService.getSessionById(row.id)).toMatchObject({
      sourceFile: returning,
      projectId: null,
      clientId: client.id,
      durationMinutes: 37,
      startedAt: row.startedAt,
      endedAt: '2026-03-04T10:15:00.000Z',
      promptCount: 3
    })
    expect(sessionService.getAllSessions()).toHaveLength(2)
    expect(
      (await sessionService.getPromptTimings(row.id)).map((timing) => timing.promptAt)
    ).toHaveLength(3)
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  }
)

it.each(['split', 'deleted', 'stale', 'rollback'] as const)(
  'retains source-less history when adoption encounters %s',
  async (reason) => {
    const sourceFile = '/review/legacy-adoption-guard'
    const row = db
      .insert(sessions)
      .values({
        sourceFile: null,
        claudeSessionId: sourceFile,
        projectPath: 'C:\\fixture',
        startedAt: '2026-03-04T10:00:00.000Z',
        endedAt: '2026-03-04T10:10:00.000Z',
        durationMinutes: 10,
        inputTokens: 1000
      })
      .returning()
      .get()
    if (reason === 'split') sessionService.splitSession(row.id, '2026-03-04T10:05:00.000Z')
    if (reason === 'deleted') sessionService.deleteSession(row.id)
    settings.idle_timeout_minutes = reason === 'split' ? '5' : '30'
    capture(sourceFile, [0, 2, 8, 10])
    await sessionService.rebuildSessionsFromRaw()
    const review = sessionService.getReconciliationCases()[0]
    expect(review).toBeDefined()
    if (reason === 'stale')
      sessionService.updateSession(row.id, { description: 'Changed since comparison' })
    if (reason === 'rollback')
      sqlite.exec(
        "CREATE TRIGGER reject_adoption BEFORE INSERT ON session_reconciliation_resolutions BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END"
      )
    const before = db.select().from(sessions).all()
    const baselines = db.select().from(sessionDerivations).all()
    const snapshots = db.select().from(sessionLegacyRecords).all()
    const revisions = db.select().from(sessionRevisions).all()
    const active = sessionService.getAllSessions()
    const mappings = active.map((saved, detectedIndex) => ({ sessionId: saved.id, detectedIndex }))
    expect(() =>
      sessionService.mapSavedHistory(sourceFile, review.fingerprint!, mappings)
    ).toThrow()
    expect(db.select().from(sessions).all()).toEqual(before)
    expect(db.select().from(sessionDerivations).all()).toEqual(baselines)
    expect(db.select().from(sessionLegacyRecords).all()).toEqual(snapshots)
    expect(db.select().from(sessionRevisions).all()).toEqual(revisions)
    expect(db.select().from(sessionReconciliationResolutions).all()).toEqual([])
  }
)

it('only proposes source-less adoption for the same provider and known conversation', async () => {
  const sourceFile = '/review/legacy-identity'
  for (const identity of [
    { tool: 'codex' as const, claudeSessionId: sourceFile },
    { tool: 'claude' as const, claudeSessionId: 'unrelated' }
  ])
    db.insert(sessions)
      .values({
        ...identity,
        sourceFile: null,
        projectPath: 'C:\\fixture',
        startedAt: '2026-03-04T10:00:00.000Z',
        endedAt: '2026-03-04T10:10:00.000Z',
        durationMinutes: 10
      })
      .run()
  capture(sourceFile, [0, 10])
  expect((await sessionService.rebuildSessionsFromRaw()).errors).toBeUndefined()
  expect(sessionService.getAllSessions()).toHaveLength(3)
  expect(sessionService.getReconciliationCases()).toEqual([])
})

it('invalidates a kept comparison when another source-less candidate is discovered', async () => {
  const sourceFile = '/review/legacy-kept'
  const legacy = {
    sourceFile: null,
    claudeSessionId: sourceFile,
    projectPath: 'C:\\fixture',
    startedAt: '2026-03-04T10:00:00.000Z',
    endedAt: '2026-03-04T10:10:00.000Z',
    durationMinutes: 10
  }
  db.insert(sessions).values(legacy).run()
  capture(sourceFile, [0, 10])
  await sessionService.rebuildSessionsFromRaw()
  const review = sessionService.getReconciliationCases()[0]
  sessionService.keepSavedHistory(sourceFile, review.fingerprint!)
  expect((await sessionService.rebuildSessionsFromRaw()).errors).toBeUndefined()
  expect(sessionService.getAllSessions()).toHaveLength(1)
  db.insert(sessions).values(legacy).run()
  const reopened = sessionService.getReconciliationCases()[0]
  expect(reopened.saved).toHaveLength(2)
  expect(reopened.fingerprint).not.toBe(review.fingerprint)
  expect(sessionService.getAllSessions()).toHaveLength(2)
})

it('explicitly maps retained legacy activity while preserving saved edits, IDs and invoice snapshots', async () => {
  const client = clientProjectService.createClient({ name: 'Mapping', billableRate: 60 })
  const sourceFile = '/review/map-legacy'
  capture(sourceFile, [0, 10])
  db.insert(rawMessages)
    .values({
      sourceFile,
      uuid: 'mapped-usage',
      claudeSessionId: sourceFile,
      type: 'assistant',
      timestamp: '2026-03-04T10:05:00Z',
      model: 'detected-model',
      inputTokens: 101,
      outputTokens: 59,
      cacheCreationInputTokens: 7,
      cacheReadInputTokens: 13
    })
    .run()
  const row = db
    .insert(sessions)
    .values({
      sourceFile,
      claudeSessionId: sourceFile,
      projectPath: 'C:\\fixture',
      clientId: client.id,
      startedAt: '2026-03-04T09:55:00.000Z',
      endedAt: '2026-03-04T10:10:00.000Z',
      durationMinutes: 37,
      inputTokens: 1000,
      description: 'Keep this edit'
    })
    .returning()
    .get()
  db.insert(sessionModelUsage).values({ sessionId: row.id, model: 'old', inputTokens: 1000 }).run()
  invoice(client.id, row.id)
  const invoiceRows = db.select().from(invoiceLineItems).all()
  await sessionService.rebuildSessionsFromRaw()
  const review = sessionService.getReconciliationCases()[0]
  sessionService.mapSavedHistory(sourceFile, review.fingerprint!, [
    { sessionId: row.id, detectedIndex: 0 }
  ])
  expect(sessionService.getReconciliationCases()).toEqual([])
  expect(sessionService.getSessionById(row.id)).toMatchObject({
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    durationMinutes: 37,
    description: 'Keep this edit',
    clientId: client.id,
    inputTokens: 101,
    outputTokens: 59,
    promptCount: 2,
    createdAt: row.createdAt
  })
  expect(db.select().from(sessionLegacyRecords).get()?.session).toEqual(row)
  expect(db.select().from(sessionLegacyRecords).get()?.modelUsage[0].inputTokens).toBe(1000)
  expect(sessionService.getModelUsage()).toEqual([
    expect.objectContaining({
      model: 'detected-model',
      inputTokens: 101,
      outputTokens: 59,
      cacheCreationInputTokens: 7,
      cacheReadInputTokens: 13
    })
  ])
  expect(db.select().from(sessionReconciliationResolutions).get()).toMatchObject({
    action: 'map_saved',
    comparison: { mappings: [{ sessionId: row.id, detectedIndex: 0 }] }
  })
  expect(db.select().from(sessionRevisions).get()?.kind).toBe('reconcile')
  expect(db.select().from(invoiceLineItems).all()).toEqual(invoiceRows)
  expect(
    (await invoiceService.generateLineItems(client.id, '2026-03-01', '2026-03-10')).lineItems
  ).toEqual([])
  capture(sourceFile, [20])
  expect((await sessionService.rebuildSessionsFromRaw()).errors).toBeUndefined()
  expect(sessionService.getSessionById(row.id)).toMatchObject({
    durationMinutes: 37,
    startedAt: row.startedAt,
    endedAt: '2026-03-04T10:20:00.000Z',
    promptCount: 3
  })
})

it('rejects stale or incomplete mappings without changing any saved history', async () => {
  const sourceFile = '/review/map-stale'
  capture(sourceFile, [0, 10])
  const row = db
    .insert(sessions)
    .values({
      sourceFile,
      claudeSessionId: sourceFile,
      projectPath: 'C:\\fixture',
      startedAt: '2026-03-04T09:55:00Z',
      endedAt: '2026-03-04T10:10:00Z',
      durationMinutes: 15
    })
    .returning()
    .get()
  await sessionService.rebuildSessionsFromRaw()
  const review = sessionService.getReconciliationCases()[0]
  const before = db.select().from(sessions).all()
  for (const mapping of [
    [],
    [{ sessionId: row.id, detectedIndex: -1 }],
    [{ sessionId: row.id, detectedIndex: 1 }],
    [{ sessionId: row.id + 100, detectedIndex: 0 }],
    [
      { sessionId: row.id, detectedIndex: 0 },
      { sessionId: row.id, detectedIndex: 0 }
    ]
  ]) {
    expect(() => sessionService.mapSavedHistory(sourceFile, review.fingerprint!, mapping)).toThrow()
  }
  expect(db.select().from(sessions).all()).toEqual(before)
  expect(db.select().from(sessionRevisions).all()).toEqual([])
  sessionService.updateSession(row.id, { description: 'Changed after preview' })
  expect(() =>
    sessionService.mapSavedHistory(sourceFile, review.fingerprint!, [
      { sessionId: row.id, detectedIndex: 0 }
    ])
  ).toThrow('comparison changed')
  expect(db.select().from(sessionReconciliationResolutions).all()).toEqual([])
})

it('rolls back mapped measurements, snapshots and revisions if the resolution cannot commit', async () => {
  const sourceFile = '/review/map-rollback'
  capture(sourceFile, [0, 10])
  const row = db
    .insert(sessions)
    .values({
      sourceFile,
      claudeSessionId: sourceFile,
      projectPath: 'C:\\fixture',
      startedAt: '2026-03-04T09:55:00Z',
      endedAt: '2026-03-04T10:10:00Z',
      durationMinutes: 15
    })
    .returning()
    .get()
  await sessionService.rebuildSessionsFromRaw()
  const review = sessionService.getReconciliationCases()[0]
  const mapping = [{ sessionId: row.id, detectedIndex: 0 }]
  sessionService._scanInProgress = true
  try {
    expect(() => sessionService.mapSavedHistory(sourceFile, review.fingerprint!, mapping)).toThrow(
      'scan is running'
    )
  } finally {
    sessionService._scanInProgress = false
  }
  sqlite.exec(
    "CREATE TRIGGER reject_mapping BEFORE INSERT ON session_reconciliation_resolutions BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END"
  )
  expect(() => sessionService.mapSavedHistory(sourceFile, review.fingerprint!, mapping)).toThrow(
    'fixture rollback'
  )
  expect(sessionService.getSessionById(row.id)).toEqual(row)
  expect(db.select().from(sessionLegacyRecords).all()).toEqual([])
  expect(db.select().from(sessionDerivations).all()).toEqual([])
  expect(db.select().from(sessionRevisions).all()).toEqual([])
  expect(sessionService.getReconciliationCases()).toEqual([review])
})

it('records the selected permutation after a keep decision and resumes scans across restart', async () => {
  const sourceFile = '/review/map-pairs'
  capture(sourceFile, [0, 10, 40, 50])
  const rows = [0, 30].map((minute) =>
    db
      .insert(sessions)
      .values({
        sourceFile,
        claudeSessionId: sourceFile,
        projectPath: 'C:\\fixture',
        startedAt: new Date(Date.UTC(2026, 2, 4, 9, minute)).toISOString(),
        endedAt: new Date(Date.UTC(2026, 2, 4, 9, minute + 10)).toISOString(),
        durationMinutes: 10
      })
      .returning()
      .get()
  )
  await sessionService.rebuildSessionsFromRaw()
  const old = sessionService.getReconciliationCases()[0]
  sessionService.keepSavedHistory(sourceFile, old.fingerprint!)
  const kept = db.select().from(sessionReconciliationResolutions).get()!
  capture(sourceFile, [55])
  await sessionService.rebuildSessionsFromRaw()
  const review = sessionService.getReconciliationCases()[0]
  sessionService.mapSavedHistory(sourceFile, review.fingerprint!, [
    { sessionId: rows[0].id, detectedIndex: 1 },
    { sessionId: rows[1].id, detectedIndex: 0 }
  ])
  expect(sessionService.getSessionById(rows[0].id)?.promptCount).toBe(3)
  expect(sessionService.getSessionById(rows[1].id)?.promptCount).toBe(2)
  expect(db.select().from(sessionReconciliationResolutions).all()[1]).toMatchObject({
    action: 'map_saved',
    parentId: kept.id,
    sequence: 2
  })
  const serialized = sqlite.serialize()
  sqlite.close()
  sqlite = new Database(serialized)
  db = drizzle(sqlite)
  expect(sessionService.getReconciliationCases()).toEqual([])
  capture(sourceFile, [58])
  expect((await sessionService.rebuildSessionsFromRaw()).errors).toBeUndefined()
  expect(sessionService.getSessionById(rows[0].id)?.promptCount).toBe(4)
  expect(sessionService.getSessionById(rows[1].id)?.promptCount).toBe(2)
  settings.idle_timeout_minutes = '5'
  expect((await sessionService.rebuildSessionsFromRaw()).errors).toHaveLength(1)
})

it.each(['split', 'deleted', 'provider', 'conversation'] as const)(
  'does not map across %s boundaries',
  async (boundary) => {
    const sourceFile = '/review/map-boundary'
    capture(sourceFile, [0, 10])
    const row = db
      .insert(sessions)
      .values({
        sourceFile,
        claudeSessionId: boundary === 'conversation' ? 'different' : sourceFile,
        tool: boundary === 'provider' ? 'codex' : 'claude',
        projectPath: 'C:\\fixture',
        startedAt: '2026-03-04T09:55:00Z',
        endedAt: '2026-03-04T10:10:00Z',
        durationMinutes: 15
      })
      .returning()
      .get()
    if (boundary === 'split') sessionService.splitSession(row.id, '2026-03-04T10:00:00Z')
    if (boundary === 'deleted') sessionService.deleteSession(row.id)
    await sessionService.rebuildSessionsFromRaw()
    const review = sessionService.getReconciliationCases()[0]
    const saved = db.select().from(sessions).all()
    const revisions = db.select().from(sessionRevisions).all()
    expect(() =>
      sessionService.mapSavedHistory(sourceFile, review.fingerprint!, [
        { sessionId: row.id, detectedIndex: 0 }
      ])
    ).toThrow()
    expect(() => sessionService.replaceSavedHistory(sourceFile, review.fingerprint!)).toThrow()
    expect(db.select().from(sessions).all()).toEqual(saved)
    expect(db.select().from(sessionRevisions).all()).toEqual(revisions)
    expect(db.select().from(sessionReconciliationResolutions).all()).toEqual([])
  }
)

it('blocks invoicing edited kept history without needing a source file or full rebuild', async () => {
  const client = clientProjectService.createClient({ name: 'Review fixture', billableRate: 100 })
  capture('/review/missing-source', [0, 10])
  await sessionService.rebuildSessionsFromRaw()
  const row = sessionService.getAllSessions()[0]
  sessionService.updateSession(row.id, { clientId: client.id })
  settings.idle_timeout_minutes = '5'
  await sessionService.rebuildSessionsFromRaw()
  const review = sessionService.getReconciliationCases()[0]
  sessionService.keepSavedHistory(review.sourceFile, review.fingerprint!)
  const decision = db.select().from(sessionReconciliationResolutions).get()
  sessionService.updateSession(row.id, { durationMinutes: 120, endedAt: '2026-03-04T12:00:00Z' })
  await expect(
    invoiceService.generateLineItems(client.id, '2026-03-01', '2026-03-10')
  ).rejects.toMatchObject({ code: 'SESSION_RECONCILIATION_REQUIRED' })
  expect((await sessionService.scanSessions()).errors).toHaveLength(1)
  const updated = sessionService.getReconciliationCases()[0]
  expect(updated.saved[0].durationMinutes).toBe(120)
  expect(updated.fingerprint).not.toBe(review.fingerprint)
  expect(db.select().from(sessionReconciliationResolutions).all()).toEqual([decision])
  sessionService.keepSavedHistory(updated.sourceFile, updated.fingerprint!)
  expect(
    (await invoiceService.generateLineItems(client.id, '2026-03-01', '2026-03-10')).lineItems[0]
      .amountCents
  ).toBe(20000)
})

it.each(['review list', 'ordinary scan'] as const)(
  'revalidates a policy change through %s without discovering source files',
  async (entry) => {
    capture('/review/changed-policy', [0, 10])
    await sessionService.rebuildSessionsFromRaw()
    settings.idle_timeout_minutes = '5'
    await sessionService.rebuildSessionsFromRaw()
    const review = sessionService.getReconciliationCases()[0]
    sessionService.keepSavedHistory(review.sourceFile, review.fingerprint!)
    const accepted = db.select().from(sessionReconciliationResolutions).all()
    const saved = db.select().from(sessions).all()
    expect(sessionService.getReconciliationCases()).toEqual([])
    settings.idle_timeout_minutes = '15'
    if (entry === 'ordinary scan')
      expect((await sessionService.scanSessions()).errors).toHaveLength(1)
    const reopened = sessionService.getReconciliationCases()
    expect(reopened).toHaveLength(1)
    expect(reopened[0].idleTimeoutMinutes).toBe(15)
    expect(reopened[0].fingerprint).not.toBe(review.fingerprint)
    expect(db.select().from(sessions).all()).toEqual(saved)
    expect(db.select().from(sessionReconciliationResolutions).all()).toEqual(accepted)
  }
)

it('revalidates bulk project reassignment before billing while leaving unrelated clients eligible', async () => {
  const oldClient = clientProjectService.createClient({ name: 'Old', billableRate: 100 })
  const newClient = clientProjectService.createClient({ name: 'New', billableRate: 100 })
  const unrelated = clientProjectService.createClient({ name: 'Unrelated', billableRate: 100 })
  const project = clientProjectService.createProject({
    name: 'Fixture',
    clientId: oldClient.id,
    directoryPath: 'C:\\fixture'
  })
  capture('/review/reassigned', [0, 10])
  await sessionService.rebuildSessionsFromRaw()
  const row = sessionService.getAllSessions()[0]
  sessionService.updateSession(row.id, { clientId: oldClient.id, projectId: project.id })
  settings.idle_timeout_minutes = '5'
  await sessionService.rebuildSessionsFromRaw()
  const review = sessionService.getReconciliationCases()[0]
  sessionService.keepSavedHistory(review.sourceFile, review.fingerprint!)
  clientProjectService.updateProject(project.id, { clientId: newClient.id })
  const other = manual()
  sessionService.updateSession(other.id, { clientId: unrelated.id })
  await expect(
    invoiceService.generateLineItems(newClient.id, '2026-03-01', '2026-03-10')
  ).rejects.toMatchObject({ code: 'SESSION_RECONCILIATION_REQUIRED' })
  expect(
    (await invoiceService.generateLineItems(unrelated.id, '2026-03-01', '2026-03-10')).lineItems
  ).toHaveLength(1)
})

it('records a keep-saved decision without replacing legacy totals, then reopens review for new activity', async () => {
  capture('/review/legacy-keep', [0, 10])
  db.insert(sessions)
    .values({
      sourceFile: '/review/legacy-keep',
      claudeSessionId: '/review/legacy-keep',
      projectPath: 'C:\\fixture',
      startedAt: '2026-03-04T10:00:00Z',
      endedAt: '2026-03-04T10:10:00Z',
      durationMinutes: 10,
      inputTokens: 1000
    })
    .run()
  const saved = sessionService.getAllSessions()
  await sessionService.rebuildSessionsFromRaw()
  const review = sessionService.getReconciliationCases()[0]
  sessionService.keepSavedHistory(review.sourceFile, review.fingerprint!)
  sessionService.keepSavedHistory(review.sourceFile, review.fingerprint!)
  const decision = db.select().from(sessionReconciliationResolutions).get()!
  expect(decision).toMatchObject({
    sequence: 1,
    parentId: null,
    action: 'keep_saved',
    comparison: { fingerprint: review.fingerprint }
  })
  expect(db.select().from(sessionReconciliationResolutions).all()).toHaveLength(1)
  expect(sessionService.getReconciliationCases()).toEqual([])
  expect((await sessionService.rebuildSessionsFromRaw()).errors).toBeUndefined()
  expect(sessionService.getAllSessions()).toEqual(saved)
  capture('/review/legacy-keep', [20])
  expect((await sessionService.rebuildSessionsFromRaw()).errors).toHaveLength(1)
  expect(sessionService.getAllSessions()).toEqual(saved)
  const changed = sessionService.getReconciliationCases()[0]
  sessionService.keepSavedHistory(changed.sourceFile, changed.fingerprint!)
  expect(db.select().from(sessionReconciliationResolutions).all()).toEqual([
    decision,
    expect.objectContaining({ sequence: 2, parentId: decision.id })
  ])
})

it('rejects stale approvals after edits, policy changes or changed facts even with identical detector totals', async () => {
  capture('/review/stale', [0, 10])
  await sessionService.rebuildSessionsFromRaw()
  settings.idle_timeout_minutes = '5'
  await sessionService.rebuildSessionsFromRaw()
  let review = sessionService.getReconciliationCases()[0]
  const row = sessionService.getAllSessions()[0]
  sessionService.updateSession(row.id, { description: 'Changed after preview' })
  expect(() => sessionService.keepSavedHistory(review.sourceFile, review.fingerprint!)).toThrow(
    'comparison changed'
  )
  await sessionService.recheckReconciliation(review.sourceFile)
  review = sessionService.getReconciliationCases()[0]
  db.update(rawMessages)
    .set({ uuid: 'replacement-event-id' })
    .where(eq(rawMessages.uuid, '/review/stale-0'))
    .run()
  expect(() => sessionService.keepSavedHistory(review.sourceFile, review.fingerprint!)).toThrow(
    'comparison changed'
  )
  await sessionService.recheckReconciliation(review.sourceFile)
  review = sessionService.getReconciliationCases()[0]
  settings.idle_timeout_minutes = '15'
  expect(() => sessionService.keepSavedHistory(review.sourceFile, review.fingerprint!)).toThrow(
    'comparison changed'
  )
  expect(db.select().from(sessionReconciliationResolutions).all()).toEqual([])
  expect(sessionService.getReconciliationCases()).toHaveLength(1)
})

it('does not silently replace kept history when a later policy would permit ordinary reconciliation', async () => {
  capture('/review/keep-policy', [0, 10])
  await sessionService.rebuildSessionsFromRaw()
  const saved = sessionService.getAllSessions()
  settings.idle_timeout_minutes = '5'
  await sessionService.rebuildSessionsFromRaw()
  const review = sessionService.getReconciliationCases()[0]
  sessionService.keepSavedHistory(review.sourceFile, review.fingerprint!)
  settings.idle_timeout_minutes = '15'
  expect((await sessionService.rebuildSessionsFromRaw()).errors).toHaveLength(1)
  expect(sessionService.getAllSessions()).toEqual(saved)
})

it('preserves saved invoices and billed exclusions after keeping a comparison with an explicit split', async () => {
  const client = clientProjectService.createClient({ name: 'Fixture', billableRate: 100 })
  capture('/review/invoiced', [0, 10])
  await sessionService.rebuildSessionsFromRaw()
  const original = sessionService.getAllSessions()[0]
  sessionService.updateSession(original.id, { clientId: client.id })
  invoice(client.id, original.id)
  const [first] = sessionService.splitSession(original.id, '2026-03-04T10:05:00Z')
  sessionService.deleteSession(first.id)
  const saved = db.select().from(sessions).all()
  const lines = db.select().from(invoiceLineItems).all()
  const refs = db.select().from(sessionBillingRefs).all()
  settings.idle_timeout_minutes = '5'
  await sessionService.rebuildSessionsFromRaw()
  const review = sessionService.getReconciliationCases()[0]
  sessionService.keepSavedHistory(review.sourceFile, review.fingerprint!)
  expect((await sessionService.rebuildSessionsFromRaw()).errors).toBeUndefined()
  expect(db.select().from(sessions).all()).toEqual(saved)
  expect(db.select().from(invoiceLineItems).all()).toEqual(lines)
  expect(db.select().from(sessionBillingRefs).all()).toEqual(refs)
  expect(sessionService.getAllSessions()).toHaveLength(1)
  expect(
    (await invoiceService.generateLineItems(client.id, '2026-03-01', '2026-03-10')).lineItems
  ).toEqual([])
})

it('upgrades pending comparisons without fabricating an approval fingerprint', async () => {
  capture('/review/upgrade', [0, 10])
  await sessionService.rebuildSessionsFromRaw()
  settings.idle_timeout_minutes = '5'
  await sessionService.rebuildSessionsFromRaw()
  const review = sessionService.getReconciliationCases()[0]
  sqlite.exec(
    'DROP TABLE session_reconciliation_resolutions; ALTER TABLE session_reconciliation_cases DROP COLUMN fingerprint'
  )
  sqlite.exec('ALTER TABLE session_splits DROP COLUMN legacy_record_id')
  sqlite.exec(
    'ALTER TABLE session_deletions DROP COLUMN legacy_record_id; DROP TABLE session_legacy_records'
  )
  sqlite.exec('DROP TABLE session_replacements')
  sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at >= ?').run(1789603200002)
  sqlite.exec('ALTER TABLE session_billing_refs DROP COLUMN billed_ranges')
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  expect(sessionService.getReconciliationCases()[0]).toMatchObject({
    sourceFile: review.sourceFile,
    fingerprint: null,
    saved: review.saved
  })
  expect(() => sessionService.keepSavedHistory(review.sourceFile, review.fingerprint!)).toThrow(
    'no longer pending'
  )
  await sessionService.recheckReconciliation(review.sourceFile)
  const refreshed = sessionService.getReconciliationCases()[0]
  sessionService.keepSavedHistory(refreshed.sourceFile, refreshed.fingerprint!)
  expect(sessionService.getReconciliationCases()).toEqual([])
})

it('rolls back the decision when resolving the queue fails and rejects approval during a scan', async () => {
  capture('/review/atomic', [0, 10])
  await sessionService.rebuildSessionsFromRaw()
  settings.idle_timeout_minutes = '5'
  await sessionService.rebuildSessionsFromRaw()
  const review = sessionService.getReconciliationCases()[0]
  sessionService._scanInProgress = true
  try {
    expect(() => sessionService.keepSavedHistory(review.sourceFile, review.fingerprint!)).toThrow(
      'scan is running'
    )
  } finally {
    sessionService._scanInProgress = false
  }
  sqlite.exec(
    "CREATE TRIGGER fixture_fail_resolution BEFORE UPDATE OF resolved_at ON session_reconciliation_cases BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END"
  )
  expect(() => sessionService.keepSavedHistory(review.sourceFile, review.fingerprint!)).toThrow(
    'fixture rollback'
  )
  expect(db.select().from(sessionReconciliationResolutions).all()).toEqual([])
  expect(sessionService.getReconciliationCases()).toEqual([review])
})

it('blocks invoice previews for unresolved work, including deletion boundaries, without blocking other clients or dates', async () => {
  const affected = clientProjectService.createClient({ name: 'Affected', billableRate: 100 })
  const healthy = clientProjectService.createClient({ name: 'Healthy', billableRate: 100 })
  capture('/review/boundary', [0, 10])
  await sessionService.rebuildSessionsFromRaw()
  const row = sessionService.getAllSessions()[0]
  sessionService.updateSession(row.id, { clientId: affected.id })
  sessionService.deleteSession(row.id)
  capture('/review/boundary', [20])
  await sessionService.rebuildSessionsFromRaw()
  expect(sessionService.getReconciliationCases()[0].saved[0].disposition).toBe('deleted')
  const other = manual()
  sessionService.updateSession(other.id, { clientId: healthy.id })
  await expect(
    invoiceService.generateLineItems(affected.id, '2026-03-01', '2026-03-10')
  ).rejects.toMatchObject({ code: 'SESSION_RECONCILIATION_REQUIRED' })
  expect(
    (await invoiceService.generateLineItems(healthy.id, '2026-03-01', '2026-03-10')).lineItems
  ).toHaveLength(1)
  expect(
    (await invoiceService.generateLineItems(affected.id, '2026-04-01', '2026-04-10')).lineItems
  ).toEqual([])
})

it('allows another project for the same client and restores invoice preview after successful reconciliation', async () => {
  const client = clientProjectService.createClient({ name: 'Fixture', billableRate: 100 })
  const affected = clientProjectService.createProject({
    clientId: client.id,
    name: 'Affected',
    directoryPath: 'C:\\affected'
  })
  const other = clientProjectService.createProject({
    clientId: client.id,
    name: 'Other',
    directoryPath: 'C:\\other'
  })
  capture('/review/policy', [0, 10])
  await sessionService.rebuildSessionsFromRaw()
  const row = sessionService.getAllSessions()[0]
  sessionService.updateSession(row.id, { clientId: client.id, projectId: affected.id })
  const manualRow = manual()
  sessionService.updateSession(manualRow.id, { clientId: client.id, projectId: other.id })
  settings.idle_timeout_minutes = '5'
  await sessionService.rebuildSessionsFromRaw()
  await expect(
    invoiceService.generateLineItems(client.id, '2026-03-01', '2026-03-10', affected.id)
  ).rejects.toMatchObject({ code: 'SESSION_RECONCILIATION_REQUIRED' })
  expect(
    (await invoiceService.generateLineItems(client.id, '2026-03-01', '2026-03-10', other.id))
      .lineItems[0].sessionIds
  ).toEqual([manualRow.id])
  settings.idle_timeout_minutes = '15'
  await sessionService.recheckReconciliation('/review/policy')
  expect(
    (await invoiceService.generateLineItems(client.id, '2026-03-01', '2026-03-10', affected.id))
      .lineItems[0].sessionIds
  ).toEqual([row.id])
})

it('keeps saved sessions in review when retained messages produce no detected intervals', async () => {
  capture('/review/noise', [0])
  db.update(rawMessages).set({ type: 'assistant' }).run()
  db.insert(sessions)
    .values({
      sourceFile: '/review/noise',
      claudeSessionId: '/review/noise',
      projectPath: 'C:\\fixture',
      startedAt: '2026-03-04T10:00:00Z',
      endedAt: '2026-03-04T10:05:00Z',
      durationMinutes: 5,
      inputTokens: 1000
    })
    .run()
  const saved = sessionService.getAllSessions()
  await sessionService.rebuildSessionsFromRaw()
  expect(sessionService.getReconciliationCases()[0]).toMatchObject({
    sourceFile: '/review/noise',
    detected: []
  })
  expect((await sessionService.recheckReconciliation('/review/noise')).errors).toHaveLength(1)
  expect(sessionService.getAllSessions()).toEqual(saved)
})

it('rechecks only the requested source and retains unresolved reviews when activity is unavailable or a scan is busy', async () => {
  capture('/review/one', [0, 10])
  capture('/review/two', [0, 10])
  await sessionService.rebuildSessionsFromRaw()
  settings.idle_timeout_minutes = '5'
  await sessionService.rebuildSessionsFromRaw()
  expect(sessionService.getReconciliationCases()).toHaveLength(2)
  sessionService._scanInProgress = true
  try {
    await expect(sessionService.recheckReconciliation('/review/one')).rejects.toThrow(
      'scan is running'
    )
  } finally {
    sessionService._scanInProgress = false
  }
  settings.idle_timeout_minutes = '15'
  await sessionService.recheckReconciliation('/review/one')
  expect(sessionService.getReconciliationCases().map((row) => row.sourceFile)).toEqual([
    '/review/two'
  ])
  expect(
    db
      .select()
      .from(sessionReconciliationCases)
      .where(eq(sessionReconciliationCases.sourceFile, '/review/one'))
      .get()?.resolvedAt
  ).toBeTruthy()
  // Simulate a legacy store with no usable facts, not a production cleanup path.
  db.delete(rawMessages).where(eq(rawMessages.sourceFile, '/review/two')).run()
  await expect(sessionService.recheckReconciliation('/review/two')).rejects.toThrow(
    'No retained activity'
  )
  expect(sessionService.getReconciliationCases()).toHaveLength(1)
})

it('refuses reset before any writes when only a reconciliation case protects legacy history', async () => {
  capture('/review/legacy', [0, 10])
  await sessionService.rebuildSessionsFromRaw()
  settings.idle_timeout_minutes = '5'
  await sessionService.rebuildSessionsFromRaw()
  const saved = sessionService.getAllSessions()
  const reviews = sessionService.getReconciliationCases()
  registerSessionHandlers()
  const handler = vi
    .mocked(ipcMain.handle)
    .mock.calls.find(([channel]) => channel === 'session:reset')![1]
  expect(await handler({} as never)).toMatchObject({ success: false })
  expect(sessionService.getAllSessions()).toEqual(saved)
  expect(sessionService.getReconciliationCases()).toEqual(reviews)
})

it('keeps nested manual split predecessors as audit rows and conserves edited time and every token category', () => {
  const row = manual(37)
  db.update(sessions)
    .set({ tool: 'codex', billable: 0, promptCount: 11, inputTokens: 101, outputTokens: 59 })
    .where(eq(sessions.id, row.id))
    .run()
  db.insert(sessionModelUsage)
    .values({
      sessionId: row.id,
      model: 'fixture',
      inputTokens: 101,
      outputTokens: 59,
      cacheReadInputTokens: 13,
      cacheCreationInputTokens: 7
    })
    .run()
  const original = sessionService.getSessionById(row.id)!
  db.insert(aiSummaries).values({ sessionId: row.id, summary: 'Original summary' }).run()
  db.insert(gitCommits)
    .values({
      sessionId: row.id,
      hash: 'fixture',
      message: 'Saved commit',
      authorName: 'Fixture',
      authorEmail: 'fixture@example.invalid',
      committedAt: row.endedAt
    })
    .run()
  const [first, second] = sessionService.splitSession(row.id, '2026-03-04T10:20:00Z')
  sessionService.splitSession(second.id, '2026-03-04T10:40:00Z')
  const active = sessionService.getAllSessions()
  expect(active).toHaveLength(3)
  expect(
    active.every((s) => s.tool === 'codex' && s.billable === 0 && s.description === 'Saved work')
  ).toBe(true)
  for (const key of ['durationMinutes', 'promptCount', 'inputTokens', 'outputTokens'] as const)
    expect(active.reduce((sum, s) => sum + s[key], 0)).toBe(original[key])
  expect(sessionService.getModelUsage()).toEqual([
    expect.objectContaining({
      inputTokens: 101,
      outputTokens: 59,
      cacheReadInputTokens: 13,
      cacheCreationInputTokens: 7,
      sessionCount: 3
    })
  ])
  expect(db.select().from(sessions).where(eq(sessions.id, row.id)).get()).toEqual(original)
  expect(sessionService.getSessionById(row.id)).toBeNull()
  expect(db.select().from(aiSummaries).get()?.sessionId).toBe(row.id)
  gitService.correlateCommitsWithSessions()
  expect(db.select().from(gitCommits).get()?.sessionId).toBe(row.id)
  const report = reportService.generateReport(
    { startDate: '2026-03-04T00:00:00Z', endDate: '2026-03-05T00:00:00Z' },
    'session-breakdown'
  )
  expect(report.sessionBreakdown?.reduce((sum, s) => sum + s.durationMinutes, 0)).toBe(37)
  expect(report.summary.totalDurationMinutes).toBe(60) // Existing wall-clock summary policy.
  expect(report.summary.totalSessions).toBe(3)
  expect(() => sessionService.deleteSession(row.id)).toThrow('audit history')
  expect(sessionService.getSessionById(first.id)).not.toBeNull()
})

it('records causal edit and split revisions, ignores no-ops, and inherits a split revision when a child is edited', () => {
  const row = manual()
  sessionService.updateSession(row.id, { description: row.description })
  expect(db.select().from(sessionRevisions).all()).toHaveLength(0)
  sessionService.updateSession(row.id, { description: 'Changed', durationMinutes: 40 })
  sessionService.updateSession(row.id, { billable: false })
  const edits = db.select().from(sessionRevisions).all()
  expect(edits.map((r) => r.sequence)).toEqual([1, 2])
  expect(edits[1].parentRevisionId).toBe(edits[0].id)
  expect(JSON.parse(edits[0].before)).toEqual({ description: 'Saved work', durationMinutes: 60 })
  expect(JSON.parse(edits[0].after)).toEqual({ description: 'Changed', durationMinutes: 40 })
  const [first] = sessionService.splitSession(row.id, '2026-03-04T10:30:00Z')
  const split = db.select().from(sessionSplits).get()!
  const revision = db
    .select()
    .from(sessionRevisions)
    .where(eq(sessionRevisions.id, split.revisionId))
    .get()!
  expect(revision.parentRevisionId).toBe(edits[1].id)
  expect(revision).toMatchObject({
    kind: 'split',
    sequence: 3,
    startedAt: row.startedAt,
    endedAt: row.endedAt
  })
  sessionService.updateSession(first.id, { description: 'Only this part' })
  expect(
    db.select().from(sessionRevisions).where(eq(sessionRevisions.sessionId, first.id)).get()
      ?.parentRevisionId
  ).toBe(split.revisionId)
})

it('replays nested automatic splits, preserving child deletion and saved IDs', async () => {
  capture('split.jsonl', [0, 10, 20])
  await sessionService.rebuildSessionsFromRaw()
  const original = sessionService.getAllSessions()[0]
  const [first, second] = sessionService.splitSession(original.id, '2026-03-04T10:08:00Z')
  const [middle, last] = sessionService.splitSession(second.id, '2026-03-04T10:14:00Z')
  sessionService.deleteSession(middle.id)
  const expected = sessionService.getAllSessions()
  expect((await sessionService.rebuildSessionsFromRaw()).errors).toBeUndefined()
  expect(sessionService.getAllSessions()).toEqual(expected)
  expect(expected.map((s) => s.id)).toEqual([first.id, last.id])
  expect(db.select().from(sessions).all()).toHaveLength(5)
})

it('carries explicit parent time overrides into both children even when they equal the measurements', async () => {
  capture('split.jsonl', [0, 10, 20])
  await sessionService.rebuildSessionsFromRaw()
  const row = sessionService.getAllSessions()[0]
  sessionService.updateSession(row.id, { durationMinutes: 21 })
  sessionService.updateSession(row.id, { durationMinutes: 20 })
  sessionService.splitSession(row.id, '2026-03-04T10:10:00Z')
  capture('split.jsonl', [25])
  expect((await sessionService.rebuildSessionsFromRaw()).errors).toBeUndefined()
  expect(sessionService.getAllSessions().map((s) => s.durationMinutes)).toEqual([10, 10])
})

it('retains split history on an incompatible policy change while another source commits', async () => {
  capture('split.jsonl', [0, 8, 16])
  await sessionService.rebuildSessionsFromRaw()
  const original = sessionService.getAllSessions()[0]
  sessionService.splitSession(original.id, '2026-03-04T10:10:00Z')
  const before = db.select().from(sessions).all()
  settings.idle_timeout_minutes = '5'
  capture('healthy.jsonl', [30, 31])
  const result = await sessionService.rebuildSessionsFromRaw()
  expect(result.errors).toEqual([
    expect.objectContaining({
      sourceFile: 'split.jsonl',
      message: expect.stringContaining('explicit split')
    })
  ])
  expect(db.select().from(sessions).all().slice(0, before.length)).toEqual(before)
  expect(sessionService.getAllSessions().some((s) => s.sourceFile === 'healthy.jsonl')).toBe(true)
})

it('rejects invalid split timestamps without writing audit history', () => {
  const row = manual()
  const before = db.select().from(sessions).all()
  for (const split of ['not-a-date', row.startedAt, row.endedAt, '2026-03-04T09:00:00Z'])
    expect(() => sessionService.splitSession(row.id, split)).toThrow()
  expect(db.select().from(sessions).all()).toEqual(before)
  expect(db.select().from(sessionSplits).all()).toEqual([])
  expect(db.select().from(sessionRevisions).all()).toEqual([])
})

it.each(['/legacy/missing.jsonl', null])(
  'splits legacy snapshots without inventing activity, including missing source identity (%s)',
  async (sourceFile) => {
    const client = clientProjectService.createClient({ name: 'Legacy', billableRate: 60 })
    const row = manual(37)
    db.update(sessions)
      .set({
        source: 'auto',
        sourceFile,
        tool: 'codex',
        clientId: client.id,
        promptCount: 11,
        inputTokens: 101,
        outputTokens: 59
      })
      .where(eq(sessions.id, row.id))
      .run()
    db.insert(sessionModelUsage)
      .values({
        sessionId: row.id,
        model: 'legacy',
        inputTokens: 101,
        outputTokens: 59,
        cacheReadInputTokens: 13,
        cacheCreationInputTokens: 7
      })
      .run()
    const original = sessionService.getSessionById(row.id)!
    const invoiceId = invoice(client.id, row.id)
    const lines = db.select().from(invoiceLineItems).all()
    db.insert(aiSummaries).values({ sessionId: row.id, summary: 'Original summary' }).run()
    const [first, second] = sessionService.splitSession(row.id, '2026-03-04T10:20:00Z')
    sessionService.splitSession(second.id, '2026-03-04T10:40:00Z')
    const active = sessionService.getAllSessions()
    expect(active).toHaveLength(3)
    for (const key of ['durationMinutes', 'promptCount', 'inputTokens', 'outputTokens'] as const)
      expect(active.reduce((sum, item) => sum + item[key], 0)).toBe(original[key])
    expect(
      active.every(
        (item) =>
          item.source === 'auto' &&
          item.tool === 'codex' &&
          item.description === original.description &&
          item.clientId === client.id
      )
    ).toBe(true)
    expect(sessionService.getModelUsage()).toEqual([
      expect.objectContaining({
        inputTokens: 101,
        outputTokens: 59,
        cacheReadInputTokens: 13,
        cacheCreationInputTokens: 7
      })
    ])
    expect(db.select().from(sessions).where(eq(sessions.id, row.id)).get()).toEqual(original)
    expect(sessionService.getSessionById(row.id)).toBeNull()
    const snapshots = db.select().from(sessionLegacyRecords).all()
    expect(snapshots).toHaveLength(5)
    const originalSnapshot = snapshots.find((item) => item.sessionId === row.id)!
    expect(originalSnapshot.session).toEqual(original)
    for (const split of db.select().from(sessionSplits).all())
      expect(split).toMatchObject({
        legacyRecordId: snapshots.find((item) => item.sessionId === split.parentSessionId)!.id
      })
    expect(db.select().from(sessionDerivations).all()).toEqual([])
    expect(db.select().from(rawMessages).all()).toEqual([])
    sessionService.updateSession(first.id, { description: 'Edited legacy child' })
    expect(db.select().from(sessionLegacyRecords).all()).toEqual(snapshots)
    expect(db.select().from(invoiceLineItems).all()).toEqual(lines)
    invoiceService.deleteInvoice(invoiceId)
    expect(
      (await invoiceService.generateLineItems(client.id, '2026-03-01', '2026-03-10')).lineItems
    ).toEqual([])
    expect(db.select().from(aiSummaries).get()?.sessionId).toBe(row.id)
  }
)

it.each([0, 30])(
  'holds returned legacy activity for review even when its start matches the saved split (%i)',
  async (start) => {
    const row = manual(37)
    const sourceFile = '/legacy/returned'
    db.update(sessions)
      .set({ source: 'auto', sourceFile, claudeSessionId: sourceFile })
      .where(eq(sessions.id, row.id))
      .run()
    const children = sessionService.splitSession(row.id, '2026-03-04T10:30:00Z')
    const saved = db.select().from(sessions).all()
    capture(sourceFile, [start, start + 10])
    capture('/healthy', [0, 10])
    const result = await sessionService.rebuildSessionsFromRaw()
    expect(result.errors).toEqual([
      expect.objectContaining({ sourceFile, message: expect.stringContaining('legacy split') })
    ])
    expect(db.select().from(sessions).all().slice(0, saved.length)).toEqual(saved)
    expect(
      sessionService.getAllSessions().filter((item) => item.sourceFile === sourceFile)
    ).toEqual(children)
    expect(sessionService.getAllSessions().some((item) => item.sourceFile === '/healthy')).toBe(
      true
    )
    const review = sessionService.getReconciliationCases()[0]
    sessionService.keepSavedHistory(sourceFile, review.fingerprint!)
    expect((await sessionService.rebuildSessionsFromRaw()).errors).toBeUndefined()
    sessionService.deleteSession(children[0].id)
    expect(sessionService.getSessionById(children[0].id)).toBeNull()
    const reopened = sessionService.getReconciliationCases()[0]
    sessionService.keepSavedHistory(sourceFile, reopened.fingerprint!)
    capture(sourceFile, [start + 20])
    expect((await sessionService.rebuildSessionsFromRaw()).errors).toHaveLength(1)
    expect(
      sessionService.getAllSessions().filter((item) => item.sourceFile === sourceFile)
    ).toEqual([children[1]])
  }
)

it('rolls back legacy snapshots and child usage when a legacy split cannot commit', () => {
  const row = manual(37)
  db.update(sessions)
    .set({ source: 'auto', sourceFile: '/legacy/atomic' })
    .where(eq(sessions.id, row.id))
    .run()
  db.insert(sessionModelUsage)
    .values({ sessionId: row.id, model: 'legacy', inputTokens: 101 })
    .run()
  const saved = db.select().from(sessions).all()
  const usage = db.select().from(sessionModelUsage).all()
  sqlite.exec(
    "CREATE TRIGGER reject_legacy_split BEFORE INSERT ON session_splits BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END"
  )
  expect(() => sessionService.splitSession(row.id, '2026-03-04T10:30:00Z')).toThrow(
    'fixture rollback'
  )
  expect(db.select().from(sessions).all()).toEqual(saved)
  expect(db.select().from(sessionModelUsage).all()).toEqual(usage)
  expect(db.select().from(sessionLegacyRecords).all()).toEqual([])
  expect(db.select().from(sessionRevisions).all()).toEqual([])
  expect(db.select().from(sessionSplits).all()).toEqual([])
})

it('upgrades existing splits without inventing a legacy link, then reuses saved legacy snapshot identity', () => {
  const manualRow = manual()
  sessionService.splitSession(manualRow.id, '2026-03-04T10:30:00Z')
  const previousSplit = db.select().from(sessionSplits).get()!
  const row = manual(37)
  db.update(sessions)
    .set({ source: 'auto', sourceFile: '/legacy/upgraded' })
    .where(eq(sessions.id, row.id))
    .run()
  const original = sessionService.getSessionById(row.id)!
  const legacyId = retainLegacySession(db, original)
  const snapshot = db.select().from(sessionLegacyRecords).get()!
  sqlite.exec('ALTER TABLE session_splits DROP COLUMN legacy_record_id')
  sqlite.exec('DROP TABLE session_replacements')
  sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at >= ?').run(1789603200005)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  expect(db.select().from(sessionSplits).get()).toEqual(previousSplit)
  expect(db.select().from(sessionLegacyRecords).get()).toEqual(snapshot)
  sessionService.updateSession(row.id, {
    description: 'Edited since snapshot',
    durationMinutes: 40
  })
  const children = sessionService.splitSession(row.id, '2026-03-04T10:30:00Z')
  expect(children.every((child) => child.description === 'Edited since snapshot')).toBe(true)
  expect(children.reduce((sum, child) => sum + child.durationMinutes, 0)).toBe(40)
  expect(
    db.select().from(sessionSplits).where(eq(sessionSplits.parentSessionId, row.id)).get()
      ?.legacyRecordId
  ).toBe(legacyId)
  expect(
    db.select().from(sessionLegacyRecords).where(eq(sessionLegacyRecords.id, legacyId)).get()
  ).toEqual(snapshot)
  const revision = db
    .select()
    .from(sessionRevisions)
    .where(eq(sessionRevisions.sessionId, row.id))
    .all()
  expect(revision[1]).toMatchObject({
    kind: 'split',
    parentRevisionId: revision[0].id,
    startedAt: null,
    endedAt: null
  })
})

it('rolls back children, revisions and audit captures if recording a split fails', () => {
  const row = manual()
  sqlite.exec(
    "CREATE TRIGGER reject_split BEFORE INSERT ON session_splits BEGIN SELECT RAISE(ABORT, 'fixture failure'); END"
  )
  expect(() => sessionService.splitSession(row.id, '2026-03-04T10:30:00Z')).toThrow(
    'fixture failure'
  )
  expect(sessionService.getAllSessions()).toEqual([row])
  expect(db.select().from(sessionRevisions).all()).toEqual([])
  expect(db.select().from(sessionSplits).all()).toEqual([])
})

it('preserves invoice snapshots and excludes billed descendants after repeated splits and local invoice hiding', async () => {
  const client = clientProjectService.createClient({ name: 'Fixture', billableRate: 100 })
  const row = manual()
  sessionService.updateSession(row.id, { clientId: client.id })
  const invoiceId = invoice(client.id, row.id)
  const header = db.select().from(invoices).get()
  const lines = db.select().from(invoiceLineItems).all()
  const [first] = sessionService.splitSession(row.id, '2026-03-04T10:30:00Z')
  sessionService.splitSession(first.id, '2026-03-04T10:15:00Z')
  expect(db.select().from(invoices).get()).toEqual(header)
  expect(db.select().from(invoiceLineItems).all()).toEqual(lines)
  expect(
    (await invoiceService.generateLineItems(client.id, '2026-03-01', '2026-03-10')).lineItems
  ).toEqual([])
  invoiceService.deleteInvoice(invoiceId)
  expect(
    (await invoiceService.generateLineItems(client.id, '2026-03-01', '2026-03-10')).lineItems
  ).toEqual([])
  testMode = true
  expect(
    (await invoiceService.generateLineItems(client.id, '2026-03-01', '2026-03-10')).lineItems.length
  ).toBeGreaterThan(0)
})

it('billing one child excludes its descendants while leaving its unbilled sibling eligible', async () => {
  const client = clientProjectService.createClient({ name: 'Fixture', billableRate: 100 })
  const row = manual()
  sessionService.updateSession(row.id, { clientId: client.id })
  const [first, second] = sessionService.splitSession(row.id, '2026-03-04T10:30:00Z')
  invoice(client.id, first.id)
  sessionService.splitSession(first.id, '2026-03-04T10:15:00Z')
  const result = await invoiceService.generateLineItems(client.id, '2026-03-01', '2026-03-10')
  expect(result.lineItems).toHaveLength(1)
  expect(result.lineItems[0].sessionIds).toEqual([second.id])
  expect(result.lineItems[0].amountCents).toBe(5000)
})

it('migrates legacy comma-separated invoice links without rewriting saved history or accepting malformed IDs', () => {
  const client = clientProjectService.createClient({ name: 'Fixture' })
  const row = manual()
  const id = db
    .insert(invoices)
    .values({ clientId: client.id, stripeInvoiceId: 'in_old' })
    .returning()
    .get().id
  db.insert(invoiceLineItems)
    .values({
      invoiceId: id,
      description: 'Legacy',
      amountCents: 1234,
      sessionIds: `${row.id},invalid,999999,${row.id}tail,${row.id}, ,`
    })
    .run()
  const savedLines = db.select().from(invoiceLineItems).all()
  sqlite.exec(
    'DROP TABLE session_splits; DROP TABLE session_revisions; DROP TABLE session_billing_refs'
  )
  sqlite.exec('DROP TABLE session_reconciliation_cases')
  sqlite.exec('DROP TABLE session_reconciliation_resolutions')
  sqlite.exec(
    'ALTER TABLE session_deletions DROP COLUMN legacy_record_id; DROP TABLE session_legacy_records'
  )
  sqlite.exec('DROP TABLE session_replacements')
  sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at >= ?').run(1789603200000)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  expect(db.select().from(sessionBillingRefs).all()).toEqual([
    expect.objectContaining({ sessionId: row.id, stripeInvoiceId: 'in_old', testMode: 0 })
  ])
  expect(sessionService.getAllSessions()).toEqual([row])
  expect(db.select().from(invoiceLineItems).all()).toEqual(savedLines)
})

it('rejects reset before deleting summaries or history when revisions exist', async () => {
  const row = manual()
  sessionService.updateSession(row.id, { description: 'Keep this edit' })
  db.insert(aiSummaries).values({ sessionId: row.id, summary: 'Keep this summary' }).run()
  const before = db.select().from(sessions).all()
  registerSessionHandlers()
  const reset = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === 'session:reset')![1]
  expect(await reset({} as never)).toMatchObject({
    success: false,
    error: { message: expect.stringContaining('revisions') }
  })
  expect(db.select().from(sessions).all()).toEqual(before)
  expect(db.select().from(aiSummaries).all()).toHaveLength(1)
  expect(db.select().from(sessionRevisions).all()).toHaveLength(1)
})
it('newly appended work stays billable after invoicing the earlier interval', async () => {
  const client = clientProjectService.createClient({ name: 'Fixture', billableRate: 60 })
  capture('/review/growing', [0, 10])
  await sessionService.rebuildSessionsFromRaw()
  const row = sessionService.getAllSessions()[0]
  sessionService.updateSession(row.id, { clientId: client.id })
  const preview = await invoiceService.generateLineItems(client.id, '2026-03-01', '2026-03-10')
  // The source can grow while the user is reviewing the invoice.
  capture('/review/growing', [15])
  await sessionService.rebuildSessionsFromRaw()
  invoiceService.saveInvoice({
    clientId: client.id,
    stripeInvoiceId: 'in_growth',
    status: 'open',
    amountDueCents: 1000,
    amountPaidCents: 0,
    currency: 'usd',
    lineItems: preview.lineItems.map((line, sortOrder) => ({ ...line, sortOrder }))
  })
  capture('/review/growing', [20])
  expect((await sessionService.rebuildSessionsFromRaw()).errors).toBeUndefined()
  expect(sessionService.getSessionById(row.id)?.durationMinutes).toBe(20)
  const next = await invoiceService.generateLineItems(client.id, '2026-03-01', '2026-03-10')
  expect(next.lineItems.reduce((sum, line) => sum + line.amountCents, 0)).toBe(1000)
  expect(next.lineItems[0].billedRanges).toEqual([
    expect.objectContaining({
      startedAt: '2026-03-04T10:10:00.000Z',
      endedAt: '2026-03-04T10:20:00.000Z'
    })
  ])
  const secondInvoice = invoiceService.saveInvoice({
    clientId: client.id,
    stripeInvoiceId: 'in_growth_2',
    status: 'open',
    amountDueCents: 1000,
    amountPaidCents: 0,
    currency: 'usd',
    lineItems: next.lineItems.map((line, sortOrder) => ({ ...line, sortOrder }))
  })
  const frozen = db.select().from(sessionBillingRefs).all()
  invoiceService.deleteInvoice(secondInvoice)
  sessionService.splitSession(row.id, '2026-03-04T10:05:00Z')
  capture('/review/growing', [30])
  expect((await sessionService.rebuildSessionsFromRaw()).errors).toBeUndefined()
  const last = await invoiceService.generateLineItems(client.id, '2026-03-01', '2026-03-10')
  expect(last.lineItems.reduce((sum, line) => sum + line.amountCents, 0)).toBe(1000)
  expect(db.select().from(sessionBillingRefs).all()).toEqual(frozen)
})
it('later imported parallel work excludes the already invoiced overlap', async () => {
  const client = clientProjectService.createClient({ name: 'Fixture', billableRate: 60 })
  const project = clientProjectService.createProject({
    name: 'Fixture',
    directoryPath: 'C:\\fixture',
    clientId: client.id
  })
  sessionService.createSession({
    projectPath: 'C:\\fixture',
    clientId: client.id,
    projectId: project.id,
    startedAt: '2026-03-04T10:00:00Z',
    endedAt: '2026-03-04T11:00:00Z',
    durationMinutes: 60
  })
  const preview = await invoiceService.generateLineItems(client.id, '2026-03-01', '2026-03-10')
  invoiceService.saveInvoice({
    clientId: client.id,
    stripeInvoiceId: 'in_overlap',
    status: 'open',
    amountDueCents: 6000,
    amountPaidCents: 0,
    currency: 'usd',
    lineItems: preview.lineItems.map((line, sortOrder) => ({ ...line, sortOrder }))
  })
  sessionService.createSession({
    projectPath: 'C:\\fixture',
    clientId: client.id,
    projectId: project.id,
    startedAt: '2026-03-04T10:30:00Z',
    endedAt: '2026-03-04T11:30:00Z',
    durationMinutes: 60
  })
  const next = await invoiceService.generateLineItems(client.id, '2026-03-01', '2026-03-10')
  expect(next.lineItems.reduce((sum, line) => sum + line.amountCents, 0)).toBe(3000)
})

it('subtracts the union of billed ranges, leaving both gaps, without leaking across projects or modes', async () => {
  const client = clientProjectService.createClient({ name: 'Fixture', billableRate: 60 })
  const project = clientProjectService.createProject({
    name: 'One',
    directoryPath: 'C:\\one',
    clientId: client.id
  })
  const other = clientProjectService.createProject({
    name: 'Two',
    directoryPath: 'C:\\two',
    clientId: client.id
  })
  const row = sessionService.createSession({
    projectPath: 'C:\\one',
    clientId: client.id,
    projectId: project.id,
    startedAt: '2026-03-04T10:00:00Z',
    endedAt: '2026-03-04T11:00:00Z',
    durationMinutes: 60
  })
  const snapshot = (from: number, to: number) => ({
    sessionId: row.id,
    clientId: client.id,
    projectId: project.id,
    startedAt: new Date(Date.UTC(2026, 2, 4, 10, from)).toISOString(),
    endedAt: new Date(Date.UTC(2026, 2, 4, 10, to)).toISOString()
  })
  invoiceService.saveInvoice({
    clientId: client.id,
    stripeInvoiceId: 'in_partial',
    status: 'open',
    amountDueCents: 2000,
    amountPaidCents: 0,
    currency: 'usd',
    lineItems: [
      {
        description: 'Previously billed',
        amountCents: 2000,
        sessionIds: [row.id],
        billedRanges: [snapshot(10, 25), snapshot(20, 30)],
        sortOrder: 0
      }
    ]
  })
  const preview = await invoiceService.generateLineItems(client.id, '2026-03-01', '2026-03-10')
  expect(preview.lineItems[0]).toMatchObject({
    amountCents: 4000,
    durationMinutes: 40,
    sessionIds: [row.id]
  })
  expect(preview.lineItems[0].billedRanges).toEqual([snapshot(0, 10), snapshot(30, 60)])
  sessionService.createSession({
    projectPath: 'C:\\two',
    clientId: client.id,
    projectId: other.id,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    durationMinutes: 60
  })
  expect(
    (await invoiceService.generateLineItems(client.id, '2026-03-01', '2026-03-10', other.id))
      .lineItems[0].amountCents
  ).toBe(6000)
  testMode = true
  expect(
    (await invoiceService.generateLineItems(client.id, '2026-03-01', '2026-03-10', project.id))
      .lineItems[0].amountCents
  ).toBe(6000)
})

it('freezes legacy billing bounds once during migration and preserves them across database reopen', async () => {
  const client = clientProjectService.createClient({ name: 'Fixture', billableRate: 60 })
  capture('/review/migrate', [0, 10])
  await sessionService.rebuildSessionsFromRaw()
  const row = sessionService.getAllSessions()[0]
  sessionService.updateSession(row.id, { clientId: client.id })
  const localId = invoice(client.id, row.id)
  invoiceService.deleteInvoice(localId)
  sqlite.exec('ALTER TABLE session_billing_refs DROP COLUMN billed_ranges')
  sqlite.exec('ALTER TABLE session_splits DROP COLUMN legacy_record_id')
  sqlite.exec('DROP TABLE session_replacements')
  sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at >= ?').run(1789603200004)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  const frozen = db.select().from(sessionBillingRefs).all()
  const image = sqlite.serialize()
  sqlite.close()
  sqlite = new Database(image)
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  capture('/review/migrate', [20])
  await sessionService.rebuildSessionsFromRaw()
  expect(
    (await invoiceService.generateLineItems(client.id, '2026-03-01', '2026-03-10')).lineItems[0]
      .amountCents
  ).toBe(1000)
  expect(db.select().from(sessionBillingRefs).all()).toEqual(frozen)
})
