// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { clients } from '../db/schema/clients'
import { folderSyncSettings, syncChanges, syncRecordStates } from '../db/schema/folder-sync'
import { sessions } from '../db/schema/sessions'
import { sessionLegacyRecords } from '../db/schema/session-legacy'
import { activeSessionCondition, sessionDeletions } from '../db/schema/session-deletions'
import { sessionRevisions, sessionSplits } from '../db/schema/session-history'
import type {
  HeldConflict,
  LegacyConflict,
  LegacyEditConflict,
  RecordConflict,
  SyncConflictItem
} from '../../shared/types/sync-conflict'
import type { SyncBatch } from './folder-sync-protocol'
import {
  applyReadySyncBatches,
  assembleOutgoingBatch,
  retainIncomingBatch
} from './folder-sync-store'
import { folderSyncAdapter } from './folder-sync-domains'
import { getDirectoryRecordView } from './folder-sync-directory-records'
import { journalDirectoryCreate, journalDirectoryEdit } from './folder-sync-directory-local'
import { adoptInitialWorkspacePolicy } from './workspace-policy'
import {
  collectLegacySyncChanges,
  journalLegacySyncChanges,
  readLegacyRecordState,
  retainSourceLessSessionsForSync
} from './folder-sync-legacy-records'
import {
  afterLocalLegacyDeletion,
  afterLocalLegacyMutation,
  afterLocalLegacySplit,
  getLegacyEditView,
  resolveLegacyEditConflict
} from './folder-sync-legacy-edits'
import { retainLegacySession } from './session-legacy'
import {
  listSyncConflicts,
  readSyncConflictResolution,
  resolveSyncConflict
} from './folder-sync-conflicts'

vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

type Db = ReturnType<typeof drizzle>
const policy = {
  version: 1,
  normalizationVersion: 1,
  detectorVersion: 1,
  idleTimeoutMinutes: 15,
  reportingTimeZone: 'UTC'
} as const

let workspaceId: string
let policySnapshot: { workspaceId: string; revisionId: string; policy: typeof policy }
const opened: Database.Database[] = []

function open(): Db {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  opened.push(sqlite)
  const db = drizzle(sqlite)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  adoptInitialWorkspacePolicy(db, policySnapshot)
  db.insert(folderSyncSettings).values({ slot: 1, workspaceId, folderPath: 'C:/sync' }).run()
  return db
}

beforeEach(() => {
  workspaceId = randomUUID()
  policySnapshot = { workspaceId: randomUUID(), revisionId: randomUUID(), policy }
})
afterEach(() => {
  while (opened.length) opened.pop()!.close()
})

function deliver(from: Db, to: Db) {
  const batch = assembleOutgoingBatch(from, workspaceId, {
    writerEpochId: randomUUID(),
    deviceId: randomUUID()
  })
  if (!batch) return
  retainIncomingBatch(to, workspaceId, JSON.parse(JSON.stringify(batch)), folderSyncAdapter)
  expect(applyReadySyncBatches(to, workspaceId, folderSyncAdapter).errors).toEqual([])
}

function edit(db: Db, syncId: string, values: Partial<typeof clients.$inferInsert>) {
  db.transaction(() =>
    journalDirectoryEdit(db, 'client', syncId, () =>
      db.update(clients).set(values).where(eq(clients.syncId, syncId)).run()
    )
  )
}

const row = (db: Db, syncId: string) =>
  db.select().from(clients).where(eq(clients.syncId, syncId)).get()!
const changes = (db: Db) => db.select().from(syncChanges).all().length

// ── Saved (legacy) history fixtures, as folder-sync-legacy-edits.test.ts records them ──

/** Each batch holds this computer's unpublished changes once; deliver it to every receiver. */
function publish(db: Db): SyncBatch | null {
  return assembleOutgoingBatch(db, workspaceId, {
    writerEpochId: randomUUID(),
    deviceId: randomUUID()
  })
}
function receive(db: Db, ...batches: Array<SyncBatch | null>) {
  for (const batch of batches)
    if (batch)
      retainIncomingBatch(db, workspaceId, JSON.parse(JSON.stringify(batch)), folderSyncAdapter)
  const result = applyReadySyncBatches(db, workspaceId, folderSyncAdapter)
  expect(result.errors).toEqual([])
  expect(result.waiting).toEqual([])
}

