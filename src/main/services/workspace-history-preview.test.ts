// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'node:path'
import {
  activityIdentities,
  activityObservations,
  activitySources
} from '../db/schema/activity-evidence'
import { activityObservers, sourceMachines } from '../db/schema/activity-observers'
import { sessions } from '../db/schema/sessions'
import { sessionDerivations, sessionTimeOverrides } from '../db/schema/session-derivations'
import {
  sessionRevisions,
  sessionSplits,
  sessionReplacements,
  sessionBillingRefs
} from '../db/schema/session-history'
import { sessionDeletions } from '../db/schema/session-deletions'
import { sessionLegacyRecords } from '../db/schema/session-legacy'
import { sessionModelUsage } from '../db/schema/session-model-usage'
import {
  sessionReconciliationCases,
  sessionReconciliationResolutions
} from '../db/schema/session-reconciliation'
import { manualTimeEntries } from '../db/schema/manual-time-entries'
import { sessionActivityMappings } from '../db/schema/session-activity-mappings'
import { removeSessionActivityMappings } from '../db/migration-test-helpers'
import { clients } from '../db/schema/clients'
import { invoices, invoiceLineItems } from '../db/schema/invoices'
import { adoptInitialWorkspacePolicy } from './workspace-policy'
import {
  previewWorkspaceHistory,
  recheckWorkspaceHistoryPreview
} from './workspace-history-preview'
import {
  adoptSessionActivityMappings,
  previewSessionActivityAdoption
} from './session-activity-mappings'
import { splitMappedSession } from './canonical-history-operations'

let sqlite: Database.Database
let db: ReturnType<typeof drizzle>
const policy = {
  version: 1,
  normalizationVersion: 1,
  detectorVersion: 1,
  idleTimeoutMinutes: 15,
  reportingTimeZone: 'UTC'
}
const candidate = { ...policy, idleTimeoutMinutes: 5 }
const start = '2026-09-26T03:00:00.000Z'
const end = '2026-09-26T03:10:00.000Z'
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

function ledger(conversationId = 'conversation', lastType = 'system') {
  for (const [index, timestamp] of [start, end].entries()) {
    const eventId = `${conversationId}-${index}`
    db.insert(activityIdentities)
      .values({
        eventId,
        provider: 'claude',
        identityVersion: 1,
        conversationId,
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
        createdAt: end,
        payloadJson: JSON.stringify({
          type: index ? lastType : 'user',
          timestamp,
          parentEventId: index ? `${conversationId}-0` : null,
          model: null,
          usage: null,
          isToolResult: false,
          hasToolUse: false,
          toolNames: []
        })
      })
      .run()
  }
}
function saved(values: Partial<typeof sessions.$inferInsert> = {}, baseline = true) {
  const row = db
    .insert(sessions)
    .values({
      projectPath: 'C:/fixture',
      startedAt: start,
      endedAt: end,
      durationMinutes: 10,
      source: 'auto',
      tool: 'claude',
      claudeSessionId: 'conversation',
      sourceFile: 'missing.jsonl',
      promptCount: 1,
      description: 'Saved description',
      billable: 0,
      ...values
    })
    .returning()
    .get()
  if (baseline)
    db.insert(sessionDerivations)
      .values({
        sessionId: row.id,
        startedAt: start,
        endedAt: end,
        durationMinutes: 10
      })
      .run()
  return row
}
function review(reason: string) {
  expect(previewWorkspaceHistory(db, candidate).comparisons[0]).toMatchObject({
    status: 'review-required',
    reason
  })
}
function revision(sessionId: number, kind: 'edit' | 'split' | 'reconcile' | 'policy' = 'edit') {
  const id = `revision-${sessionId}`
  db.insert(sessionRevisions)
    .values({
      id,
      sessionId,
      sequence: 1,
      kind,
      tool: 'claude',
      before: '{}',
      after: '{}',
      createdAt: end
    })
    .run()
  return id
}

it('upgrades with empty activity mapping storage and preserves saved history on repeat migration', () => {
  ledger()
  saved()
  const before = previewSessionActivityAdoption(db).saved
  removeSessionActivityMappings(sqlite)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  expect({ ...previewSessionActivityAdoption(db).saved, policyRevisions: [] }).toEqual({
    ...before,
    policyRevisions: []
  })
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  expect({ ...previewSessionActivityAdoption(db).saved, policyRevisions: [] }).toEqual({
    ...before,
    policyRevisions: []
  })
  expect(sqlite.pragma('foreign_key_check')).toEqual([])
})

it('previews adoption without writes and explicitly adopts only selected current-policy coverage', () => {
  ledger()
  ledger('other')
  const row = saved({ durationMinutes: 72 })
  const other = saved({ claudeSessionId: 'other' })
  revision(row.id)
  db.insert(sessionTimeOverrides).values({ sessionId: row.id, durationMinutes: 1 }).run()
  const before = sqlite.serialize()
  sqlite.pragma('query_only = ON')
  const preview = previewSessionActivityAdoption(db)
  expect(sqlite.serialize()).toEqual(before)
  expect(preview.currentPolicy).toEqual(preview.candidatePolicy)
  expect(preview.saved.activityMappings).toEqual([])
  sqlite.pragma('query_only = OFF')
  const [mapping] = adoptSessionActivityMappings(db, preview.fingerprint, [row.id])
  expect(mapping).toMatchObject({
    sessionId: row.id,
    version: 1,
    workspaceId: preview.workspaceId,
    policyRevisionId: preview.baseRevisionId,
    previewFingerprint: preview.fingerprint,
    provider: 'claude',
    conversationId: 'conversation'
  })
  const conversation = preview.conversations[0]
  if (conversation.status !== 'resolved') throw new Error('Expected resolved fixture')
  expect(JSON.parse(mapping.intervalJson)).toEqual(conversation.before[0])
  expect(JSON.parse(mapping.intervalJson).durationMinutes).toBe(10)
  const after = previewSessionActivityAdoption(db)
  expect({ ...after.saved, activityMappings: [], mappingRevisions: [] }).toEqual(preview.saved)
  expect(after.comparisons.find((entry) => entry.sessionId === row.id)).toMatchObject({
    mappingBasis: 'adopted-event-coverage',
    mappingId: mapping.id,
    effectiveMeasurement: { durationMinutes: 72 }
  })
  expect(after.comparisons.find((entry) => entry.sessionId === other.id)).toMatchObject({
    mappingBasis: 'measurement-only',
    mappingId: null
  })
  expect(after.application).toBe('unavailable')
  expect(after.fingerprint).not.toBe(preview.fingerprint)
})

