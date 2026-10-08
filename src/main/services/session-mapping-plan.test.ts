// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'node:path'
import { activityIdentities, activityObservations } from '../db/schema/activity-evidence'
import { sessions } from '../db/schema/sessions'
import { sessionDerivations, sessionTimeOverrides } from '../db/schema/session-derivations'
import { sessionBillingRefs, sessionRevisions } from '../db/schema/session-history'
import { sessionDeletions } from '../db/schema/session-deletions'
import { clients } from '../db/schema/clients'
import { invoices, invoiceLineItems } from '../db/schema/invoices'
import { workspacePolicy } from '../db/schema/workspace-policy'
import { adoptInitialWorkspacePolicy, previewLedgerWorkspacePolicy } from './workspace-policy'
import {
  adoptSessionActivityMappings,
  previewSessionActivityAdoption
} from './session-activity-mappings'
import { previewSessionMappingTransitions } from './session-mapping-transitions'
import {
  planSessionMappingApplication,
  type SessionMappingHeldReason,
  type SessionMappingSourceChoice
} from './session-mapping-plan'

let sqlite: Database.Database
let db: ReturnType<typeof drizzle>
const policy = {
  version: 1,
  normalizationVersion: 1,
  detectorVersion: 1,
  idleTimeoutMinutes: 15,
  reportingTimeZone: 'UTC'
}
const newYork = { ...policy, reportingTimeZone: 'America/New_York' }
const decisionId = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b'
const otherDecisionId = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b'
const derived = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const at = (time: string) => `2026-09-26T${time}:00.000Z`
beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  adoptInitialWorkspacePolicy(db, {
    workspaceId: 'fb751832-c62e-4f27-bc3f-b6a7a8e31214',
    revisionId: 'fbd24e8f-4aa9-4420-889a-574e83cdd267',
    policy
  })
})
afterEach(() => sqlite.close())