function legacySession(db: Db, values: Partial<typeof sessions.$inferInsert> = {}) {
  const inserted = db
    .insert(sessions)
    .values({
      projectPath: '/home/fixture/project',
      sourceFile: null,
      tool: 'claude',
      claudeSessionId: 'conversation-x',
      startedAt: '2026-03-04T10:00:00.000Z',
      endedAt: '2026-03-04T11:00:00.000Z',
      durationMinutes: 60,
      promptCount: 12,
      inputTokens: 1000,
      outputTokens: 100,
      description: 'Original',
      billable: 1,
      ...values
    })
    .returning()
    .get()
  const [retained] = retainSourceLessSessionsForSync(db, [inserted.id]).retained
  return { legacyId: retained.legacyId, sessionId: inserted.id }
}

function exportLegacy(db: Db) {
  const exported = collectLegacySyncChanges(db, workspaceId)
  expect(exported.withheld).toEqual([])
  journalLegacySyncChanges(db, workspaceId, exported.changes)
}

function sessionOf(db: Db, legacyId: string) {
  const legacy = db
    .select()
    .from(sessionLegacyRecords)
    .where(eq(sessionLegacyRecords.id, legacyId))
    .get()!
  return db.select().from(sessions).where(eq(sessions.id, legacy.sessionId)).get()!
}

function deleteLocally(db: Db, sessionId: number, legacyId: string) {
  const saved = db.select().from(sessions).where(eq(sessions.id, sessionId)).get()!
  db.insert(sessionDeletions)
    .values({
      id: randomUUID(),
      sessionId,
      sourceFile: null,
      tool: saved.tool,
      claudeSessionId: saved.claudeSessionId,
      startedAt: saved.startedAt,
      endedAt: saved.endedAt,
      createdAt: new Date().toISOString(),
      legacyRecordId: legacyId
    })
    .run()
}

/** What session-service.splitSession records for a saved row, including the parts' snapshots. */
function splitLocally(
  db: Db,
  sessionId: number,
  splitAt: string,
  minutes: [number, number]
): [string, string] {
  const parent = db.select().from(sessions).where(eq(sessions.id, sessionId)).get()!
  const parentLegacyId = retainLegacySession(db as never, parent)
  const revisionId = randomUUID()
  db.insert(sessionRevisions)
    .values({
      id: revisionId,
      sessionId,
      sequence: 1,
      kind: 'split',
      tool: parent.tool,
      claudeSessionId: parent.claudeSessionId,
      startedAt: parent.startedAt,
      endedAt: parent.endedAt,
      before: '{}',
      after: '{}',
      createdAt: new Date().toISOString()
    })
    .run()
  const parts = [
    [parent.startedAt, splitAt, minutes[0]],
    [splitAt, parent.endedAt, minutes[1]]
  ].map(([startedAt, endedAt, durationMinutes]) => {
    const { id: _id, ...rest } = parent
    const part = db
      .insert(sessions)
      .values({
        ...rest,
        startedAt: startedAt as string,
        endedAt: endedAt as string,
        durationMinutes: durationMinutes as number
      })
      .returning()
      .get()
    return { part, legacyId: retainLegacySession(db as never, part) }
  })
  db.insert(sessionSplits)
    .values({
      revisionId,
      legacyRecordId: parentLegacyId,
      parentSessionId: sessionId,
      firstSessionId: parts[0].part.id,
      secondSessionId: parts[1].part.id,
      sourceFile: null,
      tool: parent.tool,
      claudeSessionId: parent.claudeSessionId,
      startedAt: parent.startedAt,
      endedAt: parent.endedAt,
      splitAt
    })
    .run()
  return [parts[0].legacyId, parts[1].legacyId]
}

const activeMinutes = (db: Db): number =>
  db
    .select({ total: sql<number>`coalesce(sum(${sessions.durationMinutes}), 0)` })
    .from(sessions)
    .where(activeSessionCondition)
    .get()!.total
const lifecycle = (db: Db, legacyId: string) =>
  readLegacyRecordState(db, workspaceId, legacyId).lifecycle.state
