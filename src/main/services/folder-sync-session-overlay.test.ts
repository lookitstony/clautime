// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import {
  materializeRecord,
  planRevision,
  type JsonValue,
  type RecordView,
  type RevisionChange
} from './folder-sync-revisions'
import {
  SESSION_EDIT_SCHEMA,
  SESSION_MAPPING_SCHEMA,
  sessionEditEntityId,
  sessionMappingEntityId,
  type PortableSessionAnchor,
  type PortableSessionRecord
} from './folder-sync-session-records'
import {
  observedSessionEditHeads,
  resolvePortableConversation,
  resolvePortableSessionFields,
  sessionRecordHeads,
  unobservedSessionEdits,
  type PortableSessionFragment
} from './folder-sync-session-overlay'
import { portableCoverageHash } from './folder-sync-portable-coverage'
import { UNASSIGNED_CLIENT_SYNC_ID } from './folder-sync-builtin-client'

const target = { provider: 'claude', conversationId: 'conversation-1' }
const clientSyncId = '11111111-1111-4111-8111-111111111111'
const projectSyncId = '22222222-2222-4222-8222-222222222222'
type Values = Record<string, JsonValue>

const at = (minute: number): string =>
  new Date(Date.UTC(2026, 8, 1, 9, 0) + minute * 60_000).toISOString()
const hex = (n: number): string => n.toString(16).padStart(64, '0')
const eventId = (n: number): string => `claude:v1:fingerprint:${hex(n)}`
const event = (n: number): PortableSessionAnchor => ({ kind: 'event', eventId: eventId(n) })
const cut = (minute: number): PortableSessionAnchor => ({ kind: 'cut', splitAt: at(minute) })

/** Messages as [event number, minute]. */
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

function create(
  anchor: PortableSessionAnchor,
  values: Values = {},
  dependencies: string[] = []
): RevisionChange[] {
  return [
    planRevision({
      id: randomUUID(),
      schema: SESSION_EDIT_SCHEMA,
      entityId: sessionEditEntityId(target, anchor),
      history: [],
      action: {
        type: 'create',
        values: { target, anchor: anchor as unknown as JsonValue, ...values }
      },
      dependencies
    })
  ]
}
function record(history: RevisionChange[]): PortableSessionRecord {
  const entityId = history[0].entityId
  return { entityId, view: materializeRecord(SESSION_EDIT_SCHEMA, entityId, history), history }
}
function edit(history: RevisionChange[], values: Values, dependencies: string[] = []) {
  const { entityId, view } = record(history)
  return [
    ...history,
    planRevision({
      id: randomUUID(),
      schema: SESSION_EDIT_SCHEMA,
      entityId,
      history,
      action: { type: 'edit', observedHeads: view.heads, values },
      dependencies
    })
  ]
}
const heads = (history: RevisionChange[]): string[] => sessionRecordHeads(record(history).view)
const idOf = (history: RevisionChange[]): string => history[0].entityId

const mapping: PortableSessionRecord = (() => {
  const entityId = sessionMappingEntityId(target)
  const history = [
    planRevision({
      id: randomUUID(),
      schema: SESSION_MAPPING_SCHEMA,
      entityId,
      history: [],
      action: { type: 'create', values: { clientSyncId, projectSyncId } }
    })
  ]
  return { entityId, view: materializeRecord(SESSION_MAPPING_SCHEMA, entityId, history), history }
})()

const resolve = (
  piece: PortableSessionFragment,
  edits: RevisionChange[][],
  defaults: PortableSessionRecord | null = mapping
) =>
  resolvePortableSessionFields({
    target,
    fragment: piece,
    mapping: defaults,
    edits: edits.map(record)
  })

