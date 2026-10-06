// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { removeSessionActivityMappings } from '../db/migration-test-helpers'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { appSettings } from '../db/schema/app-settings'
import { clients } from '../db/schema/clients'
import { sessions } from '../db/schema/sessions'
import { invoices, invoiceLineItems } from '../db/schema/invoices'
import { workspacePolicy } from '../db/schema/workspace-policy'
import { activityIdentities, activityObservations } from '../db/schema/activity-evidence'
import { sessionRevisions, sessionBillingRefs } from '../db/schema/session-history'
import type { ParsedSessionData } from '../parsers/types'
import {
  getWorkspacePolicy,
  initializeWorkspacePolicy,
  adoptInitialWorkspacePolicy,
  previewWorkspacePolicy,
  previewLedgerWorkspacePolicy,
  readCanonicalHistoryConstraints
} from './workspace-policy'
import { historyRecordsAdapter, planSessionSplitFact } from './folder-sync-history-records'
import { recordLocalSyncChanges } from './folder-sync-store'

let sqlite: Database.Database
let db: ReturnType<typeof drizzle>
const migrationsFolder = join(__dirname, '../db/migrations')
const policy = {
  version: 1,
  normalizationVersion: 1,
  detectorVersion: 1,
  idleTimeoutMinutes: 20,
  reportingTimeZone: 'UTC'
}
const incoming = { workspaceId: randomUUID(), revisionId: randomUUID(), policy }
beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder })
})
afterEach(() => sqlite.close())

function savedHistory() {
  const client = db.insert(clients).values({ name: 'Fixture', color: 'red' }).returning().get()
  const session = db
    .insert(sessions)
    .values({
      projectPath: 'C:/fixture',
      startedAt: '2026-09-26T03:55:00Z',
      endedAt: '2026-09-26T04:10:00Z',
      durationMinutes: 72,
      description: 'Saved time override',
      source: 'manual',
      clientId: client.id
    })
    .returning()
    .get()
  db.insert(sessionRevisions)
    .values({
      id: randomUUID(),
      sessionId: session.id,
      sequence: 1,
      kind: 'edit',
      tool: 'claude',
      before: JSON.stringify({ durationMinutes: 15 }),
      after: JSON.stringify({ durationMinutes: 72 }),
      createdAt: '2026-09-26T05:00:00Z'
    })
    .run()
  db.insert(sessionBillingRefs)
    .values({
      sessionId: session.id,
      stripeInvoiceId: 'in_fixture_saved',
      testMode: 0
    })
    .run()
  const invoice = db
    .insert(invoices)
    .values({
      clientId: client.id,
      stripeInvoiceId: 'in_fixture_saved',
      status: 'paid',
      amountDueCents: 12000,
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
      sessionIds: String(session.id)
    })
    .run()
}
function history() {
  return [
    'sessions',
    'session_revisions',
    'session_billing_refs',
    'invoices',
    'invoice_line_items',
    'clients',
    'app_settings'
  ].map((table) =>
    sqlite
      .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
      .all()
      .map((row) => {
        // Later migrations add nullable provider scope and the built-in role; compare saved data.
        const {
          provider_account_id: _account,
          operation_id: _operation,
          hidden: _hidden,
          system_role: _role,
          ...saved
        } = row as Record<string, unknown>
        return saved
      })
  )
}
function recordings(): ParsedSessionData[] {
  const timestamps = [
    '2026-09-26T03:56:00Z',
    '2026-09-26T03:58:00Z',
    '2026-09-26T04:02:00Z',
    '2026-09-26T04:10:00Z'
  ]
  const usage = {
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0
  }
  return [
    {
      sessionId: 'fixture',
      sourceFile: 'fixture.jsonl',
      projectPathEncoded: '',
      projectDirectory: 'C:/fixture',
      messages: timestamps.map((timestamp) => ({
        type: 'user',
        timestamp,
        sessionId: 'fixture',
        cwd: 'C:/fixture',
        gitBranch: null,
        model: 'fixture',
        usage,
        uuid: null,
        parentUuid: null,
        isToolResult: false,
        hasToolUse: false,
        toolNames: []
      })),
      firstTimestamp: timestamps[0],
      lastTimestamp: timestamps[3],
      progressTimestamps: [],
      subagentProgressTimestamps: [],
      subagentMessages: [],
      models: ['fixture'],
      totalTokenUsage: { ...usage, inputTokens: 40, outputTokens: 20 },
      subagentTokenUsage: { ...usage, inputTokens: 0, outputTokens: 0 },
      messageCount: 4,
      summary: null
    }
  ]
}