const itemsOf = <K extends SyncConflictItem['kind']>(db: Db, kind: K) =>
  listSyncConflicts(db).items.filter((item) => item.kind === kind) as Array<
    Extract<SyncConflictItem, { kind: K }>
  >

it('shows only the concurrent field, rejects a stale review and converges both computers', () => {
  const a = open()
  const b = open()
  const syncId = randomUUID()
  a.transaction(() => {
    a.insert(clients).values({ syncId, name: 'Acme', color: '#123456' }).run()
    journalDirectoryCreate(a, 'client', syncId)
  })
  deliver(a, b)
  expect(row(b, syncId).name).toBe('Acme')

  // Concurrent: both rename; only A also changes the (disjoint) email.
  edit(a, syncId, { name: 'Acme North', email: 'billing@acme.test' })
  edit(b, syncId, { name: 'Acme South' })
  deliver(a, b)
  deliver(b, a)

  for (const db of [a, b]) {
    const items = listSyncConflicts(db).items
    expect(items).toHaveLength(1)
    const item = items[0] as RecordConflict
    expect(item).toMatchObject({ kind: 'record', entityType: 'client', lifecycleConflict: false })
    expect(item.fields.map((field) => field.field)).toEqual(['name'])
    expect(item.fields[0].lastAgreed?.label).toBe('Acme')
    expect(item.fields[0].alternatives.map((choice) => choice.label).sort()).toEqual([
      'Acme North',
      'Acme South'
    ])
    // The disjoint edit merged without a conflict; the held name keeps its last agreed value.
    expect(getDirectoryRecordView(db, workspaceId, 'client', syncId).fields.email.value).toBe(
      'billing@acme.test'
    )
    expect(row(db, syncId).name).toBe('Acme')
  }

  const shown = listSyncConflicts(b).items[0] as RecordConflict
  const choose = (review: RecordConflict, name: string) => ({
    kind: 'record',
    entityType: 'client',
    entityId: syncId,
    expectedHeads: review.expectedHeads,
    present: true,
    values: { name }
  })

  // A value that was never shown is not accepted.
  expect(() => resolveSyncConflict(b, choose(shown, 'Invented'))).toThrow(/shown values/)

  // Another computer changes a different field after the review: the review is stale.
  edit(a, syncId, { color: '#654321' })
  deliver(a, b)
  const before = changes(b)
  expect(() => resolveSyncConflict(b, choose(shown, 'Acme South'))).toThrow(
    /changed since it was shown/
  )
  expect(changes(b)).toBe(before)
  expect(row(b, syncId).name).toBe('Acme')

  const fresh = listSyncConflicts(b).items[0] as RecordConflict
  expect(fresh.fields.map((field) => field.field)).toEqual(['name'])
  resolveSyncConflict(b, choose(fresh, 'Acme South'))
  deliver(b, a)

  for (const db of [a, b]) {
    expect(listSyncConflicts(db).items).toEqual([])
    const view = getDirectoryRecordView(db, workspaceId, 'client', syncId)
    expect(view.conflicts).toEqual([])
    expect(row(db, syncId)).toMatchObject({
      name: 'Acme South',
      email: 'billing@acme.test',
      color: '#654321'
    })
  }
  // Replaying the same exchange changes nothing.
  const settled = changes(a)
  deliver(a, b)
  deliver(b, a)
  expect(changes(a)).toBe(settled)
})

