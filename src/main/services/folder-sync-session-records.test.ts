// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SyncBatch, SyncChange } from './folder-sync-protocol'
import {
  applyReadySyncBatches,
  assembleOutgoingBatch,
  recordLocalSyncChanges,
  retainIncomingBatch,
  type SyncDomainAdapter
} from './folder-sync-store'
import { PRESENT, planRevision, type RevisionChange } from './folder-sync-revisions'
import { clients } from '../db/schema/clients'
import { UNASSIGNED_CLIENT_SYNC_ID } from './folder-sync-builtin-client'
import { activitySyncAdapter, syncFactChangeId } from './folder-sync-activity-records'
import {
  directoryRecordsAdapter,
  isDirectoryEntityType,
  planDirectoryRevision
} from './folder-sync-directory-records'
import {
  isSessionRecordEntityType,
  journalSessionRecordChanges,
  planPortableSessionEdit,
  planSessionEditBaseline,
  planSessionMappingBaseline,
  planSessionSplitCopies,
  readPortableSessionRecords,
  SESSION_EDIT_SCHEMA,
  sessionRecordsAdapter,
  type PortableSessionAnchor,
  type PortableSessionEditRequest
} from './folder-sync-session-records'
import {
  resolvePortableConversation,
  resolvePortableSessionFields,
  type PortableSessionFragment
} from './folder-sync-session-overlay'

const workspaceId = '6a0f8f64-3c1d-4b8e-9f51-2d7c4e9b1a30'
const target = { provider: 'claude', conversationId: 'conversation-1' }
type Db = ReturnType<typeof drizzle>
const opened: Database.Database[] = []
let a: Db
let b: Db

function database(): Db {
  const connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  opened.push(connection)
  const db = drizzle(connection)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  return db
}
beforeEach(() => {
  a = database()
  b = database()
})
afterEach(() => {
  for (const connection of opened.splice(0)) connection.close()
})

const route = (change: SyncChange): SyncDomainAdapter =>
  isSessionRecordEntityType(change.entityType)
    ? sessionRecordsAdapter
    : isDirectoryEntityType(change.entityType)
      ? directoryRecordsAdapter
      : activitySyncAdapter
const adapter: SyncDomainAdapter = {
  validate: (change) => route(change).validate(change),
  apply: (tx, workspace, change) => route(change).apply(tx, workspace, change)
}

const record = (db: Db, changes: unknown[]): string[] =>
  recordLocalSyncChanges(db, workspaceId, changes, adapter)
const journal = (db: Db, changes: readonly RevisionChange[]): string[] =>
  journalSessionRecordChanges(db, workspaceId, changes)
const assemble = (db: Db): SyncBatch | null =>
  assembleOutgoingBatch(db, workspaceId, { writerEpochId: randomUUID(), deviceId: randomUUID() })
function publish(db: Db): SyncBatch {
  const batch = assemble(db)
  if (!batch) throw new Error('Nothing to publish')
  return batch
}
function deliver(db: Db, ...batches: SyncBatch[]): ReturnType<typeof applyReadySyncBatches> {
  for (const batch of batches) retainIncomingBatch(db, workspaceId, batch, adapter)
  return applyReadySyncBatches(db, workspaceId, adapter)
}
function exchange(): void {
  const fromA = assemble(a)
  const fromB = assemble(b)
  if (fromA) expect(deliver(b, fromA).errors).toEqual([])
  if (fromB) expect(deliver(a, fromB).errors).toEqual([])
}
function codeOf(action: () => unknown): string | undefined {
  try {
    action()
  } catch (error) {
    return (error as { code?: string }).code ?? 'uncoded'
  }
  return undefined
}

const at = (minute: number): string =>
  new Date(Date.UTC(2026, 8, 1, 9, 0) + minute * 60_000).toISOString()
const hex = (n: number): string => n.toString(16).padStart(64, '0')
const eventId = (n: number): string => `claude:v1:fingerprint:${hex(n)}`
const event = (n: number): PortableSessionAnchor => ({ kind: 'event', eventId: eventId(n) })