it('keeps an event anchor across a late earlier event and inherits unset fields', () => {
  const source = create(event(2), { description: 'Planning' })
  const before = resolve(fragment(10, [2, 10], [3, 20]), [source])
  const after = resolve(fragment(5, [1, 5], [2, 10], [3, 20]), [source])
  for (const result of [before, after]) {
    expect(result.status).toBe('resolved')
    expect(result.attached).toEqual([idOf(source)])
    expect(result.fields.description).toEqual({
      status: 'resolved',
      value: 'Planning',
      source: 'edit',
      records: [idOf(source)]
    })
    // Unwritten fields were not invented by creation; they inherit.
    expect(result.fields.projectSyncId).toEqual({
      status: 'resolved',
      value: projectSyncId,
      source: 'mapping',
      records: []
    })
    expect(result.fields.billable).toEqual({
      status: 'resolved',
      value: true,
      source: 'default',
      records: []
    })
    expect(result.fields.time).toMatchObject({ status: 'resolved', value: null, source: 'default' })
  }
  expect(resolve(fragment(10, [2, 10]), [source], null).fields.clientSyncId).toMatchObject({
    value: null,
    source: 'default'
  })
  // An explicitly written null overrides the conversation's assignment.
  const unassigned = edit(source, { clientSyncId: null, projectSyncId: null })
  expect(resolve(fragment(10, [2, 10]), [unassigned]).fields.projectSyncId).toMatchObject({
    value: null,
    source: 'edit'
  })
})

it('merges equal metadata of attached records and holds differences', () => {
  const first = create(event(1), { billable: false })
  const second = create(event(3), { billable: false })
  const merged = fragment(0, [1, 0], [2, 10], [3, 40])
  expect(resolve(merged, [first, second])).toMatchObject({
    status: 'resolved',
    fields: { billable: { status: 'resolved', value: false, source: 'edit' } }
  })

  const held = resolve(merged, [first, edit(second, { description: 'Review' })])
  expect(held.status).toBe('held')
  expect(held.reasons).toEqual([
    {
      code: 'metadata-choice-required',
      field: 'description',
      records: [idOf(first), idOf(second)].sort()
    }
  ])
  expect(held.fields.description).toEqual({ status: 'held' })
  expect(held.fields.billable).toMatchObject({ status: 'resolved', value: false })
})

it('holds concurrent same-field edits inside one record', () => {
  const base = create(event(1), { billable: true })
  const left = edit(base, { description: 'A' })
  const right = edit(base, { description: 'B' })
  const result = resolve(fragment(0, [1, 0]), [[...left, right[1]]])
  expect(result.reasons).toEqual([
    { code: 'field-conflict', entityId: idOf(base), fields: ['description'] }
  ])
  expect(result.fields.description).toEqual({ status: 'held' })
  expect(result.fields.billable).toMatchObject({ status: 'resolved', value: true })
})

it('applies a time override only to its base coverage', () => {
  const base = fragment(0, [1, 0], [2, 30])
  const time = {
    durationMinutes: 45,
    baseCoverageHash: portableCoverageHash(target.provider, target.conversationId, base.coverage)
  }
  const override = create(event(1), { time })
  expect(resolve(base, [override]).fields.time).toEqual({
    status: 'resolved',
    value: time,
    source: 'edit',
    records: [idOf(override)]
  })
  // Another computer's (or another log's) observation of the same events is not a new measurement.
  const replica = structuredClone(base)
  replica.coverage.messages[1].observationId = `observation:v1:${'f'.repeat(64)}`
  expect(resolve(replica, [override]).status).toBe('resolved')

  const grown = fragment(0, [1, 0], [2, 30], [3, 50])
  const result = resolve(grown, [override])
  expect(result.reasons).toEqual([
    { code: 'time-override-in-split-or-merge', records: [idOf(override)] }
  ])
  expect(result.fields.time).toEqual({ status: 'held' })
  expect(resolve(grown, [edit(override, { time: null })]).status).toBe('resolved')
})