it('rejects malformed or over-broad resolutions before touching the database', () => {
  const heads = { $present: [randomUUID()] }
  const record = {
    kind: 'record',
    entityType: 'client',
    entityId: randomUUID(),
    expectedHeads: heads,
    present: true,
    values: {}
  }
  expect(readSyncConflictResolution(record)).toMatchObject({ kind: 'record' })
  expect(() => readSyncConflictResolution({ ...record, extra: 1 })).toThrow(/Unexpected extra/)
  expect(() => readSyncConflictResolution({ ...record, entityType: 'invoice' })).toThrow(
    /Record type/
  )
  expect(() =>
    readSyncConflictResolution({ ...record, expectedHeads: { name: ['not-an-id'] } })
  ).toThrow(/Heads/)
  expect(() => readSyncConflictResolution({ kind: 'undelete' })).toThrow(/Resolution is invalid/)
  expect(() =>
    readSyncConflictResolution({
      kind: 'session-fragment',
      provider: 'claude',
      conversationId: 'c',
      fragmentHash: 'a'.repeat(64),
      reviewFingerprint: 'b'.repeat(64),
      action: 'set',
      values: { description: 'x', projectPath: 'C:/secret' },
      acknowledgedCopyEdits: []
    })
  ).toThrow(/Unexpected projectPath/)
  expect(() =>
    readSyncConflictResolution({
      kind: 'legacy',
      provider: 'unknown-tool',
      conversationId: 'c',
      candidates: [],
      keep: [],
      duplicates: []
    })
  ).toThrow(/Provider/)

  const db = open()
  const before = changes(db)
  // A session review that no longer matches is stale, never applied.
  expect(() =>
    resolveSyncConflict(db, {
      kind: 'session-mapping',
      provider: 'claude',
      conversationId: 'conversation-1',
      reviewFingerprint: 'c'.repeat(64),
      expectedHeads: heads,
      value: { clientSyncId: null, projectSyncId: null }
    })
  ).toThrow(/changed since it was shown/)
  expect(changes(db)).toBe(before)
  expect(listSyncConflicts(db).items).toEqual([])

  // Saved-history choices echo exactly what was shown, and nothing else.
  const legacyEdit = {
    kind: 'legacy-edit',
    legacyId: randomUUID(),
    expectedHeads: heads,
    values: {}
  }
  expect(readSyncConflictResolution(legacyEdit)).toMatchObject({ kind: 'legacy-edit' })
  expect(() =>
    readSyncConflictResolution({ ...legacyEdit, values: { projectPath: 'C:/secret' } })
  ).toThrow(/Unexpected projectPath/)
  expect(() =>
    readSyncConflictResolution({
      ...legacyEdit,
      lifecycle: { present: false, disposition: null, extra: 1 }
    })
  ).toThrow(/Unexpected extra/)
  expect(() =>
    readSyncConflictResolution({
      kind: 'legacy',
      provider: 'claude',
      conversationId: 'c',
      candidates: [],
      keep: [],
      duplicates: []
    })
  ).toThrow(/Review is invalid/)
})

it('keeps a saved session edited on one computer and deleted on another visible until an exact choice', () => {
  const a = open()
  const b = open()
  const { legacyId, sessionId } = legacySession(a)
  exportLegacy(a)
  receive(b, publish(a))
  const restored = sessionOf(b, legacyId)

  deleteLocally(a, sessionId, legacyId)
  expect(afterLocalLegacyDeletion(a, workspaceId, sessionId).status).toBe('journaled')
  b.update(sessions)
    .set({ description: 'Edited on the laptop' })
    .where(eq(sessions.id, restored.id))
    .run()
  expect(afterLocalLegacyMutation(b, workspaceId, restored.id).status).toBe('journaled')
  const deletion = publish(a)
  const edit = publish(b)
  receive(a, edit)
  receive(b, deletion)

  const [item] = itemsOf(b, 'legacy-edit') as LegacyEditConflict[]
  expect(item.lifecycle).toEqual([
    { present: true, disposition: null, label: 'Keep it counting as one saved session' },
    {
      present: false,
      disposition: { kind: 'deleted' },
      label: expect.stringMatching(/stays saved for audit/)
    }
  ])
  // Only the laptop changed the description, so it merged; only keep-or-remove is held.
  expect(item.fields).toEqual([])
  expect(item.current).toMatch(/counts in totals/)
  expect(activeMinutes(b)).toBe(60)
  // The deleting computer's own deletion stands locally, and it is told so.
  expect((itemsOf(a, 'legacy-edit')[0] as LegacyEditConflict).current).toMatch(
    /does not count on this computer/
  )

  const choose = (lifecycleChoice?: { present: boolean; disposition: unknown }) => ({
    kind: 'legacy-edit',
    legacyId,
    expectedHeads: item.expectedHeads,
    ...(lifecycleChoice ? { lifecycle: lifecycleChoice } : {}),
    values: {}
  })
  expect(() => resolveSyncConflict(b, choose())).toThrow(/keeps counting/)
  expect(() =>
    resolveSyncConflict(b, choose({ present: false, disposition: { kind: 'replaced' } }))
  ).toThrow(/shown options/)

  // The same resolution through the older legacy API still works on another computer.
  resolveLegacyEditConflict(a, workspaceId, {
    legacyId,
    expectedHeads: getLegacyEditView(a, workspaceId, legacyId).heads,
    present: false
  })
  receive(b, publish(a))
  const before = changes(b)
  // B's review predates that choice: it is stale, writes nothing and never undeletes.
  expect(() => resolveSyncConflict(b, choose({ present: true, disposition: null }))).toThrow(
    /changed since it was shown/
  )
  expect(changes(b)).toBe(before)
  for (const db of [a, b]) {
    expect(lifecycle(db, legacyId)).toBe('deleted')
    expect(itemsOf(db, 'legacy-edit')).toEqual([])
    expect(activeMinutes(db)).toBe(0)
  }
})

