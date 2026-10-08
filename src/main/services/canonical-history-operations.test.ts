// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { activityIdentities, activityObservations } from '../db/schema/activity-evidence'
import { sessions, type Session } from '../db/schema/sessions'
import { sessionDerivations, sessionTimeOverrides } from '../db/schema/session-derivations'
import { sessionModelUsage } from '../db/schema/session-model-usage'
import { sessionActivityMappings } from '../db/schema/session-activity-mappings'
import { activeSessionCondition, sessionDeletions } from '../db/schema/session-deletions'
import { sessionBillingRefs, sessionSplits } from '../db/schema/session-history'
import {
  sessionMappingDecisions,
  sessionMappingEdges,
  sessionMappingOutcomes,
  sessionMappingRevisions
} from '../db/schema/session-mapping-revisions'
import { clients } from '../db/schema/clients'
import { folderSyncSettings, syncChanges } from '../db/schema/folder-sync'
import { invoices, invoiceLineItems } from '../db/schema/invoices'
import type { DetectedSession } from '../../shared/types/session'
import { parseCodexSessionFile } from '../parsers/codex-parser'
import { storeActivityEvidence } from './activity-evidence'
import {
  adoptInitialWorkspacePolicy,
  getWorkspacePolicy,
  previewLedgerWorkspacePolicy
} from './workspace-policy'
import {
  adoptSessionActivityMappings,
  previewSessionActivityAdoption
} from './session-activity-mappings'
import { previewSessionMappingTransitions } from './session-mapping-transitions'
import { planSessionMappingApplication } from './session-mapping-plan'
import { applySessionMappingApplication, mappingHeldKeys } from './session-mapping-application'
import { reconcileMappedSource } from './session-mapping-scanner'
import { SessionReconciliationError } from './session-history'
import { unbilledSessions } from './session-billing'
import {
  deleteMappedSession,
  isExactCanonicalPartition,
  splitMappedSession
} from './canonical-history-operations'

vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
vi.mock('./device-context', () => ({
  getLocalDeviceSession: () => ({
    deviceId: '9b95ec41-b3b6-4cbb-b1b6-e7ce607ef222',
    machineName: 'Fixture'
  })
}))

let sqlite: Database.Database
let db: ReturnType<typeof drizzle>
const policy = {
  version: 1,
  normalizationVersion: 1,
  detectorVersion: 1,
  idleTimeoutMinutes: 15,
  reportingTimeZone: 'UTC'
}
const source = 'C:/fixture/log.jsonl'
const copy = 'C:/copy/log.jsonl'
const at = (time: string) => `2026-09-26T${time.length === 5 ? `${time}:00` : time}.000Z`
beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  adoptInitialWorkspacePolicy(db, { workspaceId: randomUUID(), revisionId: randomUUID(), policy })
})
afterEach(() => sqlite.close())

