// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq, sql } from 'drizzle-orm'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sessions } from '../db/schema/sessions'
import { sessionLegacyRecords } from '../db/schema/session-legacy'
import { activeSessionCondition, sessionDeletions } from '../db/schema/session-deletions'
import { sessionRevisions, sessionSplits } from '../db/schema/session-history'
import { sessionActivityMappings } from '../db/schema/session-activity-mappings'
import { sourceMachines } from '../db/schema/activity-observers'
import { syncChanges } from '../db/schema/folder-sync'
import { activitySyncAdapter, collectActivitySyncChanges } from './folder-sync-activity-records'
import type { SyncBatch, SyncChange } from './folder-sync-protocol'
import {
  applyReadySyncBatches,
  assembleOutgoingBatch,
  recordLocalSyncChanges,
  retainIncomingBatch,
  type SyncDomainAdapter
} from './folder-sync-store'
import { directoryRecordsAdapter, isDirectoryEntityType } from './folder-sync-directory-records'
import {
  collectLegacySyncChanges,
  journalLegacySyncChanges,
  LEGACY_SYNC_ENTITY_TYPES,
  legacyRecordsAdapter,
  readLegacyQueue,
  readLegacyRecordState,
  retainSourceLessSessionsForSync
} from './folder-sync-legacy-records'
import {
  afterLocalLegacyDeletion,
  afterLocalLegacyMutation,
  afterLocalLegacySplit,
  getLegacyEditView,
  readLegacyEditConflicts,
  resolveLegacyEditConflict
} from './folder-sync-legacy-edits'
import {
  historyObserversAdapter,
  collectHistoryObserverChanges
} from './folder-sync-history-observers'
import { retainLegacySession } from './session-legacy'

const workspaceId = '6a0f8f64-3c1d-4b8e-9f51-2d7c4e9b1a30'
type Db = ReturnType<typeof drizzle>
const opened: Database.Database[] = []
const connections = new Map<Db, Database.Database>()

function database(bytes?: Buffer): Db {
  const connection = new Database(bytes ?? ':memory:')
  connection.pragma('foreign_keys = ON')
  opened.push(connection)
  const db = drizzle(connection)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  connections.set(db, connection)
  return db
}
afterEach(() => {
  for (const connection of opened.splice(0)) connection.close()
  connections.clear()
})

const legacyTypes = new Set<string>(LEGACY_SYNC_ENTITY_TYPES)
const route = (change: SyncChange): SyncDomainAdapter =>
  legacyTypes.has(change.entityType)
    ? legacyRecordsAdapter
    : change.entityType === 'history-observer'
      ? historyObserversAdapter
      : isDirectoryEntityType(change.entityType)
        ? directoryRecordsAdapter
        : activitySyncAdapter
const adapter: SyncDomainAdapter = {
  validate: (change) => route(change).validate(change),
  apply: (tx, workspace, change) => route(change).apply(tx, workspace, change)
}
function publish(db: Db): SyncBatch {
  const batch = assembleOutgoingBatch(db, workspaceId, {
    writerEpochId: randomUUID(),
    deviceId: randomUUID()
  })
  if (!batch) throw new Error('Nothing to publish')
  return batch
}
function deliver(db: Db, ...batches: SyncBatch[]): void {
  for (const batch of batches) retainIncomingBatch(db, workspaceId, batch, adapter)
  const result = applyReadySyncBatches(db, workspaceId, adapter)
  expect(result.errors).toEqual([])
  expect(result.waiting).toEqual([])
}

function legacySession(
  db: Db,
  values: Partial<typeof sessions.$inferInsert> = {}
): { legacyId: string; sessionId: number } {
  const row = db
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
  const [retained] = retainSourceLessSessionsForSync(db, [row.id]).retained
  return { legacyId: retained.legacyId, sessionId: row.id }
}

function exportHistory(db: Db, name = 'Desktop') {
  const deviceId = randomUUID()
  db.insert(sourceMachines).values({ deviceId, initialName: name }).run()
  recordLocalSyncChanges(db, workspaceId, collectActivitySyncChanges(db, workspaceId), adapter)
  const legacy = collectLegacySyncChanges(db, workspaceId)
  journalLegacySyncChanges(db, workspaceId, legacy.changes)
  recordLocalSyncChanges(
    db,
    workspaceId,
    collectHistoryObserverChanges(db, workspaceId, deviceId).changes,
    adapter
  )
  return legacy
}