it('preserves issued invoices, billed references and edited values while adopting a mapping', () => {
  ledger()
  const client = db.insert(clients).values({ name: 'Fixture', color: 'red' }).returning().get()
  const row = saved({ clientId: client.id, durationMinutes: 72 })
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
      sessionIds: String(row.id)
    })
    .run()
  db.insert(sessionBillingRefs)
    .values({
      sessionId: row.id,
      stripeInvoiceId: 'in_fixture',
      testMode: 0,
      billedRanges: [
        { sessionId: row.id, projectId: null, clientId: client.id, startedAt: start, endedAt: end }
      ]
    })
    .run()
  const before = previewSessionActivityAdoption(db)
  adoptSessionActivityMappings(db, before.fingerprint, [row.id])
  const after = previewSessionActivityAdoption(db)
  expect({ ...after.saved, activityMappings: [], mappingRevisions: [] }).toEqual(before.saved)
  expect(after.baseRevisionId).toBe(before.baseRevisionId)
  expect(after.currentPolicy).toEqual(before.currentPolicy)
})

it('rejects a consumed receipt and reuses the mapping identity after a fresh preview and database copy', () => {
  ledger()
  const row = saved()
  const preview = previewSessionActivityAdoption(db)
  const first = adoptSessionActivityMappings(db, preview.fingerprint, [row.id])
  expect(() => adoptSessionActivityMappings(db, preview.fingerprint, [row.id])).toThrow(
    /comparison changed/
  )
  const before = sqlite.serialize()
  const fresh = previewSessionActivityAdoption(db)
  expect(adoptSessionActivityMappings(db, fresh.fingerprint, [row.id])).toEqual(first)
  expect(sqlite.serialize()).toEqual(before)
  const copy = new Database(sqlite.serialize())
  try {
    const copiedDb = drizzle(copy)
    expect(previewSessionActivityAdoption(copiedDb)).toEqual(fresh)
    expect(adoptSessionActivityMappings(copiedDb, fresh.fingerprint, [row.id])).toEqual(first)
  } finally {
    copy.close()
  }
})

it.each([null, [], [0], [-1], [1.5], ['1'], [1, 1], [Number.MAX_SAFE_INTEGER + 1]])(
  'rejects an invalid adoption selection %j without writes',
  (selection) => {
    ledger()
    saved()
    const preview = previewSessionActivityAdoption(db)
    const before = sqlite.serialize()
    expect(() => adoptSessionActivityMappings(db, preview.fingerprint, selection)).toThrow(
      /distinct saved session IDs/
    )
    expect(sqlite.serialize()).toEqual(before)
  }
)

it.each(['unknown', 'manual', 'running', 'missing-baseline', 'legacy', 'unresolved'])(
  'rejects a whole selection containing %s history',
  (kind) => {
    ledger()
    const valid = saved()
    ledger('other')
    const blocked = saved(
      {
        claudeSessionId: 'other',
        source: kind === 'manual' ? 'manual' : 'auto',
        status: kind === 'running' ? 'active' : 'completed'
      },
      kind !== 'missing-baseline'
    )
    if (kind === 'legacy') revision(blocked.id, 'reconcile')
    if (kind === 'unresolved')
      sqlite.exec(
        "UPDATE activity_identities SET provider = 'opencode' WHERE conversation_id = 'other'; UPDATE sessions SET tool = 'opencode' WHERE claude_session_id = 'other'"
      )
    const preview = previewSessionActivityAdoption(db)
    const before = sqlite.serialize()
    expect(() =>
      adoptSessionActivityMappings(db, preview.fingerprint, [
        valid.id,
        kind === 'unknown' ? 999 : blocked.id
      ])
    ).toThrow(/needs review/)
    expect(sqlite.serialize()).toEqual(before)
  }
)

it.each([
  ['saved edit', "UPDATE sessions SET description = 'changed'"],
  ['observation', "UPDATE activity_observations SET id = id || '-new'"],
  [
    'policy revision',
    "UPDATE workspace_policy SET revision_id = 'bccccccc-cccc-4ccc-accc-cccccccccccc'"
  ],
  ['workspace', "UPDATE workspace_policy SET workspace_id = 'bccccccc-cccc-4ccc-accc-cccccccccccc'"]
])('rejects a stale adoption after a %s change without writes', (_, sql) => {
  ledger()
  const row = saved()
  const preview = previewSessionActivityAdoption(db)
  sqlite.exec(sql)
  const before = sqlite.serialize()
  expect(() => adoptSessionActivityMappings(db, preview.fingerprint, [row.id])).toThrow(
    /comparison changed/
  )
  expect(sqlite.serialize()).toEqual(before)
})

it('rejects a candidate-policy receipt and retains current mapping evidence during later policy previews', () => {
  ledger()
  const row = saved()
  const candidatePreview = previewWorkspaceHistory(db, candidate)
  expect(() => adoptSessionActivityMappings(db, candidatePreview.fingerprint, [row.id])).toThrow(
    /comparison changed/
  )
  const current = previewSessionActivityAdoption(db)
  const [mapping] = adoptSessionActivityMappings(db, current.fingerprint, [row.id])
  const after = previewWorkspaceHistory(db, candidate)
  expect(after.comparisons[0]).toMatchObject({
    mappingBasis: 'adopted-event-coverage',
    mappingId: mapping.id,
    effectiveMeasurement: { durationMinutes: 1 }
  })
  expect(JSON.parse(after.saved.activityMappings[0].intervalJson).durationMinutes).toBe(10)
  expect(after.application).toBe('unavailable')
})

it('rolls back every selected mapping if a later insert fails', () => {
  ledger()
  ledger('other')
  const first = saved()
  const second = saved({ claudeSessionId: 'other' })
  sqlite.exec(
    `CREATE TRIGGER fail_mapping BEFORE INSERT ON session_activity_mappings WHEN NEW.session_id = ${second.id} BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`
  )
  const preview = previewSessionActivityAdoption(db)
  const before = sqlite.serialize()
  expect(() =>
    adoptSessionActivityMappings(db, preview.fingerprint, [first.id, second.id])
  ).toThrow(/fixture failure/)
  expect(sqlite.serialize()).toEqual(before)
})

it('rechecks pending caller changes and rolls back adoption with its enclosing transaction', () => {
  ledger()
  const row = saved()
  const preview = previewSessionActivityAdoption(db)
  const before = sqlite.serialize()
  expect(() =>
    db.transaction((tx) => {
      tx.update(sessions).set({ description: 'Pending edit' }).run()
      adoptSessionActivityMappings(tx, preview.fingerprint, [row.id])
    })
  ).toThrow(/comparison changed/)
  expect(sqlite.serialize()).toEqual(before)
  expect(() =>
    db.transaction((tx) => {
      adoptSessionActivityMappings(tx, preview.fingerprint, [row.id])
      throw new Error('cancel enclosing transaction')
    })
  ).toThrow(/cancel enclosing transaction/)
  expect(sqlite.serialize()).toEqual(before)
})

