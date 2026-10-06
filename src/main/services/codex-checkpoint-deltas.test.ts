// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'node:path'
import { activityIdentities, activityObservations } from '../db/schema/activity-evidence'
import { readCodexCheckpointDeltas } from './codex-checkpoint-deltas'

let sqlite: Database.Database
let db: BetterSQLite3Database
beforeEach(() => {
  sqlite = new Database(':memory:')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
})
afterEach(() => sqlite.close())

function checkpoint(
  id: string,
  parent: string | null,
  input: number,
  extra: Record<string, unknown> = {}
) {
  return {
    previousCheckpointId: parent,
    activityEventId: `event-${id}`,
    timestamp: '2026-07-19T18:07:00.000Z',
    model: 'fixture-model',
    totals: { input_tokens: input, cached_input_tokens: 0, output_tokens: 0 },
    ...extra
  }
}
function add(id: string, payload: unknown, conversationId = 'thread-a', version = 1) {
  db.insert(activityIdentities)
    .values({
      eventId: id,
      provider: 'codex',
      conversationId,
      identityVersion: 1,
      basis: 'checkpoint'
    })
    .onConflictDoNothing()
    .run()
  db.insert(activityObservations)
    .values({
      id: `${id}:${JSON.stringify(payload)}:${version}`,
      eventId: id,
      version,
      kind: 'checkpoint',
      payloadJson: JSON.stringify(payload),
      createdAt: '2026-09-01T00:00:00Z'
    })
    .onConflictDoNothing()
    .run()
}
const result = (id: string) => readCodexCheckpointDeltas(db).find((row) => row.checkpointId === id)

it('derives one shared prefix and independent branch deltas in deterministic key order', () => {
  add('right', checkpoint('right', 'root', 170))
  add('left', checkpoint('left', 'root', 130))
  add('root', checkpoint('root', null, 100))
  add('root', checkpoint('root', null, 100))
  const rows = readCodexCheckpointDeltas(db)
  expect(rows.map((row) => row.checkpointId)).toEqual(['left', 'right', 'root'])
  expect(rows.every((row) => row.status === 'resolved')).toBe(true)
  expect(rows.map((row) => row.status === 'resolved' && row.delta.input_tokens)).toEqual([
    30, 70, 100
  ])
  expect(result('left')).toMatchObject({
    previousCheckpointId: 'root',
    activityEventId: 'event-left',
    model: 'fixture-model'
  })
})

it('subtracts all recorded counters and preserves zero deltas', () => {
  const totals = {
    input_tokens: 100,
    cached_input_tokens: 30,
    output_tokens: 20,
    reasoning_output_tokens: 5,
    total_tokens: 120
  }
  add('root', checkpoint('root', null, 0, { totals }))
  add(
    'next',
    checkpoint('next', 'root', 0, { totals: { ...totals, output_tokens: 25, total_tokens: 125 } })
  )
  expect(result('next')).toMatchObject({
    status: 'resolved',
    delta: {
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 5,
      reasoning_output_tokens: 0,
      total_tokens: 5
    }
  })
})

it('does not select a correction by arrival time and blocks descendants of a conflict', () => {
  add('root', checkpoint('root', null, 100))
  add('root', checkpoint('root', null, 120))
  add('child', checkpoint('child', 'root', 150))
  add('independent', checkpoint('independent', null, 10), 'thread-b')
  expect(result('root')).toMatchObject({ status: 'unresolved', reason: 'conflicting-observations' })
  expect(result('child')).toMatchObject({ status: 'unresolved', reason: 'unresolved-predecessor' })
  expect(result('independent')).toMatchObject({ status: 'resolved' })
})

it('withdraws resolved root and descendant deltas when another root arrives in the same conversation', () => {
  add('first', checkpoint('first', null, 100))
  add('child', checkpoint('child', 'first', 120))
  expect(result('first')).toMatchObject({ status: 'resolved' })
  expect(result('child')).toMatchObject({ status: 'resolved', delta: { input_tokens: 20 } })
  add('second', checkpoint('second', null, 150))
  add('second-child', checkpoint('second-child', 'second', 170))
  add('independent', checkpoint('independent', null, 10), 'thread-b')
  for (const id of ['first', 'second'])
    expect(result(id)).toMatchObject({ status: 'unresolved', reason: 'ambiguous-root-baseline' })
  for (const id of ['child', 'second-child'])
    expect(result(id)).toMatchObject({ status: 'unresolved', reason: 'unresolved-predecessor' })
  expect(result('independent')).toMatchObject({ status: 'resolved', delta: { input_tokens: 10 } })
})

it.each(['conflicting', 'invalid', 'unsupported'])(
  'does not hide a competing root just because its observations are %s',
  (condition) => {
    add('valid', checkpoint('valid', null, 100))
    add(
      'other',
      checkpoint('other', null, 150, condition === 'invalid' ? { totals: {} } : {}),
      'thread-a',
      condition === 'unsupported' ? 2 : 1
    )
    if (condition === 'conflicting') add('other', checkpoint('other', null, 160))
    expect(result('valid')).toMatchObject({
      status: 'unresolved',
      reason: 'ambiguous-root-baseline'
    })
    expect(result('other')).toMatchObject({
      status: 'unresolved',
      reason: {
        conflicting: 'conflicting-observations',
        invalid: 'invalid-checkpoint',
        unsupported: 'unsupported-version'
      }[condition]
    })
  }
)