it('lets a kept split win over a concurrent deletion, and its parts count everywhere', () => {
  const a = open()
  const b = open()
  const { legacyId: parentId, sessionId } = legacySession(a)
  exportLegacy(a)
  receive(b, publish(a))
  const restored = sessionOf(b, parentId)

  const [first, second] = splitLocally(a, sessionId, '2026-03-04T10:20:00.000Z', [20, 40])
  expect(afterLocalLegacySplit(a, workspaceId, sessionId).status).toBe('journaled')
  deleteLocally(b, restored.id, parentId)
  expect(afterLocalLegacyDeletion(b, workspaceId, restored.id).status).toBe('journaled')
  const split = publish(a)
  const deletion = publish(b)
  receive(a, deletion)
  receive(b, split)

  const [item] = itemsOf(b, 'legacy-edit') as LegacyEditConflict[]
  const splitChoice = item.lifecycle!.find(
    (choice) =>
      choice.present === false && (choice.disposition as { kind: string }).kind === 'split'
  )!
  expect(splitChoice.label).toMatch(/Split it at 2026-03-04 10:20 UTC into 2 parts/)
  expect(item.lifecycle!.map((choice) => choice.present).sort()).toEqual([false, false, true])
  // The parts wait on this choice and are explained here, not offered as a duplicate review.
  expect(item.waiting).toEqual(['2 part(s) split from it do not count until you choose.'])
  expect(itemsOf(b, 'legacy')).toEqual([])
  expect(itemsOf(b, 'held')).toEqual([])
  expect([first, second].map((id) => lifecycle(b, id))).toEqual(['pending-split', 'pending-split'])

  // The resolution depends on the parts' snapshots, so every receiver accepts it.
  resolveSyncConflict(b, {
    kind: 'legacy-edit',
    legacyId: parentId,
    expectedHeads: item.expectedHeads,
    lifecycle: { present: splitChoice.present, disposition: splitChoice.disposition },
    values: {}
  })
  receive(a, publish(b))
  for (const db of [a, b]) {
    expect(lifecycle(db, parentId)).toBe('retired')
    expect([first, second].map((id) => lifecycle(db, id))).toEqual(['active', 'active'])
    expect(listSyncConflicts(db).items).toEqual([])
    expect(activeMinutes(db)).toBe(60)
  }
})