it('carries copied metadata through repeated cuts and reports unattached anchors', () => {
  const source = create(event(1), { description: 'Plan', billable: false })
  const first = create(
    cut(20),
    {
      description: 'Plan',
      billable: false,
      copiedFrom: { entityId: idOf(source), heads: heads(source) }
    },
    heads(source)
  )
  const second = create(
    cut(40),
    {
      description: 'Plan',
      billable: false,
      copiedFrom: { entityId: idOf(first), heads: heads(first) }
    },
    heads(first)
  )
  const pieces = [fragment(0, [1, 0], [2, 10]), fragment(20, [3, 25]), fragment(40, [4, 45])]
  const stray = create(cut(33), { description: 'Nowhere' })
  const result = resolvePortableConversation({
    target,
    fragments: pieces,
    mapping,
    edits: [source, first, second, stray].map(record)
  })
  expect(result.fragments.map((item) => [item.status, item.attached])).toEqual([
    ['resolved', [idOf(source)]],
    ['resolved', [idOf(first)]],
    ['resolved', [idOf(second)]]
  ])
  for (const item of result.fragments)
    expect(item.fields).toMatchObject({
      description: { value: 'Plan', source: 'edit' },
      billable: { value: false, source: 'edit' },
      projectSyncId: { value: projectSyncId, source: 'mapping' }
    })
  expect(result.orphaned).toEqual([idOf(stray)])

  // An unobserved edit of the original reaches the copy of the copy too.
  const offline = edit(source, { description: 'Plan and build' })
  const later = resolvePortableConversation({
    target,
    fragments: pieces,
    mapping,
    edits: [offline, first, second].map(record)
  })
  expect(later.fragments.map((item) => item.status)).toEqual(['resolved', 'held', 'held'])
  expect(later.fragments[2].reasons).toEqual([
    {
      code: 'post-split-edit',
      entityId: idOf(second),
      source: idOf(source),
      revisions: [offline[1].id]
    }
  ])
})

it('holds a split copy after an unobserved source edit, not after an aware one', () => {
  const source = create(event(1), { description: 'Plan' })
  const copy = create(
    cut(20),
    { description: 'Plan', copiedFrom: { entityId: idOf(source), heads: heads(source) } },
    heads(source)
  )
  const left = fragment(0, [1, 0], [2, 10])
  const right = fragment(20, [3, 25])

  const offline = edit(source, { description: 'Plan and build' })
  expect(resolve(left, [offline, copy])).toMatchObject({
    status: 'resolved',
    fields: { description: { value: 'Plan and build' } }
  })
  const held = resolve(right, [offline, copy])
  expect(held.status).toBe('held')
  expect(held.reasons).toEqual([
    {
      code: 'post-split-edit',
      entityId: idOf(copy),
      source: idOf(source),
      revisions: [offline[1].id]
    }
  ])

  // Made after seeing the split: it depends on the copy, so it is deliberate for the left piece.
  const aware = edit(source, { description: 'Left only' }, heads(copy))
  expect(resolve(right, [aware, copy])).toMatchObject({
    status: 'resolved',
    fields: { description: { value: 'Plan' } }
  })

  // Resolving the copy re-acknowledges the source's current heads.
  const acknowledged = [
    ...copy,
    planRevision({
      id: randomUUID(),
      schema: SESSION_EDIT_SCHEMA,
      entityId: idOf(copy),
      history: copy,
      action: {
        type: 'resolve',
        expectedHeads: record(copy).view.heads,
        present: true,
        values: {
          description: 'Plan and build',
          copiedFrom: { entityId: idOf(source), heads: heads(offline) }
        }
      },
      dependencies: heads(offline)
    })
  ]
  expect(resolve(right, [offline, acknowledged])).toMatchObject({
    status: 'resolved',
    fields: { description: { value: 'Plan and build' } }
  })
})

it('reports edits a deletion did not observe', () => {
  const deleted = fragment(0, [1, 0], [2, 10])
  const edited = create(event(1), { description: 'Plan' })
  const observed = observedSessionEditHeads(deleted, [record(edited)])
  // The flat shape the deletion fact stores and readPortableHistoryFacts returns.
  expect(observed).toEqual([edited[0].id])
  const deletion = { operationId: randomUUID(), observedSessionEditHeads: observed }
  expect(unobservedSessionEdits(deleted, [record(edited)], deletion)).toEqual([])

  const concurrent = edit(edited, { billable: false })
  const late = create(event(2), { description: 'Late' })
  expect(unobservedSessionEdits(deleted, [record(concurrent), record(late)], deletion)).toEqual(
    [
      { entityId: idOf(edited), revisions: [concurrent[1].id] },
      { entityId: idOf(late), revisions: [late[0].id] }
    ].sort((left, right) => (left.entityId < right.entityId ? -1 : 1))
  )

  // Made with knowledge of the deletion (directly or through a later revision): not a conflict,
  // and neither is the concurrent revision it supersedes.
  const aware = edit(edited, { billable: false }, [deletion.operationId])
  expect(unobservedSessionEdits(deleted, [record(aware)], deletion)).toEqual([])
  const settled = edit(concurrent, { description: 'Kept' }, [deletion.operationId])
  expect(unobservedSessionEdits(deleted, [record(settled)], deletion)).toEqual([])
  const after = edit(aware, { description: 'Later' })
  expect(unobservedSessionEdits(deleted, [record(after)], deletion)).toEqual([])
})