function fragment(start: number, ...messages: Array<[number, number]>): PortableSessionFragment {
  return {
    startedAt: at(start),
    coverage: {
      version: 1,
      messages: messages.map(([n, minute]) => ({
        eventId: eventId(n),
        observationId: `observation:v1:${hex(n)}`,
        kind: 'message' as const,
        timestamp: at(minute)
      })),
      continuity: []
    }
  }
}

/** The portable activity fact an event anchor depends on. */
function identity(n: number): SyncChange {
  return {
    id: syncFactChangeId(workspaceId, 'activity-identity', eventId(n)),
    kind: 'fact',
    entityType: 'activity-identity',
    entityId: eventId(n),
    dependencies: [],
    payload: {
      eventId: eventId(n),
      provider: 'claude',
      identityVersion: 1,
      conversationId: target.conversationId,
      basis: 'fingerprint',
      nativeEventId: null
    }
  }
}

function directory(db: Db): { clientSyncId: string; projectSyncId: string } {
  const clientSyncId = randomUUID()
  record(db, [
    planDirectoryRevision(db, workspaceId, {
      id: randomUUID(),
      entityType: 'client',
      entityId: clientSyncId,
      action: { type: 'create', values: { name: 'Acme', color: '#123456' } }
    })
  ])
  const projectSyncId = randomUUID()
  record(db, [
    planDirectoryRevision(db, workspaceId, {
      id: randomUUID(),
      entityType: 'project',
      entityId: projectSyncId,
      action: { type: 'create', values: { clientSyncId, name: 'Website' } }
    })
  ])
  return { clientSyncId, projectSyncId }
}

const read = (db: Db) => readPortableSessionRecords(db, workspaceId, target)
/** A revision planned without the fragment planner (an older build, or before seeing a copy). */
function revise(db: Db, entityId: string, values: Record<string, string | boolean> | 'delete') {
  const current = read(db).edits.find((item) => item.entityId === entityId)!
  return planRevision({
    id: randomUUID(),
    schema: SESSION_EDIT_SCHEMA,
    entityId,
    history: current.history,
    action:
      values === 'delete'
        ? { type: 'delete', observedHeads: current.view.heads }
        : { type: 'edit', observedHeads: current.view.heads, values }
  })
}
function resolveOn(db: Db, piece: PortableSessionFragment) {
  const { mapping, edits } = read(db)
  return resolvePortableSessionFields({ target, fragment: piece, mapping, edits })
}
const editPlan = (
  db: Db,
  request: Omit<PortableSessionEditRequest, 'target' | 'newId'>
): RevisionChange[] =>
  planPortableSessionEdit(db, workspaceId, { target, newId: randomUUID, ...request })

