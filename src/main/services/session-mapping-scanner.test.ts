// @vitest-environment node
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { activityIdentities, activityObservations } from '../db/schema/activity-evidence'
import { sessions } from '../db/schema/sessions'
import { sessionDerivations } from '../db/schema/session-derivations'
import { sessionActivityMappings } from '../db/schema/session-activity-mappings'
import {
  sessionMappingDecisions,
  sessionMappingRevisions
} from '../db/schema/session-mapping-revisions'
import type { DetectedSession } from '../../shared/types/session'
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
import { SessionReconciliationError } from './session-history'
import { reconcileMappedSource } from './session-mapping-scanner'
import { recordReconciliationFailure } from './session-reconciliation'

let sqlite: Database.Database
let db: ReturnType<typeof drizzle>
vi.mock('../db', () => ({ getDb: () => db }))
const policy = {
  version: 1,
  normalizationVersion: 1,
  detectorVersion: 1,
  idleTimeoutMinutes: 15,
  reportingTimeZone: 'UTC'
}
const source = 'C:/fixture/log.jsonl'
const copy = 'C:/copy/log.jsonl'
const otherSource = 'C:/other/log.jsonl'
const at = (time: string) => `2026-09-26T${time}:00.000Z`
beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  adoptInitialWorkspacePolicy(db, { workspaceId: randomUUID(), revisionId: randomUUID(), policy })
})
afterEach(() => sqlite.close())