it('requires a fresh preview after another selection is adopted and keeps both mapping identities', () => {
  ledger()
  ledger('other')
  const first = saved()
  const second = saved({ claudeSessionId: 'other' })
  const preview = previewSessionActivityAdoption(db)
  const [mapping] = adoptSessionActivityMappings(db, preview.fingerprint, [first.id])
  const before = sqlite.serialize()
  expect(() => adoptSessionActivityMappings(db, preview.fingerprint, [second.id])).toThrow(
    /comparison changed/
  )
  expect(sqlite.serialize()).toEqual(before)
  const fresh = previewSessionActivityAdoption(db)
  const adopted = adoptSessionActivityMappings(db, fresh.fingerprint, [first.id, second.id])
  expect(adopted[0]).toEqual(mapping)
  expect(adopted[1].sessionId).toBe(second.id)
  expect(adopted[1].id).not.toBe(mapping.id)
  expect(previewSessionActivityAdoption(db).saved.activityMappings).toEqual(adopted)
})

it.each([
  { version: 2 },
  { workspaceId: 'different' },
  { policyRevisionId: 'different' },
  { policyJson: '{}' },
  { provider: 'codex' },
  { conversationId: 'different' },
  { intervalJson: '{malformed' }
])('holds changed or unsupported mapping evidence for review: %j', (change) => {
  ledger()
  const row = saved()
  const preview = previewSessionActivityAdoption(db)
  adoptSessionActivityMappings(db, preview.fingerprint, [row.id])
  db.update(sessionActivityMappings).set(change).run()
  const current = previewSessionActivityAdoption(db)
  expect(current.comparisons[0]).toMatchObject({
    status: 'review-required',
    reason: 'saved-activity-mapping-mismatch'
  })
  const before = sqlite.serialize()
  expect(() => adoptSessionActivityMappings(db, current.fingerprint, [row.id])).toThrow(
    /needs review/
  )
  expect(sqlite.serialize()).toEqual(before)
})

it('does not silently rebind identical measurements to different observation identities', () => {
  ledger()
  const row = saved()
  const [mapping] = adoptSessionActivityMappings(
    db,
    previewSessionActivityAdoption(db).fingerprint,
    [row.id]
  )
  sqlite.exec("UPDATE activity_observations SET id = id || '-new'")
  const preview = previewSessionActivityAdoption(db)
  expect(preview.saved.activityMappings).toEqual([mapping])
  expect(preview.comparisons[0]).toMatchObject({
    status: 'review-required',
    reason: 'saved-activity-mapping-mismatch'
  })
})

it('retains adopted anchors when a later scanner measurement changes the baseline', () => {
  ledger()
  const row = saved()
  const [mapping] = adoptSessionActivityMappings(
    db,
    previewSessionActivityAdoption(db).fingerprint,
    [row.id]
  )
  sqlite.exec(
    "UPDATE activity_observations SET payload_json = replace(payload_json, '03:10:', '03:11:'); UPDATE sessions SET ended_at = '2026-09-26T03:11:00.000Z', duration_minutes = 11; UPDATE session_derivations SET ended_at = '2026-09-26T03:11:00.000Z', duration_minutes = 11"
  )
  const preview = previewSessionActivityAdoption(db)
  expect(preview.saved.activityMappings).toEqual([mapping])
  expect(preview.comparisons[0]).toMatchObject({
    status: 'review-required',
    reason: 'saved-activity-mapping-mismatch'
  })
})

it('compares saved baselines with both policies and preserves inferred edits, metadata and issued invoices without writes', () => {
  ledger()
  const client = db.insert(clients).values({ name: 'Fixture', color: 'red' }).returning().get()
  const row = saved({ durationMinutes: 72, clientId: client.id })
  revision(row.id)
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
      sessionIds: String(row.id)
    })
    .run()
  db.insert(sessionBillingRefs)
    .values({
      sessionId: row.id,
      stripeInvoiceId: 'in_fixture',
      testMode: 0,
      billedRanges: [
        { sessionId: row.id, projectId: null, clientId: client.id, startedAt: start, endedAt: end }
      ]
    })
    .run()
  const before = sqlite.serialize()
  sqlite.pragma('query_only = ON')
  const preview = previewWorkspaceHistory(db, candidate)
  expect(preview).toMatchObject({ scope: 'saved-history-comparison', application: 'unavailable' })
  expect(preview.saved.sessions).toEqual([row])
  expect(preview.saved.revisions).toHaveLength(1)
  expect(preview.saved.invoiceLineItems[0]).toMatchObject({
    amountCents: 12000,
    durationMinutes: 72,
    sessionIds: String(row.id)
  })
  expect(preview.saved.billingRefs[0].billedRanges).toEqual([
    { sessionId: row.id, projectId: null, clientId: client.id, startedAt: start, endedAt: end }
  ])
  expect(preview.comparisons[0]).toMatchObject({
    status: 'comparable',
    mappingBasis: 'measurement-only',
    sessionId: row.id,
    beforeIndex: 0,
    afterIndex: 0,
    preservedTimeFields: ['durationMinutes'],
    effectiveMeasurement: { startedAt: start, endedAt: start, durationMinutes: 72, promptCount: 1 }
  })
  expect(preview.conversations[0]).toMatchObject({
    savedSessionIds: [row.id],
    before: [{ durationMinutes: 10 }],
    after: [{ durationMinutes: 1 }]
  })
  expect(sqlite.serialize()).toEqual(before)
})

it('retains explicit caught-up endpoint/duration overrides instead of discarding their intent', () => {
  ledger()
  const row = saved()
  db.insert(sessionTimeOverrides)
    .values({ sessionId: row.id, endedAt: 1, durationMinutes: 1 })
    .run()
  expect(previewWorkspaceHistory(db, candidate).comparisons[0]).toMatchObject({
    status: 'comparable',
    preservedTimeFields: ['endedAt', 'durationMinutes'],
    effectiveMeasurement: { endedAt: end, durationMinutes: 10 }
  })
})

it('recognizes equivalent timestamp offsets without inventing a time edit', () => {
  ledger()
  saved({ startedAt: '2026-09-25T23:00:00-04:00', endedAt: '2026-09-25T23:10:00-04:00' })
  expect(previewWorkspaceHistory(db, candidate).comparisons[0]).toMatchObject({
    status: 'comparable',
    preservedTimeFields: [],
    effectiveMeasurement: { endedAt: start, durationMinutes: 1 }
  })
})

it('holds inferred edits that become invalid under the candidate interval', () => {
  ledger()
  saved({ startedAt: '2026-09-26T03:05:00Z' })
  review('invalid-preserved-time')
})

it('inventories source-less, identity-less, manual and running history even with an empty ledger', () => {
  const missing = saved({ sourceFile: null }, false)
  const unknown = saved({ claudeSessionId: null }, false)
  const manual = saved({ source: 'manual', claudeSessionId: null }, false)
  const running = saved({ source: 'manual', status: 'active', claudeSessionId: null }, false)
  const preview = previewWorkspaceHistory(db, candidate)
  expect(preview.saved.sessions).toHaveLength(4)
  expect(preview.conversations).toEqual([])
  expect(preview.comparisons).toMatchObject([
    { sessionId: missing.id, status: 'review-required', reason: 'missing-ledger-activity' },
    { sessionId: unknown.id, status: 'review-required', reason: 'missing-conversation-id' },
    { sessionId: manual.id, status: 'preserved', reason: 'manual-entry' },
    { sessionId: running.id, status: 'preserved', reason: 'manual-entry' }
  ])
})