it('dedupes clone baselines and keeps divergent offline edits as a visible conflict', () => {
  const { clientSyncId, projectSyncId } = directory(a)
  expect(
    planSessionEditBaseline(a, workspaceId, {
      target,
      anchor: event(1),
      values: { description: 'Planning' }
    })
  ).toEqual({
    status: 'requires',
    requires: [{ entityType: 'activity-identity', entityId: eventId(1) }]
  })
  record(a, [identity(1), identity(2)])
  exchange()

  const whole = fragment(0, [1, 0], [2, 10])
  const baselines = [a, b].map((db) => {
    const mapping = planSessionMappingBaseline(db, workspaceId, target, {
      clientSyncId,
      projectSyncId
    })
    const edit = planSessionEditBaseline(db, workspaceId, {
      target,
      anchor: event(1),
      values: { description: 'Planning', billable: undefined }
    })
    if (mapping.status !== 'ready' || edit.status !== 'ready') throw new Error('Not ready')
    // Only the differing field is written; nothing else is invented.
    expect(Object.keys(edit.change.payload.fields).sort()).toEqual(
      [PRESENT, 'anchor', 'description', 'target'].sort()
    )
    journal(db, [mapping.change, edit.change])
    return [mapping.change.id, edit.change.id]
  })
  expect(baselines[0]).toEqual(baselines[1])
  exchange()
  expect(
    planSessionMappingBaseline(a, workspaceId, target, { clientSyncId, projectSyncId }).status
  ).toBe('has-history')
  expect(planSessionEditBaseline(a, workspaceId, { target, anchor: event(2), values: {} })).toEqual(
    { status: 'unnecessary' }
  )
  const [baseline] = read(b).edits
  expect(read(b).edits).toHaveLength(1)
  expect(baseline.view.heads[PRESENT]).toEqual([baselines[0][1]])

  // Both computers edit the same fragment offline.
  journal(a, editPlan(a, { fragment: whole, values: { description: 'Design' } }))
  journal(b, editPlan(b, { fragment: whole, values: { description: 'Review', billable: false } }))
  exchange()
  const results = [a, b].map((db) => resolveOn(db, whole))
  expect(results[0]).toEqual(results[1])
  expect(results[0].status).toBe('held')
  expect(results[0].reasons).toEqual([
    { code: 'field-conflict', entityId: baseline.entityId, fields: ['description'] }
  ])
  expect(results[0].fields.billable).toMatchObject({ status: 'resolved', value: false })
  expect(results[0].fields.projectSyncId).toMatchObject({
    status: 'resolved',
    value: projectSyncId,
    source: 'mapping'
  })
  expect(codeOf(() => editPlan(a, { fragment: whole, values: { description: 'x' } }))).toBe(
    'SYNC_CONFLICT'
  )

  // An explicit resolution names the current heads and converges everywhere.
  journal(
    a,
    editPlan(a, { fragment: whole, values: { description: 'Design review' }, resolve: true })
  )
  exchange()
  for (const db of [a, b])
    expect(resolveOn(db, whole)).toMatchObject({
      status: 'resolved',
      fields: { description: { value: 'Design review', source: 'edit' } }
    })
})

it('waits for the anchor identity and enforces references and the strict allowlist', () => {
  record(a, [identity(1)])
  const identityBatch = publish(a)
  const [created] = editPlan(a, { fragment: fragment(0, [1, 0]), values: { billable: false } })
  journal(a, [created])
  const editBatch = publish(a)
  expect(deliver(b, editBatch).waiting).toEqual([
    { batchId: editBatch.batchId, missing: [identity(1).id] }
  ])
  expect(deliver(b, identityBatch).applied.sort()).toEqual(
    [identityBatch.batchId, editBatch.batchId].sort()
  )
  expect(resolveOn(b, fragment(0, [1, 0])).fields.billable).toMatchObject({ value: false })

  const piece = fragment(0, [1, 0])
  expect(
    codeOf(() =>
      editPlan(a, { fragment: piece, values: { clientSyncId: randomUUID(), projectSyncId: null } })
    )
  ).toBe('SYNC_REFERENCE_UNAVAILABLE')
  expect(codeOf(() => editPlan(a, { fragment: piece, values: { clientSyncId: null } }))).toBe(
    'SYNC_INVALID_SESSION_CHANGE'
  )

  const variant = (mutate: (change: any) => void): unknown => {
    const copy = structuredClone(created)
    mutate(copy)
    return copy
  }
  const validate = (change: unknown) => () => sessionRecordsAdapter.validate(change as SyncChange)
  expect(
    codeOf(validate(variant((c) => (c.payload.fields.anchor.value = { kind: 'legacy', id: 'x' }))))
  ).toBe('SYNC_UPDATE_REQUIRED')
  expect(
    codeOf(
      validate(
        variant((c) => (c.payload.fields.anchor.value.eventId = eventId(1).replace(':v1:', ':v2:')))
      )
    )
  ).toBe('SYNC_UPDATE_REQUIRED')
  expect(
    codeOf(validate(variant((c) => (c.payload.fields.target.value.provider = 'cursor'))))
  ).toBe('SYNC_UPDATE_REQUIRED')
  // The anchor must hash to the entity ID; only creation writes it.
  expect(
    codeOf(validate(variant((c) => (c.payload.fields.anchor.value.eventId = eventId(2)))))
  ).toBe('SYNC_MALFORMED')
  const [later] = editPlan(b, { fragment: piece, values: { description: 'Later' } })
  expect(
    codeOf(
      validate({
        ...later,
        payload: {
          fields: { ...later.payload.fields, anchor: { value: event(1), parents: [] } }
        }
      })
    )
  ).toBe('SYNC_MALFORMED')
  expect(
    codeOf(validate(variant((c) => (c.payload.fields.note = { value: 'x', parents: [] }))))
  ).toBe('SYNC_MALFORMED')
  expect(
    codeOf(
      validate(
        variant((c) => (c.payload.fields.clientSyncId = { value: randomUUID(), parents: [] }))
      )
    )
  ).toBe('SYNC_MALFORMED')
  // Assigning a client needs a dependency on that client's applied revision.
  expect(
    codeOf(() =>
      journal(b, [
        variant((c) => {
          c.id = randomUUID()
          c.payload.fields.clientSyncId = { value: randomUUID(), parents: [] }
          c.payload.fields.projectSyncId = { value: null, parents: [] }
        }) as RevisionChange
      ])
    )
  ).toBe('SYNC_MALFORMED')
})

