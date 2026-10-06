import { canonicalJson } from './folder-sync-protocol'
import { PRESENT, type JsonValue, type RecordView } from './folder-sync-revisions'
import type { CanonicalIntervalCoverage } from './canonical-intervals'
import { deletedCoverageFragment, portableCoverageHash } from './folder-sync-portable-coverage'
import { UNASSIGNED_CLIENT_SYNC_ID } from './folder-sync-builtin-client'
import type {
  PortableCopySource,
  PortableSessionAnchor,
  PortableSessionRecord,
  PortableSessionTarget,
  PortableTimeOverride
} from './folder-sync-session-records'

/*
 * Pure overlay of portable session records onto locally calculated fragments (folder-sync-plan.md
 * decisions B and D). Automatic sessions stay deterministic local views; this only decides which
 * portable metadata applies to a fragment, or why it must be held for review. No clock, arrival
 * order, local row ID, name or path is consulted.
 *
 * Fallback per field, per attached record (unambiguous by construction):
 *   1. the session-edit's own value when that field was written and is agreed (null included:
 *      a written null is an explicit "no client/project/description/time override");
 *   2. otherwise (field never written, or the edit record deleted) the conversation's
 *      session-mapping value for clientSyncId/projectSyncId;
 *   3. otherwise PORTABLE_SESSION_DEFAULTS (unassigned, no description, billable, no time override).
 * A fragment with several attached records takes a value only when every record's effective value
 * is equal; a difference is a held choice, never a pick.
 *
 * The built-in Unassigned client has one portable spelling here: null. A clientSyncId of
 * UNASSIGNED_CLIENT_SYNC_ID (written by another build, or a project's owner) reads as null.
 */

export interface PortableSessionFragment {
  /** Normalized UTC start of the fragment (a cut anchor attaches exactly here). */
  startedAt: string
  coverage: CanonicalIntervalCoverage
}

export const PORTABLE_SESSION_FIELDS = [
  'clientSyncId',
  'projectSyncId',
  'description',
  'billable',
  'time'
] as const
export type PortableSessionField = (typeof PORTABLE_SESSION_FIELDS)[number]

export const PORTABLE_SESSION_DEFAULTS: Readonly<Record<PortableSessionField, JsonValue>> =
  Object.freeze({
    clientSyncId: null,
    projectSyncId: null,
    description: null,
    billable: true,
    time: null
  })

export type PortableFieldSource = 'edit' | 'mapping' | 'default'

export type PortableResolvedField =
  | {
      status: 'resolved'
      value: JsonValue
      /** 'edit' when any attached record supplied the value. */
      source: PortableFieldSource
      /** Session-edit entity IDs that wrote this value. */
      records: string[]
    }
  | { status: 'held' }

export type PortableHeldReason =
  /** Attached records (e.g. after a policy merge) have different effective values. */
  | { code: 'metadata-choice-required'; field: PortableSessionField; records: string[] }
  /** A time override whose base coverage is not this fragment's, or differing overrides. */
  | { code: 'time-override-in-split-or-merge'; records: string[] }
  /** Concurrent same-field edits inside one record ($present excluded). */
  | { code: 'field-conflict'; entityId: string; fields: string[] }
  | { code: 'edit-lifecycle-conflict'; entityId: string }
  /** A split copy's source has revisions the copy neither observed nor was observed by. */
  | { code: 'post-split-edit'; entityId: string; source: string; revisions: string[] }
  | { code: 'mapping-conflict'; fields: string[] }

export type PortableBillingBlocker =
  | {
      code: 'directory-unavailable' | 'directory-conflict'
      entityType: 'client' | 'project'
      entityId: string
    }
  /** The resolved project belongs to another client; never repaired by name or path. */
  | { code: 'assignment-mismatch'; projectSyncId: string; clientSyncId: string | null }

export interface PortableSessionResolution {
  status: 'resolved' | 'held'
  fields: Record<PortableSessionField, PortableResolvedField>
  reasons: PortableHeldReason[]
  /** Attached session-edit entity IDs (deleted records included), sorted. */
  attached: string[]
  /** Only computed when a directory reader is supplied. */
  billingBlockers: PortableBillingBlocker[]
}

export interface PortableSessionOverlayInput {
  target: PortableSessionTarget
  fragment: PortableSessionFragment
  /** The conversation's default assignment record, if any. */
  mapping: PortableSessionRecord | null
  /** Every session-edit record of the conversation (histories are needed for ancestry). */
  edits: readonly PortableSessionRecord[]
  /** Current directory views, to report reference problems that block billing. */
  directory?: (entityType: 'client' | 'project', syncId: string) => RecordView | undefined
}