it('does not assign ledger activity to unrelated providers, conversations or manual entries', () => {
  ledger()
  saved({ tool: 'codex' })
  saved({ claudeSessionId: 'different' })
  saved({ source: 'manual' })
  const preview = previewWorkspaceHistory(db, candidate)
  expect(preview.conversations[0].savedSessionIds).toEqual([])
  expect(preview.comparisons.map((row) => row.conversationIndex)).toEqual([null, null, null])
})

it('exposes ledger-only conversations without fabricating saved predecessors', () => {
  ledger()
  const preview = previewWorkspaceHistory(db, candidate)
  expect(preview.conversations[0]).toMatchObject({ status: 'resolved', savedSessionIds: [] })
  expect(preview.comparisons).toEqual([])
})

it('associates a source-less saved conversation for comparison without using a filename as identity', () => {
  ledger()
  const row = saved({ sourceFile: null, projectPath: 'Z:/different-machine' })
  expect(previewWorkspaceHistory(db, candidate).comparisons[0]).toMatchObject({
    status: 'comparable',
    sessionId: row.id
  })
})

it.each([
  ['invalid-saved-time', "UPDATE sessions SET started_at = '2026-09-26T03:00:00'"],
  ['invalid-saved-time', "UPDATE session_derivations SET started_at = '2026-09-26T03:00:00'"],
  ['missing-baseline', 'DELETE FROM session_derivations'],
  ['baseline-coverage-mismatch', 'UPDATE session_derivations SET duration_minutes = 9'],
  ['saved-measurements-differ', 'UPDATE sessions SET input_tokens = 10'],
  ['saved-measurements-differ', 'UPDATE sessions SET prompt_count = 2'],
  ['unresolved-ledger-activity', 'UPDATE activity_identities SET identity_version = 2']
])('holds %s instead of treating captured activity as complete history', (reason, sql) => {
  ledger()
  saved()
  sqlite.exec(sql)
  review(reason)
})

it('detects missing model/cache measurements even when top-level tokens agree', () => {
  ledger()
  const row = saved()
  db.insert(sessionModelUsage)
    .values({ sessionId: row.id, model: 'old-model', cacheReadInputTokens: 100 })
    .run()
  review('saved-measurements-differ')
})

it('holds duplicate saved copies instead of assigning both rows to one canonical interval', () => {
  ledger()
  saved()
  saved({ sourceFile: 'copied.jsonl' })
  expect(
    previewWorkspaceHistory(db, candidate).comparisons.every(
      (row) => row.status === 'review-required' && row.reason === 'baseline-coverage-mismatch'
    )
  ).toBe(true)
})

it('holds a candidate split rather than redistributing a saved time edit', () => {
  ledger('conversation', 'user')
  saved({ durationMinutes: 72, promptCount: 2 })
  review('ambiguous-candidate-mapping')
})

it('holds a candidate merge rather than selecting one saved predecessor', () => {
  ledger('conversation', 'user')
  const first = saved({ endedAt: start, durationMinutes: 1 })
  const second = saved({ startedAt: end, durationMinutes: 1 })
  sqlite
    .prepare(
      'UPDATE session_derivations SET ended_at = ?, duration_minutes = 1 WHERE session_id = ?'
    )
    .run(start, first.id)
  sqlite
    .prepare(
      'UPDATE session_derivations SET started_at = ?, duration_minutes = 1 WHERE session_id = ?'
    )
    .run(end, second.id)
  sqlite.prepare('UPDATE workspace_policy SET policy_json = ?').run(JSON.stringify(candidate))
  const preview = previewWorkspaceHistory(db, policy)
  expect(
    preview.comparisons.every(
      (row) => row.status === 'review-required' && row.reason === 'ambiguous-candidate-mapping'
    )
  ).toBe(true)
})

it('does not invent a merge when a point session touches the preceding midnight boundary', () => {
  ledger('conversation', 'user')
  const firstStart = '2026-09-26T03:55:00.000Z'
  const midnight = '2026-09-26T04:00:00.000Z'
  for (const observation of db.select().from(activityObservations).all()) {
    const payload = JSON.parse(observation.payloadJson)
    payload.timestamp = payload.parentEventId === null ? firstStart : midnight
    sqlite
      .prepare('UPDATE activity_observations SET payload_json = ? WHERE id = ?')
      .run(JSON.stringify(payload), observation.id)
  }
  const first = saved({ startedAt: firstStart, endedAt: midnight, durationMinutes: 5 })
  const second = saved({ startedAt: midnight, endedAt: midnight, durationMinutes: 1 })
  sqlite
    .prepare(
      'UPDATE session_derivations SET started_at = ?, ended_at = ?, duration_minutes = ? WHERE session_id = ?'
    )
    .run(firstStart, midnight, 5, first.id)
  sqlite
    .prepare(
      'UPDATE session_derivations SET started_at = ?, ended_at = ?, duration_minutes = ? WHERE session_id = ?'
    )
    .run(midnight, midnight, 1, second.id)
  const reportingPolicy = { ...policy, reportingTimeZone: 'America/New_York' }
  sqlite.prepare('UPDATE workspace_policy SET policy_json = ?').run(JSON.stringify(reportingPolicy))
  const preview = previewWorkspaceHistory(db, reportingPolicy)
  expect(preview.comparisons).toMatchObject([
    {
      sessionId: first.id,
      status: 'comparable',
      mappingBasis: 'measurement-only',
      beforeIndex: 0,
      afterIndex: 0
    },
    {
      sessionId: second.id,
      status: 'comparable',
      mappingBasis: 'measurement-only',
      beforeIndex: 1,
      afterIndex: 1
    }
  ])
})

it('preserves deleted audit rows and holds surviving activity that would cross the deletion', () => {
  ledger()
  const deleted = saved()
  const active = saved()
  db.insert(sessionDeletions)
    .values({
      id: 'deletion',
      sessionId: deleted.id,
      sourceFile: 'missing.jsonl',
      tool: 'claude',
      claudeSessionId: 'conversation',
      startedAt: start,
      endedAt: end,
      createdAt: end
    })
    .run()
  const preview = previewWorkspaceHistory(db, candidate)
  expect(preview.comparisons).toMatchObject([
    { sessionId: deleted.id, disposition: 'deleted', status: 'preserved', reason: 'audit-history' },
    {
      sessionId: active.id,
      disposition: 'active',
      status: 'review-required',
      reason: 'protected-history'
    }
  ])
})