it('writes each attached record with its own observed heads over a merged interval', () => {
  record(a, [identity(1), identity(3)])
  journal(a, editPlan(a, { fragment: fragment(0, [1, 0]), values: { description: 'Plan' } }))
  journal(a, editPlan(a, { fragment: fragment(30, [3, 30]), values: { description: 'Build' } }))
  const merged = fragment(0, [1, 0], [3, 30])
  const held = resolveOn(a, merged)
  expect(held.reasons).toEqual([
    { code: 'metadata-choice-required', field: 'description', records: held.attached }
  ])
  expect(held.attached).toHaveLength(2)

  const before = read(a).edits
  const changes = editPlan(a, { fragment: merged, values: { description: 'Plan and build' } })
  expect(changes.map((change) => change.entityId).sort()).toEqual(held.attached)
  for (const change of changes) {
    const current = before.find((item) => item.entityId === change.entityId)!
    expect(change.payload.fields[PRESENT].parents).toEqual(current.view.heads[PRESENT])
    expect(change.payload.fields.description.parents).toEqual(current.view.heads.description)
  }
  journal(a, changes)
  expect(resolveOn(a, merged)).toMatchObject({
    status: 'resolved',
    fields: { description: { value: 'Plan and build', source: 'edit' } }
  })
})

it('copies split metadata and holds the copy after a concurrent offline edit', () => {
  record(a, [identity(1), identity(2), identity(3)])
  const whole = fragment(0, [1, 0], [2, 10], [3, 30])
  const [source] = editPlan(a, {
    fragment: whole,
    values: { description: 'Plan', billable: false }
  })
  journal(a, [source])
  exchange()

  // A splits at minute 20 while B edits the unsplit session offline.
  const pieces = [fragment(0, [1, 0], [2, 10]), fragment(20, [3, 30])]
  const split = planSessionSplitCopies(a, workspaceId, {
    target,
    fragment: whole,
    pieces,
    cuts: [at(20)],
    newId: randomUUID
  })
  if (split.status !== 'ready') throw new Error('Split is held')
  expect(split.changes).toHaveLength(1)
  const [copy] = split.changes
  expect(copy.payload.fields.anchor.value).toEqual({ kind: 'cut', splitAt: at(20) })
  expect(copy.payload.fields.time).toBeUndefined()
  journal(a, split.changes)
  const [offline] = editPlan(b, { fragment: whole, values: { description: 'Plan and build' } })
  journal(b, [offline])
  exchange()

  const resolveBoth = () =>
    [a, b].map((db) => resolvePortableConversation({ ...read(db), target, fragments: pieces }))
  for (const result of resolveBoth()) {
    expect(result.orphaned).toEqual([])
    expect(result.fragments[0]).toMatchObject({
      status: 'resolved',
      fields: { description: { value: 'Plan and build' }, billable: { value: false } }
    })
    expect(result.fragments[1].reasons).toEqual([
      {
        code: 'post-split-edit',
        entityId: copy.entityId,
        source: source.entityId,
        revisions: [offline.id]
      }
    ])
  }

  // A plain resolve never accepts the unseen source edit; acknowledging exactly what was shown does.
  journal(a, editPlan(a, { fragment: pieces[1], values: { description: 'Plan' }, resolve: true }))
  expect(resolveBoth()[0].fragments[1].status).toBe('held')
  const shown = resolveBoth()[0].fragments[1].reasons.flatMap((reason) =>
    reason.code === 'post-split-edit' ? [reason] : []
  )
  journal(
    a,
    editPlan(a, {
      fragment: pieces[1],
      values: { description: 'Plan and build' },
      acknowledgedCopyEdits: shown
    })
  )
  exchange()
  for (const result of resolveBoth())
    expect(result.fragments.map((item) => [item.status, item.fields.description])).toEqual([
      ['resolved', expect.objectContaining({ value: 'Plan and build' })],
      ['resolved', expect.objectContaining({ value: 'Plan and build' })]
    ])

  // A deliberate edit of the left piece after seeing the split does not hold the copy.
  journal(b, editPlan(b, { fragment: pieces[0], values: { description: 'Plan' } }))
  exchange()
  for (const result of resolveBoth()) {
    expect(result.fragments.map((item) => item.status)).toEqual(['resolved', 'resolved'])
    expect(result.fragments[0].fields.description).toMatchObject({ value: 'Plan' })
    expect(result.fragments[1].fields.description).toMatchObject({ value: 'Plan and build' })
    expect(result.fragments[1].fields.billable).toMatchObject({ value: false })
  }
})

