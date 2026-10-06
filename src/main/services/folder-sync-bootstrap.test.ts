// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { folderSyncAdapter } from './folder-sync-domains'
import {
  bootstrapFolderSync,
  bootstrapFolderSyncInSteps,
  probeSourceFile,
  type SourceFileProbe
} from './folder-sync-bootstrap'
import { folderSyncSettings, syncChanges } from '../db/schema/folder-sync'
import { activityIdentities, activityObservations } from '../db/schema/activity-evidence'
import { sourceMachines } from '../db/schema/activity-observers'
import { manualTimeEntries } from '../db/schema/manual-time-entries'
import { exportActivityPage } from './folder-sync-activity-export'
import { sessionActivityMappings } from '../db/schema/session-activity-mappings'
import { activityObservationId } from './folder-sync-activity-records'
import { canonicalJson } from './folder-sync-protocol'
import { readCanonicalActivity } from './canonical-activity'
import { journalSessionMutation } from './folder-sync-session-local'
import { projectSharedSessions } from './folder-sync-session-projection'
import { sessions } from '../db/schema/sessions'
import { sessionDerivations, sessionTimeOverrides } from '../db/schema/session-derivations'
import { sessionModelUsage } from '../db/schema/session-model-usage'
import { sessionLegacyRecords } from '../db/schema/session-legacy'
import { activeSessionCondition } from '../db/schema/session-deletions'
import { sessionRevisions, sessionSplits } from '../db/schema/session-history'
import { retainSourceLessSessionsForSync } from './folder-sync-legacy-records'
import {
  applyReadySyncBatches,
  assembleOutgoingBatch,
  retainIncomingBatch
} from './folder-sync-store'
import { adoptInitialWorkspacePolicy, previewLedgerWorkspacePolicy } from './workspace-policy'

// Pass-through spy: records which conversations each ledger read covered.
vi.mock('./canonical-activity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./canonical-activity')>()
  return { ...actual, readCanonicalActivity: vi.fn(actual.readCanonicalActivity) }
})
vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
vi.mock('./device-context', () => ({
  getLocalDeviceSession: () => ({
    deviceId: '9b95ec41-b3b6-4cbb-b1b6-e7ce607ef222',
    machineName: 'Fixture'
  })
}))

type Db = ReturnType<typeof drizzle>
const policy = {
  version: 1,
  normalizationVersion: 1,
  detectorVersion: 1,
  idleTimeoutMinutes: 15,
  reportingTimeZone: 'UTC'
}
const SECRET_LOG = 'C:/Users/fixture/.claude/projects/secret-project/deleted.jsonl'
const opened: Database.Database[] = []
const connections = new Map<Db, Database.Database>()
let workspaceId: string
let policySnapshot: { workspaceId: string; revisionId: string; policy: typeof policy }

function open(bytes?: Buffer): Db {
  const sqlite = new Database(bytes ?? ':memory:')
  sqlite.pragma('foreign_keys = ON')
  opened.push(sqlite)
  const db = drizzle(sqlite)
  connections.set(db, sqlite)
  if (bytes) return db
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  adoptInitialWorkspacePolicy(db, policySnapshot)
  db.insert(folderSyncSettings).values({ slot: 1, workspaceId, folderPath: 'C:/sync' }).run()
  return db
}
const clone = (db: Db): Db => open(connections.get(db)!.serialize())

beforeEach(() => {
  workspaceId = randomUUID()
  policySnapshot = { workspaceId: randomUUID(), revisionId: randomUUID(), policy }
})
afterEach(() => {
  while (opened.length) opened.pop()!.close()
  connections.clear()
})

function deliver(from: Db, to: Db): void {
  const batch = assembleOutgoingBatch(from, workspaceId, {
    writerEpochId: randomUUID(),
    deviceId: randomUUID()
  })
  if (!batch) throw new Error('Nothing to deliver')
  retainIncomingBatch(to, workspaceId, JSON.parse(JSON.stringify(batch)), folderSyncAdapter)
  const result = applyReadySyncBatches(to, workspaceId, folderSyncAdapter)
  expect(result.errors).toEqual([])
  expect(result.waiting).toEqual([])
}