it('keeps split parents as audit history and holds their children for explicit reconciliation', () => {
  ledger()
  const parent = saved()
  const first = saved()
  const second = saved()
  db.insert(sessionSplits)
    .values({
      revisionId: revision(parent.id, 'split'),
      parentSessionId: parent.id,
      firstSessionId: first.id,
      secondSessionId: second.id,
      tool: 'claude',
      claudeSessionId: 'conversation',
      startedAt: start,
      endedAt: end,
      splitAt: '2026-09-26T03:05:00Z'
    })
    .run()
  const preview = previewWorkspaceHistory(db, candidate)
  expect(preview.comparisons[0]).toMatchObject({ disposition: 'split', status: 'preserved' })
  expect(
    preview.comparisons
      .slice(1)
      .every((row) => row.status === 'review-required' && row.reason === 'protected-history')
  ).toBe(true)
})

it('treats an explicit split of an adopted row as a cut, not whole-conversation protection', () => {
  ledger()
  const row = saved()
  adoptSessionActivityMappings(db, previewSessionActivityAdoption(db).fingerprint, [row.id])
  const [first, second] = splitMappedSession(db, row.id, '2026-09-26T03:05:00.000Z')
  const preview = previewWorkspaceHistory(db, policy)
  expect(preview.comparisons).toMatchObject([
    { sessionId: row.id, disposition: 'split', status: 'preserved', reason: 'audit-history' },
    { sessionId: first.id, status: 'comparable', mappingBasis: 'adopted-event-coverage' },
    { sessionId: second.id, status: 'comparable', mappingBasis: 'adopted-event-coverage' }
  ])
  expect(preview.conversations[0]).toMatchObject({
    operations: { cuts: ['2026-09-26T03:05:00.000Z'], deletedSessionIds: [] },
    before: [
      { startedAt: start, endedAt: '2026-09-26T03:05:00.000Z', durationMinutes: 5 },
      { startedAt: '2026-09-26T03:05:00.000Z', endedAt: end, durationMinutes: 5 }
    ]
  })
})

it('preserves replacement/predecessor links and source-less legacy snapshots', () => {
  ledger()
  const parent = saved()
  const successor = saved()
  db.insert(sessionReplacements)
    .values({
      predecessorSessionId: parent.id,
      successorSessionId: successor.id,
      revisionId: revision(parent.id, 'reconcile')
    })
    .run()
  const legacy = saved({ claudeSessionId: 'legacy', sourceFile: null }, false)
  db.insert(sessionLegacyRecords)
    .values({
      id: 'legacy-id',
      sessionId: legacy.id,
      version: 1,
      session: legacy,
      modelUsage: [],
      createdAt: end
    })
    .run()
  const preview = previewWorkspaceHistory(db, candidate)
  expect(preview.saved.legacyRecords[0].session).toEqual(legacy)
  expect(preview.comparisons).toMatchObject([
    { disposition: 'replaced', status: 'preserved' },
    { status: 'review-required', reason: 'protected-history' },
    { status: 'review-required', reason: 'missing-ledger-activity' }
  ])
})

it('retains billed-work references after invoice hiding, including unknown legacy ranges', () => {
  ledger()
  const row = saved()
  db.insert(sessionBillingRefs)
    .values({ sessionId: row.id, stripeInvoiceId: 'in_hidden', testMode: 1, billedRanges: null })
    .run()
  const preview = previewWorkspaceHistory(db, candidate)
  expect(preview.saved.invoices).toEqual([])
  expect(preview.saved.billingRefs).toMatchObject([
    { sessionId: row.id, stripeInvoiceId: 'in_hidden', testMode: 1, billedRanges: null }
  ])
  expect(preview.comparisons[0].status).toBe('comparable')
})

it('keeps an unaffected conversation comparable when another lacks saved measurement coverage', () => {
  ledger()
  saved({}, false)
  ledger('independent')
  saved({ claudeSessionId: 'independent', sourceFile: 'other.jsonl' })
  const preview = previewWorkspaceHistory(db, candidate)
  expect(preview.comparisons.map((row) => row.status)).toEqual(['review-required', 'comparable'])
})

it.each(['pending', 'keep_saved'])(
  'protects %s review references after source-path changes',
  (state) => {
    ledger()
    const row = saved({ sourceFile: 'renamed.jsonl' })
    const comparison = {
      fingerprint: 'fixture',
      sourceFile: 'old.jsonl',
      message: 'Review',
      saved: [
        { ...row, billable: Boolean(row.billable), disposition: 'active' as const, modelUsage: [] }
      ],
      detected: [],
      idleTimeoutMinutes: 15,
      createdAt: end,
      updatedAt: end
    }
    if (state === 'pending') db.insert(sessionReconciliationCases).values(comparison).run()
    else
      db.insert(sessionReconciliationResolutions)
        .values({
          id: 'resolution',
          sourceFile: 'old.jsonl',
          sequence: 1,
          action: 'keep_saved',
          fingerprint: 'fixture',
          comparison,
          createdAt: end
        })
        .run()
    review('protected-history')
  }
)

it('retains completed manual identities and split-parent lineage outside automatic measurements', () => {
  const parent = saved({ source: 'manual', claudeSessionId: null }, false)
  const child = saved({ source: 'manual', claudeSessionId: null }, false)
  db.insert(manualTimeEntries)
    .values([
      { id: 'manual-parent', sessionId: parent.id, basis: 'imported' },
      { id: 'manual-child', sessionId: child.id, basis: 'imported', parentId: 'manual-parent' }
    ])
    .run()
  const preview = previewWorkspaceHistory(db, candidate)
  expect(preview.saved.manualEntries).toMatchObject([
    { id: 'manual-parent', sessionId: parent.id },
    { id: 'manual-child', sessionId: child.id, parentId: 'manual-parent' }
  ])
  expect(
    preview.comparisons.every((row) => row.status === 'preserved' && row.reason === 'manual-entry')
  ).toBe(true)
})

it('rejects missing setup and incompatible policies without altering saved history', () => {
  ledger()
  saved()
  const before = sqlite.serialize()
  expect(() => previewWorkspaceHistory(db, { ...policy, detectorVersion: 2 })).toThrow()
  expect(sqlite.serialize()).toEqual(before)
  sqlite.exec('DELETE FROM workspace_policy')
  expect(() => previewWorkspaceHistory(db, policy)).toThrow('Initialize or join')
})

function freshnessFixture() {
  ledger()
  const row = saved()
  const manual = saved({ source: 'manual', claudeSessionId: null }, false)
  db.insert(manualTimeEntries)
    .values({ id: 'manual-entry', sessionId: manual.id, basis: 'imported' })
    .run()
  const client = db.insert(clients).values({ name: 'Fixture', color: 'red' }).returning().get()
  const invoice = db
    .insert(invoices)
    .values({
      clientId: client.id,
      stripeInvoiceId: 'in_freshness',
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
      sessionIds: String(row.id)
    })
    .run()
  db.insert(sessionBillingRefs)
    .values({
      sessionId: row.id,
      stripeInvoiceId: invoice.stripeInvoiceId,
      testMode: 0,
      billedRanges: null
    })
    .run()
  return { row, manual }
}

