// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
  adoptInitialWorkspacePolicy,
  getWorkspacePolicy,
  previewLedgerWorkspacePolicy
} from './workspace-policy'
import {
  adoptSessionActivityMappings,
  previewSessionActivityAdoption
} from './session-activity-mappings'
import { reviewWorkspaceActivityAdoption } from './workspace-review'
import { readCanonicalActivity } from './canonical-activity'

// Pass-through spy: records which conversations each ledger read covered.
vi.mock('./canonical-activity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./canonical-activity')>()
  return { ...actual, readCanonicalActivity: vi.fn(actual.readCanonicalActivity) }
})

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

/** Ledger events plus saved rows measured under the current policy, as a raw scan would leave them. */
function rows(conversationId: string, times: string[]): number[] {
  times.forEach((time, index) => {
    const eventId = `${conversationId}-${index}`
    db.insert(activityIdentities)
      .values({
        eventId,
        provider: 'claude',
        conversationId,
        identityVersion: 1,
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
        createdAt: at(time),
        payloadJson: JSON.stringify({
          type: 'user',
          timestamp: at(time),
          parentEventId: index ? `${conversationId}-${index - 1}` : null,
          model: null,
          usage: null,
          isToolResult: false,
          hasToolUse: false,
          toolNames: []
        })
      })
      .run()
  })
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
        sourceFile: `C:/fixture/${conversationId}.jsonl`,
        tool: 'claude',
        claudeSessionId: conversationId,
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
    return row.id
  })
}
function adopt(ids: number[]) {
  return adoptSessionActivityMappings(db, previewSessionActivityAdoption(db).fingerprint, ids)
}

it('rejects a partial conversation selection without writes and adopts the whole conversation', () => {
  const ids = rows('conversation', ['03:00', '03:10', '05:00'])
  expect(ids).toHaveLength(2)
  const other = rows('other', ['06:00', '06:10'])
  const preview = previewSessionActivityAdoption(db)
  const before = sqlite.serialize()
  for (const selection of [[ids[0]], [ids[1]], [ids[0], ...other]])
    expect(() => adoptSessionActivityMappings(db, preview.fingerprint, selection)).toThrowError(
      expect.objectContaining({ code: 'PARTIAL_ACTIVITY_ADOPTION' })
    )
  expect(sqlite.serialize()).toEqual(before)

  const adopted = adoptSessionActivityMappings(db, preview.fingerprint, ids)
  expect(adopted.map((row) => row.sessionId)).toEqual(ids)
  expect(adopted.every((row) => row.conversationId === 'conversation')).toBe(true)
  expect(db.select().from(sessionActivityMappings).all()).toHaveLength(2)
})

it('counts already linked rows toward coverage of their conversation', () => {
  const ids = rows('conversation', ['03:00', '03:10', '05:00'])
  // A partially linked conversation left by an earlier release.
  const preview = previewSessionActivityAdoption(db)
  const conversation = preview.conversations[0]
  if (conversation.status !== 'resolved') throw new Error('Unresolved fixture')
  const first = db
    .insert(sessionActivityMappings)
    .values({
      id: 'earlier-partial-adoption',
      sessionId: ids[0],
      version: 1,
      workspaceId: preview.workspaceId,
      policyRevisionId: preview.baseRevisionId,
      policyJson: JSON.stringify(preview.currentPolicy),
      provider: 'claude',
      conversationId: 'conversation',
      intervalJson: JSON.stringify(conversation.before[0]),
      previewFingerprint: preview.fingerprint,
      createdAt: at('07:00')
    })
    .returning()
    .get()
  expect(reviewWorkspaceActivityAdoption(db).conversations).toMatchObject([
    { status: 'ready', pendingSessionIds: [ids[1]] }
  ])
  expect(adopt([ids[1]])).toMatchObject([{ sessionId: ids[1] }])
  expect(
    db
      .select()
      .from(sessionActivityMappings)
      .all()
      .map((row) => row.sessionId)
      .sort((a, b) => a - b)
  ).toEqual(ids)
  expect(adopt(ids)[0]).toEqual(first)
})