it('reviews possibly duplicated saved history only against the exact reviews it was shown', () => {
  const a = open()
  const c = open()
  const fromA = legacySession(a).legacyId
  const fromC = legacySession(c, {
    startedAt: '2026-03-04T10:30:00.000Z',
    endedAt: '2026-03-04T11:30:00.000Z'
  }).legacyId
  exportLegacy(a)
  exportLegacy(c)
  const batchA = publish(a)
  const batchC = publish(c)
  const hub = open()
  const left = open()
  const right = open()
  for (const db of [hub, left, right]) receive(db, batchA, batchC)
  const both = [fromA, fromC].sort()
  const review = (item: LegacyConflict, keep: string[], duplicates: string[]) => ({
    kind: 'legacy',
    provider: item.provider,
    conversationId: item.conversationId,
    reviewFingerprint: item.reviewFingerprint,
    candidates: item.candidates.map((candidate) => candidate.legacyId),
    keep,
    duplicates
  })

  const [shown] = itemsOf(hub, 'legacy') as LegacyConflict[]
  expect(shown.candidates.map((candidate) => [candidate.legacyId, candidate.counting])).toEqual(
    both.map((id) => [id, false])
  )
  expect(shown.previousReviews).toEqual([])
  expect(shown.explanation).toMatch(/copies from other computers do not/)
  expect(shown.explanation).not.toMatch(/agreed on/)
  expect(() => resolveSyncConflict(hub, review(shown, [], both))).toThrow(/Keep at least one copy/)

  // Left reviews first; once that arrives, the hub's older review is stale and writes nothing.
  resolveSyncConflict(
    left,
    review((itemsOf(left, 'legacy') as LegacyConflict[])[0], [fromA], [fromC])
  )
  const leftBatch = publish(left)
  receive(hub, leftBatch)
  const before = changes(hub)
  expect(() => resolveSyncConflict(hub, review(shown, both, []))).toThrow(
    /changed since it was shown/
  )
  expect(changes(hub)).toBe(before)
  expect(itemsOf(hub, 'legacy')).toEqual([])

  // Right disagrees without having seen left's review: both are shown, neither is applied.
  resolveSyncConflict(
    right,
    review((itemsOf(right, 'legacy') as LegacyConflict[])[0], [fromC], [fromA])
  )
  const rightBatch = publish(right)
  receive(hub, rightBatch)
  receive(left, rightBatch)
  receive(right, leftBatch)
  for (const db of [hub, left, right]) {
    const [disputed] = itemsOf(db, 'legacy') as LegacyConflict[]
    expect(disputed.previousReviews.map((item) => item.label).sort()).toEqual(
      [
        `Keep copy ${both.indexOf(fromA) + 1}; duplicates: copy ${both.indexOf(fromC) + 1}`,
        `Keep copy ${both.indexOf(fromC) + 1}; duplicates: copy ${both.indexOf(fromA) + 1}`
      ].sort()
    )
    expect(disputed.explanation).toMatch(/no earlier review they agreed on/)
    expect(disputed.candidates.every((candidate) => !candidate.counting)).toBe(true)
  }
  const [disputed] = itemsOf(hub, 'legacy') as LegacyConflict[]
  resolveSyncConflict(hub, review(disputed, both, []))
  const settled = publish(hub)
  receive(left, settled)
  receive(right, settled)
  for (const db of [hub, left, right]) {
    expect(itemsOf(db, 'legacy')).toEqual([])
    expect(activeMinutes(db)).toBe(120)
  }
})

it('explains invoice records that hold billing, and not copies that agree', () => {
  const db = open()
  const observation = {
    effective: null,
    heads: [],
    terminalConflict: false,
    ignoredRegressions: []
  }
  const state = (entityType: string, value: unknown) =>
    db
      .insert(syncRecordStates)
      .values({ workspaceId, entityType, entityId: randomUUID(), stateJson: JSON.stringify(value) })
      .run()
  // Two exports of one invoice that agree on what was issued: variants, not a conflict.
  state('invoice', {
    headerChangeId: randomUUID(),
    conflicts: [randomUUID()],
    issue: null,
    unresolvedRanges: 0,
    observation
  })
  expect(listSyncConflicts(db).items).toEqual([])

  state('invoice', {
    headerChangeId: randomUUID(),
    conflicts: [],
    issue: null,
    unresolvedRanges: 0,
    observation: { ...observation, terminalConflict: true }
  })
  state('provider-intent', { kind: 'send-invoice', conflicts: [randomUUID()] })
  const held = listSyncConflicts(db).items as HeldConflict[]
  expect(held.map((item) => [item.kind, item.title]).sort()).toEqual([
    ['held', 'A Stripe action'],
    ['held', 'Invoice']
  ])
  expect(held.find((item) => item.title === 'Invoice')!.explanation).toMatch(
    /paid and another as void/
  )
  expect(held.find((item) => item.title === 'A Stripe action')!.explanation).toMatch(
    /does not retry/
  )
})