/** What session-service.splitSession records for a legacy row, including child snapshots. */
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
  const children = [
    [parent.startedAt, splitAt, minutes[0]],
    [splitAt, parent.endedAt, minutes[1]]
  ].map(([startedAt, endedAt, durationMinutes]) => {
    const { id: _id, ...rest } = parent
    const row = db
      .insert(sessions)
      .values({
        ...rest,
        startedAt: startedAt as string,
        endedAt: endedAt as string,
        durationMinutes: durationMinutes as number
      })
      .returning()
      .get()
    return { row, legacyId: retainLegacySession(db as never, row) }
  })
  db.insert(sessionSplits)
    .values({
      revisionId,
      legacyRecordId: parentLegacyId,
      parentSessionId: sessionId,
      firstSessionId: children[0].row.id,
      secondSessionId: children[1].row.id,
      sourceFile: null,
      tool: parent.tool,
      claudeSessionId: parent.claudeSessionId,
      startedAt: parent.startedAt,
      endedAt: parent.endedAt,
      splitAt
    })
    .run()
  return [children[0].legacyId, children[1].legacyId]
}

function sessionOf(db: Db, legacyId: string) {
  const legacy = db
    .select()
    .from(sessionLegacyRecords)
    .where(eq(sessionLegacyRecords.id, legacyId))
    .get()!
  return db.select().from(sessions).where(eq(sessions.id, legacy.sessionId)).get()!
}

function deleteLocally(db: Db, sessionId: number, legacyId: string): void {
  const row = db.select().from(sessions).where(eq(sessions.id, sessionId)).get()!
  db.insert(sessionDeletions)
    .values({
      id: randomUUID(),
      sessionId,
      sourceFile: null,
      tool: row.tool,
      claudeSessionId: row.claudeSessionId,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      createdAt: new Date().toISOString(),
      legacyRecordId: legacyId
    })
    .run()
}

const activeMinutes = (db: Db): number =>
  db
    .select({ total: sql<number>`coalesce(sum(${sessions.durationMinutes}), 0)` })
    .from(sessions)
    .where(activeSessionCondition)
    .get()!.total
const lifecycle = (db: Db, legacyId: string) =>
  readLegacyRecordState(db, workspaceId, legacyId).lifecycle.state

it('exports edits made before sync as content-derived baselines and later edits causally', () => {
  const a = database()
  const { legacyId, sessionId } = legacySession(a)
  a.update(sessions)
    .set({ description: 'Edited before sync', billable: 0 })
    .where(eq(sessions.id, sessionId))
    .run()
  const clone = database(connections.get(a)!.serialize())
  const fromA = exportHistory(a)
  const fromClone = exportHistory(clone, 'Desktop copy')
  expect(fromA.metadataDrift).toEqual([])
  expect(fromClone.changes.map((change) => change.id)).toEqual(
    fromA.changes.map((change) => change.id)
  )
  // The snapshot stays the original saved row; the baseline carries the edited values.
  const fact = fromA.changes.find((change) => change.entityType === 'legacy-session')!
  expect(fact.payload).toMatchObject({ description: 'Original', billable: true })

  const b = database()
  deliver(b, publish(a), publish(clone))
  expect(sessionOf(b, legacyId)).toMatchObject({ description: 'Edited before sync', billable: 0 })
  expect(getLegacyEditView(b, workspaceId, legacyId).conflicts).toEqual([])

  a.update(sessions).set({ description: 'Later edit' }).where(eq(sessions.id, sessionId)).run()
  const edit = afterLocalLegacyMutation(a, workspaceId, sessionId)
  expect(edit.status).toBe('journaled')
  expect(afterLocalLegacyMutation(a, workspaceId, sessionId)).toEqual({ status: 'unchanged' })
  deliver(b, publish(a))
  const restored = sessionOf(b, legacyId)
  expect(restored.description).toBe('Later edit')

  // The receiver edits another field of the restored row; both computers converge.
  b.update(sessions).set({ billable: 1 }).where(eq(sessions.id, restored.id)).run()
  expect(afterLocalLegacyMutation(b, workspaceId, restored.id).status).toBe('journaled')
  deliver(a, publish(b))
  expect(a.select().from(sessions).where(eq(sessions.id, sessionId)).get()).toMatchObject({
    description: 'Later edit',
    billable: 1
  })
})