const USAGE = [
  {
    model: 'claude-haiku',
    inputTokens: 300,
    outputTokens: 10,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 2
  },
  {
    model: 'claude-opus',
    inputTokens: 700,
    outputTokens: 90,
    cacheCreationInputTokens: 5,
    cacheReadInputTokens: 11
  }
]

/** A measured row saved before sync whose log was later deleted; its end time was edited here. */
function measuredRow(db: Db, values: Partial<typeof sessions.$inferInsert> = {}): number {
  const row = db
    .insert(sessions)
    .values({
      projectPath: 'C:/Users/fixture/secret-project',
      sourceFile: SECRET_LOG,
      tool: 'claude',
      claudeSessionId: 'conversation-deleted',
      startedAt: '2026-03-04T10:00:00.000Z',
      endedAt: '2026-03-04T11:10:00.000Z',
      durationMinutes: 70,
      promptCount: 12,
      inputTokens: 1000,
      outputTokens: 100,
      description: 'Saved before logs were deleted',
      billable: 1,
      ...values
    })
    .returning()
    .get()
  db.insert(sessionDerivations)
    .values({
      sessionId: row.id,
      startedAt: row.startedAt,
      endedAt: '2026-03-04T11:00:00.000Z',
      durationMinutes: 60
    })
    .run()
  db.insert(sessionTimeOverrides)
    .values({ sessionId: row.id, endedAt: 1, durationMinutes: 1 })
    .run()
  for (const usage of USAGE)
    db.insert(sessionModelUsage)
      .values({ sessionId: row.id, ...usage })
      .run()
  return row.id
}

const probe =
  (state: ReturnType<SourceFileProbe>): SourceFileProbe =>
  (path) => {
    expect(path).toBe(SECRET_LOG)
    return state
  }
const legacyFacts = (db: Db) =>
  db.select().from(syncChanges).where(eq(syncChanges.entityType, 'legacy-session')).all()
const activeRows = (db: Db) =>
  db.select().from(sessions).where(and(activeSessionCondition)).orderBy(sessions.id).all()
const usageOf = (db: Db, sessionId: number) =>
  db
    .select({
      model: sessionModelUsage.model,
      inputTokens: sessionModelUsage.inputTokens,
      outputTokens: sessionModelUsage.outputTokens,
      cacheCreationInputTokens: sessionModelUsage.cacheCreationInputTokens,
      cacheReadInputTokens: sessionModelUsage.cacheReadInputTokens
    })
    .from(sessionModelUsage)
    .where(eq(sessionModelUsage.sessionId, sessionId))
    .orderBy(sessionModelUsage.model)
    .all()

it('recovers a measured, edited row whose log was deleted before sync onto a blank computer', () => {
  const a = open()
  const id = measuredRow(a)
  expect(bootstrapFolderSync(a, workspaceId, { sourceFiles: probe('missing') })).toEqual([])
  expect(legacyFacts(a)).toHaveLength(1)
  // No local path, file name or local integer ID leaves this computer.
  for (const { json } of a.select({ json: syncChanges.changeJson }).from(syncChanges).all()) {
    expect(json).not.toContain('secret-project')
    expect(json).not.toContain('deleted.jsonl')
  }
  // The saved row keeps its local metadata, derivation and time edit.
  expect(a.select().from(sessions).where(eq(sessions.id, id)).get()!.sourceFile).toBe(SECRET_LOG)
  expect(
    a.select().from(sessionTimeOverrides).where(eq(sessionTimeOverrides.sessionId, id)).get()
  ).toMatchObject({ endedAt: 1 })

  const b = open()
  deliver(a, b)
  const [restored] = activeRows(b)
  expect(activeRows(b)).toHaveLength(1)
  expect(restored).toMatchObject({
    sourceFile: null,
    projectPath: '',
    tool: 'claude',
    claudeSessionId: 'conversation-deleted',
    startedAt: '2026-03-04T10:00:00.000Z',
    endedAt: '2026-03-04T11:10:00.000Z',
    durationMinutes: 70,
    promptCount: 12,
    inputTokens: 1000,
    outputTokens: 100,
    description: 'Saved before logs were deleted',
    billable: 1
  })
  expect(usageOf(b, restored.id)).toEqual(USAGE)
  // Nothing invented: no derivation, activity or second row on the receiver.
  expect(b.select().from(sessionDerivations).all()).toEqual([])
})