type Usage = {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}
const tokens = (input: number, output: number, creation = 0, read = 0): Usage => ({
  inputTokens: input,
  outputTokens: output,
  cacheCreationInputTokens: creation,
  cacheReadInputTokens: read
})
function record(id: string, kind: 'message' | 'activity', payload: Record<string, unknown>) {
  db.insert(activityIdentities)
    .values({
      eventId: id,
      provider: 'claude',
      conversationId: 'conversation',
      identityVersion: 1,
      basis: 'native',
      nativeEventId: id
    })
    .run()
  db.insert(activityObservations)
    .values({
      id: `observation-${id}`,
      eventId: id,
      version: 1,
      kind,
      createdAt: payload.timestamp as string,
      payloadJson: JSON.stringify(payload)
    })
    .run()
}
function message(
  id: string,
  parent: string | null,
  time: string,
  type: 'user' | 'assistant' = 'user',
  usage: Usage | null = null,
  model: string | null = null
) {
  record(id, 'message', {
    type,
    timestamp: at(time),
    parentEventId: parent,
    model,
    usage,
    isToolResult: false,
    hasToolUse: false,
    toolNames: []
  })
}
function progress(id: string, parent: string, time: string) {
  record(id, 'activity', {
    kind: 'progress',
    progressType: null,
    timestamp: at(time),
    parentEventId: parent
  })
}
/** Saved rows exactly as a current-policy scan leaves them, with per-model usage. */
function save(tool: 'claude' | 'codex' = 'claude', conversationId = 'conversation') {
  const conversation = previewLedgerWorkspacePolicy(db, policy).conversations.find(
    (row) => row.conversationId === conversationId
  )
  if (conversation?.status !== 'resolved') throw new Error('Unresolved fixture')
  return conversation.before.map((interval) => {
    const row = db
      .insert(sessions)
      .values({
        projectPath: 'C:/fixture',
        sourceFile: source,
        tool,
        claudeSessionId: conversationId,
        startedAt: interval.startedAt,
        endedAt: interval.endedAt,
        durationMinutes: interval.durationMinutes,
        promptCount: interval.promptCount,
        inputTokens: interval.inputTokens,
        outputTokens: interval.outputTokens,
        description: 'Saved note',
        billable: 0
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
}
function adopt(ids: number[]) {
  adoptSessionActivityMappings(db, previewSessionActivityAdoption(db).fingerprint, ids)
  return ids
}
/** One continuous interval, 10:00–10:20: three prompts, two models and progress in one gap. */
function seed() {
  message('m0', null, '10:00')
  message('m1', 'm0', '10:04', 'assistant', tokens(100, 10), 'model-a')
  message('m2', 'm1', '10:08')
  progress('p1', 'm2', '10:09')
  progress('p2', 'p1', '10:11')
  message('m3', 'p2', '10:12', 'assistant', tokens(200, 20, 5, 7), 'model-a')
  message('m4', 'm3', '10:16')
  message('m5', 'm4', '10:20', 'assistant', tokens(300, 30), 'model-b')
  return adopt(save())
}
/** Two intervals separated by idle time: 10:00–10:05 and 10:40–10:45. */
function twoIntervals() {
  message('m0', null, '10:00')
  message('m1', 'm0', '10:05', 'assistant', tokens(100, 10), 'model-a')
  message('m2', 'm1', '10:40')
  message('m3', 'm2', '10:45', 'assistant', tokens(50, 5), 'model-a')
  return adopt(save())
}
const plan = (candidate = policy) =>
  planSessionMappingApplication(previewSessionMappingTransitions(db, candidate), randomUUID())
    .conversations[0]
const ledger = (candidate = policy) => {
  const conversation = previewLedgerWorkspacePolicy(db, candidate).conversations[0]
  if (conversation.status !== 'resolved') throw new Error('Unresolved fixture')
  return conversation
}
const active = () =>
  db.select().from(sessions).where(activeSessionCondition).orderBy(sessions.id).all()
const row = (id: number) => db.select().from(sessions).where(eq(sessions.id, id)).get()!
const mapping = (id: number) =>
  db.select().from(sessionActivityMappings).where(eq(sessionActivityMappings.sessionId, id)).get()!
const snapshot = (id: number) => JSON.parse(mapping(id).intervalJson)
const usageOf = (id: number) =>
  db
    .select()
    .from(sessionModelUsage)
    .where(eq(sessionModelUsage.sessionId, id))
    .orderBy(sessionModelUsage.model)
    .all()
    .map((entry) => ({
      model: entry.model,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheCreationInputTokens: entry.cacheCreationInputTokens,
      cacheReadInputTokens: entry.cacheReadInputTokens
    }))
const overrides = (id: number) =>
  db.select().from(sessionTimeOverrides).where(eq(sessionTimeOverrides.sessionId, id)).get()
const detected = (sourceFile: string): DetectedSession => ({
  startedAt: at('10:00'),
  endedAt: at('10:20'),
  durationMinutes: 20,
  projectPath: 'C:/from-file-path',
  tool: 'claude',
  claudeSessionId: 'conversation',
  sourceFile,
  promptCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  modelUsage: []
})

it('splits at a message boundary by exact ownership and adopts both parts with lineage', () => {
  const [id] = seed()
  const parent = row(id)
  const head = mapping(id)
  const [first, second] = splitMappedSession(db, id, '2026-09-26T10:08:00Z')
  // The prompt at the cut belongs to the later part; tokens follow their messages.
  expect(first).toMatchObject({
    startedAt: at('10:00'),
    endedAt: at('10:08'),
    durationMinutes: 8,
    promptCount: 1,
    inputTokens: 100,
    outputTokens: 10,
    description: 'Saved note',
    billable: 0,
    sourceFile: source
  })
  expect(second).toMatchObject({
    startedAt: at('10:08'),
    endedAt: at('10:20'),
    durationMinutes: 12,
    promptCount: 2,
    inputTokens: 500,
    outputTokens: 50
  })
  expect(usageOf(first.id)).toEqual([{ model: 'model-a', ...tokens(100, 10) }])
  expect(usageOf(second.id)).toEqual([
    { model: 'model-a', ...tokens(200, 20, 5, 7) },
    { model: 'model-b', ...tokens(300, 30) }
  ])
  expect(row(id)).toEqual(parent)
  expect(mapping(id)).toEqual(head)
  expect(active().map((entry) => entry.id)).toEqual([first.id, second.id])
  expect(db.select().from(sessionSplits).get()).toMatchObject({
    parentSessionId: id,
    firstSessionId: first.id,
    secondSessionId: second.id,
    splitAt: at('10:08'),
    startedAt: at('10:00'),
    endedAt: at('10:20'),
    legacyRecordId: null
  })
  const decision = db.select().from(sessionMappingDecisions).get()!
  expect(decision.basePolicyRevisionId).toBe(decision.targetPolicyRevisionId)
  expect(JSON.parse(decision.requestJson)).toMatchObject({ operation: 'split', sessionId: id })
  expect(db.select().from(sessionMappingOutcomes).get()).toMatchObject({ decisionId: decision.id })
  const revisions = db
    .select()
    .from(sessionMappingRevisions)
    .where(eq(sessionMappingRevisions.kind, 'split'))
    .all()
  expect(revisions.map((entry) => entry.sessionId).sort((a, b) => a - b)).toEqual([
    first.id,
    second.id
  ])
  for (const revision of revisions) {
    expect(revision.decisionId).toBe(decision.id)
    expect(revision.snapshotJson).toBe(JSON.stringify(mapping(revision.sessionId)))
  }
  expect(db.select().from(sessionMappingEdges).all()).toEqual(
    expect.arrayContaining(
      revisions.map((entry) => ({ childRevisionId: entry.id, parentRevisionId: head.revisionId }))
    )
  )
  expect(isExactCanonicalPartition(snapshot(id), [snapshot(first.id), snapshot(second.id)])).toBe(
    true
  )
  const current = plan()
  expect(current).toMatchObject({ status: 'applicable', activeSessionIds: [first.id, second.id] })
  expect(current.successors.map((entry) => [entry.kind, entry.keepSessionId])).toEqual([
    ['continue', first.id],
    ['continue', second.id]
  ])
  expect(current.successors.every((entry) => entry.intervalUnchanged)).toBe(true)
  expect(sqlite.pragma('foreign_key_check')).toEqual([])
})

it('clips a cut inside a gap so each part owns its own time and progress once', () => {
  const [id] = seed()
  const [first, second] = splitMappedSession(db, id, at('10:10'))
  expect(first).toMatchObject({ endedAt: at('10:10'), durationMinutes: 10, promptCount: 2 })
  expect(second).toMatchObject({ startedAt: at('10:10'), durationMinutes: 10, promptCount: 1 })
  const [left, right] = [snapshot(first.id), snapshot(second.id)]
  expect(left.coverage.messages.map((item: { eventId: string }) => item.eventId)).toEqual([
    'm0',
    'm1',
    'm2'
  ])
  expect(right.coverage.messages.map((item: { eventId: string }) => item.eventId)).toEqual([
    'm3',
    'm4',
    'm5'
  ])
  expect(left.coverage.continuity.at(-1)).toMatchObject({
    from: { eventId: 'm2' },
    to: { eventId: 'm3' },
    startedAt: at('10:08'),
    endedAt: at('10:10'),
    progress: [{ eventId: 'p1' }]
  })
  expect(right.coverage.continuity[0]).toMatchObject({
    from: { eventId: 'm2' },
    to: { eventId: 'm3' },
    startedAt: at('10:10'),
    endedAt: at('10:12'),
    progress: [{ eventId: 'p2' }]
  })
  expect(isExactCanonicalPartition(snapshot(id), [left, right])).toBe(true)
})

it('keeps part ids on append and treats a copied source as the same conversation', () => {
  const [id] = seed()
  const [first, second] = splitMappedSession(db, id, at('10:08'))
  message('m6', 'm5', '10:30')
  expect(reconcileMappedSource(db, [detected(source)], source)).toBe(2)
  expect(active()).toMatchObject([
    { id: first.id, endedAt: at('10:08'), durationMinutes: 8, promptCount: 1 },
    {
      id: second.id,
      startedAt: at('10:08'),
      endedAt: at('10:30'),
      durationMinutes: 22,
      promptCount: 3
    }
  ])
  expect(db.select().from(sessions).all()).toHaveLength(3)
  const before = sqlite.serialize()
  expect(reconcileMappedSource(db, [detected(copy)], copy)).toBe(2)
  expect(sqlite.serialize()).toEqual(before)
  expect(plan().successors.every((entry) => entry.intervalUnchanged)).toBe(true)
})

it('splits parts again with telescoping minutes, including a message-free gap part', () => {
  const [id] = seed()
  const [first, second] = splitMappedSession(db, id, at('10:08:30'))
  expect([first.durationMinutes, second.durationMinutes]).toEqual([9, 11])
  const [middle, last] = splitMappedSession(db, second.id, at('10:12:45'))
  expect(middle).toMatchObject({
    startedAt: at('10:08:30'),
    endedAt: at('10:12:45'),
    durationMinutes: 4,
    promptCount: 0,
    inputTokens: 200,
    outputTokens: 20
  })
  expect(last).toMatchObject({ durationMinutes: 7, promptCount: 1, inputTokens: 300 })
  const [gap, rest] = splitMappedSession(db, middle.id, at('10:10'))
  expect(gap).toMatchObject({
    durationMinutes: 1,
    promptCount: 0,
    inputTokens: 0,
    outputTokens: 0
  })
  expect(rest).toMatchObject({ durationMinutes: 3, promptCount: 0, inputTokens: 200 })
  expect(usageOf(gap.id)).toEqual([])
  expect(snapshot(gap.id).coverage).toMatchObject({
    messages: [],
    continuity: [
      {
        from: { eventId: 'm2' },
        to: { eventId: 'm3' },
        startedAt: at('10:08:30'),
        endedAt: at('10:10'),
        progress: [{ eventId: 'p1' }]
      }
    ]
  })
  expect(active().map((entry) => entry.id)).toEqual([first.id, last.id, gap.id, rest.id])
  expect(active().reduce((sum, entry) => sum + entry.durationMinutes, 0)).toBe(20)
  expect(active().reduce((sum, entry) => sum + entry.inputTokens, 0)).toBe(600)
  message('m6', 'm5', '10:30')
  expect(reconcileMappedSource(db, [detected(source)], source)).toBe(4)
  expect(row(last.id)).toMatchObject({ endedAt: at('10:30'), durationMinutes: 17, promptCount: 2 })
  expect(active().map((entry) => entry.id)).toEqual([first.id, last.id, gap.id, rest.id])
})

it('keeps an edited start with the earlier part and its override only', () => {
  const [id] = seed()
  db.update(sessions)
    .set({ startedAt: '2026-09-26T09:55:00.000Z' })
    .where(eq(sessions.id, id))
    .run()
  db.insert(sessionTimeOverrides).values({ sessionId: id, startedAt: 1 }).run()
  const [first, second] = splitMappedSession(db, id, at('10:08'))
  expect(first).toMatchObject({ startedAt: '2026-09-26T09:55:00.000Z', durationMinutes: 8 })
  expect(overrides(first.id)).toMatchObject({ startedAt: 1, endedAt: 0, durationMinutes: 0 })
  expect(overrides(second.id)).toMatchObject({ startedAt: 0, endedAt: 0, durationMinutes: 0 })
  expect(
    db.select().from(sessionDerivations).where(eq(sessionDerivations.sessionId, first.id)).get()
  ).toMatchObject({ startedAt: at('10:00'), endedAt: at('10:08') })
  expect(plan().successors[0]).toMatchObject({
    keepSessionId: first.id,
    preservedTimeFields: ['startedAt']
  })
})

it.each<[string, (id: number) => void, RegExp, string?]>([
  [
    'an edited duration',
    (id) => {
      db.update(sessions).set({ durationMinutes: 25 }).where(eq(sessions.id, id)).run()
      db.insert(sessionTimeOverrides).values({ sessionId: id, durationMinutes: 1 }).run()
    },
    /edited duration/
  ],
  [
    // Equal today, but frozen: a later append to a part would never update its duration.
    'an explicit duration override equal to the measurement',
    (id) => {
      db.insert(sessionTimeOverrides).values({ sessionId: id, durationMinutes: 1 }).run()
    },
    /edited duration/
  ],
  [
    'an edited start after the split point',
    (id) => {
      db.update(sessions)
        .set({ startedAt: at('10:09') })
        .where(eq(sessions.id, id))
        .run()
      db.insert(sessionTimeOverrides).values({ sessionId: id, startedAt: 1 }).run()
    },
    /edited start/
  ],
  ['unsaved new activity', () => message('m6', 'm5', '10:30'), /Scan for sessions/],
  [
    'unresolved retained evidence',
    () =>
      db
        .insert(activityObservations)
        .values({
          id: 'observation-conflict',
          eventId: 'm0',
          version: 1,
          kind: 'message',
          createdAt: at('10:00'),
          payloadJson: '{}'
        })
        .run(),
    /history review/
  ],
  ['a point outside measured activity', () => undefined, /between the measured/, at('10:25')],
  [
    'a failed receipt write',
    () =>
      sqlite.exec(
        "CREATE TRIGGER fail_outcome BEFORE INSERT ON session_mapping_outcomes BEGIN SELECT RAISE(ABORT, 'fixture failure'); END"
      ),
    /fixture failure/
  ]
])('refuses a split with %s without writes', (_label, change, error, splitAt = at('10:08')) => {
  const [id] = seed()
  change(id)
  const before = sqlite.serialize()
  expect(() => splitMappedSession(db, id, splitAt)).toThrow(error)
  expect(sqlite.serialize()).toEqual(before)
})

it('preserves billed audit and exclusions across a split and later growth', () => {
  const [id] = seed()
  const client = db.insert(clients).values({ name: 'Billed', color: 'red' }).returning().get()
  const invoice = db
    .insert(invoices)
    .values({
      clientId: client.id,
      stripeInvoiceId: 'in_split',
      status: 'paid',
      amountPaidCents: 100
    })
    .returning()
    .get()
  db.insert(invoiceLineItems)
    .values({
      invoiceId: invoice.id,
      description: 'Issued',
      amountCents: 100,
      durationMinutes: 20,
      sessionIds: String(id)
    })
    .run()
  const lines = db.select().from(invoiceLineItems).all()
  const [, second] = splitMappedSession(db, id, at('10:08'))
  expect(db.select().from(sessionBillingRefs).all()).toMatchObject([
    {
      sessionId: id,
      stripeInvoiceId: 'in_split',
      billedRanges: [{ sessionId: id, startedAt: at('10:00'), endedAt: at('10:20') }]
    }
  ])
  expect(unbilledSessions(db, active(), false)).toEqual([])
  message('m6', 'm5', '10:30')
  expect(reconcileMappedSource(db, [detected(source)], source)).toBe(2)
  expect(unbilledSessions(db, active(), false)).toMatchObject([
    { id: second.id, startedAt: at('10:20'), endedAt: at('10:30') }
  ])
  expect(db.select().from(invoiceLineItems).all()).toEqual(lines)
  expect(db.select().from(invoices).all()).toEqual([invoice])
})

it('suppresses deleted coverage through copies and rebuilds while later independent work continues', () => {
  const [kept, deleted] = twoIntervals()
  const saved = row(deleted)
  deleteMappedSession(db, deleted)
  expect(db.select().from(sessionDeletions).all()).toMatchObject([
    { sessionId: deleted, startedAt: at('10:40'), endedAt: at('10:45'), legacyRecordId: null }
  ])
  const decision = db.select().from(sessionMappingDecisions).get()!
  expect(JSON.parse(decision.requestJson)).toMatchObject({
    operation: 'delete',
    sessionId: deleted
  })
  expect(JSON.parse(db.select().from(sessionMappingOutcomes).get()!.resultJson)).toMatchObject({
    retiredSessionIds: [deleted]
  })
  expect(row(deleted)).toEqual(saved)
  expect(active().map((entry) => entry.id)).toEqual([kept])
  const conversation = ledger()
  expect(conversation.before.map((interval) => interval.startedAt)).toEqual([at('10:00')])
  expect(conversation.operations).toMatchObject({
    deletedSessionIds: [deleted],
    suppressed: { before: [{ sessionIds: [deleted], startedAt: at('10:40') }] },
    conflicts: { before: [], after: [] }
  })
  let before = sqlite.serialize()
  expect(reconcileMappedSource(db, [detected(copy)], copy)).toBe(1)
  expect(reconcileMappedSource(db, [detected(source)], source)).toBe(1)
  expect(sqlite.serialize()).toEqual(before)
  message('m4', 'm3', '11:30')
  expect(reconcileMappedSource(db, [detected(source)], source)).toBe(2)
  expect(active()).toMatchObject([
    { id: kept },
    {
      startedAt: at('11:30'),
      sourceFile: source,
      projectPath: 'C:/fixture',
      description: null,
      billable: 1
    }
  ])
  before = sqlite.serialize()
  expect(reconcileMappedSource(db, [detected(copy)], copy)).toBe(2)
  expect(sqlite.serialize()).toEqual(before)
  expect(db.select().from(sessionDeletions).all()).toHaveLength(1)
})

it('plans later work of a conversation whose only adopted session was deleted', () => {
  message('m0', null, '10:00')
  message('m1', 'm0', '10:05', 'assistant', tokens(100, 10), 'model-a')
  const [id] = adopt(save())
  deleteMappedSession(db, id)
  expect(plan()).toMatchObject({
    status: 'applicable',
    activeSessionIds: [],
    successors: [],
    suppressed: [{ sessionIds: [id], startedAt: at('10:00'), endedAt: at('10:05') }]
  })
  message('m2', 'm1', '11:00')
  const keys = ['["claude","conversation"]']
  const preview = previewSessionMappingTransitions(db, policy, keys)
  const decisionId = randomUUID()
  const reviewed = planSessionMappingApplication(preview, decisionId).conversations[0]
  expect(reviewed.successors).toMatchObject([
    {
      kind: 'adopt',
      sourceSessionId: id,
      metadata: { projectPath: 'C:/fixture', description: null, billable: 1 }
    }
  ])
  const result = applySessionMappingApplication(db, {
    decisionId,
    candidate: policy,
    expectedFingerprint: preview.fingerprint,
    choices: [],
    acknowledgedHeld: [],
    conversationKeys: keys
  })
  expect(result.appliedSessionIds).toHaveLength(1)
  expect(active()).toMatchObject([{ startedAt: at('11:00'), sourceFile: source }])
  expect(db.select().from(sessionDeletions).all()).toHaveLength(1)
})

// Requires the scanner hook: deleted coverage orders new work like a kept interval.
it('scans later work of a conversation whose only adopted session was deleted', () => {
  message('m0', null, '10:00')
  message('m1', 'm0', '10:05', 'assistant', tokens(100, 10), 'model-a')
  const [id] = adopt(save())
  deleteMappedSession(db, id)
  expect(reconcileMappedSource(db, [detected(source)], source)).toBe(0)
  message('m2', 'm1', '11:00')
  expect(reconcileMappedSource(db, [detected(source)], source)).toBe(1)
  expect(active()).toMatchObject([{ startedAt: at('11:00'), sourceFile: source }])
})

it('holds later work that continues across deleted coverage instead of counting or hiding it', () => {
  const [kept, deleted] = twoIntervals()
  deleteMappedSession(db, deleted)
  message('m4', 'm3', '10:50')
  const held = plan()
  expect(held.status).toBe('held')
  expect(held.heldReasons).toContain('history-operation-conflict')
  const conversation = ledger()
  expect(conversation.before.map((interval) => interval.startedAt)).toEqual([at('10:00')])
  expect(conversation.operations?.conflicts.before).toMatchObject([
    { sessionIds: [deleted], startedAt: at('10:40'), endedAt: at('10:50') }
  ])
  const before = sqlite.serialize()
  expect(() => reconcileMappedSource(db, [detected(source)], source)).toThrow(
    SessionReconciliationError
  )
  expect(() => splitMappedSession(db, kept, at('10:02'))).toThrow(/history review/)
  expect(() => deleteMappedSession(db, kept)).toThrow(/history review/)
  expect(sqlite.serialize()).toEqual(before)
})

it('holds a late branch between kept and deleted coverage', () => {
  const [, deleted] = twoIntervals()
  deleteMappedSession(db, deleted)
  // This late copy forks from the kept interval. It must remain held rather than
  // being admitted as independent work before the deleted interval.
  message('late', 'm1', '10:22')
  expect(plan().status).toBe('held')
  const before = sqlite.serialize()
  expect(() => reconcileMappedSource(db, [detected(source)], source)).toThrow(
    SessionReconciliationError
  )
  expect(sqlite.serialize()).toEqual(before)
})

function reviewed(candidate = policy) {
  const preview = previewSessionMappingTransitions(db, candidate)
  const decisionId = randomUUID()
  return {
    decisionId,
    candidate,
    expectedFingerprint: preview.fingerprint,
    choices: [],
    acknowledgedHeld: mappingHeldKeys(planSessionMappingApplication(preview, decisionId))
  }
}
const key = '["claude","conversation"]'

it('releases a policy hold through deletions that observed it, then scans later work', () => {
  message('m0', null, '10:00')
  message('m1', 'm0', '10:05', 'assistant', tokens(100, 10), 'model-a')
  const [id] = adopt(save())
  db.update(sessions).set({ status: 'active' }).where(eq(sessions.id, id)).run()
  const wider = { ...policy, idleTimeoutMinutes: 20 }
  const change = reviewed(wider)
  expect(change.acknowledgedHeld).toEqual([key])
  applySessionMappingApplication(db, change)
  db.update(sessions).set({ status: 'completed' }).where(eq(sessions.id, id)).run()
  expect(() => deleteMappedSession(db, id)).toThrow(/earlier tracking policy/)
  applySessionMappingApplication(db, reviewed(wider))
  deleteMappedSession(db, id)
  const deletion = db
    .select()
    .from(sessionMappingDecisions)
    .all()
    .find((row) => JSON.parse(row.requestJson).operation === 'delete')!
  expect(deletion.targetPolicyRevisionId).toBe(change.decisionId)
  expect(JSON.parse(deletion.observedDecisionIdsJson)).toEqual([change.decisionId])

  // A deletion that did not observe the hold cannot release it.
  sqlite.exec('DROP TRIGGER mapping_decision_no_update')
  const observed = deletion.observedDecisionIdsJson
  const forge = (value: string) =>
    db
      .update(sessionMappingDecisions)
      .set({ observedDecisionIdsJson: value })
      .where(eq(sessionMappingDecisions.id, deletion.id))
      .run()
  forge('[]')
  const before = sqlite.serialize()
  expect(() => reconcileMappedSource(db, [detected(source)], source)).toThrow(
    /none of its sessions remain/
  )
  expect(sqlite.serialize()).toEqual(before)
  forge(observed)

  expect(reconcileMappedSource(db, [detected(source)], source)).toBe(0)
  message('m2', 'm1', '11:00')
  expect(reconcileMappedSource(db, [detected(source)], source)).toBe(1)
  expect(active()).toMatchObject([{ startedAt: at('11:00'), sourceFile: source }])
  // The adopted head observed the hold, so later growth continues normally.
  message('m3', 'm2', '11:05')
  expect(reconcileMappedSource(db, [detected(source)], source)).toBe(1)
  expect(active()).toMatchObject([{ startedAt: at('11:00'), endedAt: at('11:05') }])
})

it('lets a policy change proceed past a conflicting conversation whose rows were all deleted', () => {
  message('m0', null, '10:00')
  message('m1', 'm0', '10:05', 'assistant', tokens(100, 10), 'model-a')
  const [id] = adopt(save())
  deleteMappedSession(db, id)
  message('m2', 'm1', '10:10')
  const wider = { ...policy, idleTimeoutMinutes: 20 }
  const change = reviewed(wider)
  const preview = previewSessionMappingTransitions(db, wider)
  const held = planSessionMappingApplication(preview, change.decisionId).conversations[0]
  expect(held).toMatchObject({ status: 'held', activeSessionIds: [] })
  expect(held.heldReasons).toContain('history-operation-conflict')
  expect(change.acknowledgedHeld).toEqual([key])
  applySessionMappingApplication(db, change)
  expect(getWorkspacePolicy(db)?.policy).toEqual(wider)
  // Still managed and held through its deletion mask; never re-measured by raw scans.
  const before = sqlite.serialize()
  expect(() => reconcileMappedSource(db, [detected(source)], source)).toThrow(
    /none of its sessions remain/
  )
  expect(sqlite.serialize()).toEqual(before)
  expect(active()).toEqual([])
  expect(db.select().from(sessionDeletions).all()).toHaveLength(1)
})

describe('operation proofs', () => {
  let parts: [Session, Session]
  let deleted: number
  const decisionOf = (operation: string) =>
    db
      .select()
      .from(sessionMappingDecisions)
      .all()
      .find((row) => JSON.parse(row.requestJson).operation === operation)!
  const editPlan = (operation: string, change: Record<string, unknown>) => {
    const decision = decisionOf(operation)
    db.update(sessionMappingDecisions)
      .set({ planJson: JSON.stringify({ ...JSON.parse(decision.planJson), ...change }) })
      .where(eq(sessionMappingDecisions.id, decision.id))
      .run()
  }
  beforeEach(() => {
    // Deliberately corrupt only this disposable fixture to exercise read-side proofs.
    sqlite.exec(
      'DROP TRIGGER mapping_decision_no_update; DROP TRIGGER mapping_outcome_no_delete; DROP TRIGGER mapping_edge_no_delete; DROP TRIGGER mapping_revision_no_update'
    )
    const [first, second] = twoIntervals()
    deleted = second
    parts = splitMappedSession(db, first, at('10:03'))
    deleteMappedSession(db, deleted)
  })

  it('proves split and deletion operations that parts have advanced past', () => {
    expect(plan().status).toBe('applicable')
    expect(ledger().operations).toMatchObject({ cuts: [at('10:03')], invalid: [] })
    const wider = { ...policy, idleTimeoutMinutes: 20 }
    applySessionMappingApplication(db, reviewed(wider))
    // Current part heads are policy revisions now; the original split revisions are ancestors.
    expect(
      db
        .select()
        .from(sessionMappingRevisions)
        .where(eq(sessionMappingRevisions.id, mapping(parts[1].id).revisionId!))
        .get()?.kind
    ).toBe('policy')
    expect(ledger(wider).operations).toMatchObject({ cuts: [at('10:03')], invalid: [] })
    const [, last] = splitMappedSession(db, parts[1].id, at('10:04'))
    expect(ledger(wider).operations).toMatchObject({
      cuts: [at('10:03'), at('10:04')],
      invalid: []
    })
    expect(plan(wider).status).toBe('applicable')
    expect(last.endedAt).toBe(at('10:05'))
  })

  it.each<[string, () => void]>([
    [
      'a deletion without its decision',
      () => {
        const interval = snapshot(parts[1].id)
        db.insert(sessionDeletions)
          .values({
            id: randomUUID(),
            sessionId: parts[1].id,
            sourceFile: source,
            tool: 'claude',
            claudeSessionId: 'conversation',
            startedAt: interval.startedAt,
            endedAt: interval.endedAt,
            createdAt: at('12:00'),
            legacyRecordId: null
          })
          .run()
      }
    ],
    [
      'a deletion without its receipt',
      () =>
        db
          .delete(sessionMappingOutcomes)
          .where(eq(sessionMappingOutcomes.decisionId, decisionOf('delete').id))
          .run()
    ],
    ['a deletion decision for other coverage', () => editPlan('delete', { coverageHash: 'x' })],
    ['a deletion decision for another session', () => editPlan('delete', { sessionId: 999 })],
    [
      'a deletion decision that never observed the retired head',
      () =>
        db
          .update(sessionMappingDecisions)
          .set({ baseHeadsJson: '[]' })
          .where(eq(sessionMappingDecisions.id, decisionOf('delete').id))
          .run()
    ],
    [
      'a moved split instant',
      () =>
        db
          .update(sessionSplits)
          .set({ splitAt: at('10:02') })
          .run()
    ],
    ['a split decision for another instant', () => editPlan('split', { splitAt: at('10:02') })],
    ['a split decision with forged parts', () => editPlan('split', { parts: [] })],
    [
      'a split part without its original edge',
      () =>
        db
          .delete(sessionMappingEdges)
          .where(eq(sessionMappingEdges.childRevisionId, mapping(parts[0].id).revisionId!))
          .run()
    ],
    [
      'a split part whose original revision is not a split',
      () =>
        db
          .update(sessionMappingRevisions)
          .set({ kind: 'continue' })
          .where(eq(sessionMappingRevisions.id, mapping(parts[0].id).revisionId!))
          .run()
    ],
    [
      'a duplicate forged split decision',
      () => {
        const decision = decisionOf('split')
        db.insert(sessionMappingDecisions)
          .values({ ...decision, id: randomUUID() })
          .run()
      }
    ],
    [
      'a split without its receipt',
      () =>
        db
          .delete(sessionMappingOutcomes)
          .where(eq(sessionMappingOutcomes.decisionId, decisionOf('split').id))
          .run()
    ]
  ])('holds the conversation for %s without writes', (_label, tamper) => {
    expect(plan().status).toBe('applicable')
    tamper()
    const held = plan()
    expect(held.status).toBe('held')
    expect(held.heldReasons).toContain('history-operation-conflict')
    expect(ledger().operations?.invalid.length).toBeGreaterThan(0)
    const before = sqlite.serialize()
    expect(() => reconcileMappedSource(db, [detected(source)], source)).toThrow(
      SessionReconciliationError
    )
    expect(() => splitMappedSession(db, parts[0].id, at('10:01'))).toThrow()
    expect(() => deleteMappedSession(db, parts[0].id)).toThrow()
    expect(sqlite.serialize()).toEqual(before)
  })
})

it('refuses to delete while new activity is unsaved, without writes', () => {
  const [id] = seed()
  message('m6', 'm5', '10:30')
  const before = sqlite.serialize()
  expect(() => deleteMappedSession(db, id)).toThrow(/Scan for sessions/)
  expect(sqlite.serialize()).toEqual(before)
})

describe('portable journal', () => {
  const workspaceId = '3f0c1b8e-7a52-4c1d-9e4b-2d6f8a1c5e70'
  const history = () => db.select().from(syncChanges).all()
  beforeEach(() => {
    db.insert(folderSyncSettings).values({ slot: 1, workspaceId, folderPath: 'C:/sync' }).run()
  })

  it('journals a split as a canonical fact inside the split transaction', () => {
    const [id] = seed()
    const [first] = splitMappedSession(db, id, '2026-09-26T10:08:00Z')
    const rows = history()
    expect(rows).toMatchObject([
      { workspaceId, kind: 'fact', entityType: 'session-split', origin: 'local' }
    ])
    const change = JSON.parse(rows[0].changeJson)
    expect(change.payload).toEqual({
      version: 1,
      provider: 'claude',
      conversationId: 'conversation',
      splitAt: at('10:08')
    })
    expect(change.dependencies).toEqual([])
    for (const local of [String(id), String(first.id), source, 'C:/fixture'])
      expect(rows[0].changeJson).not.toContain(`"${local}"`)
    // The union of the proven local cut and its own fact is still one cut.
    expect(ledger().operations).toMatchObject({ cuts: [at('10:08')], invalid: [] })
    expect(plan().status).toBe('applicable')

    // A failed journal write rolls the whole split back with it.
    sqlite.exec(
      "CREATE TRIGGER fail_journal BEFORE INSERT ON sync_changes BEGIN SELECT RAISE(ABORT, 'journal failure'); END"
    )
    const before = sqlite.serialize()
    expect(() => splitMappedSession(db, first.id, at('10:04'))).toThrow(/journal failure/)
    expect(sqlite.serialize()).toEqual(before)
    expect(history()).toHaveLength(1)
  })

  it('refuses a deletion whose coverage cannot be exported, without writes', () => {
    // These fixtures use non-canonical event IDs, which no portable fact may carry.
    const [, deleted] = twoIntervals()
    const before = sqlite.serialize()
    expect(() => deleteMappedSession(db, deleted)).toThrow(/unrecognized event ID/)
    expect(sqlite.serialize()).toEqual(before)
    expect(history()).toEqual([])
  })
})

it('keeps cuts and deletion masks under a reviewed policy change', () => {
  const [first, deleted] = twoIntervals()
  const [a, b] = splitMappedSession(db, first, at('10:03'))
  deleteMappedSession(db, deleted)
  const wider = { ...policy, idleTimeoutMinutes: 20 }
  const preview = previewSessionMappingTransitions(db, wider)
  const conversation = preview.history.conversations[0]
  if (conversation.status !== 'resolved') throw new Error('Unresolved fixture')
  expect(conversation.after.map((interval) => [interval.startedAt, interval.endedAt])).toEqual([
    [at('10:00'), at('10:03')],
    [at('10:03'), at('10:05')]
  ])
  expect(conversation.operations).toMatchObject({
    cuts: [at('10:03')],
    deletedSessionIds: [deleted],
    suppressed: { after: [{ sessionIds: [deleted], startedAt: at('10:40') }] }
  })
  const decisionId = randomUUID()
  const reviewed = planSessionMappingApplication(preview, decisionId)
  expect(reviewed.conversations[0]).toMatchObject({
    status: 'applicable',
    suppressed: [{ sessionIds: [deleted], startedAt: at('10:40'), endedAt: at('10:45') }]
  })
  expect(reviewed.conversations[0].successors.map((row) => [row.kind, row.keepSessionId])).toEqual([
    ['policy', a.id],
    ['policy', b.id]
  ])
  // A policy joining deleted coverage to kept work holds instead of counting it again.
  const merged = plan({ ...policy, idleTimeoutMinutes: 40 })
  expect(merged.status).toBe('held')
  expect(merged.heldReasons).toContain('history-operation-conflict')
  applySessionMappingApplication(db, {
    decisionId,
    candidate: wider,
    expectedFingerprint: preview.fingerprint,
    choices: [],
    acknowledgedHeld: mappingHeldKeys(reviewed)
  })
  expect(getWorkspacePolicy(db)?.policy).toEqual(wider)
  expect(active().map((entry) => entry.id)).toEqual([a.id, b.id])
  expect(db.select().from(sessionDeletions).all()).toHaveLength(1)
  const settled = plan(wider).successors
  expect(settled.every((row) => row.kind === 'continue' && row.intervalUnchanged)).toBe(true)
  // Parts adopted under the new policy can be split again.
  expect(splitMappedSession(db, b.id, at('10:04'))).toHaveLength(2)
})

describe('Codex checkpoints', () => {
  let directory: string
  const minute = (value: number) =>
    new Date(Date.parse('2026-09-26T03:00:00Z') + value * 60_000).toISOString()
  const item = (value: number, role: string) => ({
    timestamp: minute(value),
    type: 'response_item',
    payload: {
      type: 'message',
      role,
      content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: 'fixture' }]
    }
  })
  const checkpoint = (value: number, input: number, output: number) => ({
    timestamp: minute(value),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: input, cached_input_tokens: 20, output_tokens: output }
      }
    }
  })
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'clautime-codex-operations-'))
  })
  afterEach(() => {
    const target = resolve(directory)
    if (
      !target.startsWith(resolve(tmpdir()) + sep) ||
      !target.includes('clautime-codex-operations-')
    )
      throw new Error('Invalid fixture path')
    rmSync(target, { recursive: true, force: true })
  })

  it('keeps a later checkpoint with its owning message across the cut', async () => {
    const path = join(directory, 'fixture.jsonl')
    writeFileSync(
      path,
      [
        {
          timestamp: minute(0),
          type: 'session_meta',
          payload: { id: 'codex-split-fixture', cwd: 'C:/fixture' }
        },
        { timestamp: minute(0), type: 'turn_context', payload: { model: 'fixture-model' } },
        item(0, 'user'),
        item(1, 'assistant'),
        checkpoint(4, 100, 10),
        item(6, 'user'),
        item(7, 'assistant'),
        checkpoint(7.5, 250, 30)
      ]
        .map((line) => JSON.stringify(line))
        .join('\n')
    )
    const parsed = (await parseCodexSessionFile(path))!
    expect(parsed.codexActivityEvidence?.status).toBe('captured')
    db.transaction((tx) => storeActivityEvidence(tx, parsed, minute(10)))
    const [id] = adopt(save('codex', 'codex-split-fixture'))
    const [first, second] = splitMappedSession(db, id, minute(3))
    expect(first).toMatchObject({ promptCount: 1, inputTokens: 80, outputTokens: 10 })
    expect(second).toMatchObject({ promptCount: 1, inputTokens: 150, outputTokens: 20 })
    expect(usageOf(first.id)).toEqual([{ model: 'fixture-model', ...tokens(80, 10, 0, 20) }])
    const [left, right] = [snapshot(first.id), snapshot(second.id)]
    expect(left.coverage.version).toBe(2)
    expect(left.coverage.usage).toMatchObject([{ timestamp: minute(4) }])
    expect(right.coverage.usage).toMatchObject([{ timestamp: minute(7.5) }])
    // The checkpoint's time evidence stays in the later gap; its usage does not.
    expect(
      right.coverage.continuity[0].progress.map((entry: { timestamp: string }) => entry.timestamp)
    ).toContain(minute(4))
    expect(isExactCanonicalPartition(snapshot(id), [left, right])).toBe(true)
    const settled = plan().successors
    expect(settled.every((row) => row.kind === 'continue' && row.intervalUnchanged)).toBe(true)
  })

  // Known limitation (P2-4): a checkpoint belongs to the latest assistant so far, even across
  // an idle gap. Resumed usage owned by deleted coverage is held, never silently moved to the
  // resumed work, until a versioned ownership rule (normalizationVersion bump) exists.
  it('holds resumed usage owned by deleted coverage instead of redistributing it', async () => {
    const path = join(directory, 'resumed.jsonl')
    const head = [
      {
        timestamp: minute(0),
        type: 'session_meta',
        payload: { id: 'codex-resumed-fixture', cwd: 'C:/fixture' }
      },
      { timestamp: minute(0), type: 'turn_context', payload: { model: 'fixture-model' } },
      item(0, 'user'),
      item(1, 'assistant'),
      checkpoint(2, 100, 10)
    ]
    const store = async (lines: unknown[], observedAt: number) => {
      writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n'))
      const parsed = (await parseCodexSessionFile(path))!
      db.transaction((tx) => storeActivityEvidence(tx, parsed, minute(observedAt)))
    }
    await store(head, 5)
    const [id] = adopt(save('codex', 'codex-resumed-fixture'))
    deleteMappedSession(db, id)
    expect(plan().status).toBe('applicable')
    const mask = snapshot(id)
    // After the idle gap an aborted turn records usage before any assistant item.
    await store([...head, item(30, 'user'), checkpoint(31, 180, 25)], 35)
    const held = plan()
    expect(held).toMatchObject({ status: 'held', activeSessionIds: [] })
    expect(held.heldReasons).toContain('history-operation-conflict')
    // Evidence is preserved: the deletion, its mask and the checkpoint are all retained.
    expect(db.select().from(sessionDeletions).all()).toMatchObject([{ sessionId: id }])
    expect(snapshot(id)).toEqual(mask)
    const operations = ledger().operations!
    expect(operations.conflicts.before.length + operations.invalid.length).toBeGreaterThan(0)
    expect(active()).toEqual([])
  })
})