it('adds empty policy storage on upgrade without choosing defaults or modifying saved history', () => {
  savedHistory()
  removeSessionActivityMappings(sqlite)
  sqlite.exec('DROP TABLE workspace_policy')
  sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at = ?').run(1790380800002)
  const before = history()
  migrate(db, { migrationsFolder })
  expect(getWorkspacePolicy(db)).toBeNull()
  expect(history()).toEqual(before)
  migrate(db, { migrationsFolder })
  expect(getWorkspacePolicy(db)).toBeNull()
  expect(sqlite.pragma('foreign_key_check')).toEqual([])
})

it('initializes once from current settings and preserves the policy across retries, restart and copies', () => {
  savedHistory()
  db.insert(appSettings).values({ key: 'idle_timeout_minutes', value: '27' }).run()
  const before = history()
  const first = initializeWorkspacePolicy(db, 'America/New_York')
  expect(first.policy).toEqual({
    ...policy,
    // New workspaces use the current normalization; joined/adopted ones keep theirs.
    normalizationVersion: 2,
    idleTimeoutMinutes: 27,
    reportingTimeZone: 'America/New_York'
  })
  expect(history()).toEqual(before)
  sqlite.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run('3', 'idle_timeout_minutes')
  expect(initializeWorkspacePolicy(db, 'Asia/Kathmandu')).toEqual(first)
  const copy = new Database(sqlite.serialize())
  try {
    const copiedDb = drizzle(copy)
    migrate(copiedDb, { migrationsFolder })
    expect(initializeWorkspacePolicy(copiedDb, 'UTC')).toEqual(first)
    expect(getWorkspacePolicy(copiedDb)).toEqual(first)
  } finally {
    copy.close()
  }
})

it('uses the ordinary 15 minute default only when explicitly creating without a saved idle setting', () => {
  expect(initializeWorkspacePolicy(db, 'UTC').policy.idleTimeoutMinutes).toBe(15)
})

it.each(['', ' ', 'nonsense', '20minutes', '0', '-1', 'Infinity', '20.5', '1e3', '0x20'])(
  'refuses invalid initial idle settings (%s) without saving a policy',
  (value) => {
    db.insert(appSettings).values({ key: 'idle_timeout_minutes', value }).run()
    expect(() => initializeWorkspacePolicy(db, 'UTC')).toThrow()
    expect(getWorkspacePolicy(db)).toBeNull()
  }
)

it('refuses a missing/invalid initial timezone without saving a policy', () => {
  expect(() => initializeWorkspacePolicy(db, '')).toThrow()
  expect(() => initializeWorkspacePolicy(db, 'Invalid/Zone')).toThrow()
  expect(getWorkspacePolicy(db)).toBeNull()
})

it('adopts an initial shared snapshot without reading or overwriting receiving-computer settings/history', () => {
  savedHistory()
  db.insert(appSettings)
    .values({ key: 'idle_timeout_minutes', value: 'invalid-local-setting' })
    .run()
  const before = history()
  expect(adoptInitialWorkspacePolicy(db, incoming)).toEqual(incoming)
  expect(adoptInitialWorkspacePolicy(db, structuredClone(incoming))).toEqual(incoming)
  expect(initializeWorkspacePolicy(db, 'Invalid/Zone')).toEqual(incoming)
  expect(history()).toEqual(before)
  expect(db.select().from(workspacePolicy).all()).toHaveLength(1)
})

it.each([
  { ...incoming, workspaceId: randomUUID() },
  { ...incoming, revisionId: randomUUID() },
  { ...incoming, policy: { ...policy, idleTimeoutMinutes: 30 } },
  { ...incoming, policy: { ...policy, reportingTimeZone: 'America/New_York' } }
])(
  'rejects workspace/revision/content conflicts without replacing the saved policy (%#)',
  (value) => {
    adoptInitialWorkspacePolicy(db, incoming)
    expect(() => adoptInitialWorkspacePolicy(db, value)).toThrow('reconciliation')
    expect(getWorkspacePolicy(db)).toEqual(incoming)
  }
)

it.each([
  null,
  { ...incoming, workspaceId: 'not-a-uuid' },
  { ...incoming, future: true },
  { ...incoming, policy: { ...policy, version: 2 } }
])('rejects malformed or unsupported initial snapshots before writing (%#)', (value) => {
  expect(() => adoptInitialWorkspacePolicy(db, value)).toThrow()
  expect(getWorkspacePolicy(db)).toBeNull()
})