it('never treats a present or unavailable log as deleted, and retains once it is proved missing', () => {
  const a = open()
  const id = measuredRow(a)
  bootstrapFolderSync(a, workspaceId, { sourceFiles: probe('present') })
  bootstrapFolderSync(a, workspaceId, { sourceFiles: probe('unavailable') })
  expect(a.select().from(sessionLegacyRecords).all()).toEqual([])
  expect(legacyFacts(a)).toEqual([])

  bootstrapFolderSync(a, workspaceId, { sourceFiles: probe('missing') })
  expect(
    a
      .select()
      .from(sessionLegacyRecords)
      .all()
      .map((row) => row.sessionId)
  ).toEqual([id])
  // Idempotent; a retained row is not probed again.
  const count = a.select().from(syncChanges).all().length
  bootstrapFolderSync(a, workspaceId, {
    sourceFiles: () => {
      throw new Error('probed a retained row')
    }
  })
  expect(a.select().from(syncChanges).all()).toHaveLength(count)
})

it('gives an exact database copy the same legacy UUIDs and change IDs', () => {
  const a = open()
  measuredRow(a)
  const copy = clone(a)
  bootstrapFolderSync(a, workspaceId, { sourceFiles: probe('missing') })
  bootstrapFolderSync(copy, workspaceId, { sourceFiles: probe('missing') })
  const ids = (db: Db) => legacyFacts(db).map((row) => [row.id, row.entityId])
  expect(ids(copy)).toEqual(ids(a))

  // Both copies reaching a blank computer count the saved row once.
  const b = open()
  deliver(a, b)
  deliver(copy, b)
  expect(activeRows(b)).toHaveLength(1)
})

it('keeps source-less measured rows (shared projections) out of legacy retention', () => {
  const a = open()
  measuredRow(a, { sourceFile: null })
  bootstrapFolderSync(a, workspaceId, {
    sourceFiles: () => {
      throw new Error('no file to probe')
    }
  })
  expect(a.select().from(sessionLegacyRecords).all()).toEqual([])
})