it('rechecks the same preview repeatedly and after database copying without writing or authorizing application', () => {
  freshnessFixture()
  const preview = previewWorkspaceHistory(db, candidate)
  expect(preview.fingerprint).toMatch(/^workspace-history-preview:v1:[a-f0-9]{64}$/)
  const before = sqlite.serialize()
  sqlite.pragma('query_only = ON')
  expect(recheckWorkspaceHistoryPreview(db, candidate, preview.fingerprint)).toEqual(preview)
  expect(
    recheckWorkspaceHistoryPreview(db, { ...candidate }, preview.fingerprint).application
  ).toBe('unavailable')
  expect(sqlite.serialize()).toEqual(before)
  const copy = new Database(before)
  try {
    copy.pragma('query_only = ON')
    expect(recheckWorkspaceHistoryPreview(drizzle(copy), candidate, preview.fingerprint)).toEqual(
      preview
    )
  } finally {
    copy.close()
  }
})

it.each([
  ['saved time', 'UPDATE sessions SET duration_minutes = 72 WHERE id = 1'],
  ['saved description', "UPDATE sessions SET description = 'New description' WHERE id = 1"],
  ['saved billability', 'UPDATE sessions SET billable = 1 WHERE id = 1'],
  ['detector baseline', 'UPDATE session_derivations SET duration_minutes = 9'],
  [
    'explicit override',
    'INSERT INTO session_time_overrides(session_id, duration_minutes) VALUES (1, 1)'
  ],
  ['manual time', 'UPDATE sessions SET duration_minutes = 72 WHERE id = 2'],
  [
    'manual provenance',
    "INSERT INTO source_machines(device_id, initial_name) VALUES ('fixture-device', 'Fixture'); UPDATE manual_time_entries SET device_id = 'fixture-device'"
  ],
  ['invoice status', "UPDATE invoices SET status = 'void'"],
  ['invoice amount', 'UPDATE invoices SET amount_paid_cents = 200'],
  ['invoice line snapshot', 'UPDATE invoice_line_items SET amount_cents = 300'],
  ['invoice line linkage', "UPDATE invoice_line_items SET session_ids = '1,2'"],
  ['hidden invoice', 'DELETE FROM invoice_line_items; DELETE FROM invoices'],
  ['billed reference', 'UPDATE session_billing_refs SET test_mode = 1'],
  ['billed ranges', "UPDATE session_billing_refs SET billed_ranges = '[]'"],
  [
    'policy revision',
    "UPDATE workspace_policy SET revision_id = '93098de4-63c9-493d-a0cf-bf3d79751a3e'"
  ],
  [
    'workspace identity',
    "UPDATE workspace_policy SET workspace_id = '93098de4-63c9-493d-a0cf-bf3d79751a3e'"
  ],
  [
    'event identity metadata',
    "UPDATE activity_identities SET native_event_id = 'changed-native-id' WHERE event_id = 'conversation-0'"
  ]
])('rejects a preview after %s changes and allows a fresh review', (_name, sql) => {
  freshnessFixture()
  const previous = previewWorkspaceHistory(db, candidate)
  sqlite.exec(sql)
  const afterMutation = sqlite.serialize()
  expect(() => recheckWorkspaceHistoryPreview(db, candidate, previous.fingerprint)).toThrowError(
    expect.objectContaining({ code: 'STALE_WORKSPACE_HISTORY_PREVIEW' })
  )
  expect(sqlite.serialize()).toEqual(afterMutation)
  const current = previewWorkspaceHistory(db, candidate)
  expect(current.fingerprint).not.toBe(previous.fingerprint)
  expect(recheckWorkspaceHistoryPreview(db, candidate, current.fingerprint)).toEqual(current)
})

it('binds new retained activity, corrections, and observations whose unresolved output stays unchanged', () => {
  freshnessFixture()
  const original = previewWorkspaceHistory(db, candidate)
  ledger('additional')
  expect(() => recheckWorkspaceHistoryPreview(db, candidate, original.fingerprint)).toThrow(
    'comparison changed'
  )
  const beforeCorrection = previewWorkspaceHistory(db, candidate)
  const observation = db.select().from(activityObservations).get()!
  db.insert(activityObservations)
    .values({
      ...observation,
      id: 'correction',
      payloadJson: JSON.stringify({
        ...JSON.parse(observation.payloadJson),
        model: 'corrected-model'
      })
    })
    .run()
  expect(() => recheckWorkspaceHistoryPreview(db, candidate, beforeCorrection.fingerprint)).toThrow(
    'comparison changed'
  )
  const conflict = previewWorkspaceHistory(db, candidate)
  sqlite
    .prepare('UPDATE activity_observations SET payload_json = ? WHERE id = ?')
    .run('{invalid-correction', 'correction')
  const changed = previewWorkspaceHistory(db, candidate)
  expect(changed.conversations).toEqual(conflict.conversations)
  expect(changed.comparisons).toEqual(conflict.comparisons)
  expect(() => recheckWorkspaceHistoryPreview(db, candidate, conflict.fingerprint)).toThrow(
    'comparison changed'
  )
})

it('binds source-less legacy snapshots, revision history and deleted audit intent', () => {
  const { row } = freshnessFixture()
  let previous = previewWorkspaceHistory(db, candidate)
  revision(row.id)
  expect(() => recheckWorkspaceHistoryPreview(db, candidate, previous.fingerprint)).toThrow(
    'comparison changed'
  )
  previous = previewWorkspaceHistory(db, candidate)
  db.insert(sessionLegacyRecords)
    .values({
      id: 'legacy',
      sessionId: row.id,
      version: 1,
      session: row,
      modelUsage: [],
      createdAt: end
    })
    .run()
  expect(() => recheckWorkspaceHistoryPreview(db, candidate, previous.fingerprint)).toThrow(
    'comparison changed'
  )
  previous = previewWorkspaceHistory(db, candidate)
  sqlite
    .prepare('UPDATE session_legacy_records SET session_json = ?')
    .run(JSON.stringify({ ...row, durationMinutes: 72 }))
  expect(() => recheckWorkspaceHistoryPreview(db, candidate, previous.fingerprint)).toThrow(
    'comparison changed'
  )
  previous = previewWorkspaceHistory(db, candidate)
  db.insert(sessionDeletions)
    .values({
      id: 'delete',
      sessionId: row.id,
      tool: 'claude',
      startedAt: start,
      endedAt: end,
      createdAt: end
    })
    .run()
  expect(() => recheckWorkspaceHistoryPreview(db, candidate, previous.fingerprint)).toThrow(
    'comparison changed'
  )
})