it('shares a deletion as retained, non-counting audit history', () => {
  const a = database()
  const { legacyId, sessionId } = legacySession(a)
  exportHistory(a)
  const b = database()
  deliver(b, publish(a))
  expect(activeMinutes(b)).toBe(60)

  deleteLocally(a, sessionId, legacyId)
  expect(afterLocalLegacyDeletion(a, workspaceId, sessionId).status).toBe('journaled')
  deliver(b, publish(a))
  expect(activeMinutes(b)).toBe(0)
  expect(lifecycle(b, legacyId)).toBe('deleted')
  // Retained for audit, and a deletion is not a review item.
  expect(sessionOf(b, legacyId).durationMinutes).toBe(60)
  expect(readLegacyQueue(b, workspaceId)).toEqual([])
})

it('exports a deletion that happened before sync and restores it as deleted', () => {
  const a = database()
  const { legacyId, sessionId } = legacySession(a)
  deleteLocally(a, sessionId, legacyId)
  const exported = exportHistory(a)
  expect(exported.withheld).toEqual([])
  const b = database()
  deliver(b, publish(a))
  expect(activeMinutes(b)).toBe(0)
  expect(lifecycle(b, legacyId)).toBe('deleted')
})

it('keeps a concurrent edit and deletion as a visible conflict with the last agreed lifecycle', () => {
  const a = database()
  const { legacyId, sessionId } = legacySession(a)
  exportHistory(a)
  const shared = publish(a)
  const b = database()
  deliver(b, shared)
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
  deliver(a, edit)
  deliver(b, deletion)
  const d = database()
  deliver(d, shared, edit, deletion)

  for (const db of [b, d]) {
    // The last agreed lifecycle (present) keeps counting; nothing is undeleted or dropped silently.
    expect(activeMinutes(db)).toBe(60)
    expect(lifecycle(db, legacyId)).toBe('conflict')
    expect(sessionOf(db, legacyId).description).toBe('Edited on the laptop')
    expect(readLegacyEditConflicts(db, workspaceId).map((row) => row.legacyId)).toEqual([legacyId])
  }
  // The deleting computer's own deletion stands locally, and the conflict is visible there too.
  expect(activeMinutes(a)).toBe(0)
  expect(lifecycle(a, legacyId)).toBe('conflict')
  expect(afterLocalLegacyMutation(b, workspaceId, restored.id).status).not.toBe('journaled')

  resolveLegacyEditConflict(d, workspaceId, {
    legacyId,
    expectedHeads: getLegacyEditView(d, workspaceId, legacyId).heads,
    present: false
  })
  const resolution = publish(d)
  deliver(a, resolution)
  deliver(b, resolution)
  for (const db of [a, b, d]) {
    expect(lifecycle(db, legacyId)).toBe('deleted')
    expect(activeMinutes(db)).toBe(0)
    expect(readLegacyEditConflicts(db, workspaceId)).toEqual([])
  }
})

it('exports a historical legacy split so a blank receiver counts its children and keeps the parent for audit', () => {
  const a = database()
  const { legacyId: parentId, sessionId } = legacySession(a)
  const [first, second] = splitLocally(a, sessionId, '2026-03-04T10:20:00.000Z', [20, 40])
  expect(activeMinutes(a)).toBe(60)
  const clone = database(connections.get(a)!.serialize())
  const exported = exportHistory(a)
  expect(exported.withheld).toEqual([])
  const facts = exported.changes.filter((change) => change.entityType === 'legacy-session')
  expect(
    Object.fromEntries(facts.map((change) => [change.entityId, change.payload.splitFrom]))
  ).toEqual({
    [parentId]: null,
    [first]: parentId,
    [second]: parentId
  })
  // The split names both children and depends on their snapshots.
  const retire = exported.changes.find(
    (change) =>
      change.entityType === 'legacy-edit' &&
      change.entityId === parentId &&
      change.dependencies.length > 1
  )!
  expect((retire.payload.fields as Record<string, { value: unknown }>).disposition.value).toEqual({
    kind: 'split',
    splitAt: '2026-03-04T10:20:00.000Z',
    children: [first, second]
  })
  expect(exportHistory(clone, 'Desktop copy').changes.map((change) => change.id)).toEqual(
    exported.changes.map((change) => change.id)
  )

  const b = database()
  deliver(b, publish(a))
  expect(activeMinutes(b)).toBe(60)
  expect(lifecycle(b, parentId)).toBe('retired')
  expect(lifecycle(b, first)).toBe('active')
  expect(readLegacyQueue(b, workspaceId)).toEqual([])
  expect(b.select().from(sessionLegacyRecords).all()).toHaveLength(3)

  // A current split of a restored child on B reaches A through the same lineage.
  const secondRow = sessionOf(b, second)
  const [third, fourth] = splitLocally(b, secondRow.id, '2026-03-04T10:40:00.000Z', [20, 20])
  expect(afterLocalLegacySplit(b, workspaceId, secondRow.id).status).toBe('journaled')
  deliver(a, publish(b))
  for (const db of [a, b]) {
    expect(activeMinutes(db)).toBe(60)
    expect(lifecycle(db, second)).toBe('retired')
    expect([third, fourth].map((id) => lifecycle(db, id))).toEqual(['active', 'active'])
    expect(readLegacyQueue(db, workspaceId)).toEqual([])
  }
})