function event(id: string, kind: 'message' | 'activity', payload: Record<string, unknown>) {
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
function message(id: string, parent: string | null, time: string, type = 'user') {
  event(id, 'message', {
    type,
    timestamp: at(time),
    parentEventId: parent,
    model: null,
    usage: null,
    isToolResult: false,
    hasToolUse: false,
    toolNames: []
  })
}
function progress(id: string, parent: string, time: string) {
  event(id, 'activity', {
    kind: 'progress',
    progressType: null,
    timestamp: at(time),
    parentEventId: parent
  })
}
/** Saves the current-policy calculation as ordinary scanned rows with detector baselines. */
function save(current: typeof policy) {
  db.update(workspacePolicy)
    .set({ policyJson: JSON.stringify(current) })
    .run()
  const conversation = previewLedgerWorkspacePolicy(db, current).conversations[0]
  if (conversation.status !== 'resolved') throw new Error('Expected resolved fixture')
  return conversation.before.map((interval) => {
    const row = db
      .insert(sessions)
      .values({
        source: 'auto',
        tool: 'claude',
        claudeSessionId: 'conversation',
        projectPath: 'C:/fixture',
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
        startedAt: interval.startedAt,
        endedAt: interval.endedAt,
        durationMinutes: interval.durationMinutes
      })
      .run()
    return row.id
  })
}
function seed(current = policy, times: Array<string | [string, string]> = ['03:00', '03:10']) {
  times.forEach((entry, index) => {
    const [time, type] = typeof entry === 'string' ? [entry, 'user'] : entry
    message(`event-${index}`, index ? `event-${index - 1}` : null, time, type)
  })
  return save(current)
}
function adopt(ids: number[]) {
  return adoptSessionActivityMappings(db, previewSessionActivityAdoption(db).fingerprint, ids)
}
function plan(candidate: unknown, choices?: SessionMappingSourceChoice[], id = decisionId) {
  return planSessionMappingApplication(previewSessionMappingTransitions(db, candidate), id, choices)
}
function choose(afterIndex: number, sourceSessionId: number): SessionMappingSourceChoice {
  return { provider: 'claude', conversationId: 'conversation', afterIndex, sourceSessionId }
}
function parentRevision(mapping: ReturnType<typeof adopt>[number]) {
  return (mapping as typeof mapping & { revisionId?: string | null }).revisionId ?? mapping.id
}
function edit(id: number, values: Partial<typeof sessions.$inferInsert>) {
  db.update(sessions).set(values).where(eq(sessions.id, id)).run()
}
function bill(sessionId: number) {
  const row = db.select().from(sessions).where(eq(sessions.id, sessionId)).get()!
  db.insert(sessionBillingRefs)
    .values({
      sessionId,
      stripeInvoiceId: `in_${sessionId}`,
      testMode: 0,
      billedRanges: [
        {
          sessionId,
          projectId: row.projectId,
          clientId: row.clientId,
          startedAt: row.startedAt,
          endedAt: row.endedAt
        }
      ]
    })
    .run()
}
function billLineItem(sessionId: number) {
  const client = db.insert(clients).values({ name: 'Billed', color: 'red' }).returning().get()
  const invoice = db
    .insert(invoices)
    .values({
      clientId: client.id,
      stripeInvoiceId: 'in_line_item',
      status: 'paid',
      amountPaidCents: 100
    })
    .returning()
    .get()
  db.insert(invoiceLineItems)
    .values({
      invoiceId: invoice.id,
      description: 'Issued snapshot',
      amountCents: 100,
      durationMinutes: 1,
      sessionIds: String(sessionId)
    })
    .run()
}
function errorCode(run: () => unknown) {
  try {
    run()
  } catch (error) {
    return (error as { code?: string }).code
  }
  return null
}

it('continues an unchanged adopted session in place with a new revision identity', () => {
  const [mapping] = adopt(seed())
  const result = plan(policy)
  expect(result).toMatchObject({
    version: 1,
    scope: 'session-mapping-application-plan',
    decisionId,
    retainedWithoutActivity: []
  })
  const [conversation] = result.conversations
  expect(conversation).toMatchObject({
    status: 'applicable',
    heldReasons: [],
    activeSessionIds: [mapping.sessionId],
    retiredSessionIds: []
  })
  expect(conversation.successors).toHaveLength(1)
  const [successor] = conversation.successors
  expect(successor).toMatchObject({
    afterIndex: 0,
    kind: 'continue',
    keepSessionId: mapping.sessionId,
    predecessorSessionIds: [mapping.sessionId],
    predecessorMappingIds: [mapping.id],
    predecessorRevisionIds: [parentRevision(mapping)],
    mappingId: mapping.id,
    sourceSessionId: mapping.sessionId,
    metadata: {
      projectPath: 'C:/fixture',
      projectId: null,
      clientId: null,
      description: null,
      billable: 1
    },
    conflictingFields: [],
    preservedTimeFields: [],
    timeOverrides: { startedAt: 0, endedAt: 0, durationMinutes: 0 },
    effective: { startedAt: at('03:00'), endedAt: at('03:10'), durationMinutes: 10 },
    policyChanged: false,
    intervalUnchanged: true
  })
  expect(successor.revisionId).toMatch(derived)
  expect(successor.revisionId).not.toBe(mapping.id)
  // A continuing row keeps its mapping id; only the revision is decision-scoped.
  const other = plan(policy, [], otherDecisionId).conversations[0].successors[0]
  expect(other.mappingId).toBe(mapping.id)
  expect(other.revisionId).not.toBe(successor.revisionId)
})

it.each(['unscanned', 'rescanned'])(
  'keeps a billed row id for a true append continuation (%s)',
  (mode) => {
    const [mapping] = adopt(seed())
    const id = mapping.sessionId
    bill(id)
    message('event-2', 'event-1', '03:20')
    if (mode === 'rescanned') {
      // The scanner grows the row and its baseline in place; the mapping snapshot goes stale.
      const current = previewLedgerWorkspacePolicy(db, policy).conversations[0]
      if (current.status !== 'resolved') throw new Error('Expected resolved fixture')
      const [grown] = current.before
      edit(id, {
        endedAt: grown.endedAt,
        durationMinutes: grown.durationMinutes,
        promptCount: grown.promptCount
      })
      db.update(sessionDerivations)
        .set({ endedAt: grown.endedAt, durationMinutes: grown.durationMinutes })
        .where(eq(sessionDerivations.sessionId, id))
        .run()
    }
    const [conversation] = plan(policy).conversations
    expect(conversation).toMatchObject({ status: 'applicable', retiredSessionIds: [] })
    expect(conversation.successors).toMatchObject([
      {
        kind: 'continue',
        keepSessionId: id,
        mappingId: mapping.id,
        predecessorSessionIds: [id],
        intervalUnchanged: false,
        policyChanged: false,
        effective: { startedAt: at('03:00'), endedAt: at('03:20'), durationMinutes: 20 }
      }
    ])
  }
)

it('carries a preserved time edit into an appended continuation', () => {
  const [mapping] = adopt(seed())
  edit(mapping.sessionId, { endedAt: at('03:12') })
  db.insert(sessionTimeOverrides).values({ sessionId: mapping.sessionId, endedAt: 1 }).run()
  message('event-2', 'event-1', '03:20')
  const [conversation] = plan(policy).conversations
  expect(conversation.status).toBe('applicable')
  expect(conversation.successors[0]).toMatchObject({
    keepSessionId: mapping.sessionId,
    preservedTimeFields: ['endedAt'],
    timeOverrides: { startedAt: 0, endedAt: 1, durationMinutes: 0 },
    effective: { startedAt: at('03:00'), endedAt: at('03:12'), durationMinutes: 20 }
  })
})

it.each<[string, (id: number) => void, boolean]>([
  ['unbilled', () => undefined, true],
  ['billing ref', bill, false],
  ['invoice line item', billLineItem, false]
])('changes boundaries under a new policy: %s', (_label, billing, keeps) => {
  // The leading system message is noise under 5 minutes and joins the row under 15.
  const current = { ...policy, idleTimeoutMinutes: 5 }
  const [mapping] = adopt(seed(current, [['03:00', 'system'], '03:10']))
  const id = mapping.sessionId
  billing(id)
  const preview = previewSessionMappingTransitions(db, policy)
  expect(preview.mappings[0]).toMatchObject({ relationship: 'one-to-one' })
  const [conversation] = planSessionMappingApplication(preview, decisionId).conversations
  expect(conversation.status).toBe('applicable')
  const [successor] = conversation.successors
  expect(successor).toMatchObject({
    kind: 'policy',
    predecessorSessionIds: [id],
    predecessorMappingIds: [mapping.id],
    policyChanged: true,
    intervalUnchanged: false,
    effective: { startedAt: at('03:00'), endedAt: at('03:10'), durationMinutes: 10 }
  })
  if (keeps) {
    expect(successor).toMatchObject({ keepSessionId: id, mappingId: mapping.id })
    expect(conversation.retiredSessionIds).toEqual([])
  } else {
    // Billed work is retired into audit history, never rewritten in place.
    expect(successor.keepSessionId).toBeNull()
    expect(successor.mappingId).toMatch(derived)
    expect(successor.mappingId).not.toBe(mapping.id)
    expect(conversation.retiredSessionIds).toEqual([id])
  }
})

it('keeps a billed row id when a new policy leaves its measurements unchanged', () => {
  const [mapping] = adopt(seed())
  bill(mapping.sessionId)
  const [conversation] = plan({ ...policy, idleTimeoutMinutes: 20 }).conversations
  expect(conversation.successors).toMatchObject([
    {
      kind: 'policy',
      keepSessionId: mapping.sessionId,
      mappingId: mapping.id,
      policyChanged: true,
      intervalUnchanged: true
    }
  ])
})

it('holds a one-to-one label that drops a counted event and its measured gap', () => {
  adopt(seed(policy, ['03:00', ['03:10', 'system']]))
  const candidate = { ...policy, idleTimeoutMinutes: 5 }
  const preview = previewSessionMappingTransitions(db, candidate)
  expect(preview.mappings[0]).toMatchObject({ relationship: 'one-to-one' })
  expect(planSessionMappingApplication(preview, decisionId).conversations[0]).toMatchObject({
    status: 'held',
    heldReasons: ['lost-continuity-coverage', 'lost-event-coverage'],
    successors: []
  })
})

it('holds a policy split that keeps every message but drops a measured gap', () => {
  adopt(seed())
  const preview = previewSessionMappingTransitions(db, { ...policy, idleTimeoutMinutes: 5 })
  expect(preview.mappings[0]).toMatchObject({ relationship: 'split' })
  expect(planSessionMappingApplication(preview, decisionId).conversations[0]).toMatchObject({
    status: 'held',
    heldReasons: ['lost-continuity-coverage'],
    successors: []
  })
})

it('permits a shorter timeout only after the exact counted-time reduction is reviewed', () => {
  adopt(seed())
  const candidate = { ...policy, idleTimeoutMinutes: 5 }
  const preview = previewSessionMappingTransitions(db, candidate)
  const pending = planSessionMappingApplication(preview, decisionId)
  expect(pending.coverageReductions).toMatchObject([
    { beforeMinutes: 10, afterMinutes: 2, uncountedEvents: [] }
  ])
  expect(pending.coverageReductions[0].removedContinuity).toHaveLength(1)
  const acknowledgment = pending.coverageReductions.map((row) => row.key)
  const accepted = planSessionMappingApplication(preview, decisionId, [], acknowledgment)
  expect(accepted.conversations[0]).toMatchObject({ status: 'applicable', heldReasons: [] })
  expect(accepted.conversations[0].successors).toHaveLength(2)
  message('event-2', 'event-1', '03:11')
  expect(() =>
    planSessionMappingApplication(
      previewSessionMappingTransitions(db, candidate),
      decisionId,
      [],
      acknowledgment
    )
  ).toThrow(/Coverage changed/)
})

it('holds a split that would drop retained progress inside a counted gap', () => {
  message('event-0', null, '03:00')
  progress('progress-0', 'event-0', '03:05')
  message('event-1', 'progress-0', '03:10')
  adopt(save(policy))
  expect(plan({ ...policy, idleTimeoutMinutes: 5 }).conversations[0]).toMatchObject({
    status: 'held',
    heldReasons: ['lost-continuity-coverage', 'lost-event-coverage']
  })
})

it('holds unmatched predecessors whose events are filtered by the candidate', () => {
  const current = { ...newYork, idleTimeoutMinutes: 30 }
  adopt(
    seed(current, [
      ['03:50', 'system'],
      ['04:10', 'system']
    ])
  )
  const [conversation] = plan({ ...current, idleTimeoutMinutes: 5 }).conversations
  expect(conversation.status).toBe('held')
  expect(conversation.heldReasons).toEqual(
    expect.arrayContaining(['unmatched-predecessor', 'lost-event-coverage'])
  )
})

it('splits at a new midnight without losing the gap and carries agreed metadata', () => {
  const [mapping] = adopt(seed(policy, ['03:55', '04:05']))
  edit(mapping.sessionId, { description: 'Shared note' })
  const [conversation] = plan(newYork).conversations
  expect(conversation).toMatchObject({
    status: 'applicable',
    retiredSessionIds: [mapping.sessionId]
  })
  expect(conversation.successors).toMatchObject([
    {
      kind: 'split',
      keepSessionId: null,
      predecessorSessionIds: [mapping.sessionId],
      metadata: { description: 'Shared note' },
      effective: { startedAt: at('03:55'), endedAt: at('04:00') }
    },
    {
      kind: 'split',
      keepSessionId: null,
      predecessorSessionIds: [mapping.sessionId],
      metadata: { description: 'Shared note' },
      effective: { startedAt: at('04:00'), endedAt: at('04:05') }
    }
  ])
  const ids = conversation.successors.flatMap((row) => [row.mappingId, row.revisionId])
  expect(new Set([...ids, mapping.id]).size).toBe(5)
  for (const id of ids) expect(id).toMatch(derived)
})

it.each([
  ['an inferred duration edit', (id: number) => edit(id, { durationMinutes: 7 })],
  [
    'an explicit override flag',
    (id: number) => db.insert(sessionTimeOverrides).values({ sessionId: id, startedAt: 1 }).run()
  ]
])('holds a split of a row with %s', (_label, change) => {
  const [mapping] = adopt(seed(policy, ['03:55', '04:05']))
  change(mapping.sessionId)
  expect(plan(newYork).conversations[0]).toMatchObject({
    status: 'held',
    heldReasons: ['time-override-in-split-or-merge'],
    successors: []
  })
})

function mergeFixture() {
  const ids = seed(newYork, ['03:55', '04:05', '06:00'])
  expect(ids).toHaveLength(3)
  adopt(ids)
  const client = db.insert(clients).values({ name: 'Agreed', color: 'blue' }).returning().get()
  for (const id of ids) edit(id, { clientId: client.id })
  return { ids, client }
}

it('requires an explicit source for conflicting merge metadata and carries agreed fields', () => {
  const { ids, client } = mergeFixture()
  const [first, second, third] = ids
  edit(first, { description: 'Before midnight' })
  edit(second, { description: 'After midnight' })
  expect(plan(policy).conversations[0]).toMatchObject({
    status: 'held',
    heldReasons: ['metadata-choice-required'],
    requiredChoices: [
      { afterIndex: 0, candidateSessionIds: [first, second], conflictingFields: ['description'] }
    ],
    activeSessionIds: ids,
    successors: []
  })
  const [conversation] = plan(policy, [choose(0, second)]).conversations
  expect(conversation).toMatchObject({ status: 'applicable', retiredSessionIds: [first, second] })
  expect(conversation.successors).toMatchObject([
    {
      kind: 'merge',
      keepSessionId: null,
      predecessorSessionIds: [first, second],
      sourceSessionId: second,
      conflictingFields: ['description'],
      metadata: { description: 'After midnight', clientId: client.id, projectPath: 'C:/fixture' },
      effective: { startedAt: at('03:55'), endedAt: at('04:05'), durationMinutes: 10 }
    },
    { kind: 'policy', keepSessionId: third, intervalUnchanged: true, policyChanged: true }
  ])
  expect(errorCode(() => plan(policy, [choose(0, third)]))).toBe('INVALID_MAPPING_CHOICE')
})

it('holds a merge of a row with a time override', () => {
  const { ids } = mergeFixture()
  edit(ids[0], { durationMinutes: 9 })
  expect(plan(policy).conversations[0]).toMatchObject({
    status: 'held',
    heldReasons: ['time-override-in-split-or-merge']
  })
})

it('inherits assignment for new work while resetting description and billable defaults', () => {
  const [mapping] = adopt(seed())
  edit(mapping.sessionId, { description: 'Carry' })
  message('event-2', 'event-1', '04:00')
  const [conversation] = plan(policy).conversations
  expect(conversation.status).toBe('applicable')
  expect(conversation.successors[1]).toMatchObject({
    kind: 'adopt',
    keepSessionId: null,
    predecessorSessionIds: [],
    predecessorMappingIds: [],
    predecessorRevisionIds: [],
    sourceSessionId: mapping.sessionId,
    metadata: { description: null, billable: 1, projectPath: 'C:/fixture' },
    effective: { startedAt: at('04:00'), endedAt: at('04:00') }
  })
  expect(conversation.successors[1].mappingId).toMatch(derived)
})

it('uses the nearest preceding assignment for a new interval despite older metadata differences', () => {
  const ids = seed(newYork, ['03:55', '04:05'])
  adopt(ids)
  edit(ids[0], { description: 'A', billable: 0, projectPath: 'C:/older' })
  edit(ids[1], { description: 'B', billable: 0, projectPath: 'C:/latest' })
  message('event-2', 'event-1', '06:00')
  const [conversation] = plan(newYork).conversations
  expect(conversation.status).toBe('applicable')
  expect(conversation.successors.map((row) => [row.kind, row.keepSessionId])).toEqual([
    ['continue', ids[0]],
    ['continue', ids[1]],
    ['adopt', null]
  ])
  expect(conversation.successors[2]).toMatchObject({
    sourceSessionId: ids[1],
    metadata: { projectPath: 'C:/latest', description: null, billable: 1 }
  })
  expect(conversation.successors[0].metadata).toMatchObject({ description: 'A', billable: 0 })
  expect(conversation.successors[1].metadata).toMatchObject({ description: 'B', billable: 0 })
  expect(() => plan(newYork, [choose(2, ids[0])])).toThrow('does not belong')
})

it('holds unadopted and partially adopted conversations', () => {
  const ids = seed(newYork, ['03:55', '04:05'])
  expect(plan(newYork).conversations[0]).toMatchObject({
    status: 'held',
    heldReasons: ['unadopted-history'],
    activeSessionIds: ids,
    successors: []
  })
  adopt(ids)
  // A partially restored/imported mapping set is still held by the pure planner,
  // even though new local adoption now rejects a partial selection.
  const preview = previewSessionMappingTransitions(db, newYork)
  preview.history.saved.activityMappings = preview.history.saved.activityMappings.filter(
    (row) => row.sessionId === ids[0]
  )
  expect(planSessionMappingApplication(preview, decisionId).conversations[0]).toMatchObject({
    status: 'held',
    heldReasons: ['partial-adoption']
  })
})

const firstId = () => db.select().from(sessions).get()!.id
it.each<[string, () => void, SessionMappingHeldReason]>([
  ['a running row', () => edit(firstId(), { status: 'active' }), 'running-session'],
  [
    'reconciliation history',
    () =>
      db
        .insert(sessionRevisions)
        .values({
          id: 'revision',
          sessionId: firstId(),
          sequence: 1,
          kind: 'reconcile',
          tool: 'claude',
          before: '{}',
          after: '{}',
          createdAt: at('04:00')
        })
        .run(),
    'protected-history'
  ],
  [
    // Deleted adopted coverage is a mask; work continuing across it is neither counted nor hidden.
    'later work continuing across deleted adopted coverage',
    () => {
      db.insert(sessionDeletions)
        .values({
          id: 'deletion',
          sessionId: firstId(),
          tool: 'claude',
          claudeSessionId: 'conversation',
          startedAt: at('03:00'),
          endedAt: at('03:10'),
          createdAt: at('04:00')
        })
        .run()
      message('event-2', 'event-1', '03:20')
    },
    'history-operation-conflict'
  ],
  [
    'replaced observations',
    () => sqlite.exec("UPDATE activity_observations SET id = id || '-changed'"),
    'changed-or-missing-evidence'
  ],
  [
    'a correction conflict',
    () => {
      const observation = db.select().from(activityObservations).all()[0]
      db.insert(activityObservations)
        .values({
          ...observation,
          id: 'corrected-observation',
          payloadJson: JSON.stringify({ ...JSON.parse(observation.payloadJson), model: 'x' })
        })
        .run()
    },
    'unresolved-activity'
  ],
  [
    'a baseline that no longer matches its mapping',
    () =>
      db
        .update(sessionDerivations)
        .set({ endedAt: at('03:05'), durationMinutes: 5 })
        .run(),
    'saved-row-diverged'
  ],
  [
    'a zone-less saved time',
    () => edit(firstId(), { startedAt: '2026-09-26 03:00' }),
    'invalid-saved-time'
  ]
])('holds %s', (_label, change, reason) => {
  adopt(seed())
  change()
  const [conversation] = plan(policy).conversations
  expect(conversation.status).toBe('held')
  expect(conversation.heldReasons).toContain(reason)
  expect(conversation.successors).toEqual([])
  expect(conversation.retiredSessionIds).toEqual([])
})

it('derives identical identities from the same decision on a database copy', () => {
  const [mapping] = adopt(seed(policy, ['03:55', '04:05']))
  const preview = previewSessionMappingTransitions(db, newYork)
  const result = planSessionMappingApplication(preview, decisionId)
  expect(result.fingerprint).toMatch(/^session-mapping-plan:v1:[a-f0-9]{64}$/)
  expect(planSessionMappingApplication(preview, decisionId)).toEqual(result)
  const copy = new Database(sqlite.serialize())
  try {
    const replay = previewSessionMappingTransitions(drizzle(copy), newYork)
    expect(planSessionMappingApplication(replay, decisionId)).toEqual(result)
  } finally {
    copy.close()
  }
  const other = planSessionMappingApplication(preview, otherDecisionId)
  const ids = (value: typeof result) =>
    value.conversations[0].successors.flatMap((row) => [row.mappingId, row.revisionId])
  expect(ids(other).filter((id) => ids(result).includes(id))).toEqual([])
  expect(other.conversations[0].successors.map((row) => row.coverageHash)).toEqual(
    result.conversations[0].successors.map((row) => row.coverageHash)
  )
  expect(other.fingerprint).not.toBe(result.fingerprint)
  expect(result.conversations[0].successors[0].predecessorRevisionIds).toEqual([
    parentRevision(mapping)
  ])
})

it('rejects malformed decisions and selections instead of holding them', () => {
  const [mapping] = adopt(seed())
  const preview = previewSessionMappingTransitions(db, policy)
  const choice = choose(0, mapping.sessionId)
  for (const id of ['not-a-uuid', decisionId.toUpperCase(), '', null])
    expect(errorCode(() => planSessionMappingApplication(preview, id as string))).toBe(
      'INVALID_MAPPING_DECISION'
    )
  for (const choices of [
    null,
    [choice, choice],
    [{ ...choice, afterIndex: 1 }],
    [{ ...choice, afterIndex: -1 }],
    [{ ...choice, afterIndex: 0.5 }],
    [{ ...choice, conversationId: 'other' }],
    [{ ...choice, provider: 'codex' }],
    [{ ...choice, sourceSessionId: mapping.sessionId + 100 }],
    [{ ...choice, extra: true }]
  ])
    expect(
      errorCode(() =>
        planSessionMappingApplication(
          preview,
          decisionId,
          choices as unknown as SessionMappingSourceChoice[]
        )
      )
    ).toBe('INVALID_MAPPING_CHOICE')
  expect(
    planSessionMappingApplication(preview, decisionId, [choice]).conversations[0].successors[0]
  ).toMatchObject({ sourceSessionId: mapping.sessionId, keepSessionId: mapping.sessionId })
})