it('classifies records on deleted coverage apart from real orphans', () => {
  const active = fragment(0, [1, 0], [2, 10])
  // Deleted after a cut at minute 20: the partition truncated the 10→30 span at the cut.
  const deletedCoverage = {
    version: 1 as const,
    messages: [
      {
        eventId: eventId(3),
        observationId: `observation:v1:${hex(3)}`,
        kind: 'message' as const,
        timestamp: at(30)
      }
    ],
    continuity: [
      {
        from: {
          eventId: eventId(2),
          observationId: `observation:v1:${hex(2)}`,
          kind: 'message' as const,
          timestamp: at(10)
        },
        to: {
          eventId: eventId(3),
          observationId: `observation:v1:${hex(3)}`,
          kind: 'message' as const,
          timestamp: at(30)
        },
        startedAt: at(20),
        endedAt: at(30),
        progress: []
      }
    ]
  }
  const kept = create(event(1), { description: 'Kept' })
  const copy = create(cut(20), { description: 'Copied' })
  const onDeleted = create(event(3), { description: 'Deleted work' })
  const stray = create(cut(50), { description: 'Nowhere' })
  const deletion = {
    operationId: randomUUID(),
    coverage: deletedCoverage,
    observedSessionEditHeads: [...heads(copy), ...heads(onDeleted)].sort()
  }
  const classify = (edits: RevisionChange[][]) =>
    resolvePortableConversation({
      target,
      fragments: [active],
      mapping,
      edits: edits.map(record),
      deletions: [deletion]
    })

  const observed = classify([kept, copy, onDeleted, stray])
  expect(observed.fragments.map((item) => item.attached)).toEqual([[idOf(kept)]])
  // The cut-anchored copy attaches to the deleted piece through its lower bound.
  expect(observed.deleted).toEqual([idOf(copy), idOf(onDeleted)].sort())
  expect(observed.deletionConflicts).toEqual([])
  expect(observed.orphaned).toEqual([idOf(stray)])

  // An edit the deletion did not see is a visible conflict, not an orphan and not undeleted.
  const concurrent = edit(onDeleted, { billable: false })
  const conflicted = classify([kept, copy, concurrent, stray])
  expect(conflicted.deletionConflicts).toEqual([
    { operationId: deletion.operationId, entityId: idOf(onDeleted), revisions: [concurrent[1].id] }
  ])
  expect(conflicted.deleted).toEqual([idOf(copy)])
  expect(conflicted.orphaned).toEqual([idOf(stray)])
})

it('reads the built-in Unassigned client as null, so equal assignments never conflict', () => {
  const merged = fragment(0, [1, 0], [3, 40])
  const reserved = create(event(1), { clientSyncId: UNASSIGNED_CLIENT_SYNC_ID, projectSyncId })
  const plain = create(event(3), { clientSyncId: null, projectSyncId })
  const project = {
    entityType: 'project',
    entityId: projectSyncId,
    lifecycle: 'present',
    conflicts: [],
    fields: {
      clientSyncId: { status: 'resolved', value: UNASSIGNED_CLIENT_SYNC_ID, heads: [], base: [] }
    }
  } as unknown as RecordView
  const result = resolvePortableSessionFields({
    target,
    fragment: merged,
    mapping,
    edits: [reserved, plain].map(record),
    directory: (entityType) => (entityType === 'project' ? project : undefined)
  })
  expect(result.status).toBe('resolved')
  expect(result.fields.clientSyncId).toMatchObject({ status: 'resolved', value: null })
  // A project of the built-in client assigned with a null client is not a mismatch.
  expect(result.billingBlockers).toEqual([])
})
