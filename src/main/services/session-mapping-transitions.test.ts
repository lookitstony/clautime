// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'node:path'
import { activityIdentities, activityObservations } from '../db/schema/activity-evidence'
import { sessions } from '../db/schema/sessions'
import { sessionDerivations } from '../db/schema/session-derivations'
import { sessionActivityMappings } from '../db/schema/session-activity-mappings'
import { sessionRevisions } from '../db/schema/session-history'
import { clients } from '../db/schema/clients'
import { invoices, invoiceLineItems } from '../db/schema/invoices'
import { workspacePolicy } from '../db/schema/workspace-policy'
import { adoptInitialWorkspacePolicy, previewLedgerWorkspacePolicy } from './workspace-policy'
import {
  adoptSessionActivityMappings,
  previewSessionActivityAdoption
} from './session-activity-mappings'
import {
  previewSessionMappingTransitions,
  recheckSessionMappingTransitions
} from './session-mapping-transitions'

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
  adoptInitialWorkspacePolicy(db, {
    workspaceId: 'fb751832-c62e-4f27-bc3f-b6a7a8e31214',
    revisionId: 'fbd24e8f-4aa9-4420-889a-574e83cdd267',
    policy
  })
})
afterEach(() => sqlite.close())

function message(id: string, parent: string | null, timestamp: string, type = 'user') {
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
      kind: 'message',
      createdAt: timestamp,
      payloadJson: JSON.stringify({
        type,
        timestamp,
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
function seed(current = policy, times = ['03:00', '03:10'], type = 'user') {
  db.update(workspacePolicy)
    .set({ policyJson: JSON.stringify(current) })
    .run()
  times.forEach((time, index) =>
    message(`event-${index}`, index ? `event-${index - 1}` : null, at(time), type)
  )
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
function adopt(ids: number[]) {
  return adoptSessionActivityMappings(db, previewSessionActivityAdoption(db).fingerprint, ids)
}

it('previews unchanged adopted anchors under query-only access and survives a database copy', () => {
  const [mapping] = adopt(seed())
  const before = sqlite.serialize()
  sqlite.pragma('query_only = ON')
  const preview = previewSessionMappingTransitions(db, policy)
  expect(preview).toMatchObject({
    version: 1,
    scope: 'adopted-mapping-transitions',
    application: 'unavailable',
    relationshipScope: 'retained-adopted-mappings',
    mappings: [
      {
        mappingId: mapping.id,
        policyRevisionId: mapping.policyRevisionId,
        status: 'compared',
        relationship: 'unchanged',
        successorIndices: [0]
      }
    ]
  })
  expect(preview.conversations[0].candidates[0].predecessors).toEqual([
    {
      mappingId: mapping.id,
      sessionId: mapping.sessionId,
      sharedMessageEventIds: ['event-0', 'event-1'],
      sharedContinuity: [
        {
          fromEventId: 'event-0',
          toEventId: 'event-1',
          startedAt: at('03:00'),
          endedAt: at('03:10')
        }
      ]
    }
  ])
  expect(recheckSessionMappingTransitions(db, policy, preview.fingerprint)).toEqual(preview)
  expect(sqlite.serialize()).toEqual(before)
  const copy = new Database(sqlite.serialize())
  try {
    expect(previewSessionMappingTransitions(drizzle(copy), policy)).toEqual(preview)
  } finally {
    copy.close()
  }
})

it('links appended work to its adopted predecessor despite a changed current baseline', () => {
  const [mapping] = adopt(seed())
  message('event-2', 'event-1', at('03:20'))
  const before = sqlite.serialize()
  const preview = previewSessionMappingTransitions(db, policy)
  expect(preview.mappings[0]).toMatchObject({
    status: 'compared',
    relationship: 'one-to-one',
    successorIndices: [0]
  })
  expect(preview.history.comparisons[0]).toMatchObject({
    status: 'review-required',
    reason: 'baseline-coverage-mismatch'
  })
  expect(preview.history.saved.activityMappings).toEqual([mapping])
  expect(preview.conversations[0].candidates[0].predecessors[0].sharedMessageEventIds).toEqual([
    'event-0',
    'event-1'
  ])
  expect(sqlite.serialize()).toEqual(before)
})

it('leaves a new disjoint interval without an adopted predecessor', () => {
  adopt(seed())
  message('event-2', 'event-1', at('04:00'))
  const preview = previewSessionMappingTransitions(db, policy)
  expect(preview.mappings[0]).toMatchObject({ relationship: 'unchanged', successorIndices: [0] })
  expect(preview.conversations[0].candidates[1]).toEqual({ afterIndex: 1, predecessors: [] })
})

it('reports a policy split without replacing the original mapping', () => {
  const mappings = adopt(seed())
  const preview = previewSessionMappingTransitions(db, { ...policy, idleTimeoutMinutes: 5 })
  expect(preview.mappings[0]).toMatchObject({ relationship: 'split', successorIndices: [0, 1] })
  expect(
    preview.conversations[0].candidates.map((row) => row.predecessors[0].sharedMessageEventIds)
  ).toEqual([['event-0'], ['event-1']])
  expect(preview.history.saved.activityMappings).toEqual(mappings)
})

it('reports all adopted predecessors when a policy merges two saved intervals', () => {
  const mappings = adopt(seed({ ...policy, idleTimeoutMinutes: 5 }))
  const preview = previewSessionMappingTransitions(db, policy)
  expect(preview.mappings.map((row) => row.status === 'compared' && row.relationship)).toEqual([
    'merge',
    'merge'
  ])
  expect(preview.conversations[0].candidates[0].predecessors.map((row) => row.mappingId)).toEqual(
    mappings.map((row) => row.id)
  )
})

it('rejects partial adoption before transition ownership can become incomplete', () => {
  const ids = seed({ ...policy, idleTimeoutMinutes: 5 })
  expect(() => adopt([ids[0]])).toThrow('whole conversation')
  expect(db.select().from(sessionActivityMappings).all()).toEqual([])
  adopt(ids)
  const preview = previewSessionMappingTransitions(db, policy)
  expect(preview.conversations[0].unmappedSessionIds).toEqual([])
  expect(preview.conversations[0].candidates[0].predecessors).toHaveLength(2)
})

it('retains continuity-only predecessor links across changed midnight boundaries', () => {
  const current = { ...policy, idleTimeoutMinutes: 300, reportingTimeZone: 'America/New_York' }
  const mappings = adopt(seed(current, ['02:00', '06:00']))
  const preview = previewSessionMappingTransitions(db, {
    ...current,
    reportingTimeZone: 'America/Halifax'
  })
  expect(preview.mappings.map((row) => row.status === 'compared' && row.relationship)).toEqual([
    'complex',
    'merge'
  ])
  expect(preview.conversations[0].candidates[1].predecessors[0]).toMatchObject({
    mappingId: mappings[0].id,
    sharedMessageEventIds: [],
    sharedContinuity: [{ startedAt: at('03:00'), endedAt: at('04:00') }]
  })
})

it('reports unmatched mappings when the candidate filters out their midnight fragments', () => {
  const current = { ...policy, idleTimeoutMinutes: 30, reportingTimeZone: 'America/New_York' }
  const ids = seed(current, ['03:50', '04:10'], 'system')
  expect(ids).toHaveLength(2)
  adopt(ids)
  const preview = previewSessionMappingTransitions(db, { ...current, idleTimeoutMinutes: 5 })
  expect(preview.mappings.map((row) => row.status === 'compared' && row.relationship)).toEqual([
    'unmatched',
    'unmatched'
  ])
  expect(preview.conversations[0].candidates).toEqual([])
})

it('does not invent a merge between touching midnight and point-session boundaries', () => {
  const current = { ...policy, reportingTimeZone: 'America/New_York' }
  adopt(seed(current, ['03:55', '04:00']))
  const preview = previewSessionMappingTransitions(db, current)
  expect(preview.mappings.map((row) => row.status === 'compared' && row.relationship)).toEqual([
    'unchanged',
    'unchanged'
  ])
  expect(preview.conversations[0].candidates.map((row) => row.predecessors.length)).toEqual([1, 1])
})

it('holds replaced observation identities instead of treating equal totals as unchanged evidence', () => {
  adopt(seed())
  sqlite.exec("UPDATE activity_observations SET id = id || '-changed'")
  const preview = previewSessionMappingTransitions(db, policy)
  expect(preview.mappings[0]).toMatchObject({
    status: 'review-required',
    reason: 'changed-or-missing-evidence'
  })
  expect(preview.conversations[0].candidates[0].predecessors).toEqual([])
  expect(preview.conversations[0].blockedMappingIds).toEqual([preview.mappings[0].mappingId])
})

it('holds correction conflicts and retains their original mapping snapshots', () => {
  const mappings = adopt(seed())
  const observation = db.select().from(activityObservations).all()[0]
  db.insert(activityObservations)
    .values({
      ...observation,
      id: 'corrected-observation',
      payloadJson: JSON.stringify({ ...JSON.parse(observation.payloadJson), model: 'corrected' })
    })
    .run()
  const preview = previewSessionMappingTransitions(db, policy)
  expect(preview.mappings[0]).toMatchObject({
    status: 'review-required',
    reason: 'unresolved-activity'
  })
  expect(preview.history.saved.activityMappings).toEqual(mappings)
})

it('holds protected history and running sessions outside predecessor proposals', () => {
  const ids = seed({ ...policy, idleTimeoutMinutes: 5 })
  adopt(ids)
  db.update(sessions).set({ status: 'active' }).run()
  expect(previewSessionMappingTransitions(db, policy).mappings[0]).toMatchObject({
    status: 'review-required',
    reason: 'running-session'
  })
  db.update(sessions).set({ status: 'completed' }).run()
  db.insert(sessionRevisions)
    .values({
      id: 'revision',
      sessionId: ids[0],
      sequence: 1,
      kind: 'reconcile',
      tool: 'claude',
      before: '{}',
      after: '{}',
      createdAt: at('04:00')
    })
    .run()
  const preview = previewSessionMappingTransitions(db, policy)
  expect(preview.mappings).toHaveLength(2)
  for (const mapping of preview.mappings)
    expect(mapping).toMatchObject({ status: 'review-required', reason: 'protected-history' })
  expect(preview.conversations[0].candidates[0].predecessors).toEqual([])
})

it.each([
  { version: 2 },
  { policyRevisionId: 'invalid-revision' },
  { workspaceId: 'other' },
  { provider: 'codex' },
  { conversationId: 'other' },
  { policyJson: '{}' },
  { intervalJson: 'null' },
  { intervalJson: '{broken' }
])('holds invalid or unsupported stored mappings: %j', (change) => {
  adopt(seed())
  db.update(sessionActivityMappings).set(change).run()
  const before = sqlite.serialize()
  expect(previewSessionMappingTransitions(db, policy).mappings[0]).toMatchObject({
    status: 'review-required',
    reason: 'invalid-mapping'
  })
  expect(sqlite.serialize()).toEqual(before)
})

it.each(['version', 'duplicate-message', 'backward-edge', 'foreign-event', 'negative-measurement'])(
  'rejects malformed historical coverage: %s',
  (kind) => {
    const [mapping] = adopt(seed())
    const interval = JSON.parse(mapping.intervalJson)
    if (kind === 'version') interval.coverage.version = 2
    if (kind === 'duplicate-message') interval.coverage.messages.push(interval.coverage.messages[0])
    if (kind === 'backward-edge') interval.coverage.continuity[0].endedAt = at('02:00')
    if (kind === 'foreign-event') interval.coverage.messages[0].eventId = 'unrelated'
    if (kind === 'negative-measurement') interval.durationMinutes = -1
    db.update(sessionActivityMappings)
      .set({ intervalJson: JSON.stringify(interval) })
      .run()
    expect(previewSessionMappingTransitions(db, policy).mappings[0]).toMatchObject({
      status: 'review-required',
      reason: kind === 'foreign-event' ? 'changed-or-missing-evidence' : 'invalid-mapping'
    })
  }
)

it.each([
  "UPDATE sessions SET description = 'edited'",
  "UPDATE session_activity_mappings SET created_at = '2026-09-27T00:00:00.000Z'",
  "UPDATE workspace_policy SET revision_id = 'bccccccc-cccc-4ccc-accc-cccccccccccc'",
  "UPDATE activity_observations SET id = id || '-new'"
])('rejects stale transition receipts after retained state changes: %s', (sql) => {
  adopt(seed())
  const preview = previewSessionMappingTransitions(db, policy)
  sqlite.exec(sql)
  const before = sqlite.serialize()
  expect(() => recheckSessionMappingTransitions(db, policy, preview.fingerprint)).toThrow(
    /transitions changed/
  )
  expect(sqlite.serialize()).toEqual(before)
})

it('binds the candidate policy and rejects an adoption receipt as transition approval', () => {
  adopt(seed())
  const preview = previewSessionMappingTransitions(db, policy)
  expect(() =>
    recheckSessionMappingTransitions(db, { ...policy, idleTimeoutMinutes: 5 }, preview.fingerprint)
  ).toThrow(/transitions changed/)
  expect(() => recheckSessionMappingTransitions(db, policy, preview.history.fingerprint)).toThrow(
    /transitions changed/
  )
  expect(() => recheckSessionMappingTransitions(db, policy, null)).toThrow(/transitions changed/)
})

it('retains the historical policy revision while comparing against a newer saved revision', () => {
  const [mapping] = adopt(seed())
  db.update(workspacePolicy).set({ revisionId: 'bccccccc-cccc-4ccc-accc-cccccccccccc' }).run()
  const preview = previewSessionMappingTransitions(db, policy)
  expect(preview.mappings[0]).toMatchObject({
    policyRevisionId: mapping.policyRevisionId,
    status: 'compared',
    relationship: 'unchanged'
  })
  expect(preview.history.baseRevisionId).not.toBe(mapping.policyRevisionId)
  expect(preview.history.comparisons[0]).toMatchObject({ status: 'review-required' })
})

it('keeps edited time and an issued invoice intact while exposing a policy split', () => {
  const ids = seed()
  adopt(ids)
  const client = db.insert(clients).values({ name: 'Fixture', color: 'red' }).returning().get()
  db.update(sessions)
    .set({ durationMinutes: 72, clientId: client.id, description: 'Saved edit' })
    .run()
  const invoice = db
    .insert(invoices)
    .values({
      clientId: client.id,
      stripeInvoiceId: 'in_fixture',
      status: 'paid',
      amountPaidCents: 12000
    })
    .returning()
    .get()
  db.insert(invoiceLineItems)
    .values({
      invoiceId: invoice.id,
      description: 'Issued snapshot',
      amountCents: 12000,
      durationMinutes: 72,
      sessionIds: String(ids[0])
    })
    .run()
  const before = sqlite.serialize()
  sqlite.pragma('query_only = ON')
  const preview = previewSessionMappingTransitions(db, { ...policy, idleTimeoutMinutes: 5 })
  expect(preview.mappings[0]).toMatchObject({ relationship: 'split' })
  expect(preview.history.saved.sessions[0]).toMatchObject({
    durationMinutes: 72,
    description: 'Saved edit',
    clientId: client.id
  })
  expect(preview.history.saved.invoiceLineItems[0]).toMatchObject({
    amountCents: 12000,
    durationMinutes: 72,
    sessionIds: String(ids[0])
  })
  expect(sqlite.serialize()).toEqual(before)
})