it.each([
  '{',
  JSON.stringify({ ...policy, detectorVersion: 2 }),
  JSON.stringify({ ...policy, reportingTimeZone: '' })
])(
  'never replaces an invalid or incompatible saved policy with local defaults (%#)',
  (policyJson) => {
    db.insert(workspacePolicy)
      .values({
        slot: 1,
        workspaceId: incoming.workspaceId,
        revisionId: incoming.revisionId,
        policyJson
      })
      .run()
    const before = db.select().from(workspacePolicy).all()
    expect(() => getWorkspacePolicy(db)).toThrow()
    expect(() => initializeWorkspacePolicy(db, 'UTC')).toThrow()
    expect(() => adoptInitialWorkspacePolicy(db, incoming)).toThrow()
    expect(() => previewWorkspacePolicy(db, recordings(), policy)).toThrow()
    expect(db.select().from(workspacePolicy).all()).toEqual(before)
  }
)

it('rolls back failed creation and allows a clean retry', () => {
  sqlite.exec(`CREATE TRIGGER fail_policy BEFORE INSERT ON workspace_policy
    BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`)
  expect(() => initializeWorkspacePolicy(db, 'UTC')).toThrow()
  expect(() => adoptInitialWorkspacePolicy(db, incoming)).toThrow()
  expect(getWorkspacePolicy(db)).toBeNull()
  sqlite.exec('DROP TRIGGER fail_policy')
  expect(adoptInitialWorkspacePolicy(db, incoming)).toEqual(incoming)
})

it('enforces one policy row per application database', () => {
  adoptInitialWorkspacePolicy(db, incoming)
  expect(() =>
    db
      .insert(workspacePolicy)
      .values({
        slot: 2,
        workspaceId: randomUUID(),
        revisionId: randomUUID(),
        policyJson: JSON.stringify(policy)
      })
      .run()
  ).toThrow()
  expect(getWorkspacePolicy(db)).toEqual(incoming)
})

it('previews before/after calculations on a read-only database without modifying saved edits, invoices or facts', () => {
  savedHistory()
  const saved = adoptInitialWorkspacePolicy(db, incoming)
  const before = history()
  const facts = recordings()
  const original = structuredClone(facts)
  sqlite.pragma('query_only = ON')
  const preview = previewWorkspacePolicy(db, facts, {
    ...policy,
    reportingTimeZone: 'America/New_York'
  })
  expect(preview).toMatchObject({
    scope: 'supplied-recordings',
    workspaceId: saved.workspaceId,
    baseRevisionId: saved.revisionId,
    currentPolicy: policy
  })
  expect(preview.before.map((row) => row.durationMinutes)).toEqual([14])
  expect(preview.after.map((row) => row.durationMinutes)).toEqual([4, 10])
  expect(preview.after.reduce((total, row) => total + row.inputTokens, 0)).toBe(40)
  expect(history()).toEqual(before)
  expect(getWorkspacePolicy(db)).toEqual(saved)
  expect(facts).toEqual(original)
})

it('rejects preview before setup and rejects incompatible candidates without changing saved policy', () => {
  expect(() => previewWorkspacePolicy(db, recordings(), policy)).toThrow('Initialize or join')
  adoptInitialWorkspacePolicy(db, incoming)
  const before = sqlite.serialize()
  expect(() =>
    previewWorkspacePolicy(db, recordings(), { ...policy, normalizationVersion: 3 })
  ).toThrow()
  expect(sqlite.serialize()).toEqual(before)
})