it("keeps split children out of totals until their parent's split arrives", () => {
  const a = database()
  const { legacyId: parentId, sessionId } = legacySession(a)
  exportHistory(a)
  const before = publish(a)
  const [first] = splitLocally(a, sessionId, '2026-03-04T10:20:00.000Z', [20, 40])
  expect(afterLocalLegacySplit(a, workspaceId, sessionId).status).toBe('journaled')
  const split = publish(a)
  const children = split.changes.filter((change) => change.entityType === 'legacy-session')
  expect(children).toHaveLength(2)

  const b = database()
  deliver(b, before)
  // Deliver only the child snapshots first: they wait outside totals, visibly.
  b.transaction((tx) => {
    for (const change of children) {
      tx.insert(syncChanges)
        .values({
          id: change.id,
          workspaceId,
          kind: change.kind,
          entityType: change.entityType,
          entityId: change.entityId,
          changeJson: JSON.stringify(change),
          origin: 'imported',
          recordedAt: new Date().toISOString()
        })
        .run()
      legacyRecordsAdapter.apply(tx, workspaceId, change)
    }
  })
  expect(activeMinutes(b)).toBe(60)
  expect(readLegacyQueue(b, workspaceId).filter((entry) => entry.legacyId === first)).toMatchObject(
    [{ status: 'queued', counting: false, reasons: ['pending-split'], splitFrom: parentId }]
  )
})

it('exports an adopted legacy row as non-counting audit history for receivers', () => {
  const a = database()
  const { legacyId, sessionId } = legacySession(a)
  a.insert(sessionActivityMappings)
    .values({
      id: randomUUID(),
      sessionId,
      version: 1,
      workspaceId,
      policyRevisionId: randomUUID(),
      policyJson: '{}',
      provider: 'claude',
      conversationId: 'conversation-x',
      intervalJson: '{}',
      previewFingerprint: 'fixture',
      createdAt: new Date().toISOString()
    })
    .run()
  exportHistory(a)
  // The origin's row is the adopted activity session and keeps counting.
  expect(activeMinutes(a)).toBe(60)
  const b = database()
  deliver(b, publish(a))
  expect(readLegacyRecordState(b, workspaceId, legacyId).lifecycle).toMatchObject({
    state: 'retired',
    disposition: { kind: 'adopted', coverageHash: null }
  })
  expect(activeMinutes(b)).toBe(0)
})

it('rejects legacy edits with unknown dispositions or without their snapshot', () => {
  const entityId = randomUUID()
  const future = {
    id: randomUUID(),
    kind: 'revision',
    entityType: 'legacy-edit',
    entityId,
    dependencies: [],
    payload: {
      fields: {
        $present: { value: false, parents: [] },
        disposition: { value: { kind: 'archived' }, parents: [] }
      }
    }
  } as unknown as SyncChange
  expect(() => legacyRecordsAdapter.validate(future)).toThrow(/update ClauTime/)
  const partial = {
    ...future,
    payload: {
      fields: { $present: { value: true, parents: [] }, description: { value: 'x', parents: [] } }
    }
  } as unknown as SyncChange
  expect(() => legacyRecordsAdapter.validate(partial)).toThrow(/baseline/)

  // A baseline whose snapshot is not applied waits instead of inventing a row.
  const a = database()
  const { legacyId } = legacySession(a)
  exportHistory(a)
  const baseline = a
    .select()
    .from(syncChanges)
    .where(eq(syncChanges.entityType, 'legacy-edit'))
    .all()
    .map((row) => JSON.parse(row.changeJson) as SyncChange)
    .find((change) => change.entityId === legacyId)!
  const b = database()
  expect(() => recordLocalSyncChanges(b, workspaceId, [baseline], adapter)).toThrow(/missing/)
})