/** A session-deletion fact as readPortableHistoryFacts returns it. */
export interface PortableSessionDeletion {
  /** The fact's change ID; later edits that depend on it were made with knowledge of it. */
  operationId: string
  coverage: CanonicalIntervalCoverage
  /** Flat session-edit revision IDs, exactly as stored in the fact. */
  observedSessionEditHeads: readonly string[]
}

export interface PortableConversationResolution {
  fragments: PortableSessionResolution[]
  /** Present or lifecycle-conflicted records attached to no active fragment or deleted coverage. */
  orphaned: string[]
  /** Records only on deleted coverage whose every revision a deletion observed: suppressed with it. */
  deleted: string[]
  /** Edit-versus-delete: revisions of records on deleted coverage that the deletion did not see. */
  deletionConflicts: Array<{ operationId: string; entityId: string; revisions: string[] }>
}

type Revision = { id: string; dependencies: string[] }
type Effective = { held: true } | { held: false; value: JsonValue; source: PortableFieldSource }

/** One spelling of the built-in Unassigned client: null. */
function portableValue(field: string, value: JsonValue): JsonValue {
  return field === 'clientSyncId' && value === UNASSIGNED_CLIENT_SYNC_ID ? null : value
}

function byEntityId(left: PortableSessionRecord, right: PortableSessionRecord): number {
  return left.entityId < right.entityId ? -1 : left.entityId > right.entityId ? 1 : 0
}

/** Every current head of a record across fields, `$present` included; sorted. */
export function sessionRecordHeads(view: RecordView): string[] {
  return [...new Set(Object.values(view.heads).flat())].sort()
}

function graphOf(history: readonly unknown[]): Map<string, string[]> {
  const graph = new Map<string, string[]>()
  for (const change of history) {
    const { id, dependencies } = change as Revision
    graph.set(id, dependencies)
  }
  return graph
}

/** The heads and every same-record revision they depend on. */
function ancestry(graph: Map<string, string[]>, heads: Iterable<string>): Set<string> {
  const seen = new Set<string>()
  const stack = [...heads].filter((id) => graph.has(id))
  while (stack.length) {
    const id = stack.pop() as string
    if (seen.has(id)) continue
    seen.add(id)
    for (const dependency of graph.get(id) ?? []) if (graph.has(dependency)) stack.push(dependency)
  }
  return seen
}

function anchorOf(record: PortableSessionRecord): PortableSessionAnchor | undefined {
  const field = record.view.fields.anchor
  return field?.status === 'resolved'
    ? (field.value as unknown as PortableSessionAnchor)
    : undefined
}

/**
 * What a split copy observed of its source. Concurrent re-acknowledgments conflict the field; every
 * alternative names the same primary source, so the copy observed the union of their heads (the
 * record stays held for the field conflict until one resolution names that union).
 */
export function sessionCopiedFrom(record: PortableSessionRecord): PortableCopySource | null {
  const field = record.view.fields.copiedFrom
  if (field?.status === 'resolved')
    return field.value !== null ? (field.value as unknown as PortableCopySource) : null
  if (field?.status !== 'conflict') return null
  const alternatives = field.heads
    .map((head) => head.value as unknown as PortableCopySource | null)
    .filter((value): value is PortableCopySource => value !== null)
  if (!alternatives.length) return null
  return {
    entityId: alternatives.map((item) => item.entityId).sort()[0],
    heads: [...new Set(alternatives.flatMap((item) => item.heads))].sort()
  }
}
const copiedFromOf = sessionCopiedFrom

/**
 * Event anchors attach to the fragment whose retained coverage counts that event (messages and
 * gap progress), so a late earlier event never moves them. Cut anchors attach to the fragment
 * starting exactly at the cut.
 */
export function sessionAnchorAttaches(
  anchor: PortableSessionAnchor,
  fragment: PortableSessionFragment
): boolean {
  if (anchor.kind === 'cut') return Date.parse(anchor.splitAt) === Date.parse(fragment.startedAt)
  const { coverage } = fragment
  return (
    coverage.messages.some((event) => event.eventId === anchor.eventId) ||
    coverage.continuity.some((edge) =>
      edge.progress.some((event) => event.eventId === anchor.eventId)
    )
  )
}

