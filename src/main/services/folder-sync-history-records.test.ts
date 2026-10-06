// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { activityIdentities, activityObservations } from '../db/schema/activity-evidence'
import { folderSyncSettings, syncChanges, syncRecordStates } from '../db/schema/folder-sync'
import { sessions } from '../db/schema/sessions'
import { sessionDerivations } from '../db/schema/session-derivations'
import { sessionModelUsage } from '../db/schema/session-model-usage'
import { sessionDeletions } from '../db/schema/session-deletions'
import {
  sessionMappingDecisions,
  sessionMappingOutcomes
} from '../db/schema/session-mapping-revisions'
import {
  activityObservationId,
  activitySyncAdapter,
  collectActivitySyncChanges,
  syncFactChangeId
} from './folder-sync-activity-records'
import {
  applyReadySyncBatches,
  assembleOutgoingBatch,
  recordLocalSyncChanges,
  retainIncomingBatch,
  type SyncDomainAdapter
} from './folder-sync-store'
import { canonicalJson, type SyncChange } from './folder-sync-protocol'
import {
  collectHistorySyncChanges,
  HISTORY_SYNC_ENTITY_TYPES,
  historyRecordsAdapter,
  planSessionDeletionFact,
  planSessionSplitFact,
  readPortableHistoryFacts,
  sessionDeletionEntityId,
  sessionSplitEntityId
} from './folder-sync-history-records'
import {
  adoptInitialWorkspacePolicy,
  previewLedgerWorkspacePolicy,
  readCanonicalHistoryConstraints
} from './workspace-policy'
import {
  adoptSessionActivityMappings,
  previewSessionActivityAdoption
} from './session-activity-mappings'
import { previewSessionMappingTransitions } from './session-mapping-transitions'
import { planSessionMappingApplication } from './session-mapping-plan'
import { deleteMappedSession, splitMappedSession } from './canonical-history-operations'

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
const CONVERSATION = 'conversation-1'
const KEY = JSON.stringify(['claude', CONVERSATION])
const at = (time: string) => `2026-09-26T${time.length === 5 ? `${time}:00` : time}.000Z`
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const eventId = (name: string) =>
  `claude:v1:native:${sha(JSON.stringify(['claude', 1, CONVERSATION, 'native', name]))}`

let workspaceId: string
let policySnapshot: { workspaceId: string; revisionId: string; policy: typeof policy }
const opened: Database.Database[] = []
const observations = new Map<string, string>()

function open(connected: boolean): Db {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  opened.push(sqlite)
  const db = drizzle(sqlite)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  adoptInitialWorkspacePolicy(db, policySnapshot)
  if (connected)
    db.insert(folderSyncSettings).values({ slot: 1, workspaceId, folderPath: 'C:/sync' }).run()
  return db
}

beforeEach(() => {
  workspaceId = randomUUID()
  policySnapshot = { workspaceId: randomUUID(), revisionId: randomUUID(), policy }
})
afterEach(() => {
  vi.useRealTimers()
  while (opened.length) opened.pop()!.close()
})

// Stand-in for the root session metadata adapters: only their change IDs matter here.
const editAdapter: SyncDomainAdapter = { validate: () => undefined, apply: () => undefined }
const history = new Set<string>(HISTORY_SYNC_ENTITY_TYPES)
const pick = (change: SyncChange) =>
  history.has(change.entityType)
    ? historyRecordsAdapter
    : change.entityType === 'session-edit' || change.entityType === 'session-mapping'
      ? editAdapter
      : activitySyncAdapter
const adapter: SyncDomainAdapter = {
  validate: (change) => pick(change).validate(change),
  apply: (tx, workspace, change) => pick(change).apply(tx, workspace, change)
}

function deliver(
  from: Db,
  to: Db,
  writer = { writerEpochId: randomUUID(), deviceId: randomUUID() }
) {
  const batch = assembleOutgoingBatch(from, workspaceId, writer)
  if (!batch) throw new Error('Nothing to deliver')
  retainIncomingBatch(to, workspaceId, JSON.parse(JSON.stringify(batch)), adapter)
  return applyReadySyncBatches(to, workspaceId, adapter)
}