it('an explicit keep choice restores locally deleted history without erasing deletion audit', () => {
  const a = database()
  const { legacyId, sessionId } = legacySession(a)
  exportHistory(a)
  const b = database()
  deliver(b, publish(a))
  deleteLocally(a, sessionId, legacyId)
  afterLocalLegacyDeletion(a, workspaceId, sessionId)
  const remote = sessionOf(b, legacyId)
  b.update(sessions).set({ description: 'Concurrent edit' }).where(eq(sessions.id, remote.id)).run()
  afterLocalLegacyMutation(b, workspaceId, remote.id)
  const deletion = publish(a)
  const edit = publish(b)
  deliver(a, edit)
  deliver(b, deletion)
  resolveLegacyEditConflict(b, workspaceId, {
    legacyId,
    expectedHeads: getLegacyEditView(b, workspaceId, legacyId).heads,
    present: true
  })
  deliver(a, publish(b))
  expect(activeMinutes(a)).toBe(60)
  expect(activeMinutes(b)).toBe(60)
  expect(a.select().from(sessionDeletions).all()).toHaveLength(1)
  a.update(sessions)
    .set({ description: 'Edited after restore' })
    .where(eq(sessions.id, sessionId))
    .run()
  expect(afterLocalLegacyMutation(a, workspaceId, sessionId).status).toBe('journaled')
  deliver(b, publish(a))
  expect(sessionOf(b, legacyId).description).toBe('Edited after restore')
  exportHistory(a)
  expect(activeMinutes(a)).toBe(60)
})
it('a rejected split keeps its parts only as settled audit history', () => {
  const a = database()
  const { legacyId: parentId, sessionId } = legacySession(a)
  exportHistory(a)
  const b = database()
  deliver(b, publish(a))
  const parts = splitLocally(a, sessionId, '2026-03-04T10:20:00.000Z', [20, 40])
  afterLocalLegacySplit(a, workspaceId, sessionId)
  const other = sessionOf(b, parentId)
  deleteLocally(b, other.id, parentId)
  afterLocalLegacyDeletion(b, workspaceId, other.id)
  const split = publish(a)
  const deletion = publish(b)
  deliver(a, deletion)
  deliver(b, split)
  resolveLegacyEditConflict(b, workspaceId, {
    legacyId: parentId,
    expectedHeads: getLegacyEditView(b, workspaceId, parentId).heads,
    present: false,
    disposition: { kind: 'deleted' }
  })
  deliver(a, publish(b))
  for (const db of [a, b]) {
    expect(parts.map((id) => lifecycle(db, id))).toEqual(['retired', 'retired'])
    expect(readLegacyQueue(db, workspaceId)).toEqual([])
    expect(activeMinutes(db)).toBe(0)
    expect(db.select().from(sessionLegacyRecords).all()).toHaveLength(3)
  }
})

it('plans keep-all resolutions only for the conversations a local hook touches', () => {
  const a = database()
  const overlapping = (claudeSessionId: string) => [
    legacySession(a, { claudeSessionId }),
    legacySession(a, {
      claudeSessionId,
      startedAt: '2026-03-04T10:30:00.000Z',
      endedAt: '2026-03-04T11:30:00.000Z'
    })
  ]
  const [touched] = overlapping('touched')
  const [splitRow] = overlapping('split')
  overlapping('other')
  const lone = legacySession(a, { claudeSessionId: 'lone' })
  // Journaled as a stepped bootstrap does: every conversation's keep-all is still pending.
  journalLegacySyncChanges(a, workspaceId, collectLegacySyncChanges(a, workspaceId).changes, {
    origin: 'none'
  })
  const keepAll = () =>
    a
      .select({ json: syncChanges.changeJson })
      .from(syncChanges)
      .where(eq(syncChanges.entityType, 'legacy-reconciliation'))
      .all()
      .map((row) => (JSON.parse(row.json) as SyncChange).payload.conversationId as string)
      .sort()
  expect(keepAll()).toEqual([])

  deleteLocally(a, lone.sessionId, lone.legacyId)
  expect(afterLocalLegacyDeletion(a, workspaceId, lone.sessionId).status).toBe('journaled')
  splitLocally(a, splitRow.sessionId, '2026-03-04T10:20:00.000Z', [20, 40])
  expect(afterLocalLegacySplit(a, workspaceId, splitRow.sessionId).status).toBe('journaled')
  expect(keepAll()).not.toContain('other')
  expect(keepAll()).not.toContain('touched')

  a.update(sessions).set({ description: 'Edited' }).where(eq(sessions.id, touched.sessionId)).run()
  expect(afterLocalLegacyMutation(a, workspaceId, touched.sessionId).status).toBe('journaled')
  expect(keepAll()).toContain('touched')
  expect(keepAll()).not.toContain('other')

  // The other conversation is left for the unscoped sweep.
  journalLegacySyncChanges(a, workspaceId, [])
  expect(keepAll()).toContain('other')
})