function message(id: string, parent: string | null, time: string, conversationId: string) {
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
/** Ledger events plus saved rows measured under the current policy, as a raw scan would leave them. */
function rows(conversationId: string, sourceFile: string, times: string[]): number[] {
  times.forEach((time, index) =>
    message(
      `${conversationId}-${index}`,
      index ? `${conversationId}-${index - 1}` : null,
      time,
      conversationId
    )
  )
  const conversation = previewLedgerWorkspacePolicy(
    db,
    getWorkspacePolicy(db)!.policy
  ).conversations.find((row) => row.conversationId === conversationId)!
  if (conversation.status !== 'resolved') throw new Error('Unresolved fixture')
  return conversation.before.map((interval) => {
    const row = db
      .insert(sessions)
      .values({
        projectPath: 'C:/fixture',
        sourceFile,
        tool: 'claude',
        claudeSessionId: conversationId,
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
}
function adopt(ids: number[]) {
  adoptSessionActivityMappings(db, previewSessionActivityAdoption(db).fingerprint, ids)
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
const detected = (conversationId: string, sourceFile: string): DetectedSession => ({
  startedAt: at('03:50'),
  endedAt: at('04:10'),
  durationMinutes: 20,
  projectPath: 'C:/from-file-path',
  tool: 'claude',
  claudeSessionId: conversationId,
  sourceFile,
  promptCount: 3,
  inputTokens: 0,
  outputTokens: 0,
  modelUsage: []
})

it('manages a copied source through the existing mapping without duplicate rows or decisions', () => {
  adopt(rows('conversation', source, ['03:50', '04:00', '04:10']))
  const before = sqlite.serialize()
  expect(reconcileMappedSource(db, [detected('conversation', copy)], copy)).toBe(1)
  expect(sqlite.serialize()).toEqual(before)
})

it('advances an appended mapping in place with a stable id and retries as a no-op', () => {
  const [id] = rows('conversation', source, ['03:50', '04:00', '04:10'])
  adopt([id])
  const origin = db.select().from(sessionActivityMappings).get()!
  message('conversation-3', 'conversation-2', '04:20', 'conversation')
  expect(reconcileMappedSource(db, [detected('conversation', source)], source)).toBe(1)
  expect(db.select().from(sessions).all()).toMatchObject([
    { id, endedAt: at('04:20'), promptCount: 4, projectPath: 'C:/fixture' }
  ])
  const mapping = db.select().from(sessionActivityMappings).get()!
  expect(mapping).toMatchObject({ id: origin.id, sessionId: id })
  expect(mapping.revisionId).not.toBe(origin.revisionId)
  expect(db.select().from(sessionMappingRevisions).all()).toHaveLength(2)
  const decisions = db.select().from(sessionMappingDecisions).all()
  expect(decisions).toHaveLength(1)
  expect(JSON.parse(decisions[0].requestJson)).toMatchObject({
    choices: [],
    acknowledgedHeld: [],
    conversationKeys: ['["claude","conversation"]']
  })
  const applied = sqlite.serialize()
  expect(reconcileMappedSource(db, [detected('conversation', source)], source)).toBe(1)
  expect(sqlite.serialize()).toEqual(applied)
})

it('appends a later interval with inherited assignment and fresh description/billable defaults', () => {
  const [id] = rows('conversation', source, ['03:50', '04:00', '04:10'])
  adopt([id])
  message('conversation-3', 'conversation-2', '05:00', 'conversation')
  expect(reconcileMappedSource(db, [detected('conversation', source)], source)).toBe(2)
  const saved = db.select().from(sessions).orderBy(sessions.id).all()
  expect(saved).toMatchObject([
    { id, endedAt: at('04:10') },
    {
      startedAt: at('05:00'),
      projectPath: 'C:/fixture',
      description: null,
      billable: 1,
      sourceFile: source
    }
  ])
  expect(db.select().from(sessionActivityMappings).all()).toHaveLength(2)
})

it('retains running and unresolved mapped groups as scanner errors without writes', () => {
  adopt(rows('conversation', source, ['03:50', '04:00', '04:10']))
  db.update(sessions).set({ status: 'active' }).run()
  let before = sqlite.serialize()
  expect(() => reconcileMappedSource(db, [detected('conversation', source)], source)).toThrow(
    SessionReconciliationError
  )
  expect(sqlite.serialize()).toEqual(before)
  db.update(sessions).set({ status: 'completed' }).run()
  message('orphan', 'missing-parent', '04:20', 'conversation')
  before = sqlite.serialize()
  expect(() => reconcileMappedSource(db, [detected('conversation', copy)], copy)).toThrow(
    SessionReconciliationError
  )
  expect(sqlite.serialize()).toEqual(before)
})

it('holds a whole source that mixes mapped and unmapped conversations', () => {
  adopt(rows('conversation', source, ['03:50', '04:00', '04:10']))
  message('independent', null, '05:00', 'other')
  const before = sqlite.serialize()
  expect(() =>
    reconcileMappedSource(db, [detected('conversation', source), detected('other', source)], source)
  ).toThrow(SessionReconciliationError)
  expect(sqlite.serialize()).toEqual(before)
})

it('returns null for an independent unmanaged source', () => {
  adopt(rows('conversation', source, ['03:50', '04:00', '04:10']))
  message('independent', null, '05:00', 'other')
  const before = sqlite.serialize()
  expect(reconcileMappedSource(db, [detected('other', otherSource)], otherSource)).toBeNull()
  expect(sqlite.serialize()).toEqual(before)
})

it('retries a transient mapped failure without being blocked by its own review record', () => {
  adopt(rows('conversation', source, ['03:50', '04:00', '04:10']))
  db.update(sessions).set({ status: 'active' }).run()
  let error: Error | undefined
  try {
    reconcileMappedSource(db, [detected('conversation', source)], source)
  } catch (caught) {
    error = caught as Error
  }
  expect(error).toBeInstanceOf(SessionReconciliationError)
  recordReconciliationFailure(
    db,
    source,
    error!.message,
    [detected('conversation', source)],
    15,
    undefined,
    true
  )
  db.update(sessions).set({ status: 'completed' }).run()
  message('conversation-3', 'conversation-2', '04:20', 'conversation')
  expect(reconcileMappedSource(db, [detected('conversation', source)], source)).toBe(1)
  expect(db.select().from(sessions).get()).toMatchObject({ endedAt: at('04:20') })
})

it('continues a healthy conversation even when another conversation has a damaged head', () => {
  const good = rows('conversation', source, ['03:50', '04:00', '04:10'])
  const other = rows('other', otherSource, ['05:00'])
  adopt([...good, ...other])
  db.update(sessionActivityMappings)
    .set({ previewFingerprint: 'damaged' })
    .where(eq(sessionActivityMappings.sessionId, other[0]))
    .run()
  message('conversation-3', 'conversation-2', '04:20', 'conversation')
  expect(reconcileMappedSource(db, [detected('conversation', source)], source)).toBe(1)
  expect(() => reconcileMappedSource(db, [detected('other', otherSource)], otherSource)).toThrow(
    /mapping needs history review/
  )
})

const legacySource = 'C:/legacy/log.jsonl'
/** Saved-only history: no conversation id, so the ledger can never cover it. */
function legacyRow(): number {
  return db
    .insert(sessions)
    .values({
      projectPath: 'C:/legacy',
      sourceFile: legacySource,
      tool: 'claude',
      startedAt: at('06:00'),
      endedAt: at('06:10'),
      durationMinutes: 10,
      promptCount: 1,
      inputTokens: 0,
      outputTokens: 0
    })
    .returning()
    .get().id
}

it('continues unadopted and saved-only sources after a same-policy global decision', () => {
  adopt(rows('conversation', source, ['03:50', '04:00', '04:10']))
  rows('other', otherSource, ['05:00'])
  const legacy = legacyRow()
  const decision = request()
  expect(decision.acknowledgedHeld).toEqual(['["claude","other"]', `saved:${legacy}`])
  applySessionMappingApplication(db, decision)

  // Held for review only: ordinary reconciliation keeps counting their new work.
  message('other-1', 'other-0', '05:05', 'other')
  const before = sqlite.serialize()
  expect(reconcileMappedSource(db, [detected('other', otherSource)], otherSource)).toBeNull()
  expect(reconcileMappedSource(db, [], legacySource)).toBeNull()
  expect(sqlite.serialize()).toEqual(before)
})

it('refuses a policy change that would strand unlinked conversations until they are linked', () => {
  adopt(rows('conversation', source, ['03:50', '04:00', '04:10']))
  const [other] = rows('other', otherSource, ['05:00'])
  const legacy = legacyRow()
  const candidate = { ...policy, idleTimeoutMinutes: 20 }
  const refused = request(candidate)
  expect(refused.acknowledgedHeld).toEqual(['["claude","other"]', `saved:${legacy}`])
  let before = sqlite.serialize()
  expect(() => applySessionMappingApplication(db, refused)).toThrow(
    /1 held conversation\(s\) are not linked to captured activity \(unadopted-history\)/
  )
  expect(sqlite.serialize()).toEqual(before)

  adopt([other])
  const decision = request(candidate)
  expect(decision.acknowledgedHeld).toEqual([`saved:${legacy}`])
  applySessionMappingApplication(db, decision)
  expect(getWorkspacePolicy(db)?.policy).toEqual(candidate)
  expect(reconcileMappedSource(db, [detected('other', otherSource)], otherSource)).toBe(1)
  // Historical saved-only rows never block the change, but stay held from scans.
  before = sqlite.serialize()
  expect(() => reconcileMappedSource(db, [], legacySource)).toThrow(SessionReconciliationError)
  expect(sqlite.serialize()).toEqual(before)
})

it('holds a mapping measured under another policy until a later decision observes the hold', () => {
  adopt(rows('conversation', source, ['03:50', '04:00', '04:10']))
  db.update(sessions).set({ status: 'active' }).run()
  const candidate = { ...policy, idleTimeoutMinutes: 20 }
  const change = request(candidate)
  expect(change.acknowledgedHeld).toEqual(['["claude","conversation"]'])
  applySessionMappingApplication(db, change)
  db.update(sessions).set({ status: 'completed' }).run()
  const before = sqlite.serialize()
  expect(() => reconcileMappedSource(db, [detected('conversation', source)], source)).toThrow(
    /different workspace policy/
  )
  expect(sqlite.serialize()).toEqual(before)

  const release = request(candidate)
  applySessionMappingApplication(db, release)
  const recorded = db
    .select()
    .from(sessionMappingDecisions)
    .where(eq(sessionMappingDecisions.id, release.decisionId))
    .get()!
  expect(JSON.parse(recorded.observedDecisionIdsJson)).toEqual([change.decisionId])
  message('conversation-3', 'conversation-2', '04:20', 'conversation')
  expect(reconcileMappedSource(db, [detected('conversation', source)], source)).toBe(1)
  expect(db.select().from(sessions).get()).toMatchObject({ endedAt: at('04:20') })
})

it('records scanner decisions for only the selected conversation, its heads and causal holds', () => {
  const good = rows('conversation', source, ['03:50', '04:00', '04:10'])
  const other = rows('other', otherSource, ['05:00'])
  adopt([...good, ...other])
  applySessionMappingApplication(db, request())
  const global = db.select().from(sessionMappingDecisions).all()
  // Interleaved growth: each conversation continues while the other's head keeps moving.
  message('conversation-3', 'conversation-2', '04:20', 'conversation')
  expect(reconcileMappedSource(db, [detected('conversation', source)], source)).toBe(1)
  message('other-1', 'other-0', '05:05', 'other')
  expect(reconcileMappedSource(db, [detected('other', otherSource)], otherSource)).toBe(1)
  message('conversation-4', 'conversation-3', '04:30', 'conversation')
  expect(reconcileMappedSource(db, [detected('conversation', source)], source)).toBe(1)
  expect(db.select().from(sessions).orderBy(sessions.id).all()).toMatchObject([
    { endedAt: at('04:30') },
    { endedAt: at('05:05') }
  ])

  const mappingKeys = new Map(
    db
      .select()
      .from(sessionActivityMappings)
      .all()
      .map((row) => [row.id, JSON.stringify([row.provider, row.conversationId])])
  )
  const scanned = db
    .select()
    .from(sessionMappingDecisions)
    .all()
    .filter((row) => !global.some((entry) => entry.id === row.id))
  expect(scanned).toHaveLength(3)
  for (const decision of scanned) {
    const [key] = JSON.parse(decision.requestJson).conversationKeys as string[]
    const plan = JSON.parse(decision.planJson)
    expect(
      plan.conversations.map((row: { provider: string; conversationId: string }) =>
        JSON.stringify([row.provider, row.conversationId])
      )
    ).toEqual([key])
    expect(plan.retainedWithoutActivity).toEqual([])
    const heads = JSON.parse(decision.baseHeadsJson) as Array<[string, string]>
    expect(heads.length).toBe(1)
    expect(heads.map(([id]) => mappingKeys.get(id))).toEqual([key])
    expect(JSON.parse(decision.observedDecisionIdsJson)).toEqual([])
    expect(JSON.parse(decision.heldJson)).toEqual([])
  }
})