function message(
  db: Db,
  name: string,
  parent: string | null,
  time: string,
  type: 'user' | 'assistant' = 'user'
) {
  const id = eventId(name)
  const payload = {
    type,
    timestamp: at(time),
    parentEventId: parent && eventId(parent),
    model: type === 'assistant' ? 'model-a' : null,
    usage:
      type === 'assistant'
        ? {
            inputTokens: 100,
            outputTokens: 10,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0
          }
        : null,
    isToolResult: false,
    hasToolUse: false,
    toolNames: []
  }
  db.insert(activityIdentities)
    .values({
      eventId: id,
      provider: 'claude',
      conversationId: CONVERSATION,
      identityVersion: 1,
      basis: 'native',
      nativeEventId: name
    })
    .run()
  const observation = activityObservationId(id, 'message', payload)
  observations.set(name, observation)
  db.insert(activityObservations)
    .values({
      id: observation,
      eventId: id,
      version: 1,
      kind: 'message',
      createdAt: at(time),
      // The ledger's canonical form, as activity-evidence writes it.
      payloadJson: canonicalJson(payload)
    })
    .run()
}

/** Two intervals separated by idle time: 10:00–10:05 and 10:40–10:45. */
function twoIntervals(db: Db) {
  message(db, 'm0', null, '10:00')
  message(db, 'm1', 'm0', '10:05', 'assistant')
  message(db, 'm2', 'm1', '10:40')
  message(db, 'm3', 'm2', '10:45', 'assistant')
  const conversation = previewLedgerWorkspacePolicy(db, policy).conversations[0]
  if (conversation?.status !== 'resolved') throw new Error('Unresolved fixture')
  const ids = conversation.before.map((interval) => {
    const row = db
      .insert(sessions)
      .values({
        projectPath: 'C:/fixture',
        sourceFile: 'C:/fixture/log.jsonl',
        tool: 'claude',
        claudeSessionId: CONVERSATION,
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
    for (const usage of interval.modelUsage)
      db.insert(sessionModelUsage)
        .values({ sessionId: row.id, ...usage })
        .run()
    return row.id
  })
  adoptSessionActivityMappings(db, previewSessionActivityAdoption(db).fingerprint, ids)
  return ids
}

function exportActivity(db: Db, names?: string[]) {
  const scope = names?.map((name) => observations.get(name)!)
  recordLocalSyncChanges(
    db,
    workspaceId,
    collectActivitySyncChanges(db, workspaceId, scope),
    adapter
  )
}

function ledger(db: Db) {
  return previewLedgerWorkspacePolicy(db, policy)
}
function plan(db: Db) {
  return planSessionMappingApplication(previewSessionMappingTransitions(db, policy), randomUUID())
    .conversations[0]
}
const historyRows = (db: Db, entityType: string) =>
  db.select().from(syncChanges).where(eq(syncChanges.entityType, entityType)).all()

it('holds a deletion that arrives before its evidence, then suppresses without inventing local rows', () => {
  const a = open(true)
  const b = open(false)
  const [kept, deleted] = twoIntervals(a)
  deleteMappedSession(a, deleted)
  const [row] = historyRows(a, 'session-deletion')
  expect(row).toMatchObject({ workspaceId, kind: 'fact', origin: 'local' })
  const change = JSON.parse(row.changeJson)
  expect(change.id).toBe(syncFactChangeId(workspaceId, 'session-deletion', change.entityId))
  expect(Object.keys(change.payload).sort()).toEqual([
    'conversationId',
    'coverage',
    'observedSessionEditHeads',
    'provider',
    'version'
  ])
  // Nothing local leaves: no row, mapping or decision IDs and no paths.
  const decision = a.select().from(sessionMappingDecisions).get()!
  for (const local of ['C:/', 'sessionId', 'sourceFile', 'projectPath', decision.id])
    expect(row.changeJson).not.toContain(local)
  expect(ledger(a).conversations[0]).toMatchObject({
    operations: {
      deletedSessionIds: [deleted],
      deletionOperationIds: [change.id],
      suppressed: { before: [{ sessionIds: [deleted], operationIds: [change.id] }] }
    }
  })

  // 1. Only the deletion: no activity of its conversation yet.
  expect(deliver(a, b).errors).toEqual([])
  expect(ledger(b)).toMatchObject({ conversations: [], waitingOperationIds: [change.id] })

  // 2. Partial evidence: the conversation is held, never counted with deleted work.
  exportActivity(a, ['m0', 'm1'])
  expect(deliver(a, b).errors).toEqual([])
  const partial = ledger(b).conversations[0]
  expect(partial).toMatchObject({
    status: 'resolved',
    operations: {
      heldOperations: [{ operationId: change.id, reason: 'missing-deleted-evidence' }],
      deletedSessionIds: []
    }
  })
  expect(plan(b)).toMatchObject({ status: 'held' })
  expect(plan(b).heldReasons).toContain('history-operation-conflict')

  // 3. Complete evidence: suppressed by the portable fact alone.
  exportActivity(a)
  expect(deliver(a, b).errors).toEqual([])
  const complete = ledger(b).conversations[0]
  if (complete.status !== 'resolved') throw new Error('Unresolved')
  expect(complete.before.map((interval) => interval.startedAt)).toEqual([at('10:00')])
  expect(complete.operations).toMatchObject({
    deletedSessionIds: [],
    deletionOperationIds: [change.id],
    heldOperations: [],
    invalid: [],
    suppressed: {
      before: [{ sessionIds: [], operationIds: [change.id], startedAt: at('10:40') }]
    }
  })
  expect(plan(b).heldReasons).not.toContain('history-operation-conflict')
  // Nothing local was deleted or created: mapping a mask onto rows is the projector's job.
  expect(b.select().from(sessions).all()).toEqual([])
  expect(b.select().from(sessionDeletions).all()).toEqual([])
  expect(a.select().from(sessions).where(eq(sessions.id, kept)).get()).toBeDefined()
})

it('unions equal cuts made on two computers into one fact despite clock skew and copies', () => {
  const a = open(true)
  const b = open(true)
  const [first] = twoIntervals(a)
  splitMappedSession(a, first, at('10:03'))
  const [local] = historyRows(a, 'session-split')
  expect(JSON.parse(local.changeJson).payload).toEqual({
    version: 1,
    provider: 'claude',
    conversationId: CONVERSATION,
    splitAt: at('10:03')
  })
  expect(local.entityId).toBe(sessionSplitEntityId('claude', CONVERSATION, at('10:03')))

  // The same cut, spelled differently, recorded years later on the other computer.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2031-01-01T00:00:00.000Z'))
  const copy = planSessionSplitFact(workspaceId, {
    provider: 'claude',
    conversationId: CONVERSATION,
    splitAt: '2026-09-26T10:03:00Z'
  })
  recordLocalSyncChanges(b, workspaceId, [copy], adapter)
  vi.useRealTimers()
  expect(copy.id).toBe(local.id)

  expect(deliver(a, b).errors).toEqual([])
  expect(deliver(b, a).errors).toEqual([])
  for (const db of [a, b]) {
    expect(historyRows(db, 'session-split')).toHaveLength(1)
    expect(readCanonicalHistoryConstraints(db).get(KEY)).toMatchObject({
      cuts: [at('10:03')],
      cutOperations: [{ operationId: local.id, splitAt: at('10:03') }]
    })
  }
  // A different instant is a different cut; both are kept.
  const other = planSessionSplitFact(workspaceId, {
    provider: 'claude',
    conversationId: CONVERSATION,
    splitAt: at('10:04')
  })
  recordLocalSyncChanges(b, workspaceId, [other], adapter)
  expect(readCanonicalHistoryConstraints(b).get(KEY)?.cuts).toEqual([at('10:03'), at('10:04')])
})

it('gives deletions with different observed edits different fact IDs and dedupes copies', () => {
  const a = open(true)
  const b = open(true)
  const [, deleted] = twoIntervals(a)
  const interval = previewLedgerWorkspacePolicy(a, policy).conversations[0]
  if (interval.status !== 'resolved') throw new Error('Unresolved')
  const coverage = interval.before[1].coverage
  const target = { provider: 'claude', conversationId: CONVERSATION, coverage }
  const [h1, h2] = [randomUUID(), randomUUID()].sort()
  const bare = planSessionDeletionFact(workspaceId, target)
  const observed = planSessionDeletionFact(workspaceId, {
    ...target,
    observedSessionEditHeads: [h2, h1, h2]
  })
  expect(observed.payload.observedSessionEditHeads).toEqual([h1, h2])
  expect(observed.dependencies).toEqual([h1, h2])
  expect(observed.entityId).not.toBe(bare.entityId)
  expect(observed.id).not.toBe(bare.id)
  expect(
    planSessionDeletionFact(workspaceId, { ...target, observedSessionEditHeads: [h1, h2] })
  ).toEqual(observed)

  // Observed edits must exist as session-edit changes of this shared history.
  expect(() => recordLocalSyncChanges(a, workspaceId, [observed], adapter)).toThrow(
    /observed history|observed session edit/
  )
  const edit = (id: string, entityType: 'session-edit' | 'session-mapping'): SyncChange => ({
    id,
    kind: 'revision',
    entityType,
    entityId: KEY,
    dependencies: [],
    payload: {}
  })
  recordLocalSyncChanges(
    a,
    workspaceId,
    [edit(h1, 'session-edit'), edit(h2, 'session-mapping')],
    adapter
  )
  expect(() => recordLocalSyncChanges(a, workspaceId, [observed], adapter)).toThrow(
    /observed session edit/
  )

  // The same fact recorded independently on both computers is one change.
  deleteMappedSession(a, deleted)
  const [journaled] = historyRows(a, 'session-deletion')
  expect(journaled.id).toBe(bare.id)
  recordLocalSyncChanges(b, workspaceId, [bare], adapter)
  expect(deliver(a, b).errors).toEqual([])
  expect(historyRows(b, 'session-deletion')).toHaveLength(1)
  expect(readPortableHistoryFacts(b).get(KEY)?.deletions).toMatchObject([
    { operationId: bare.id, observedSessionEditHeads: [] }
  ])
})

it('refuses a deletion that observes an edit of another conversation', () => {
  const a = open(true)
  twoIntervals(a)
  const interval = previewLedgerWorkspacePolicy(a, policy).conversations[0]
  if (interval.status !== 'resolved') throw new Error('Unresolved')
  const target = {
    provider: 'claude',
    conversationId: CONVERSATION,
    coverage: interval.before[1].coverage
  }
  const [elsewhereHead, hereHead] = [randomUUID(), randomUUID()]
  const edit = (id: string, entityId: string): SyncChange => ({
    id,
    kind: 'revision',
    entityType: 'session-edit',
    entityId,
    dependencies: [],
    payload: {}
  })
  recordLocalSyncChanges(
    a,
    workspaceId,
    [edit(elsewhereHead, 'edit-elsewhere'), edit(hereHead, 'edit-here')],
    adapter
  )
  // What the session-edit adapter would have written for each record.
  for (const [entityId, conversationId] of [
    ['edit-elsewhere', 'conversation-2'],
    ['edit-here', CONVERSATION]
  ])
    a.insert(syncRecordStates)
      .values({
        workspaceId,
        entityType: 'session-edit',
        entityId,
        stateJson: JSON.stringify({ view: {}, target: { provider: 'claude', conversationId } })
      })
      .run()

  const elsewhere = planSessionDeletionFact(workspaceId, {
    ...target,
    observedSessionEditHeads: [elsewhereHead]
  })
  expect(() => recordLocalSyncChanges(a, workspaceId, [elsewhere], adapter)).toThrow(
    /another conversation/
  )
  const here = planSessionDeletionFact(workspaceId, {
    ...target,
    observedSessionEditHeads: [hereHead]
  })
  recordLocalSyncChanges(a, workspaceId, [here], adapter)
  expect(historyRows(a, 'session-deletion').map((row) => row.id)).toEqual([here.id])
  expect(readPortableHistoryFacts(a).get(KEY)?.deletions).toMatchObject([
    { operationId: here.id, observedSessionEditHeads: [hereHead] }
  ])
})

it('rejects unsupported versions, forged hashes, paths and local fields', () => {
  const a = open(true)
  twoIntervals(a)
  const interval = previewLedgerWorkspacePolicy(a, policy).conversations[0]
  if (interval.status !== 'resolved') throw new Error('Unresolved')
  const deletion = planSessionDeletionFact(workspaceId, {
    provider: 'claude',
    conversationId: CONVERSATION,
    coverage: interval.before[1].coverage
  })
  const split = planSessionSplitFact(workspaceId, {
    provider: 'claude',
    conversationId: CONVERSATION,
    splitAt: at('10:03')
  })
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
  /** Rehashes so only the named defect is under test. */
  const rehash = (change: SyncChange) => {
    change.entityId = sessionDeletionEntityId(change.payload)
    change.id = syncFactChangeId(workspaceId, 'session-deletion', change.entityId)
    return change
  }
  const code = (change: SyncChange) => {
    try {
      historyRecordsAdapter.validate(change)
    } catch (error) {
      return (error as { code?: string }).code
    }
    return 'accepted'
  }
  expect(code(deletion)).toBe('accepted')
  expect(code(split)).toBe('accepted')

  const newer = clone(deletion)
  newer.payload.version = 2
  expect(code(rehash(newer))).toBe('SYNC_UPDATE_REQUIRED')
  const text = clone(split)
  text.payload.version = '1'
  expect(code(text)).toBe('SYNC_MALFORMED')
  const provider = clone(split)
  provider.payload.provider = 'newtool'
  expect(code(provider)).toBe('SYNC_UPDATE_REQUIRED')

  const path = clone(deletion)
  path.payload.sourceFile = 'C:/fixture/log.jsonl'
  expect(code(rehash(path))).toBe('SYNC_MALFORMED')
  type Refs = { messages: Array<Record<string, unknown>> }
  const refs = (change: SyncChange) => change.payload.coverage as unknown as Refs
  const localRef = clone(deletion)
  refs(localRef).messages[0].sessionId = 4
  expect(code(rehash(localRef))).toBe('SYNC_MALFORMED')
  const foreign = clone(deletion)
  refs(foreign).messages[0].eventId = `codex:v1:native:${'0'.repeat(64)}`
  expect(code(rehash(foreign))).toBe('SYNC_MALFORMED')
  const empty = clone(deletion)
  empty.payload.coverage = { version: 1, messages: [], continuity: [] }
  expect(code(rehash(empty))).toBe('SYNC_MALFORMED')

  const forged = clone(deletion)
  forged.entityId = `deletion:v1:${'0'.repeat(64)}`
  expect(code(forged)).toBe('SYNC_MALFORMED')
  const moved = clone(deletion)
  refs(moved).messages[0].timestamp = at('10:41')
  expect(code(moved)).toBe('SYNC_MALFORMED')
  const unsorted = clone(deletion)
  unsorted.payload.observedSessionEditHeads = [
    'b0000000-0000-4000-8000-000000000000',
    'a0000000-0000-4000-8000-000000000000'
  ]
  expect(code(rehash(unsorted))).toBe('SYNC_MALFORMED')
  const dependent = clone(deletion)
  dependent.dependencies = [randomUUID()]
  expect(code(dependent)).toBe('SYNC_MALFORMED')

  const spelled = clone(split)
  spelled.payload.splitAt = '2026-09-26T10:03:00Z'
  expect(code(spelled)).toBe('SYNC_MALFORMED')
  const elsewhere = clone(split)
  elsewhere.payload.splitAt = at('10:04')
  expect(code(elsewhere)).toBe('SYNC_MALFORMED')
  const revision = clone(split)
  revision.kind = 'revision'
  expect(code(revision)).toBe('SYNC_MALFORMED')

  // A change ID not derived from this workspace's fact is refused before anything is kept.
  const wrong = { ...clone(split), id: randomUUID() }
  expect(() => recordLocalSyncChanges(a, workspaceId, [wrong], adapter)).toThrow(/not derived/)
  expect(historyRows(a, 'session-split')).toEqual([])
})

it('bootstraps proven local operations from proof rows only and withholds unproven ones', () => {
  const a = open(false)
  const [first, deleted] = twoIntervals(a)
  splitMappedSession(a, first, at('10:03'))
  deleteMappedSession(a, deleted)
  expect(a.select().from(syncChanges).all()).toEqual([])

  const collected = collectHistorySyncChanges(a, workspaceId)
  expect(collected.withheld).toEqual([])
  expect(collected.changes.map((change) => change.entityType)).toEqual([
    'session-split',
    'session-deletion'
  ])
  expect(collectHistorySyncChanges(a, workspaceId)).toEqual(collected)
  const [split, deletion] = collected.changes
  expect(split.payload.splitAt).toBe(at('10:03'))
  expect(deletion.payload.observedSessionEditHeads).toEqual([])
  for (const change of collected.changes) expect(JSON.stringify(change)).not.toContain('C:/')

  recordLocalSyncChanges(a, workspaceId, collected.changes, adapter)
  // Recorded deletions are not exported again, whatever heads a later hook reports.
  expect(
    collectHistorySyncChanges(a, workspaceId, { observedSessionEditHeads: () => [randomUUID()] })
      .changes
  ).toEqual([split])
  const conversation = ledger(a).conversations[0]
  expect(conversation).toMatchObject({
    operations: {
      cuts: [at('10:03')],
      cutOperationIds: [split.id],
      suppressed: { before: [{ sessionIds: [deleted], operationIds: [deletion.id] }] },
      invalid: []
    }
  })
  expect(plan(a).status).toBe('applicable')

  // An unproven local operation withholds its whole conversation.
  const decision = a
    .select()
    .from(sessionMappingDecisions)
    .all()
    .find((row) => JSON.parse(row.requestJson).operation === 'delete')!
  // Outcomes are immutable; this disposable database drops the guard to simulate a lost proof.
  a.run(sql`DROP TRIGGER mapping_outcome_no_delete`)
  a.delete(sessionMappingOutcomes).where(eq(sessionMappingOutcomes.decisionId, decision.id)).run()
  expect(collectHistorySyncChanges(a, workspaceId)).toEqual({ changes: [], withheld: [KEY] })
})
