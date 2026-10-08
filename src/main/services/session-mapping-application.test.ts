// @vitest-environment node
import { beforeEach, afterEach, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { activityIdentities, activityObservations } from '../db/schema/activity-evidence'
import { sessions } from '../db/schema/sessions'
import { sessionDerivations, sessionTimeOverrides } from '../db/schema/session-derivations'
import { sessionActivityMappings } from '../db/schema/session-activity-mappings'
import {
  sessionMappingRevisions,
  sessionMappingEdges
} from '../db/schema/session-mapping-revisions'
import { sessionBillingRefs, sessionReplacements } from '../db/schema/session-history'
import { activeSessionCondition } from '../db/schema/session-deletions'
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
import { unbilledSessions } from './session-billing'

let sqlite: Database.Database
let db: ReturnType<typeof drizzle>
const policy = {
  version: 1,
  normalizationVersion: 1,
  detectorVersion: 1,
  idleTimeoutMinutes: 15,
  reportingTimeZone: 'UTC'
}
const at = (time: string) => `2026-09-26T${time}:00.000Z`
beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  adoptInitialWorkspacePolicy(db, { workspaceId: randomUUID(), revisionId: randomUUID(), policy })
})
afterEach(() => sqlite.close())

function message(id: string, parent: string | null, time: string, conversationId = 'conversation') {
  db.insert(activityIdentities)
    .values({
      eventId: id,
      provider: 'claude',
      conversationId,
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
      kind: 'message',
      createdAt: at(time),
      payloadJson: JSON.stringify({
        type: 'user',
        timestamp: at(time),
        parentEventId: parent,
        model: null,
        usage: null,
        isToolResult: false,
        hasToolUse: false,
        toolNames: []
      })
    })
    .run()
}
function seed(times = ['03:50', '04:00', '04:10']) {
  times.forEach((time, index) =>
    message(`event-${index}`, index ? `event-${index - 1}` : null, time)
  )
  const conversation = previewLedgerWorkspacePolicy(db, policy).conversations[0]
  if (conversation.status !== 'resolved') throw new Error('Unresolved fixture')
  const ids = conversation.before.map((interval) => {
    const row = db
      .insert(sessions)
      .values({
        projectPath: 'C:/fixture',
        sourceFile: 'C:/fixture/log.jsonl',
        tool: 'claude',
        claudeSessionId: 'conversation',
        startedAt: interval.startedAt,
        endedAt: interval.endedAt,
        durationMinutes: interval.durationMinutes,
        promptCount: interval.promptCount,
        inputTokens: interval.inputTokens,
        outputTokens: interval.outputTokens,
        description: 'Preserve this description',
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
    return row.id
  })
  adoptSessionActivityMappings(db, previewSessionActivityAdoption(db).fingerprint, ids)
  return ids
}
function request(candidate = policy) {
  const preview = previewSessionMappingTransitions(db, candidate)
  const decisionId = randomUUID()
  const plan = planSessionMappingApplication(preview, decisionId)
  return {
    decisionId,
    candidate,
    expectedFingerprint: preview.fingerprint,
    choices: [],
    acknowledgedHeld: mappingHeldKeys(plan)
  }
}

it('advances an appended mapping in place, preserving edits, origins and frozen billed ranges', () => {
  const [id] = seed()
  const origin = db.select().from(sessionMappingRevisions).get()!
  const old = db.select().from(sessions).get()!
  db.insert(sessionBillingRefs)
    .values({
      sessionId: id,
      stripeInvoiceId: 'in_fixture',
      testMode: 0,
      billedRanges: [
        {
          sessionId: id,
          projectId: null,
          clientId: null,
          startedAt: old.startedAt,
          endedAt: old.endedAt
        }
      ]
    })
    .run()
  db.update(sessions).set({ durationMinutes: 99 }).where(eq(sessions.id, id)).run()
  db.insert(sessionTimeOverrides).values({ sessionId: id, durationMinutes: 1 }).run()
  message('event-3', 'event-2', '04:20')
  const decision = request()
  expect(decision.acknowledgedHeld).toEqual([])
  const result = applySessionMappingApplication(db, decision)
  expect(result.appliedSessionIds).toEqual([id])
  expect(db.select().from(sessions).get()).toMatchObject({
    id,
    durationMinutes: 99,
    endedAt: at('04:20'),
    promptCount: 4,
    description: old.description,
    billable: 0
  })
  expect(db.select().from(sessionDerivations).get()).toMatchObject({ durationMinutes: 30 })
  expect(
    db.select().from(sessionMappingRevisions).where(eq(sessionMappingRevisions.id, origin.id)).get()
  ).toEqual(origin)
  expect(db.select().from(sessionMappingEdges).get()).toMatchObject({ parentRevisionId: origin.id })
  const active = db.select().from(sessions).where(activeSessionCondition).all()
  expect(unbilledSessions(db, active, false)).toMatchObject([
    { id, startedAt: at('04:10'), endedAt: at('04:20') }
  ])
  const beforeRetry = sqlite.serialize()
  expect(applySessionMappingApplication(db, decision)).toEqual(result)
  expect(sqlite.serialize()).toEqual(beforeRetry)
  message('event-4', 'event-3', '04:30')
  const again = request()
  expect(again.acknowledgedHeld).toEqual([])
  expect(applySessionMappingApplication(db, again).appliedSessionIds).toEqual([id])
  expect(db.select().from(sessionMappingRevisions).all()).toHaveLength(3)
})

it('retains a billed predecessor across a midnight split and permits later clean continuation', () => {
  const [id] = seed()
  const old = db.select().from(sessions).get()!
  db.insert(sessionBillingRefs)
    .values({
      sessionId: id,
      stripeInvoiceId: 'in_fixture',
      testMode: 0,
      billedRanges: [
        {
          sessionId: id,
          projectId: null,
          clientId: null,
          startedAt: old.startedAt,
          endedAt: old.endedAt
        }
      ]
    })
    .run()
  const candidate = { ...policy, reportingTimeZone: 'America/New_York' }
  const decision = request(candidate)
  expect(decision.acknowledgedHeld).toEqual([])
  const result = applySessionMappingApplication(db, decision)
  expect(result.retiredSessionIds).toEqual([id])
  expect(result.appliedSessionIds).toHaveLength(2)
  expect(db.select().from(sessions).where(eq(sessions.id, id)).get()).toEqual(old)
  expect(db.select().from(sessionReplacements).all()).toHaveLength(2)
  expect(
    unbilledSessions(db, db.select().from(sessions).where(activeSessionCondition).all(), false)
  ).toEqual([])
  expect(getWorkspacePolicy(db)?.policy).toEqual(candidate)
  message('event-3', 'event-2', '04:20')
  const again = request(candidate)
  expect(again.acknowledgedHeld).toEqual([])
  expect(applySessionMappingApplication(db, again).appliedSessionIds).toEqual(
    result.appliedSessionIds
  )
  const remaining = unbilledSessions(
    db,
    db.select().from(sessions).where(activeSessionCondition).all(),
    false
  )
  expect(remaining).toMatchObject([{ startedAt: at('04:10'), endedAt: at('04:20') }])
  expect(sqlite.pragma('foreign_key_check')).toEqual([])
})

it('rejects stale reviews and decision reuse with different contents without writes', () => {
  seed()
  const stale = request()
  db.update(sessions).set({ billable: 1 }).run()
  let before = sqlite.serialize()
  expect(() => applySessionMappingApplication(db, stale)).toThrow(/changed/)
  expect(sqlite.serialize()).toEqual(before)
  const decision = request()
  applySessionMappingApplication(db, decision)
  before = sqlite.serialize()
  expect(() =>
    applySessionMappingApplication(db, {
      ...decision,
      candidate: { ...policy, idleTimeoutMinutes: 20 }
    })
  ).toThrow(/different contents/)
  expect(sqlite.serialize()).toEqual(before)
})

it.each(['session_mapping_revisions', 'session_mapping_outcomes', 'workspace_policy_revisions'])(
  'rolls back policy, sessions, parents and decisions when %s fails',
  (table) => {
    seed()
    const decision = request({ ...policy, reportingTimeZone: 'America/New_York' })
    sqlite.exec(
      `CREATE TRIGGER fail_apply BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`
    )
    const before = sqlite.serialize()
    expect(() => applySessionMappingApplication(db, decision)).toThrow(/fixture failure/)
    expect(sqlite.serialize()).toEqual(before)
  }
)

it('requires exact held acknowledgment and retains held rows while applying independent work', () => {
  seed()
  db.update(sessions).set({ status: 'active' }).run()
  message('independent', null, '05:00', 'other')
  const decision = request({ ...policy, idleTimeoutMinutes: 20 })
  expect(decision.acknowledgedHeld).toEqual(['["claude","conversation"]'])
  const before = sqlite.serialize()
  expect(() => applySessionMappingApplication(db, { ...decision, acknowledgedHeld: [] })).toThrow(
    /held history/
  )
  expect(sqlite.serialize()).toEqual(before)
  const saved = db.select().from(sessions).get()!
  const result = applySessionMappingApplication(db, decision)
  expect(result.appliedSessionIds).toHaveLength(1)
  expect(db.select().from(sessions).where(eq(sessions.id, saved.id)).get()).toEqual(saved)
})

it('refuses a modified current mapping even when a fresh preview has matching measurements', () => {
  seed()
  db.update(sessionActivityMappings).set({ previewFingerprint: 'modified' }).run()
  const decision = request()
  const before = sqlite.serialize()
  expect(() => applySessionMappingApplication(db, decision)).toThrow(/mapping needs history review/)
  expect(sqlite.serialize()).toEqual(before)
})

it('applies an acknowledged time reduction without changing its retained facts or audit predecessor', () => {
  const [id] = seed()
  const old = db.select().from(sessions).get()!
  const facts = db.select().from(activityObservations).all()
  const candidate = { ...policy, idleTimeoutMinutes: 5 }
  const preview = previewSessionMappingTransitions(db, candidate)
  const decisionId = randomUUID()
  const pending = planSessionMappingApplication(preview, decisionId)
  const acknowledgedReductions = pending.coverageReductions.map((row) => row.key)
  const plan = planSessionMappingApplication(preview, decisionId, [], acknowledgedReductions)
  const result = applySessionMappingApplication(db, {
    decisionId,
    candidate,
    expectedFingerprint: preview.fingerprint,
    choices: [],
    acknowledgedHeld: mappingHeldKeys(plan),
    acknowledgedReductions
  })
  expect(result.retiredSessionIds).toEqual([id])
  expect(result.appliedSessionIds).toHaveLength(3)
  expect(db.select().from(activityObservations).all()).toEqual(facts)
  expect(db.select().from(sessions).where(eq(sessions.id, id)).get()).toEqual(old)
  expect(
    db
      .select()
      .from(sessions)
      .where(activeSessionCondition)
      .all()
      .map((row) => row.durationMinutes)
  ).toEqual([1, 1, 1])
})

it('scopes scanner continuation to selected conversations and rejects scoped policy changes', () => {
  const [id] = seed()
  message('event-3', 'event-2', '04:20')
  message('independent', null, '05:00', 'other')
  const keys = ['["claude","conversation"]']
  const scopedRequest = (candidate = policy) => {
    const preview = previewSessionMappingTransitions(db, candidate, keys)
    const decisionId = randomUUID()
    return {
      decisionId,
      candidate,
      expectedFingerprint: preview.fingerprint,
      choices: [],
      acknowledgedHeld: [],
      conversationKeys: keys
    }
  }
  const decision = scopedRequest()
  const result = applySessionMappingApplication(db, decision)
  expect(result.appliedSessionIds).toEqual([id])
  expect(db.select().from(sessions).all()).toHaveLength(1)
  const changed = scopedRequest({ ...policy, idleTimeoutMinutes: 20 })
  const before = sqlite.serialize()
  expect(() => applySessionMappingApplication(db, changed)).toThrow(/current policy/)
  expect(sqlite.serialize()).toEqual(before)
})