it('blocks the whole conversation when any active row is ineligible', () => {
  const ids = rows('conversation', ['03:00', '03:10', '05:00'])
  db.update(sessions).set({ status: 'active' }).where(eq(sessions.id, ids[1])).run()
  const preview = previewSessionActivityAdoption(db)
  const before = sqlite.serialize()
  expect(() => adoptSessionActivityMappings(db, preview.fingerprint, [ids[0]])).toThrowError(
    expect.objectContaining({ code: 'PARTIAL_ACTIVITY_ADOPTION' })
  )
  expect(() => adoptSessionActivityMappings(db, preview.fingerprint, ids)).toThrow(/needs review/)
  expect(sqlite.serialize()).toEqual(before)
  expect(reviewWorkspaceActivityAdoption(db).conversations).toMatchObject([
    {
      conversationId: 'conversation',
      status: 'blocked',
      reasons: ['running-session'],
      pendingSessionIds: ids
    }
  ])
})

it('scopes the preview, fingerprint and adoption to the selected conversations', () => {
  const ids = rows('conversation', ['03:00', '03:10', '05:00'])
  const unrelated = rows('unrelated', ['06:00', '06:10'])
  const key = '["claude","conversation"]'
  const reads = vi.mocked(readCanonicalActivity)
  reads.mockClear()
  const scoped = previewSessionActivityAdoption(db, [key])
  expect(reads.mock.calls.map(([, keys]) => keys)).toEqual([[key]])
  expect(scoped.conversations.map((row) => row.conversationId)).toEqual(['conversation'])
  expect(scoped.comparisons.map((row) => row.sessionId)).toEqual(ids)
  const full = previewSessionActivityAdoption(db)
  expect(scoped.fingerprint).not.toBe(full.fingerprint)

  const before = sqlite.serialize()
  // A fingerprint binds its scope, and rows outside the scope were never reviewed.
  expect(() => adoptSessionActivityMappings(db, full.fingerprint, ids, [key])).toThrowError(
    expect.objectContaining({ code: 'STALE_WORKSPACE_HISTORY_PREVIEW' })
  )
  expect(() => adoptSessionActivityMappings(db, scoped.fingerprint, ids)).toThrowError(
    expect.objectContaining({ code: 'STALE_WORKSPACE_HISTORY_PREVIEW' })
  )
  expect(() => adoptSessionActivityMappings(db, scoped.fingerprint, unrelated, [key])).toThrow(
    /needs review/
  )
  expect(() => adoptSessionActivityMappings(db, scoped.fingerprint, [ids[0]], [key])).toThrowError(
    expect.objectContaining({ code: 'PARTIAL_ACTIVITY_ADOPTION' })
  )
  expect(sqlite.serialize()).toEqual(before)

  reads.mockClear()
  const adopted = adoptSessionActivityMappings(db, scoped.fingerprint, ids, [key])
  expect(adopted.map((row) => row.sessionId)).toEqual(ids)
  expect(reads.mock.calls.map(([, keys]) => keys)).toEqual([[key]])
  expect(
    db
      .select()
      .from(sessionActivityMappings)
      .all()
      .map((row) => row.conversationId)
  ).toEqual(['conversation', 'conversation'])
})

it('groups the renderer review by conversation with pending, linked and blocked state', () => {
  const ids = rows('conversation', ['03:00', '03:10', '05:00'])
  const [linked] = rows('linked', ['06:00', '06:10'])
  adopt([linked])
  const review = reviewWorkspaceActivityAdoption(db)
  expect(review.fingerprint).toBe(previewSessionActivityAdoption(db).fingerprint)
  expect(review.conversations).toMatchObject([
    {
      key: '["claude","conversation"]',
      status: 'ready',
      reasons: [],
      pendingSessionIds: ids,
      sessions: ids.map((sessionId) => ({ sessionId, adopted: false }))
    },
    {
      key: '["claude","linked"]',
      status: 'linked',
      pendingSessionIds: [],
      sessions: [{ sessionId: linked, adopted: true }]
    }
  ])
  expect(
    adoptSessionActivityMappings(db, review.fingerprint, review.conversations[0].pendingSessionIds)
  ).toHaveLength(2)
})
