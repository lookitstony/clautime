// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { eq } from 'drizzle-orm'
import { sessions } from '../db/schema/sessions'
import { sessionDerivations } from '../db/schema/session-derivations'
import { sessionModelUsage } from '../db/schema/session-model-usage'
import { sessionActivityMappings } from '../db/schema/session-activity-mappings'
import { sessionBillingRefs } from '../db/schema/session-history'
import { parseCodexSessionFile } from '../parsers/codex-parser'
import { storeActivityEvidence } from './activity-evidence'
import { adoptInitialWorkspacePolicy, previewLedgerWorkspacePolicy } from './workspace-policy'
import {
  adoptSessionActivityMappings,
  previewSessionActivityAdoption
} from './session-activity-mappings'
import { previewSessionMappingTransitions } from './session-mapping-transitions'
import { planSessionMappingApplication } from './session-mapping-plan'
import { applySessionMappingApplication } from './session-mapping-application'

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
let directory: string
const policy = {
  version: 1,
  normalizationVersion: 1,
  detectorVersion: 1,
  idleTimeoutMinutes: 15,
  reportingTimeZone: 'UTC'
}
const at = (minute: number) =>
  new Date(Date.parse('2026-09-26T03:00:00Z') + minute * 60_000).toISOString()
const item = (minute: number, role: string) => ({
  timestamp: at(minute),
  type: 'response_item',
  payload: {
    type: 'message',
    role,
    content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: 'fixture' }]
  }
})
const tokens = (minute: number, input: number, output: number) => ({
  timestamp: at(minute),
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: input, cached_input_tokens: 20, output_tokens: output }
    }
  }
})
const lines = () => [
  {
    timestamp: at(0),
    type: 'session_meta',
    payload: { id: 'codex-mapping-fixture', cwd: 'C:/fixture' }
  },
  { timestamp: at(0), type: 'turn_context', payload: { model: 'fixture-model' } },
  item(0, 'user'),
  item(1, 'assistant'),
  tokens(1.1, 100, 10)
]
beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  adoptInitialWorkspacePolicy(db, { workspaceId: randomUUID(), revisionId: randomUUID(), policy })
  directory = mkdtempSync(join(tmpdir(), 'clautime-codex-mapping-'))
})
afterEach(() => {
  sqlite.close()
  const target = resolve(directory)
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('clautime-codex-mapping-'))
    throw new Error('Invalid fixture path')
  rmSync(target, { recursive: true, force: true })
})
async function capture(records: unknown[], file = 'fixture.jsonl') {
  const path = join(directory, file)
  writeFileSync(path, records.map((row) => JSON.stringify(row)).join('\n'))
  const parsed = (await parseCodexSessionFile(path))!
  expect(parsed.codexActivityEvidence?.status).toBe('captured')
  db.transaction((tx) => storeActivityEvidence(tx, parsed, at(5)))
}
async function seed() {
  await capture(lines())
  const conversation = previewLedgerWorkspacePolicy(db, policy).conversations[0]
  if (conversation.status !== 'resolved') throw new Error(conversation.reason)
  const interval = conversation.before[0]
  const row = db
    .insert(sessions)
    .values({
      source: 'auto',
      tool: 'codex',
      claudeSessionId: 'codex-mapping-fixture',
      projectPath: 'C:/fixture',
      sourceFile: join(directory, 'fixture.jsonl'),
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
  db.insert(sessionModelUsage)
    .values(interval.modelUsage.map((usage) => ({ ...usage, sessionId: row.id })))
    .run()
  adoptSessionActivityMappings(db, previewSessionActivityAdoption(db).fingerprint, [row.id])
  return row
}

it('applies new checkpoints on the same message without losing its saved anchors or billed ranges', async () => {
  const row = await seed()
  db.insert(sessionBillingRefs)
    .values({
      sessionId: row.id,
      stripeInvoiceId: 'in_fixture',
      testMode: 1,
      billedRanges: [
        {
          sessionId: row.id,
          projectId: null,
          clientId: null,
          startedAt: row.startedAt,
          endedAt: row.endedAt
        }
      ]
    })
    .run()
  const billed = db.select().from(sessionBillingRefs).all()
  const original = db.select().from(sessionActivityMappings).get()!
  await capture([...lines(), tokens(1.2, 250, 30)])
  await capture([...lines(), tokens(1.2, 250, 30)], 'copy.jsonl')
  const preview = previewSessionMappingTransitions(db, policy)
  expect(preview.mappings[0]).toMatchObject({ status: 'compared', relationship: 'one-to-one' })
  const decisionId = randomUUID()
  const plan = planSessionMappingApplication(preview, decisionId)
  expect(plan.conversations[0]).toMatchObject({
    status: 'applicable',
    successors: [
      {
        keepSessionId: row.id,
        interval: { inputTokens: 230, outputTokens: 30, coverage: { version: 2 } }
      }
    ]
  })
  expect(plan.conversations[0].successors[0].interval.coverage.usage).toHaveLength(2)
  const result = applySessionMappingApplication(db, {
    decisionId,
    candidate: policy,
    expectedFingerprint: preview.fingerprint,
    choices: [],
    acknowledgedHeld: []
  })
  expect(result.appliedSessionIds).toEqual([row.id])
  expect(db.select().from(sessions).all()).toHaveLength(1)
  expect(db.select().from(sessionBillingRefs).all()).toEqual(billed)
  const updated = db.select().from(sessionActivityMappings).get()!
  expect(updated.id).toBe(original.id)
  expect(updated.revisionId).not.toBe(original.revisionId)
  expect(previewSessionMappingTransitions(db, policy).mappings[0]).toMatchObject({
    status: 'compared',
    relationship: 'unchanged'
  })
})

it.each(['missing-usage', 'wrong-owner', 'wrong-count', 'duplicate-observation', 'wrong-version'])(
  'rejects malformed Codex mapping evidence: %s',
  async (corruption) => {
    await seed()
    const mapping = db.select().from(sessionActivityMappings).get()!
    const interval = JSON.parse(mapping.intervalJson)
    if (corruption === 'missing-usage') delete interval.coverage.usage
    if (corruption === 'wrong-owner') interval.coverage.usage[0].messageEventId = 'absent'
    if (corruption === 'wrong-count') interval.inputTokens++
    if (corruption === 'duplicate-observation')
      interval.coverage.messages[0].observationIds.push(interval.coverage.messages[0].observationId)
    if (corruption === 'wrong-version') interval.coverage.version = 1
    db.update(sessionActivityMappings)
      .set({ intervalJson: JSON.stringify(interval) })
      .where(eq(sessionActivityMappings.id, mapping.id))
      .run()
    expect(previewSessionMappingTransitions(db, policy).mappings[0]).toMatchObject({
      status: 'review-required',
      reason: 'invalid-mapping'
    })
  }
)

it('holds lost checkpoint coverage and includes it in the exact reduction acknowledgment', async () => {
  await seed()
  const preview = previewSessionMappingTransitions(db, policy)
  const conversation = preview.history.conversations[0]
  if (conversation.status !== 'resolved') throw new Error('fixture unresolved')
  conversation.after = structuredClone(conversation.after)
  conversation.after[0].coverage.usage = []
  const plan = planSessionMappingApplication(preview, randomUUID())
  expect(plan.conversations[0].heldReasons).toContain('lost-usage-coverage')
  expect(plan.coverageReductions[0].uncountedUsage).toHaveLength(1)
  expect(
    planSessionMappingApplication(preview, randomUUID(), [], [plan.coverageReductions[0].key])
      .conversations[0].status
  ).toBe('held')
})