export function attachedSessionRecords(
  fragment: PortableSessionFragment,
  edits: readonly PortableSessionRecord[]
): PortableSessionRecord[] {
  return edits
    .filter((record) => {
      if (record.view.lifecycle === 'missing') return false
      const anchor = anchorOf(record)
      return !!anchor && sessionAnchorAttaches(anchor, fragment)
    })
    .sort(byEntityId)
}

/**
 * Anchor for a new record on a fragment with none attached. 'event' prefers the first counted
 * message by (timestamp, eventId); 'cut' prefers the cut the fragment starts at (split copies).
 * Either falls back to the other; null when the fragment has neither.
 */
export function defaultSessionAnchor(
  fragment: PortableSessionFragment,
  cuts: readonly string[] = [],
  prefer: 'event' | 'cut' = 'event'
): PortableSessionAnchor | null {
  const start = Date.parse(fragment.startedAt)
  const cut: PortableSessionAnchor | null = cuts.some((item) => Date.parse(item) === start)
    ? { kind: 'cut', splitAt: new Date(start).toISOString() }
    : null
  const first = [...fragment.coverage.messages].sort((left, right) => {
    const delta = Date.parse(left.timestamp) - Date.parse(right.timestamp)
    return delta || (left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0)
  })[0]
  const event: PortableSessionAnchor | null = first
    ? { kind: 'event', eventId: first.eventId }
    : null
  return prefer === 'cut' ? (cut ?? event) : (event ?? cut)
}

/** Records named by a split copy: its copiedFrom entity and any record owning a copied head. */
export function sessionCopySources(
  record: PortableSessionRecord,
  edits: readonly PortableSessionRecord[]
): PortableSessionRecord[] {
  const copied = copiedFromOf(record)
  if (!copied) return []
  const heads = new Set(copied.heads)
  return edits
    .filter(
      (other) =>
        other.entityId !== record.entityId &&
        (other.entityId === copied.entityId ||
          other.history.some((change) => heads.has((change as Revision).id)))
    )
    .sort(byEntityId)
}

/** Copies derived from a record, transitively (copies of copies). */
export function sessionCopiesOf(
  record: PortableSessionRecord,
  edits: readonly PortableSessionRecord[]
): PortableSessionRecord[] {
  const found = new Map<string, PortableSessionRecord>()
  const queue = [record]
  while (queue.length) {
    const current = queue.pop() as PortableSessionRecord
    for (const other of edits) {
      if (other.entityId === record.entityId || found.has(other.entityId)) continue
      if (sessionCopySources(other, edits).some((source) => source.entityId === current.entityId)) {
        found.set(other.entityId, other)
        queue.push(other)
      }
    }
  }
  return [...found.values()].sort(byEntityId)
}

/**
 * Source revisions a split copy did not observe (outside the ancestry of copiedFrom.heads) and
 * that were not made with knowledge of the copy (no dependency on a revision of the copy chain).
 * Recurses through present copies of copies. The record itself may be deleted, so a restore can
 * compare what the user acknowledges. Ancestry only; never timestamps.
 */
export function unobservedCopySourceRevisions(
  record: PortableSessionRecord,
  edits: readonly PortableSessionRecord[]
): Array<{ source: string; revisions: string[] }> {
  const result: Array<{ source: string; revisions: string[] }> = []
  const seen = new Set([record.entityId])
  const visit = (copy: PortableSessionRecord, chain: Set<string>): void => {
    const copied = copiedFromOf(copy)
    if (!copied || (copy !== record && copy.view.lifecycle !== 'present')) return
    const known = new Set([...chain, ...copy.history.map((change) => (change as Revision).id)])
    for (const source of sessionCopySources(copy, edits)) {
      if (seen.has(source.entityId)) continue
      seen.add(source.entityId)
      const graph = graphOf(source.history)
      const observed = ancestry(graph, copied.heads)
      const aware = new Set<string>()
      for (let grew = true; grew; ) {
        grew = false
        for (const [id, dependencies] of graph)
          if (!aware.has(id) && dependencies.some((item) => known.has(item) || aware.has(item))) {
            aware.add(id)
            grew = true
          }
      }
      const revisions = [...graph.keys()].filter((id) => !observed.has(id) && !aware.has(id)).sort()
      if (revisions.length) result.push({ source: source.entityId, revisions })
      visit(source, known)
    }
  }
  visit(record, new Set())
  return result.sort((left, right) => (left.source < right.source ? -1 : 1))
}

/**
 * For a deletion fact (SessionDeletionTarget.observedSessionEditHeads): every head of each record
 * attached to the deleted fragment, as one flat sorted list.
 */
