// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'node:path'
import { activityIdentities, activityObservations } from '../db/schema/activity-evidence'
import { readCanonicalActivity } from './canonical-activity'
import {
  calculateCanonicalIntervals,
  constrainCanonicalIntervals,
  type CanonicalIntervalCoverage
} from './canonical-intervals'

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
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  // Two intervals separated by idle time: 10:00–10:05 and 10:40–10:45.
  message('m0', null, '10:00')
  message('m1', 'm0', '10:05', 'assistant')
  message('m2', 'm1', '10:40')
  message('m3', 'm2', '10:45', 'assistant')
})
afterEach(() => sqlite.close())

function message(id: string, parent: string | null, time: string, type = 'user') {
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
      createdAt: at(time),
      payloadJson: JSON.stringify({
        type,
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

function measure() {
  const [conversation] = readCanonicalActivity(db)
  if (conversation?.status !== 'resolved') throw new Error('Unresolved fixture')
  return { conversation, intervals: calculateCanonicalIntervals(conversation, policy) }
}
const bounds = (items: Array<{ startedAt: string; endedAt: string }>) =>
  items.map((item) => [item.startedAt, item.endedAt])

it('keeps local numeric owners and portable operation owners distinct over one coverage', () => {
  const { conversation, intervals } = measure()
  const coverage = intervals[1].coverage
  const result = constrainCanonicalIntervals(conversation, intervals, {
    cuts: [],
    masks: [
      { sessionId: 7, coverage },
      { operationId: 'op-b', coverage },
      { operationId: 'op-a', coverage }
    ],
    invalid: []
  })
  expect(bounds(result.intervals)).toEqual([[at('10:00'), at('10:05')]])
  expect(result.suppressed).toMatchObject([
    { sessionIds: [7], operationIds: ['op-a', 'op-b'], interval: { startedAt: at('10:40') } }
  ])
  expect(result.conflicts).toEqual([])
  expect(result.invalid).toEqual([])
  // Local-only masks report no portable owners, as before.
  const local = constrainCanonicalIntervals(conversation, intervals, {
    cuts: [],
    masks: [{ sessionId: 7, coverage }],
    invalid: []
  })
  expect(local.suppressed).toMatchObject([{ sessionIds: [7], operationIds: [] }])
})

it('holds a portable deletion until its evidence arrives; a local one stays strictly changed', () => {
  const { conversation, intervals } = measure()
  const coverage: CanonicalIntervalCoverage = {
    ...intervals[1].coverage,
    messages: [
      ...intervals[1].coverage.messages,
      { eventId: 'm4', observationId: 'observation-m4', kind: 'message', timestamp: at('10:46') }
    ]
  }
  const constrain = (mask: { sessionId?: number; operationId?: string }) =>
    constrainCanonicalIntervals(conversation, intervals, {
      cuts: [],
      masks: [{ ...mask, coverage }],
      invalid: []
    }).invalid
  expect(constrain({ operationId: 'op' })).toEqual([
    { operationId: 'op', reason: 'missing-deleted-evidence' }
  ])
  expect(constrain({ sessionId: 3 })).toEqual([
    { sessionId: 3, reason: 'changed-deleted-evidence' }
  ])
  expect(constrain({ sessionId: 3, operationId: 'op' })).toEqual([
    { sessionId: 3, operationId: 'op', reason: 'changed-deleted-evidence' }
  ])

  // Once the evidence is present the same fact suppresses exactly its coverage.
  message('m4', 'm3', '10:46')
  const complete = measure()
  const result = constrainCanonicalIntervals(complete.conversation, complete.intervals, {
    cuts: [],
    masks: [{ operationId: 'op', coverage: complete.intervals[1].coverage }],
    invalid: []
  })
  expect(result.invalid).toEqual([])
  expect(result.suppressed).toMatchObject([{ sessionIds: [], operationIds: ['op'] }])
})

it('reports contradicted portable evidence as changed, never as waiting', () => {
  const { conversation, intervals } = measure()
  const moved = structuredClone(intervals[1].coverage)
  moved.messages[0] = { ...moved.messages[0], timestamp: at('10:41') }
  expect(
    constrainCanonicalIntervals(conversation, intervals, {
      cuts: [],
      masks: [{ operationId: 'op', coverage: moved }],
      invalid: []
    }).invalid
  ).toEqual([{ operationId: 'op', reason: 'changed-deleted-evidence' }])
})

it('holds work continuing across a portable mask as a conflict naming the operation', () => {
  const { intervals } = measure()
  const coverage = intervals[1].coverage
  message('m4', 'm3', '10:50')
  const grown = measure()
  const result = constrainCanonicalIntervals(grown.conversation, grown.intervals, {
    cuts: [],
    masks: [{ operationId: 'op', coverage }],
    invalid: []
  })
  expect(result.suppressed).toEqual([])
  expect(result.conflicts).toMatchObject([
    { sessionIds: [], operationIds: ['op'], interval: { endedAt: at('10:50') } }
  ])
})

it('applies cuts before masks and refuses a mask with no owner', () => {
  const { conversation, intervals } = measure()
  const cut = constrainCanonicalIntervals(conversation, intervals, {
    cuts: [at('10:03'), at('10:03')],
    masks: [],
    invalid: []
  })
  expect(bounds(cut.intervals)).toEqual([
    [at('10:00'), at('10:03')],
    [at('10:03'), at('10:05')],
    [at('10:40'), at('10:45')]
  ])
  expect(() =>
    constrainCanonicalIntervals(conversation, intervals, {
      cuts: [],
      masks: [{ coverage: intervals[0].coverage }],
      invalid: []
    })
  ).toThrow(/local session or portable operation/)
})