it('proves a missing log only with ENOENT under a mounted directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clautime-probe-'))
  try {
    const file = join(dir, 'log.jsonl')
    writeFileSync(file, '{}\n')
    expect(probeSourceFile(file)).toBe('present')
    rmSync(file)
    expect(probeSourceFile(file)).toBe('missing')
    expect(probeSourceFile(join(dir, 'gone-project', 'nested', 'log.jsonl'))).toBe('missing')
    expect(probeSourceFile('relative/log.jsonl')).toBe('unavailable')
    expect(probeSourceFile('')).toBe('unavailable')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const keyOf = (conversationId: string) => JSON.stringify(['claude', conversationId])

/**
 * Captured events 10:00–10:05 and 10:40–10:45 with matching unadopted saved rows, as a raw
 * scan leaves them. The relative log path is never proved missing, so nothing is retained.
 */
function savedConversation(db: Db, conversationId: string): number[] {
  const eventId = (name: string) =>
    `claude:v1:native:${createHash('sha256')
      .update(JSON.stringify(['claude', 1, conversationId, 'native', name]))
      .digest('hex')}`
  const times = ['10:00', '10:05', '10:40', '10:45']
  times.forEach((time, index) => {
    const id = eventId(`m${index}`)
    const payload = {
      type: 'user',
      timestamp: `2026-09-26T${time}:00.000Z`,
      parentEventId: index ? eventId(`m${index - 1}`) : null,
      model: null,
      usage: null,
      isToolResult: false,
      hasToolUse: false,
      toolNames: []
    }
    db.insert(activityIdentities)
      .values({
        eventId: id,
        provider: 'claude',
        conversationId,
        identityVersion: 1,
        basis: 'native',
        nativeEventId: `m${index}`
      })
      .run()
    db.insert(activityObservations)
      .values({
        id: activityObservationId(id, 'message', payload),
        eventId: id,
        version: 1,
        kind: 'message',
        createdAt: payload.timestamp,
        payloadJson: canonicalJson(payload)
      })
      .run()
  })
  const ledger = previewLedgerWorkspacePolicy(db, policy).conversations.find(
    (row) => row.conversationId === conversationId
  )
  if (ledger?.status !== 'resolved') throw new Error('Unresolved fixture')
  return ledger.before.map((interval) => {
    const row = db
      .insert(sessions)
      .values({
        projectPath: 'C:/fixture',
        sourceFile: `fixture/${conversationId}.jsonl`,
        tool: 'claude',
        claudeSessionId: conversationId,
        startedAt: interval.startedAt,
        endedAt: interval.endedAt,
        durationMinutes: interval.durationMinutes,
        promptCount: interval.promptCount,
        inputTokens: interval.inputTokens,
        outputTokens: interval.outputTokens
      })
      .returning()
      .get()
    db.insert(sessionDerivations)
      .values({
        sessionId: row.id,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        durationMinutes: row.durationMinutes
      })
      .run()
    return row.id
  })
}
const linkedConversations = (db: Db) => [
  ...new Set(
    db
      .select()
      .from(sessionActivityMappings)
      .all()
      .map((row) => row.conversationId)
  )
]
const sharedActivityConversations = (db: Db) => [
  ...new Set(
    db
      .select()
      .from(syncChanges)
      .where(eq(syncChanges.entityType, 'activity-identity'))
      .all()
      .map((row) => (JSON.parse(row.changeJson) as { payload: { conversationId: string } }).payload)
      .map((payload) => payload.conversationId)
  )
]
const ledgerScopes = () =>
  vi.mocked(readCanonicalActivity).mock.calls.map(([, conversationKeys]) => conversationKeys)

it('bootstraps in committed steps, adopting each candidate conversation on its own', async () => {
  const a = open()
  const first = savedConversation(a, 'first')
  const second = savedConversation(a, 'second')
  const sqlite = connections.get(a)!
  vi.mocked(readCanonicalActivity).mockClear()
  const linkedAtYield: number[] = []
  const issues = await bootstrapFolderSyncInSteps(a, workspaceId, async () => {
    expect(sqlite.inTransaction).toBe(false)
    linkedAtYield.push(a.select().from(sessionActivityMappings).all().length)
  })
  expect(issues.filter((row) => row.code === 'SYNC_LOCAL_EXPORT_WITHHELD')).toEqual([])
  const all = first.length + second.length
  // Directory, one adoption step per conversation, retention once, one automatic history step
  // per adopted conversation, then saved history, manual entries and invoices.
  expect(linkedAtYield).toEqual([0, first.length, all, all, all, all, all, all, all])
  // Preview and recheck of one conversation each; the whole ledger is never read.
  expect(ledgerScopes()).toEqual([
    [keyOf('first')],
    [keyOf('first')],
    [keyOf('second')],
    [keyOf('second')]
  ])
  // Captured activity is left to the caller's paged export.
  expect(sharedActivityConversations(a)).toEqual([])

  // Nothing is left to adopt, so a repeat reads no ledger at all.
  vi.mocked(readCanonicalActivity).mockClear()
  await bootstrapFolderSyncInSteps(a, workspaceId, async () => {})
  expect(ledgerScopes()).toEqual([])
})

it('retains once, then exports automatic history one adopted conversation per step', async () => {
  const a = open()
  const first = savedConversation(a, 'first')
  const second = savedConversation(a, 'second')
  // The caller's paged activity export, so mapped edit baselines have their anchors.
  for (const phase of ['observations', 'identities', 'machines'] as const) {
    let page = { cursor: 0, done: false }
    while (!page.done) page = exportActivityPage(a, workspaceId, page.cursor, 100, phase)
  }
  const edited = () =>
    a
      .select()
      .from(syncChanges)
      .where(eq(syncChanges.entityType, 'session-edit'))
      .all()
      .map(
        (row) =>
          (
            JSON.parse(row.changeJson) as {
              payload: { fields: { target: { value: { conversationId: string } } } }
            }
          ).payload.fields.target.value.conversationId
      )
      .sort()
  const atYield: string[][] = []
  await bootstrapFolderSyncInSteps(a, workspaceId, async () => {
    atYield.push(edited())
  })
  const firstOnly = first.map(() => 'first')
  const both = [...firstOnly, ...second.map(() => 'second')]
  // Directory, two adoption steps and retention export no edits; then one conversation each.
  expect(atYield).toEqual([[], [], [], [], firstOnly, both, both, both, both])
})

it('exports saved history in committed batches and sweeps keep-all resolutions after them', async () => {
  const a = open()
  // Two overlapping saved-only rows of one conversation; both are retained as legacy history.
  for (const [startedAt, endedAt] of [
    ['2026-03-04T10:00:00.000Z', '2026-03-04T11:00:00.000Z'],
    ['2026-03-04T10:30:00.000Z', '2026-03-04T11:30:00.000Z']
  ])
    a.insert(sessions)
      .values({
        projectPath: 'C:/fixture',
        sourceFile: null,
        tool: 'claude',
        claudeSessionId: 'saved-only',
        startedAt,
        endedAt,
        durationMinutes: 60
      })
      .run()
  const copy = clone(a)
  const sqlite = connections.get(a)!
  const count = (entityType: string) =>
    a.select().from(syncChanges).where(eq(syncChanges.entityType, entityType)).all().length
  const atYield: Array<[number, number]> = []
  const issues = await bootstrapFolderSyncInSteps(a, workspaceId, async () => {
    expect(sqlite.inTransaction).toBe(false)
    atYield.push([count('legacy-session'), count('legacy-reconciliation')])
  })
  expect(issues.filter((row) => row.code === 'SYNC_LOCAL_EXPORT_WITHHELD')).toEqual([])
  // The saved-history batch commits both rows' facts; the keep-all sweep follows on its own,
  // then manual entries and invoices.
  expect(atYield.slice(-4)).toEqual([
    [2, 0],
    [2, 1],
    [2, 1],
    [2, 1]
  ])
  expect(atYield.slice(0, -4).every(([facts]) => facts === 0)).toBe(true)
  expect(activeRows(a)).toHaveLength(2)

  // The same legacy changes as a single-transaction bootstrap of an identical copy.
  bootstrapFolderSync(copy, workspaceId, { skipActivity: true, skipAdoption: true })
  const legacyIds = (db: Db) =>
    db
      .select({ id: syncChanges.id, entityType: syncChanges.entityType })
      .from(syncChanges)
      .all()
      .filter((row) => row.entityType.startsWith('legacy-'))
      .map((row) => row.id)
      .sort()
  expect(legacyIds(a)).toEqual(legacyIds(copy))

  // A rerun has nothing left to journal.
  const before = legacyIds(a)
  await bootstrapFolderSyncInSteps(a, workspaceId, async () => {})
  expect(legacyIds(a)).toEqual(before)
})

it('exports a manual entry with its machine for an edit that touches no conversation', () => {
  const a = open()
  savedConversation(a, 'unrelated')
  const deviceId = '9b95ec41-b3b6-4cbb-b1b6-e7ce607ef222'
  a.insert(sourceMachines).values({ deviceId, initialName: 'Fixture' }).run()
  const row = a
    .insert(sessions)
    .values({
      projectPath: 'C:/fixture',
      source: 'manual',
      tool: 'claude',
      startedAt: '2026-09-26T10:00:00.000Z',
      endedAt: '2026-09-26T11:00:00.000Z',
      durationMinutes: 60,
      description: 'Manual work'
    })
    .returning()
    .get()
  const entryId = randomUUID()
  a.insert(manualTimeEntries)
    .values({ id: entryId, sessionId: row.id, deviceId, basis: 'created' })
    .run()
  // A manual edit's scoped bootstrap: no conversation, so no captured activity is read.
  const issues = bootstrapFolderSync(a, workspaceId, { conversationKeys: [] })
  expect(issues.filter((issue) => issue.code === 'SYNC_REFERENCE_UNAVAILABLE')).toEqual([])
  const journaled = (entityType: string) =>
    a
      .select({ entityId: syncChanges.entityId })
      .from(syncChanges)
      .where(eq(syncChanges.entityType, entityType))
      .all()
      .map((change) => change.entityId)
  expect(journaled('machine')).toEqual([deviceId])
  expect(journaled('manual-entry')).toContain(entryId)
  expect(sharedActivityConversations(a)).toEqual([])

  // Everything the baseline depends on was exported: a blank computer applies it.
  deliver(a, open())
})

it('leaves skipped activity and adoption to the caller', () => {
  const a = open()
  const ids = savedConversation(a, 'first')
  bootstrapFolderSync(a, workspaceId, { skipActivity: true, skipAdoption: true })
  expect(linkedConversations(a)).toEqual([])
  expect(sharedActivityConversations(a)).toEqual([])

  expect(bootstrapFolderSync(a, workspaceId)).toEqual([])
  expect(a.select().from(sessionActivityMappings).all()).toHaveLength(ids.length)
  expect(sharedActivityConversations(a)).toEqual(['first'])
})

it('prepares a local edit from its own conversation only, with every baseline it needs', () => {
  const a = open()
  const [edited] = savedConversation(a, 'touched')
  savedConversation(a, 'unrelated')
  vi.mocked(readCanonicalActivity).mockClear()
  a.transaction((tx) =>
    journalSessionMutation(tx, edited, () =>
      tx.update(sessions).set({ description: 'Edited here' }).where(eq(sessions.id, edited)).run()
    )
  )
  const scopes = ledgerScopes()
  expect(scopes.length).toBeGreaterThan(0)
  expect(scopes.every((keys) => JSON.stringify(keys) === JSON.stringify([keyOf('touched')]))).toBe(
    true
  )
  // The unrelated conversation waits for the next full or stepped bootstrap.
  expect(linkedConversations(a)).toEqual(['touched'])
  expect(sharedActivityConversations(a)).toEqual(['touched'])

  // Everything the edit depends on was exported: a blank computer applies it without waiting.
  const b = open()
  deliver(a, b)
  projectSharedSessions(b, workspaceId)
  const startedAt = a.select().from(sessions).where(eq(sessions.id, edited)).get()!.startedAt
  expect(
    b
      .select()
      .from(sessions)
      .where(and(eq(sessions.claudeSessionId, 'touched'), eq(sessions.startedAt, startedAt)))
      .get()?.description
  ).toBe('Edited here')
  expect(b.select().from(sessions).where(eq(sessions.claudeSessionId, 'unrelated')).all()).toEqual(
    []
  )
})

const entities = (db: Db, entityType: string) =>
  db
    .select({ entityId: syncChanges.entityId })
    .from(syncChanges)
    .where(eq(syncChanges.entityType, entityType))
    .all()
    .map((row) => row.entityId)
    .sort()
const keepAllConversations = (db: Db) =>
  db
    .select({ json: syncChanges.changeJson })
    .from(syncChanges)
    .where(eq(syncChanges.entityType, 'legacy-reconciliation'))
    .all()
    .map((row) => (JSON.parse(row.json) as { payload: { conversationId: string } }).payload)
    .map((payload) => payload.conversationId)

it('prepares a saved-history edit from its own row and split lineage only', () => {
  const a = open()
  const saved = (conversationId: string, startedAt: string, endedAt: string, minutes: number) =>
    a
      .insert(sessions)
      .values({
        projectPath: 'C:/fixture',
        sourceFile: null,
        tool: 'claude',
        claudeSessionId: conversationId,
        startedAt: `2026-03-04T${startedAt}:00.000Z`,
        endedAt: `2026-03-04T${endedAt}:00.000Z`,
        durationMinutes: minutes
      })
      .returning()
      .get()
  // Overlapping native history of another conversation: its keep-all is pending.
  const other = [saved('other', '10:00', '11:00', 60), saved('other', '10:30', '11:30', 60)]
  // A native row of the touched conversation, split here before sync.
  const parent = saved('touched', '12:00', '13:00', 60)
  const first = saved('touched', '12:00', '12:30', 30)
  const second = saved('touched', '12:30', '13:00', 30)
  const legacyOf = new Map(
    retainSourceLessSessionsForSync(
      a,
      [...other, parent, first, second].map((row) => row.id)
    ).retained.map((row) => [row.sessionId, row.legacyId])
  )
  const revisionId = randomUUID()
  a.insert(sessionRevisions)
    .values({
      id: revisionId,
      sessionId: parent.id,
      sequence: 1,
      kind: 'split',
      tool: 'claude',
      claudeSessionId: 'touched',
      startedAt: parent.startedAt,
      endedAt: parent.endedAt,
      before: '{}',
      after: '{}',
      createdAt: new Date().toISOString()
    })
    .run()
  a.insert(sessionSplits)
    .values({
      revisionId,
      legacyRecordId: legacyOf.get(parent.id)!,
      parentSessionId: parent.id,
      firstSessionId: first.id,
      secondSessionId: second.id,
      sourceFile: null,
      tool: 'claude',
      claudeSessionId: 'touched',
      startedAt: parent.startedAt,
      endedAt: parent.endedAt,
      splitAt: first.endedAt
    })
    .run()

  a.transaction((tx) =>
    journalSessionMutation(tx, first.id, () =>
      tx.update(sessions).set({ description: 'Edited part' }).where(eq(sessions.id, first.id)).run()
    )
  )
  // The edited part, its sibling and the parent it was split from; the other conversation waits.
  expect(entities(a, 'legacy-session')).toEqual(
    [parent, first, second].map((row) => legacyOf.get(row.id)!).sort()
  )
  expect(keepAllConversations(a)).not.toContain('other')

  // The parent's split retirement and the edit carry every dependency: a blank computer counts
  // the parts (one edited), never the parent.
  const b = open()
  deliver(a, b)
  expect(
    activeRows(b)
      .filter((row) => row.claudeSessionId === 'touched')
      .map((row) => row.description)
      .sort()
  ).toEqual(['Edited part', null])

  // The unscoped bootstrap still exports the rest and plans the pending keep-all.
  bootstrapFolderSync(a, workspaceId, { skipActivity: true, skipAdoption: true })
  expect(entities(a, 'legacy-session')).toHaveLength(5)
  expect(keepAllConversations(a)).toContain('other')
})

it('prepares a manual edit from its own entry and lineage only', () => {
  const a = open()
  const deviceId = '9b95ec41-b3b6-4cbb-b1b6-e7ce607ef222'
  a.insert(sourceMachines).values({ deviceId, initialName: 'Fixture' }).run()
  const entry = (parentId: string | null = null) => {
    const row = a
      .insert(sessions)
      .values({
        projectPath: 'C:/fixture',
        source: 'manual',
        tool: 'claude',
        startedAt: '2026-09-26T10:00:00.000Z',
        endedAt: '2026-09-26T11:00:00.000Z',
        durationMinutes: 60
      })
      .returning()
      .get()
    const id = randomUUID()
    a.insert(manualTimeEntries)
      .values({ id, sessionId: row.id, deviceId, basis: 'created', parentId })
      .run()
    return { id, sessionId: row.id }
  }
  const parent = entry()
  const child = entry(parent.id)
  const unrelated = entry()
  a.transaction((tx) =>
    journalSessionMutation(tx, child.sessionId, () =>
      tx
        .update(sessions)
        .set({ description: 'Edited entry' })
        .where(eq(sessions.id, child.sessionId))
        .run()
    )
  )
  // The edited entry and the parent its identity depends on; the unrelated entry waits.
  const shared = entities(a, 'manual-entry')
  expect(shared).toContain(child.id)
  expect(shared).toContain(parent.id)
  expect(shared).not.toContain(unrelated.id)
  expect(entities(a, 'machine')).toEqual([deviceId])
  deliver(a, open())

  bootstrapFolderSync(a, workspaceId, { skipActivity: true, skipAdoption: true })
  expect(entities(a, 'manual-entry')).toContain(unrelated.id)
})