export function observedSessionEditHeads(
  fragment: PortableSessionFragment,
  edits: readonly PortableSessionRecord[]
): string[] {
  return [
    ...new Set(
      attachedSessionRecords(fragment, edits).flatMap((record) => sessionRecordHeads(record.view))
    )
  ].sort()
}

/**
 * Edit-versus-delete: revisions of records attached to deleted coverage that the deletion neither
 * observed (ancestry of its flat heads; IDs of other records are ignored) nor preceded (a revision
 * depending, directly or through the record's own history, on the deletion fact was made with
 * knowledge of it; so are its ancestors). Each is a visible conflict that blocks billing; it never
 * undeletes anything.
 */
export function unobservedSessionEdits(
  fragment: PortableSessionFragment,
  edits: readonly PortableSessionRecord[],
  deletion: Pick<PortableSessionDeletion, 'operationId' | 'observedSessionEditHeads'>
): Array<{ entityId: string; revisions: string[] }> {
  return attachedSessionRecords(fragment, edits).flatMap((record) => {
    const graph = graphOf(record.history)
    const aware = new Set<string>()
    for (let grew = true; grew; ) {
      grew = false
      for (const [id, dependencies] of graph)
        if (
          !aware.has(id) &&
          dependencies.some((item) => item === deletion.operationId || aware.has(item))
        ) {
          aware.add(id)
          grew = true
        }
    }
    const observed = ancestry(graph, [...deletion.observedSessionEditHeads, ...aware])
    const revisions = [...graph.keys()].filter((id) => !observed.has(id)).sort()
    return revisions.length ? [{ entityId: record.entityId, revisions }] : []
  })
}

export function resolvePortableSessionFields(
  input: PortableSessionOverlayInput
): PortableSessionResolution {
  const { target, fragment, mapping, edits } = input
  const attached = attachedSessionRecords(fragment, edits)
  const reasons = new Map<string, PortableHeldReason>()
  const hold = (reason: PortableHeldReason): void => {
    reasons.set(canonicalJson(reason), reason)
  }

  for (const record of attached) {
    if (record.view.lifecycle === 'conflict')
      hold({ code: 'edit-lifecycle-conflict', entityId: record.entityId })
    if (record.view.lifecycle !== 'present') continue
    const fields = record.view.conflicts.filter((field) => field !== PRESENT)
    if (fields.length) hold({ code: 'field-conflict', entityId: record.entityId, fields })
    for (const { source, revisions } of unobservedCopySourceRevisions(record, edits))
      hold({ code: 'post-split-edit', entityId: record.entityId, source, revisions })
  }

  const fallback = (field: PortableSessionField): Effective => {
    if (mapping && (field === 'clientSyncId' || field === 'projectSyncId')) {
      const view = mapping.view
      if (view.lifecycle === 'conflict') {
        hold({ code: 'mapping-conflict', fields: [PRESENT] })
        return { held: true }
      }
      if (view.lifecycle === 'present') {
        const state = view.fields[field]
        if (state.status === 'conflict') {
          hold({ code: 'mapping-conflict', fields: [field] })
          return { held: true }
        }
        if (state.status === 'resolved')
          return {
            held: false,
            value: portableValue(field, state.value as JsonValue),
            source: 'mapping'
          }
      }
    }
    return { held: false, value: PORTABLE_SESSION_DEFAULTS[field], source: 'default' }
  }
  const effective = (record: PortableSessionRecord, field: PortableSessionField): Effective => {
    const { view } = record
    if (view.lifecycle === 'conflict') return { held: true }
    if (view.lifecycle !== 'present') return fallback(field)
    const state = view.fields[field]
    if (state.status === 'conflict') return { held: true }
    if (state.status === 'resolved')
      return { held: false, value: portableValue(field, state.value as JsonValue), source: 'edit' }
    return fallback(field)
  }

  const hash = portableCoverageHash(target.provider, target.conversationId, fragment.coverage)
  const attachedIds = attached.map((record) => record.entityId)
  const fields = {} as Record<PortableSessionField, PortableResolvedField>
  for (const field of PORTABLE_SESSION_FIELDS) {
    const values = attached.length
      ? attached.map((record) => ({ entityId: record.entityId, result: effective(record, field) }))
      : [{ entityId: '', result: fallback(field) }]
    const known = values.flatMap(({ entityId, result }) =>
      result.held ? [] : [{ entityId, value: result.value, source: result.source }]
    )
    if (known.length < values.length) {
      fields[field] = { status: 'held' }
      continue
    }
    const distinct = new Set(known.map((item) => canonicalJson(item.value)))
    const records = known.filter((item) => item.source === 'edit').map((item) => item.entityId)
    if (
      field === 'time' &&
      known.some(
        (item) =>
          item.value !== null &&
          (distinct.size > 1 ||
            (item.value as unknown as PortableTimeOverride).baseCoverageHash !== hash)
      )
    ) {
      hold({ code: 'time-override-in-split-or-merge', records })
      fields[field] = { status: 'held' }
      continue
    }
    if (distinct.size > 1) {
      hold({ code: 'metadata-choice-required', field, records: attachedIds })
      fields[field] = { status: 'held' }
      continue
    }
    fields[field] = {
      status: 'resolved',
      value: known[0].value,
      source: records.length ? 'edit' : known[0].source,
      records
    }
  }

  const billingBlockers: PortableBillingBlocker[] = []
  const { directory } = input
  if (directory) {
    const reference = (entityType: 'client' | 'project', field: PortableSessionField) => {
      const state = fields[field]
      if (state.status !== 'resolved' || typeof state.value !== 'string') return undefined
      const view = directory(entityType, state.value)
      if (!view || view.lifecycle === 'missing')
        billingBlockers.push({ code: 'directory-unavailable', entityType, entityId: state.value })
      else if (view.conflicts.length)
        billingBlockers.push({ code: 'directory-conflict', entityType, entityId: state.value })
      return view
    }
    reference('client', 'clientSyncId')
    const project = reference('project', 'projectSyncId')
    const client = fields.clientSyncId
    const owner = project?.fields.clientSyncId
    if (
      project &&
      client.status === 'resolved' &&
      owner?.status === 'resolved' &&
      portableValue('clientSyncId', owner.value as JsonValue) !== client.value
    )
      billingBlockers.push({
        code: 'assignment-mismatch',
        projectSyncId: project.entityId,
        clientSyncId: client.value as string | null
      })
  }

  return {
    status: reasons.size ? 'held' : 'resolved',
    fields,
    reasons: [...reasons.values()],
    attached: attachedIds,
    billingBlockers
  }
}