/** A's source edit on the whole session, split at minute 20 into a cut-anchored copy. */
function splitSource(values: Parameters<typeof editPlan>[1]['values']) {
  record(a, [identity(1), identity(2), identity(3)])
  const whole = fragment(0, [1, 0], [2, 10], [3, 30])
  const [source] = editPlan(a, { fragment: whole, values })
  journal(a, [source])
  exchange()
  const pieces = [fragment(0, [1, 0], [2, 10]), fragment(20, [3, 30])]
  const split = planSessionSplitCopies(a, workspaceId, {
    target,
    fragment: whole,
    pieces,
    cuts: [at(20)],
    newId: randomUUID
  })
  if (split.status !== 'ready') throw new Error('Split is held')
  journal(a, split.changes)
  return { whole, pieces, source, copy: split.changes[0] }
}
const rightPiece = (db: Db, pieces: PortableSessionFragment[]) =>
  resolvePortableConversation({ ...read(db), target, fragments: pieces }).fragments[1]

it('restores a deleted split copy without accepting unseen source edits', () => {
  const { whole, pieces, source, copy } = splitSource({ description: 'Plan' })
  // B edits the unsplit session offline while A deletes the copy to inherit again.
  const [offline] = editPlan(b, { fragment: whole, values: { description: 'Plan and build' } })
  journal(b, [offline])
  journal(a, [revise(a, copy.entityId, 'delete')])
  exchange()
  for (const db of [a, b])
    expect(rightPiece(db, pieces)).toMatchObject({
      status: 'resolved',
      fields: { description: { value: null, source: 'default' } }
    })

  // Editing the piece again is a plain restore: no resolve, and copiedFrom is left alone.
  const restore = editPlan(a, { fragment: pieces[1], values: { description: 'Build' } })
  expect(restore[0].payload.fields.copiedFrom).toBeUndefined()
  journal(a, restore)
  exchange()
  for (const db of [a, b])
    expect(rightPiece(db, pieces).reasons).toEqual([
      {
        code: 'post-split-edit',
        entityId: copy.entityId,
        source: source.entityId,
        revisions: [offline.id]
      }
    ])

  // Only an acknowledgment of exactly the revisions now unobserved moves copiedFrom.
  const acknowledge = (revisions: string[]) =>
    editPlan(a, {
      fragment: pieces[1],
      values: { description: 'Build' },
      acknowledgedCopyEdits: [{ entityId: copy.entityId, source: source.entityId, revisions }]
    })
  expect(codeOf(() => acknowledge([]))).toBe('SYNC_CONFLICT')
  journal(a, acknowledge([offline.id]))
  exchange()
  for (const db of [a, b])
    expect(rightPiece(db, pieces)).toMatchObject({
      status: 'resolved',
      fields: { description: { value: 'Build', source: 'edit' } }
    })

  // A dependency on a deletion must name a recorded deletion fact.
  expect(
    codeOf(() =>
      editPlan(a, {
        fragment: pieces[1],
        values: { billable: false },
        observedDeletions: [randomUUID()]
      })
    )
  ).toBe('SYNC_INVALID_SESSION_CHANGE')
})