it('recomputes missing dependencies when their observations arrive without writing derived rows', () => {
  add('child', checkpoint('child', 'root', 150))
  expect(result('child')).toMatchObject({ status: 'unresolved', reason: 'missing-predecessor' })
  add('root', checkpoint('root', null, 100))
  const before = db.select().from(activityObservations).all()
  expect(result('child')).toMatchObject({ status: 'resolved', delta: { input_tokens: 50 } })
  expect(db.select().from(activityObservations).all()).toEqual(before)
})

it('does not infer counter resets from decreasing cumulative observations', () => {
  add('root', checkpoint('root', null, 100))
  add('drop', checkpoint('drop', 'root', 20))
  add('child', checkpoint('child', 'drop', 30))
  expect(result('drop')).toMatchObject({ status: 'unresolved', reason: 'counter-decrease' })
  expect(result('child')).toMatchObject({ status: 'unresolved', reason: 'unresolved-predecessor' })
})

it('leaves changed counter sets unresolved rather than treating absent counters as zero', () => {
  add('root', checkpoint('root', null, 100))
  add(
    'child',
    checkpoint('child', 'root', 150, {
      totals: {
        input_tokens: 150,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 2
      }
    })
  )
  expect(result('child')).toMatchObject({ status: 'unresolved', reason: 'counter-fields-changed' })
})

it('rejects cross-conversation predecessors', () => {
  add('root', checkpoint('root', null, 100), 'thread-a')
  add('child', checkpoint('child', 'root', 150), 'thread-b')
  expect(result('child')).toMatchObject({
    status: 'unresolved',
    reason: 'cross-conversation-predecessor'
  })
})

it('detects cycles and their dependent checkpoints without recursive traversal', () => {
  add('a', checkpoint('a', 'b', 100))
  add('b', checkpoint('b', 'a', 100))
  add('child', checkpoint('child', 'a', 150))
  add('self', checkpoint('self', 'self', 1))
  expect(result('a')).toMatchObject({ status: 'unresolved', reason: 'cyclic-predecessor' })
  expect(result('b')).toMatchObject({ status: 'unresolved', reason: 'cyclic-predecessor' })
  expect(result('self')).toMatchObject({ status: 'unresolved', reason: 'cyclic-predecessor' })
  expect(result('child')).toMatchObject({ status: 'unresolved', reason: 'unresolved-predecessor' })
})

it.each([
  null,
  {},
  { previousCheckpointId: 7 },
  { timestamp: 'no timezone' },
  { totals: { input_tokens: -1, output_tokens: 0, cached_input_tokens: 0 } },
  {
    totals: { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 0, cached_input_tokens: 0 }
  },
  { totals: { input_tokens: 10, output_tokens: 1 } }
])('reports invalid checkpoint payloads: %j', (patch) => {
  add(
    'bad',
    patch === null || Object.keys(patch).length === 0 ? patch : checkpoint('bad', null, 10, patch)
  )
  expect(result('bad')).toMatchObject({ status: 'unresolved', reason: 'invalid-checkpoint' })
})

it('reports unsupported observation versions', () => {
  add('future', checkpoint('future', null, 100), 'thread-a', 2)
  expect(result('future')).toMatchObject({ status: 'unresolved', reason: 'unsupported-version' })
})

it('reports missing, malformed and unsupported identity records without dropping them', () => {
  add('missing', checkpoint('missing', null, 10))
  add('malformed', checkpoint('malformed', null, 10))
  add('future-identity', checkpoint('future-identity', null, 10))
  sqlite.prepare('DELETE FROM activity_observations WHERE event_id = ?').run('missing')
  sqlite
    .prepare('UPDATE activity_observations SET payload_json = ? WHERE event_id = ?')
    .run('{', 'malformed')
  sqlite
    .prepare('UPDATE activity_identities SET identity_version = 2 WHERE event_id = ?')
    .run('future-identity')
  expect(result('missing')).toMatchObject({ status: 'unresolved', reason: 'missing-observation' })
  expect(result('malformed')).toMatchObject({ status: 'unresolved', reason: 'invalid-checkpoint' })
  expect(result('future-identity')).toMatchObject({
    status: 'unresolved',
    reason: 'unsupported-version'
  })
})

it('handles long checkpoint chains without exhausting the call stack', () => {
  db.transaction(() => {
    for (let i = 0; i < 12000; i++)
      add(String(i), checkpoint(String(i), i === 0 ? null : String(i - 1), i + 1))
  })
  const rows = readCodexCheckpointDeltas(db)
  expect(rows).toHaveLength(12000)
  expect(rows.every((row) => row.status === 'resolved' && row.delta.input_tokens === 1)).toBe(true)
})