/**
 * Resolves every active fragment of a conversation and classifies present or lifecycle-conflicted
 * records that attach to none of them. Records on deleted coverage (the fragment rebuilt by
 * deletedCoverageFragment) are `deleted` when the deletion saw them, or `deletionConflicts` when
 * it did not; only records on no known coverage (a cut no fragment starts at, unresolved
 * coverage) are `orphaned`. The root holds conflicts and orphans rather than dropping the edit.
 */
export function resolvePortableConversation(
  input: Omit<PortableSessionOverlayInput, 'fragment'> & {
    fragments: readonly PortableSessionFragment[]
    /** The conversation's deletion facts (readPortableHistoryFacts(...).deletions). */
    deletions?: readonly PortableSessionDeletion[]
  }
): PortableConversationResolution {
  const fragments = input.fragments.map((fragment) =>
    resolvePortableSessionFields({ ...input, fragment })
  )
  const attached = new Set(fragments.flatMap((resolution) => resolution.attached))
  const live = input.edits.filter(
    (record) => record.view.lifecycle === 'present' || record.view.lifecycle === 'conflict'
  )
  const onDeleted = new Set<string>()
  const deletionConflicts: PortableConversationResolution['deletionConflicts'] = []
  for (const deletion of input.deletions ?? []) {
    const piece = deletedCoverageFragment(deletion.coverage)
    if (!piece) continue
    for (const record of attachedSessionRecords(piece, live)) onDeleted.add(record.entityId)
    for (const item of unobservedSessionEdits(piece, live, deletion))
      deletionConflicts.push({ operationId: deletion.operationId, ...item })
  }
  deletionConflicts.sort((left, right) =>
    left.operationId !== right.operationId
      ? left.operationId < right.operationId
        ? -1
        : 1
      : left.entityId < right.entityId
        ? -1
        : left.entityId > right.entityId
          ? 1
          : 0
  )
  const conflicting = new Set(deletionConflicts.map((item) => item.entityId))
  const ids = live.map((record) => record.entityId).filter((id) => !attached.has(id))
  return {
    fragments,
    orphaned: ids.filter((id) => !onDeleted.has(id)).sort(),
    deleted: ids.filter((id) => onDeleted.has(id) && !conflicting.has(id)).sort(),
    deletionConflicts
  }
}