it('binds pending and resolved reconciliation decisions even when calculations remain unchanged', () => {
  const { row } = freshnessFixture()
  const comparison = {
    fingerprint: 'fixture',
    sourceFile: 'old.jsonl',
    message: 'Review',
    saved: [
      { ...row, billable: Boolean(row.billable), disposition: 'active' as const, modelUsage: [] }
    ],
    detected: [],
    idleTimeoutMinutes: 15,
    createdAt: end,
    updatedAt: end
  }
  let previous = previewWorkspaceHistory(db, candidate)
  db.insert(sessionReconciliationCases).values(comparison).run()
  expect(() => recheckWorkspaceHistoryPreview(db, candidate, previous.fingerprint)).toThrow(
    'comparison changed'
  )
  previous = previewWorkspaceHistory(db, candidate)
  db.insert(sessionReconciliationResolutions)
    .values({
      id: 'resolution',
      sourceFile: 'old.jsonl',
      sequence: 1,
      action: 'keep_saved',
      fingerprint: 'fixture',
      comparison,
      createdAt: end
    })
    .run()
  expect(() => recheckWorkspaceHistoryPreview(db, candidate, previous.fingerprint)).toThrow(
    'comparison changed'
  )
})

it('binds model/cache measurements, explicit split and replacement lineage', () => {
  const { row } = freshnessFixture()
  const first = saved()
  const second = saved()
  const revisionId = revision(row.id, 'split')
  let previous = previewWorkspaceHistory(db, candidate)
  db.insert(sessionModelUsage)
    .values({ sessionId: row.id, model: 'fixture-model', cacheReadInputTokens: 42 })
    .run()
  expect(() => recheckWorkspaceHistoryPreview(db, candidate, previous.fingerprint)).toThrow(
    'comparison changed'
  )
  previous = previewWorkspaceHistory(db, candidate)
  db.insert(sessionSplits)
    .values({
      revisionId,
      parentSessionId: row.id,
      firstSessionId: first.id,
      secondSessionId: second.id,
      tool: 'claude',
      startedAt: start,
      endedAt: end,
      splitAt: '2026-09-26T03:05:00Z'
    })
    .run()
  expect(() => recheckWorkspaceHistoryPreview(db, candidate, previous.fingerprint)).toThrow(
    'comparison changed'
  )
  previous = previewWorkspaceHistory(db, candidate)
  db.insert(sessionReplacements)
    .values({ predecessorSessionId: first.id, successorSessionId: second.id, revisionId })
    .run()
  expect(() => recheckWorkspaceHistoryPreview(db, candidate, previous.fingerprint)).toThrow(
    'comparison changed'
  )
})

it('binds both policy contents even when revised timeouts calculate the same measurements', () => {
  freshnessFixture()
  const preview = previewWorkspaceHistory(db, candidate)
  const otherCandidate = { ...candidate, idleTimeoutMinutes: 6 }
  expect(previewWorkspaceHistory(db, otherCandidate).conversations).toEqual(preview.conversations)
  expect(() => recheckWorkspaceHistoryPreview(db, otherCandidate, preview.fingerprint)).toThrow(
    'comparison changed'
  )
  sqlite
    .prepare('UPDATE workspace_policy SET policy_json = ?')
    .run(JSON.stringify({ ...policy, idleTimeoutMinutes: 16 }))
  expect(previewWorkspaceHistory(db, candidate).conversations).toEqual(preview.conversations)
  expect(() => recheckWorkspaceHistoryPreview(db, candidate, preview.fingerprint)).toThrow(
    'comparison changed'
  )
})

it('does not invalidate for repeated copies, new observers, observation capture times or unrelated local settings', () => {
  freshnessFixture()
  const preview = previewWorkspaceHistory(db, candidate)
  const deviceId = '93098de4-63c9-493d-a0cf-bf3d79751a3e'
  db.insert(sourceMachines).values({ deviceId, initialName: 'Second machine' }).run()
  for (const observation of db.select().from(activityObservations).all()) {
    db.insert(activitySources)
      .values({ observationId: observation.id, sourceFile: 'copy.jsonl', isSubagent: 0 })
      .run()
    db.insert(activityObservers)
      .values({ observationId: observation.id, deviceId, basis: 'observed' })
      .run()
    db.insert(activityObservations).values(observation).onConflictDoNothing().run()
  }
  sqlite.exec(
    "UPDATE activity_observations SET created_at = '2026-09-27T00:00:00Z'; INSERT INTO app_settings(key, value, updated_at) VALUES ('idle_timeout_minutes', '99', '2026-09-27T00:00:00Z')"
  )
  expect(recheckWorkspaceHistoryPreview(db, candidate, preview.fingerprint)).toEqual(preview)
})

it('keeps fingerprint ordering independent of physical identity/observation insertion order', () => {
  freshnessFixture()
  const preview = previewWorkspaceHistory(db, candidate)
  const identities = db.select().from(activityIdentities).all()
  const observations = db.select().from(activityObservations).all()
  sqlite.exec('DELETE FROM activity_observations; DELETE FROM activity_identities')
  db.insert(activityIdentities).values(identities.reverse()).run()
  db.insert(activityObservations).values(observations.reverse()).run()
  expect(recheckWorkspaceHistoryPreview(db, candidate, preview.fingerprint)).toEqual(preview)
})

it.each([
  null,
  undefined,
  '',
  'workspace-history-preview:v2:' + 'a'.repeat(64),
  'a'.repeat(64),
  { fingerprint: 'untrusted' }
])('rejects absent, malformed or incompatible fingerprints (%#)', (fingerprint) => {
  freshnessFixture()
  const before = sqlite.serialize()
  expect(() => recheckWorkspaceHistoryPreview(db, candidate, fingerprint)).toThrowError(
    expect.objectContaining({ code: 'STALE_WORKSPACE_HISTORY_PREVIEW' })
  )
  expect(sqlite.serialize()).toEqual(before)
})

it('can reject within a caller transaction and roll back the caller mutation', () => {
  freshnessFixture()
  const preview = previewWorkspaceHistory(db, candidate)
  const before = sqlite.serialize()
  expect(() =>
    db.transaction((tx) => {
      tx.insert(sessionTimeOverrides).values({ sessionId: 1, durationMinutes: 1 }).run()
      recheckWorkspaceHistoryPreview(tx, candidate, preview.fingerprint)
    })
  ).toThrow('comparison changed')
  expect(sqlite.serialize()).toEqual(before)
  expect(recheckWorkspaceHistoryPreview(db, candidate, preview.fingerprint)).toEqual(preview)
})