it('clears a copiedFrom conflict left by concurrent acknowledgments', () => {
  const { pieces, source, copy } = splitSource({ description: 'Plan', billable: false })
  exchange()
  // Each computer edits the source without seeing the copy, then accepts what it was shown.
  journal(a, [revise(a, source.entityId, { description: 'Plan A' })])
  journal(b, [revise(b, source.entityId, { billable: true })])
  for (const db of [a, b]) {
    const shown = rightPiece(db, pieces).reasons.flatMap((reason) =>
      reason.code === 'post-split-edit' ? [reason] : []
    )
    expect(shown).toHaveLength(1)
    journal(
      db,
      editPlan(db, {
        fragment: pieces[1],
        values: { description: 'Copied' },
        acknowledgedCopyEdits: shown
      })
    )
  }
  exchange()
  for (const db of [a, b]) {
    const piece = rightPiece(db, pieces)
    expect(piece.status).toBe('held')
    expect(piece.reasons).toContainEqual({
      code: 'field-conflict',
      entityId: copy.entityId,
      fields: expect.arrayContaining(['copiedFrom'])
    })
    // Both acknowledged revisions are observed through the union; nothing else is held.
    expect(piece.reasons.filter((reason) => reason.code === 'post-split-edit')).toEqual([])
  }

  // One explicit resolution writes the union and converges everywhere.
  journal(a, editPlan(a, { fragment: pieces[1], values: { description: 'Copied' }, resolve: true }))
  exchange()
  for (const db of [a, b]) {
    expect(rightPiece(db, pieces)).toMatchObject({ status: 'resolved', reasons: [] })
    const resolved = read(db).edits.find((item) => item.entityId === copy.entityId)!
    expect(resolved.view.fields.copiedFrom).toMatchObject({
      status: 'resolved',
      value: { entityId: source.entityId }
    })
  }
})

it('writes the built-in Unassigned client as null on every planning path', () => {
  const builtin = a
    .insert(clients)
    .values({ name: 'Unassigned', color: '#6b7280', systemRole: 'unassigned' })
    .returning()
    .get()
  record(a, [identity(1)])
  // Neither spelling needs a mapping record or waits for a directory record that never exists.
  for (const clientSyncId of [builtin.syncId, UNASSIGNED_CLIENT_SYNC_ID])
    expect(
      planSessionMappingBaseline(a, workspaceId, target, { clientSyncId, projectSyncId: null })
    ).toEqual({ status: 'unnecessary' })
  expect(
    planSessionEditBaseline(a, workspaceId, {
      target,
      anchor: event(1),
      values: { clientSyncId: builtin.syncId, projectSyncId: null }
    }).status
  ).toBe('ready')
  const piece = fragment(0, [1, 0])
  const [created] = editPlan(a, {
    fragment: piece,
    values: { clientSyncId: builtin.syncId, projectSyncId: null }
  })
  expect(created.payload.fields.clientSyncId.value).toBeNull()
  journal(a, [created])
  expect(resolveOn(a, piece).fields.clientSyncId).toMatchObject({ value: null, source: 'edit' })
})