it('previews captured ledger on a query-only database while preserving saved edited/billed automatic history', () => {
  savedHistory()
  sqlite.exec("UPDATE sessions SET source = 'auto', claude_session_id = 'fixture'")
  adoptInitialWorkspacePolicy(db, incoming)
  const facts = recordings()[0]
  for (const [index, message] of facts.messages.entries()) {
    const eventId = `fixture-${index}`
    db.insert(activityIdentities)
      .values({
        eventId,
        provider: 'claude',
        identityVersion: 1,
        conversationId: 'fixture',
        basis: 'native',
        nativeEventId: eventId
      })
      .run()
    db.insert(activityObservations)
      .values({
        id: `observation-${index}`,
        eventId,
        version: 1,
        kind: 'message',
        createdAt: '2026-09-26T05:00:00Z',
        payloadJson: JSON.stringify({
          type: message.type,
          timestamp: message.timestamp,
          parentEventId: index ? `fixture-${index - 1}` : null,
          model: message.model,
          usage: message.usage,
          isToolResult: false,
          hasToolUse: false,
          toolNames: []
        })
      })
      .run()
  }
  const before = sqlite.serialize()
  sqlite.pragma('query_only = ON')
  const preview = previewLedgerWorkspacePolicy(db, {
    ...policy,
    reportingTimeZone: 'America/New_York'
  })
  expect(preview).toMatchObject({ scope: 'captured-ledger', baseRevisionId: incoming.revisionId })
  const conversation = preview.conversations[0]
  expect(conversation.status).toBe('resolved')
  if (conversation.status !== 'resolved') throw new Error('Expected resolved calculation')
  expect(conversation.before.map((row) => row.durationMinutes)).toEqual([14])
  expect(conversation.after.map((row) => row.durationMinutes)).toEqual([4, 10])
  expect(conversation.after.reduce((sum, row) => sum + row.inputTokens, 0)).toBe(40)
  expect(sqlite.serialize()).toEqual(before)
  expect(db.select().from(sessions).get()!.durationMinutes).toBe(72)
})

it('requires setup and compatible candidates for ledger previews, and labels empty coverage explicitly', () => {
  expect(() => previewLedgerWorkspacePolicy(db, policy)).toThrow('Initialize or join')
  adoptInitialWorkspacePolicy(db, incoming)
  expect(() => previewLedgerWorkspacePolicy(db, { ...policy, detectorVersion: 2 })).toThrow()
  expect(previewLedgerWorkspacePolicy(db, policy)).toMatchObject({
    scope: 'captured-ledger',
    conversations: []
  })
  expect(getWorkspacePolicy(db)).toEqual(incoming)
})

it('unions portable facts into constraints without inventing local rows, and lists facts still waiting for activity', () => {
  adoptInitialWorkspacePolicy(db, incoming)
  const workspaceId = randomUUID()
  const cut = (splitAt: string) =>
    planSessionSplitFact(workspaceId, { provider: 'claude', conversationId: 'remote', splitAt })
  const [later, earlier] = [cut('2026-09-26T10:04:00.000Z'), cut('2026-09-26T10:03:00.000Z')]
  recordLocalSyncChanges(db, workspaceId, [later, earlier], historyRecordsAdapter)
  const key = JSON.stringify(['claude', 'remote'])
  expect(readCanonicalHistoryConstraints(db).get(key)).toEqual({
    cuts: ['2026-09-26T10:03:00.000Z', '2026-09-26T10:04:00.000Z'],
    cutOperations: [
      { operationId: earlier.id, splitAt: '2026-09-26T10:03:00.000Z' },
      { operationId: later.id, splitAt: '2026-09-26T10:04:00.000Z' }
    ],
    masks: [],
    invalid: []
  })
  expect(readCanonicalHistoryConstraints(db, ['["claude","other"]']).size).toBe(0)
  expect(previewLedgerWorkspacePolicy(db, policy)).toMatchObject({
    conversations: [],
    waitingOperationIds: [earlier.id, later.id].sort()
  })
  expect(db.select().from(sessions).all()).toEqual([])
})

it('keeps independent workspaces distinct but produces matching previews after an explicit join', () => {
  const saved = initializeWorkspacePolicy(db, 'UTC')
  const other = new Database(':memory:')
  try {
    const otherDb = drizzle(other)
    migrate(otherDb, { migrationsFolder })
    const independent = initializeWorkspacePolicy(otherDb, 'UTC')
    expect(independent.workspaceId).not.toBe(saved.workspaceId)
    expect(independent.revisionId).not.toBe(saved.revisionId)
    expect(() => adoptInitialWorkspacePolicy(otherDb, saved)).toThrow('reconciliation')
  } finally {
    other.close()
  }
  const joining = new Database(':memory:')
  try {
    const joiningDb = drizzle(joining)
    migrate(joiningDb, { migrationsFolder })
    joiningDb.insert(appSettings).values({ key: 'idle_timeout_minutes', value: '1' }).run()
    adoptInitialWorkspacePolicy(joiningDb, saved)
    const candidate = { ...policy, reportingTimeZone: 'America/New_York' }
    expect(previewWorkspacePolicy(joiningDb, recordings(), candidate)).toEqual(
      previewWorkspacePolicy(db, recordings(), candidate)
    )
  } finally {
    joining.close()
  }
})