it('scopes a comparison and its fingerprint to selected conversations only', () => {
  ledger()
  ledger('other')
  const row = saved()
  const other = saved({ claudeSessionId: 'other' })
  const keys = ['["claude","conversation"]']
  const full = previewWorkspaceHistory(db, candidate)
  const scoped = previewWorkspaceHistory(db, candidate, keys)
  expect(scoped.conversationScope).toEqual(keys)
  expect(scoped.conversations.map((entry) => entry.conversationId)).toEqual(['conversation'])
  expect(scoped.saved.sessions.map((entry) => entry.id)).toEqual([row.id])
  expect(scoped.comparisons).toEqual(full.comparisons.filter((entry) => entry.sessionId === row.id))
  expect(scoped.fingerprint).not.toBe(full.fingerprint)
  // A scoped fingerprint never authorizes a full review, nor the reverse.
  expect(() => recheckWorkspaceHistoryPreview(db, candidate, scoped.fingerprint)).toThrow(
    'comparison changed'
  )
  expect(() => recheckWorkspaceHistoryPreview(db, candidate, full.fingerprint, keys)).toThrow(
    'comparison changed'
  )

  // Unrelated heads, rows and evidence do not invalidate the selected comparison.
  db.insert(sessionTimeOverrides).values({ sessionId: other.id, durationMinutes: 1 }).run()
  ledger('third')
  expect(recheckWorkspaceHistoryPreview(db, candidate, scoped.fingerprint, keys)).toEqual(scoped)
  expect(() => recheckWorkspaceHistoryPreview(db, candidate, full.fingerprint)).toThrow(
    'comparison changed'
  )
  db.insert(sessionTimeOverrides).values({ sessionId: row.id, durationMinutes: 1 }).run()
  expect(() => recheckWorkspaceHistoryPreview(db, candidate, scoped.fingerprint, keys)).toThrow(
    'comparison changed'
  )
})

/** Scoped and full previews agree on each selected row; indexes differ with the ledger scope. */
function agreesWithFull(conversationId: string, against: typeof policy = candidate) {
  const keys = [JSON.stringify(['claude', conversationId])]
  const full = previewWorkspaceHistory(db, against)
  const scoped = previewWorkspaceHistory(db, against, keys)
  const ids = new Set(scoped.saved.sessions.map((row) => row.id))
  const strip = (rows: typeof full.comparisons) =>
    rows.map((row) => ({ ...row, conversationIndex: row.conversationIndex === null }))
  expect(strip(scoped.comparisons)).toEqual(
    strip(full.comparisons.filter((row) => ids.has(row.sessionId)))
  )
  expect(scoped.saved.sessions).toEqual(
    full.saved.sessions.filter(
      (row) => row.source === 'auto' && row.claudeSessionId === conversationId
    )
  )
  expect(recheckWorkspaceHistoryPreview(db, against, scoped.fingerprint, keys)).toEqual(scoped)
  return scoped
}

it('keeps protections from rows referenced outside the selected conversation', () => {
  ledger()
  ledger('reviewed')
  ledger('legacy')
  ledger('replaced')
  saved()
  // A pending review filed under another source file still names this row.
  const reviewed = saved({ claudeSessionId: 'reviewed', sourceFile: 'renamed.jsonl' })
  db.insert(sessionReconciliationCases)
    .values({
      fingerprint: 'fixture',
      sourceFile: 'old.jsonl',
      message: 'Review',
      saved: [
        {
          ...reviewed,
          billable: Boolean(reviewed.billable),
          disposition: 'active' as const,
          modelUsage: []
        }
      ],
      detected: [],
      idleTimeoutMinutes: 15,
      createdAt: end,
      updatedAt: end
    })
    .run()
  const legacy = saved({ claudeSessionId: 'legacy', sourceFile: 'legacy.jsonl' })
  db.insert(sessionLegacyRecords)
    .values({
      id: 'legacy-id',
      sessionId: legacy.id,
      version: 1,
      session: legacy,
      modelUsage: [],
      createdAt: end
    })
    .run()
  // A policy replacement is not protection; its predecessor is audit history.
  const predecessor = saved({ claudeSessionId: 'replaced', sourceFile: 'replaced.jsonl' })
  const successor = saved({ claudeSessionId: 'replaced', sourceFile: 'replaced.jsonl' })
  db.insert(sessionReplacements)
    .values({
      predecessorSessionId: predecessor.id,
      successorSessionId: successor.id,
      revisionId: revision(predecessor.id, 'policy')
    })
    .run()

  const scoped = agreesWithFull('reviewed')
  expect(scoped.comparisons).toMatchObject([
    { sessionId: reviewed.id, status: 'review-required', reason: 'protected-history' }
  ])
  expect(scoped.saved.reconciliationCases).toHaveLength(1)
  expect(agreesWithFull('legacy').comparisons).toMatchObject([
    { sessionId: legacy.id, status: 'review-required', reason: 'protected-history' }
  ])
  const replaced = agreesWithFull('replaced')
  expect(replaced.comparisons[0]).toMatchObject({
    sessionId: predecessor.id,
    disposition: 'replaced',
    status: 'preserved'
  })
  expect(replaced.comparisons[1]).not.toMatchObject({ reason: 'protected-history' })
  expect(replaced.saved.revisions.map((row) => row.kind)).toEqual(['policy'])
  // Unrelated conversations' rows, facts and reviews are not shown.
  expect(replaced.saved.legacyRecords).toEqual([])
  expect(replaced.saved.reconciliationCases).toEqual([])
  expect(agreesWithFull('conversation').comparisons[0].status).toBe('comparable')
})

it('scopes explicit splits: unadopted ones protect, adopted ones are cuts', () => {
  ledger()
  ledger('adopted')
  const parent = saved()
  const first = saved()
  const second = saved()
  db.insert(sessionSplits)
    .values({
      revisionId: revision(parent.id, 'split'),
      parentSessionId: parent.id,
      firstSessionId: first.id,
      secondSessionId: second.id,
      tool: 'claude',
      claudeSessionId: 'conversation',
      startedAt: start,
      endedAt: end,
      splitAt: '2026-09-26T03:05:00Z'
    })
    .run()
  const row = saved({ claudeSessionId: 'adopted', sourceFile: 'adopted.jsonl' })
  adoptSessionActivityMappings(
    db,
    previewSessionActivityAdoption(db, [JSON.stringify(['claude', 'adopted'])]).fingerprint,
    [row.id],
    [JSON.stringify(['claude', 'adopted'])]
  )
  const [cutFirst, cutSecond] = splitMappedSession(db, row.id, '2026-09-26T03:05:00.000Z')

  const unadopted = agreesWithFull('conversation', policy)
  expect(unadopted.comparisons.slice(1)).toMatchObject([
    { status: 'review-required', reason: 'protected-history' },
    { status: 'review-required', reason: 'protected-history' }
  ])
  expect(unadopted.saved.activityMappings).toEqual([])
  const adopted = agreesWithFull('adopted', policy)
  expect(adopted.comparisons, JSON.stringify(adopted.comparisons)).toMatchObject([
    { sessionId: row.id, disposition: 'split', status: 'preserved' },
    { sessionId: cutFirst.id, status: 'comparable', mappingBasis: 'adopted-event-coverage' },
    { sessionId: cutSecond.id, status: 'comparable', mappingBasis: 'adopted-event-coverage' }
  ])
  expect(adopted.saved.splits.map((split) => split.parentSessionId)).toEqual([row.id])
})

it.each([[[]], [['conversation']], [['["claude"]']], [['["claude","a"]', '["claude","a"]']]])(
  'rejects a malformed conversation scope %j',
  (keys) => {
    ledger()
    expect(() => previewWorkspaceHistory(db, candidate, keys)).toThrow(/distinct conversations/)
  }
)
