import { createHash } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { sessions } from '../db/schema/sessions'
import { manualTimeEntries } from '../db/schema/manual-time-entries'
import { sourceMachines } from '../db/schema/activity-observers'
import { sessionDeletions } from '../db/schema/session-deletions'
import { sessionSplits } from '../db/schema/session-history'
import { syncChanges, syncRecordStates } from '../db/schema/folder-sync'
import { syncHistorySuppressions } from '../db/schema/sync-legacy'
import { AppError } from '../../shared/types/ipc'
import { canonicalJson, isSyncUuid, SyncError } from './folder-sync-protocol'
import { recordLocalSyncChanges, type SyncDomainAdapter } from './folder-sync-store'
import { syncFactChangeId } from './folder-sync-activity-records'
import { getDirectoryRecordView } from './folder-sync-directory-records'
import {
  findClientByPortableId,
  getPortableClientId,
  findProjectByPortableId,
  getPortableProjectId
} from './folder-sync-builtin-client'
import {
  PRESENT,
  RevisionError,
  checkRevision,
  materializeRecord,
  planRevision,
  readRevisionChange,
  type HeadsByField,
  type JsonValue,
  type ParsedRevision,
  type RecordSchema,
  type RecordView,
  type RevisionAction,
  type RevisionChange
} from './folder-sync-revisions'

/*
 * Portable manual time entries (folder-sync-plan.md decisions A, D and E).
 *
 * manual-entry: a causal revision record keyed by the existing manual_time_entries UUID.
 * - The identity root writes only $present and the create-only basis/deviceId/parentId. Its change
 *   ID is a version-8 UUID over the workspace and complete body, and its dependencies are the
 *   origin machine fact and the parent's identity root, so every computer (and every clone)
 *   plans the same root for the same entry.
 * - Values (times, description, billable, client/project syncIds) are ordinary field revisions.
 *   The bootstrap values revision also has a full-body ID: exact clones dedupe, while diverged
 *   pre-sync copies become visible field conflicts. Local edits use random IDs.
 * - deviceId is the creating computer for basis 'created'. Migrated entries (basis 'imported')
 *   carry null; their "imported from" label is a separate history-observer fact, so clones
 *   labelled by different computers never conflict on the entry itself.
 * - `disposition` says why an entry stopped counting: deleted, or split at an instant into named
 *   parts. `$present` false always names one and a restore writes it back to null, so a plain
 *   deletion and a split made concurrently are a visible disposition conflict, never two equal
 *   deletions. A split depends on its parts' identity roots.
 *
 * A split part (parentId set) counts only while its parent's agreed disposition is a split naming
 * it; until then it is held outside totals (pending), and once the parent settles otherwise
 * (deleted, kept, split differently) it stays non-counting audit history. A lifecycle conflict
 * keeps the last agreed state: the parent counts and its parts do not, on every computer, until an
 * explicit choice names the current heads. The lineage is a pure function of applied history.
 *
 * Import projects each entry once into a local manual session (no path, no source file) mapped by
 * manual_time_entries; later revisions update that row in place. Non-counting entries are only
 * suppressed (sync_history_suppressions) and kept for audit, with their billing references.
 * `restoresLocalHistory` lets shared history count a row again over this computer's own
 * deletion/split audit rows, which stay. Conflicted fields keep the last agreed value and are
 * listed as blockers. Running timers are never exported.
 */

type Db<TSchema extends Record<string, unknown>> = BetterSQLite3Database<TSchema>
type Transaction = Parameters<SyncDomainAdapter['apply']>[0]
type Reader = Pick<Transaction, 'select'>
type Values = Record<string, JsonValue>

export const MANUAL_IDENTITY_FIELDS = ['basis', 'deviceId', 'parentId'] as const
export const MANUAL_VALUE_FIELDS = [
  'startedAt',
  'endedAt',
  'durationMinutes',
  'description',
  'billable',
  'clientSyncId',
  'projectSyncId'
] as const

/** Written only together with `$present`: false names one, a restore writes null. */
export const MANUAL_LIFECYCLE_FIELD = 'disposition'

export type ManualDisposition =
  | { kind: 'deleted' }
  | { kind: 'split'; splitAt: string; children: string[] }

export type ManualLifecycleState =
  | 'missing'
  | 'active'
  /** $present or disposition conflicted; `counting` follows the last agreed state. */
  | 'conflict'
  | 'deleted'
  | 'split'
  /** A split part whose parent has not (or not yet) agreed on a split naming it. */
  | 'pending-split'
  /** A split part whose parent settled otherwise: kept, deleted or split differently. */
  | 'rejected'

export interface ManualLifecycle {
  state: ManualLifecycleState
  counting: boolean
  /** The agreed disposition of a deleted or split entry. */
  disposition: ManualDisposition | null
  splitFrom: string | null
  /** Counts although shared history once deleted or split it (an explicit restore or a conflict). */
  restored: boolean
}

export interface ManualEntryIdentity {
  basis: 'created' | 'imported'
  deviceId: string | null
  parentId: string | null
}

export interface PortableManualValues {
  startedAt: string
  endedAt: string
  durationMinutes: number
  description: string | null
  billable: boolean
  clientSyncId: string | null
  projectSyncId: string | null
}

export type ManualProjectionIssue =
  | { code: 'unresolved-field'; fields: string[] }
  | { code: 'parent-unavailable'; parentId: string }
  | { code: 'machine-unavailable'; deviceId: string }
  | { code: 'invalid-times' }
  /** A pre-existing local entry differs and was never exported; bootstrap it to compete. */
  | { code: 'unexported-local-values' }

/** Persisted in sync_record_states.state_json; rebuildable from sync_changes. */
export interface ManualEntryState {
  view: RecordView
  lifecycle?: ManualLifecycle
  /** Read by activeSessionCondition: counts over this computer's deletion/split audit rows. */
  restoresLocalHistory?: boolean
  /** Conflicted fields ($present included) and unavailable references; block billing use. */
  blockers: string[]
  projectionIssue?: ManualProjectionIssue
}

export interface ManualReference {
  entityType: 'machine' | 'client' | 'project' | 'manual-entry'
  entityId: string
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const ZONED = /(?:Z|[+-]\d{2}:\d{2})$/
const MAX_DESCRIPTION = 4000
const MAX_DURATION_MINUTES = 100_000
const MAX_SPLIT_PARTS = 16
const PLACEHOLDER_ID = '00000000-0000-8000-8000-000000000000'
const REFERENCES = [
  ['clientSyncId', 'client'],
  ['projectSyncId', 'project']
] as const

function malformed(message: string): never {
  throw new SyncError('SYNC_MALFORMED', message)
}

function invalid(message: string): never {
  throw new AppError('SYNC_INVALID_MANUAL_CHANGE', message)
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    TIMESTAMP.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  )
}

function isDescription(value: unknown): boolean {
  if (value === null) return true
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_DESCRIPTION) return false
  if (!value.isWellFormed()) return false
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if ((code < 0x20 || code === 0x7f) && code !== 0x09 && code !== 0x0a && code !== 0x0d)
      return false
  }
  return true
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isDisposition(value: unknown): boolean {
  if (value === null) return true
  if (!isObject(value)) return false
  const keys = Object.keys(value).sort().join()
  if (value.kind === 'deleted') return keys === 'kind'
  const children = value.children
  return (
    value.kind === 'split' &&
    keys === 'children,kind,splitAt' &&
    isTimestamp(value.splitAt) &&
    Array.isArray(children) &&
    children.length >= 2 &&
    children.length <= MAX_SPLIT_PARTS &&
    children.every(isSyncUuid) &&
    new Set(children).size === children.length
  )
}

export function isManualSplit(
  value: unknown
): value is Extract<ManualDisposition, { kind: 'split' }> {
  return isObject(value) && value.kind === 'split'
}

const isNullableSyncId = (value: JsonValue): boolean => value === null || isSyncUuid(value)
const CHECKS: Record<string, (value: JsonValue) => boolean> = {
  disposition: isDisposition,
  basis: (value) => value === 'created' || value === 'imported',
  deviceId: isNullableSyncId,
  parentId: isNullableSyncId,
  startedAt: isTimestamp,
  endedAt: isTimestamp,
  durationMinutes: (value) =>
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= MAX_DURATION_MINUTES,
  description: isDescription,
  billable: (value) => typeof value === 'boolean',
  clientSyncId: isNullableSyncId,
  projectSyncId: isNullableSyncId
}

/** No defaults: creation never invents values. */
export const MANUAL_ENTRY_SCHEMA: RecordSchema = Object.freeze({
  entityType: 'manual-entry',
  fields: Object.freeze([
    ...MANUAL_IDENTITY_FIELDS,
    ...MANUAL_VALUE_FIELDS,
    MANUAL_LIFECYCLE_FIELD
  ]),
  validate: (field: string, value: JsonValue) =>
    Object.hasOwn(CHECKS, field) && CHECKS[field](value)
})

/** RFC 9562 version-8 UUID over sha256 of canonical JSON. */
function v8(value: unknown): string {
  const bytes = createHash('sha256').update(canonicalJson(value)).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x80
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function bodyId(purpose: string, workspaceId: string, change: RevisionChange): string {
  const { id: _id, ...body } = change
  return v8({ purpose, workspaceId, body })
}

function isRoot(revision: ParsedRevision): boolean {
  return revision.fields.get(PRESENT)!.parents.length === 0
}

/** For applied (already validated) changes. */
function isRootChange(change: unknown): boolean {
  const fields = (change as Partial<RevisionChange>)?.payload?.fields
  return (
    (change as Partial<RevisionChange>)?.kind === 'revision' &&
    fields?.[PRESENT]?.parents.length === 0
  )
}

function everRetired(history: readonly unknown[]): boolean {
  return history.some(
    (change) => (change as RevisionChange).payload.fields[PRESENT]?.value === false
  )
}

/** Structural and domain check without database access. Facts are never accepted. */
export function validateManualChange(change: unknown): ParsedRevision {
  let revision: ParsedRevision
  try {
    revision = readRevisionChange(change, MANUAL_ENTRY_SCHEMA)
  } catch (error) {
    if (error instanceof RevisionError) malformed(error.message)
    throw error
  }
  const { id, entityId, fields } = revision
  if (!isSyncUuid(entityId)) malformed(`${id} must name a manual entry UUID`)
  const identity = MANUAL_IDENTITY_FIELDS.filter((field) => fields.has(field))
  if (isRoot(revision)) {
    if (fields.get(PRESENT)!.value !== true) malformed(`${id} must create ${entityId}`)
    if (identity.length !== MANUAL_IDENTITY_FIELDS.length || fields.size !== identity.length + 1)
      malformed(`${id}: a manual entry root writes exactly its identity`)
    const basis = fields.get('basis')!.value
    const deviceId = fields.get('deviceId')!.value
    const parentId = fields.get('parentId')!.value
    if ((basis === 'created') !== (deviceId !== null))
      malformed(`${id}: only created entries name their origin device`)
    if (parentId === entityId) malformed(`${id} cannot be its own parent`)
    const expected = (deviceId === null ? 0 : 1) + (parentId === null ? 0 : 1)
    if (revision.dependencies.length !== expected)
      malformed(`${id} must depend only on its machine and parent identity`)
  } else if (identity.length) malformed(`${id}: only the root writes ${identity.join(', ')}`)
  const disposition = fields.get(MANUAL_LIFECYCLE_FIELD)?.value
  if (fields.get(PRESENT)!.value === false && (disposition === undefined || disposition === null))
    malformed(`${id}: removing ${entityId} must name its disposition`)
  if (disposition !== undefined && disposition !== null && fields.get(PRESENT)!.value !== false)
    malformed(`${id}: a disposition removes the entry`)
  if (isManualSplit(disposition)) {
    if (disposition.children.includes(entityId)) malformed(`${id} cannot split into itself`)
    const parents = new Set([...fields.values()].flatMap((field) => field.parents))
    if (
      revision.dependencies.filter((dependency) => !parents.has(dependency)).length <
      disposition.children.length
    )
      malformed(`${id} must depend on the identity root of every split part`)
  }
  if (fields.has('clientSyncId') !== fields.has('projectSyncId'))
    malformed(`${id} must write clientSyncId and projectSyncId together`)
  const parents = new Set([...fields.values()].flatMap((field) => field.parents))
  for (const [field] of REFERENCES)
    if (
      typeof fields.get(field)?.value === 'string' &&
      revision.dependencies.every((dependency) => parents.has(dependency))
    )
      malformed(`${id} must depend on the ${field} record it assigns`)
  return revision
}

// ── Reading applied history ──

function appliedChange(db: Reader, workspaceId: string, id: string): unknown {
  const row = db
    .select({ json: syncChanges.changeJson })
    .from(syncChanges)
    .where(and(eq(syncChanges.workspaceId, workspaceId), eq(syncChanges.id, id)))
    .get()
  return row ? JSON.parse(row.json) : undefined
}

function historyOf(db: Reader, workspaceId: string, entryId: string): unknown[] {
  return db
    .select({ json: syncChanges.changeJson })
    .from(syncChanges)
    .where(
      and(
        eq(syncChanges.workspaceId, workspaceId),
        eq(syncChanges.entityType, 'manual-entry'),
        eq(syncChanges.entityId, entryId)
      )
    )
    .all()
    .map((row) => JSON.parse(row.json))
}

function hasLocalOrigin(db: Reader, workspaceId: string, entryId: string): boolean {
  return !!db
    .select({ id: syncChanges.id })
    .from(syncChanges)
    .where(
      and(
        eq(syncChanges.workspaceId, workspaceId),
        eq(syncChanges.entityType, 'manual-entry'),
        eq(syncChanges.entityId, entryId),
        eq(syncChanges.origin, 'local')
      )
    )
    .get()
}

export function getManualEntryView(db: Reader, workspaceId: string, entryId: string): RecordView {
  return materializeRecord(MANUAL_ENTRY_SCHEMA, entryId, historyOf(db, workspaceId, entryId))
}

export function readManualEntryState(
  db: Reader,
  workspaceId: string,
  entryId: string
): ManualEntryState | null {
  const row = db
    .select({ json: syncRecordStates.stateJson })
    .from(syncRecordStates)
    .where(
      and(
        eq(syncRecordStates.workspaceId, workspaceId),
        eq(syncRecordStates.entityType, 'manual-entry'),
        eq(syncRecordStates.entityId, entryId)
      )
    )
    .get()
  return row ? (JSON.parse(row.json) as ManualEntryState) : null
}

/** The applied identity root of an entry, if any. */
function appliedRootId(db: Reader, workspaceId: string, entryId: string): string | null {
  return (
    (historyOf(db, workspaceId, entryId).find(isRootChange) as RevisionChange | undefined)?.id ??
    null
  )
}

/** Entries whose applied identity root names this entry as its split parent. */
function splitPartsOf(db: Reader, workspaceId: string, entryId: string): string[] {
  return db
    .select({ json: syncChanges.changeJson })
    .from(syncChanges)
    .where(
      and(
        eq(syncChanges.workspaceId, workspaceId),
        eq(syncChanges.entityType, 'manual-entry'),
        sql`json_extract(${syncChanges.changeJson}, '$.payload.fields.parentId.value') = ${entryId}`
      )
    )
    .all()
    .map((row) => JSON.parse(row.json) as RevisionChange)
    .filter(
      (change) =>
        change.entityId !== entryId &&
        isRootChange(change) &&
        change.payload.fields.parentId?.value === entryId
    )
    .map((change) => change.entityId)
    .sort()
}

// ── Lifecycle and split lineage ──

/** Own lifecycle of one entry, before its split lineage is considered. */
export function ownManualLifecycle(
  view: RecordView,
  history: readonly unknown[]
): Omit<ManualLifecycle, 'splitFrom'> {
  if (view.lifecycle === 'missing')
    return { state: 'missing', counting: false, disposition: null, restored: false }
  const present = view.present
  const disposition = view.fields[MANUAL_LIFECYCLE_FIELD]
  if (present.status === 'conflict' || disposition.status === 'conflict') {
    // The last agreed state of whichever part is conflicted: edit-versus-delete keeps the entry
    // (last common $present), delete-versus-split keeps it (last common disposition is null).
    const counting =
      (present.status !== 'conflict' || present.value !== false) &&
      (disposition.status !== 'conflict' ||
        disposition.value === null ||
        disposition.value === undefined)
    return {
      state: 'conflict',
      counting,
      disposition: null,
      restored: counting && everRetired(history)
    }
  }
  if (view.lifecycle === 'deleted') {
    const value = isManualSplit(disposition.value)
      ? (disposition.value as ManualDisposition)
      : ({ kind: 'deleted' } as const)
    return {
      state: value.kind === 'split' ? 'split' : 'deleted',
      counting: false,
      disposition: value,
      restored: false
    }
  }
  return { state: 'active', counting: true, disposition: null, restored: everRetired(history) }
}

type LifecycleMemo = Map<string, ManualLifecycle>

/**
 * Shared lifecycle of one entry, a pure function of applied history. A split part counts only
 * while its parent (itself live in its own lineage) agrees on a split naming it.
 */
export function manualEntryLifecycle(
  db: Reader,
  workspaceId: string,
  entryId: string,
  memo: LifecycleMemo = new Map(),
  visiting: Set<string> = new Set()
): ManualLifecycle {
  const known = memo.get(entryId)
  if (known) return known
  const history = historyOf(db, workspaceId, entryId)
  const view = materializeRecord(MANUAL_ENTRY_SCHEMA, entryId, history)
  const parentId =
    typeof view.fields.parentId?.value === 'string' ? view.fields.parentId.value : null
  const held = (state: 'pending-split' | 'rejected'): ManualLifecycle => ({
    state,
    counting: false,
    disposition: null,
    splitFrom: parentId,
    restored: false
  })
  if (visiting.has(entryId)) return held('pending-split')
  visiting.add(entryId)
  let result: ManualLifecycle | undefined
  if (parentId) {
    const parent = manualEntryLifecycle(db, workspaceId, parentId, memo, visiting)
    const applies =
      parent.state === 'split' &&
      isManualSplit(parent.disposition) &&
      parent.disposition.children.includes(entryId)
    if (!applies) {
      const settled =
        parent.state === 'deleted' ||
        parent.state === 'split' ||
        parent.state === 'rejected' ||
        (parent.state === 'active' && parent.restored)
      result = held(settled ? 'rejected' : 'pending-split')
    }
  }
  result ??= { ...ownManualLifecycle(view, history), splitFrom: parentId }
  visiting.delete(entryId)
  memo.set(entryId, result)
  return result
}

// ── Identity roots ──

function identityRootBody(
  workspaceId: string,
  entryId: string,
  identity: ManualEntryIdentity,
  parentRootId: string | null
): RevisionChange {
  const dependencies = [
    ...(identity.deviceId ? [syncFactChangeId(workspaceId, 'machine', identity.deviceId)] : []),
    ...(parentRootId ? [parentRootId] : [])
  ]
  const change = planRevision({
    id: PLACEHOLDER_ID,
    schema: MANUAL_ENTRY_SCHEMA,
    entityId: entryId,
    history: [],
    action: { type: 'create', values: { ...identity } },
    dependencies
  })
  return { ...change, id: bodyId('clautime-manual-entry-identity-1', workspaceId, change) }
}

/** The portable identity of a local entry (null when it has no manual_time_entries row). */
export function localManualIdentity(db: Reader, entryId: string): ManualEntryIdentity | null {
  const row = db.select().from(manualTimeEntries).where(eq(manualTimeEntries.id, entryId)).get()
  if (!row) return null
  return {
    basis: row.basis,
    // A migrated entry's label is provenance (history-observer), not identity.
    deviceId: row.basis === 'created' ? row.deviceId : null,
    parentId: row.parentId
  }
}

/** Deterministic root change of a local entry, computed from immutable identity only. */
export function manualEntryIdentityRoot(
  db: Reader,
  workspaceId: string,
  entryId: string,
  seen: ReadonlySet<string> = new Set()
): RevisionChange {
  const identity = localManualIdentity(db, entryId)
  if (!identity) throw new AppError('MANUAL_ENTRY_NOT_FOUND', `Manual entry ${entryId} not found`)
  if (identity.basis === 'created' && !identity.deviceId)
    throw new AppError('MANUAL_ENTRY_UNATTRIBUTED', `Manual entry ${entryId} has no origin device`)
  if (seen.has(entryId))
    throw new AppError('MANUAL_ENTRY_CYCLE', 'Manual split lineage has a cycle')
  const parentRootId = identity.parentId
    ? manualEntryIdentityRoot(db, workspaceId, identity.parentId, new Set([...seen, entryId])).id
    : null
  return identityRootBody(workspaceId, entryId, identity, parentRootId)
}

// ── Import ──

function requireDirectoryDependency(
  lookup: (id: string) => unknown,
  revision: ParsedRevision,
  entityType: 'client' | 'project',
  syncId: string
): void {
  const found = revision.dependencies.some((id) => {
    const dependency = lookup(id) as Partial<RevisionChange> | undefined
    return (
      dependency?.kind === 'revision' &&
      dependency.entityType === entityType &&
      dependency.entityId === syncId
    )
  })
  if (!found) malformed(`${revision.id} does not depend on ${entityType} ${syncId}`)
}

function checkRoot(
  lookup: (id: string) => unknown,
  workspaceId: string,
  change: RevisionChange,
  revision: ParsedRevision
): void {
  const identity = Object.fromEntries(
    MANUAL_IDENTITY_FIELDS.map((field) => [field, revision.fields.get(field)!.value])
  ) as unknown as ManualEntryIdentity
  let parentRootId: string | null = null
  if (identity.parentId) {
    parentRootId =
      revision.dependencies.find((id) => {
        const dependency = lookup(id) as Partial<RevisionChange> | undefined
        return (
          dependency?.entityType === 'manual-entry' && dependency.entityId === identity.parentId
        )
      }) ?? null
    const parent = parentRootId ? lookup(parentRootId) : undefined
    if (!parent || !isRoot(validateManualChange(parent)))
      malformed(`${revision.id} must depend on the identity root of ${identity.parentId}`)
  }
  const expected = identityRootBody(workspaceId, revision.entityId, identity, parentRootId)
  if (expected.id !== change.id || canonicalJson(expected) !== canonicalJson(change))
    malformed(`${revision.id} is not the deterministic identity root of ${revision.entityId}`)
}

function portableValuesOf(db: Reader, session: typeof sessions.$inferSelect): PortableManualValues {
  return {
    startedAt: new Date(session.startedAt).toISOString(),
    endedAt: new Date(session.endedAt).toISOString(),
    durationMinutes: session.durationMinutes,
    description: session.description?.trim() ? session.description : null,
    billable: !!session.billable,
    clientSyncId: session.clientId === null ? null : getPortableClientId(db, session.clientId),
    projectSyncId: session.projectId === null ? null : getPortableProjectId(db, session.projectId)
  }
}

function resolveReference(
  tx: Reader,
  workspaceId: string,
  entityType: 'client' | 'project',
  syncId: string
): number | null {
  if (getDirectoryRecordView(tx, workspaceId, entityType, syncId).lifecycle === 'missing')
    return null
  if (entityType === 'client') return findClientByPortableId(tx, syncId)?.id ?? null
  return findProjectByPortableId(tx, syncId)?.id ?? null
}

/** Equal instants and blank descriptions are the same value; local spelling is preserved. */
function sameColumn(column: string, current: unknown, value: unknown): boolean {
  if (column === 'startedAt' || column === 'endedAt')
    return typeof current === 'string' && Date.parse(current) === Date.parse(value as string)
  if (column === 'description')
    return (typeof current === 'string' && current.trim() ? current : null) === value
  return current === value
}

function setSuppressed(
  tx: Transaction,
  workspaceId: string,
  entryId: string,
  sessionId: number,
  lifecycle: ManualLifecycle,
  blockers: string[]
): void {
  tx.delete(syncHistorySuppressions).where(eq(syncHistorySuppressions.sessionId, sessionId)).run()
  if (!lifecycle.counting)
    tx.insert(syncHistorySuppressions)
      .values({
        sessionId,
        workspaceId,
        recordType: 'manual-entry',
        recordId: entryId,
        status:
          lifecycle.state === 'pending-split'
            ? 'queued'
            : lifecycle.state === 'conflict'
              ? 'conflict'
              : 'deleted',
        detailJson: JSON.stringify({
          blockers,
          lifecycle: lifecycle.state,
          disposition: lifecycle.disposition,
          ...(lifecycle.splitFrom ? { splitFrom: lifecycle.splitFrom } : {})
        })
      })
      .run()
}

function projectManualEntry(
  tx: Transaction,
  workspaceId: string,
  view: RecordView,
  lifecycle: ManualLifecycle
): Omit<ManualEntryState, 'view'> {
  const entryId = view.entityId
  const blockers = [...view.conflicts]
  const agreed: Values = {}
  for (const [field, state] of Object.entries(view.fields))
    if (state.value !== undefined) agreed[field] = state.value
  const columns: Partial<typeof sessions.$inferInsert> = {}
  const set = (field: string, apply: (value: JsonValue) => void) => {
    if (Object.hasOwn(agreed, field)) apply(agreed[field])
  }
  set('startedAt', (value) => (columns.startedAt = value as string))
  set('endedAt', (value) => (columns.endedAt = value as string))
  set('durationMinutes', (value) => (columns.durationMinutes = value as number))
  set('description', (value) => (columns.description = value as string | null))
  set('billable', (value) => (columns.billable = value ? 1 : 0))
  for (const [field, entityType] of REFERENCES)
    set(field, (value) => {
      const id =
        value === null ? null : resolveReference(tx, workspaceId, entityType, value as string)
      if (value !== null && id === null) blockers.push(`${field}:unavailable`)
      else if (entityType === 'client') columns.clientId = id
      else columns.projectId = id
    })
  if (
    typeof columns.startedAt === 'string' &&
    typeof columns.endedAt === 'string' &&
    columns.endedAt < columns.startedAt
  )
    return { blockers, projectionIssue: { code: 'invalid-times' } }

  const local = tx.select().from(manualTimeEntries).where(eq(manualTimeEntries.id, entryId)).get()
  const now = new Date().toISOString()
  let sessionId: number
  if (!local) {
    if (view.lifecycle === 'missing') return { blockers }
    const required = [
      ...MANUAL_IDENTITY_FIELDS,
      'startedAt',
      'endedAt',
      'durationMinutes',
      'billable'
    ]
    const missing = required.filter((field) => !Object.hasOwn(agreed, field))
    if (missing.length)
      return { blockers, projectionIssue: { code: 'unresolved-field', fields: missing } }
    const parentId = agreed.parentId as string | null
    if (
      parentId &&
      !tx.select().from(manualTimeEntries).where(eq(manualTimeEntries.id, parentId)).get()
    )
      return { blockers, projectionIssue: { code: 'parent-unavailable', parentId } }
    const deviceId = agreed.deviceId as string | null
    if (
      deviceId &&
      !tx.select().from(sourceMachines).where(eq(sourceMachines.deviceId, deviceId)).get()
    )
      return { blockers, projectionIssue: { code: 'machine-unavailable', deviceId } }
    // Imported once into a local manual session; later revisions update this row in place.
    sessionId = tx
      .insert(sessions)
      .values({
        projectPath: '',
        sourceFile: null,
        source: 'manual',
        status: 'completed',
        promptCount: 0,
        startedAt: columns.startedAt!,
        endedAt: columns.endedAt!,
        durationMinutes: columns.durationMinutes!,
        description: columns.description ?? null,
        billable: columns.billable!,
        clientId: columns.clientId ?? null,
        projectId: columns.projectId ?? null,
        createdAt: now,
        updatedAt: now
      })
      .returning({ id: sessions.id })
      .get().id
    tx.insert(manualTimeEntries)
      .values({
        id: entryId,
        sessionId,
        deviceId,
        basis: agreed.basis as 'created' | 'imported',
        parentId
      })
      .run()
  } else {
    sessionId = local.sessionId
    const row = tx.select().from(sessions).where(eq(sessions.id, sessionId)).get()!
    const current = row as unknown as Record<string, unknown>
    const changed = Object.fromEntries(
      Object.entries(columns).filter(
        ([column, value]) => !sameColumn(column, current[column], value)
      )
    )
    if (Object.keys(changed).length) {
      // Never overwrite a pre-existing entry this computer has not exported yet.
      if (!hasLocalOrigin(tx, workspaceId, entryId)) {
        const previous = readManualEntryState(tx, workspaceId, entryId)
        if (!previous || previous.projectionIssue?.code === 'unexported-local-values')
          return { blockers, projectionIssue: { code: 'unexported-local-values' } }
      }
      tx.update(sessions)
        .set({ ...changed, updatedAt: now })
        .where(eq(sessions.id, sessionId))
        .run()
    }
  }
  // Only the agreed lineage suppresses; a lifecycle conflict keeps its last agreed state.
  setSuppressed(tx, workspaceId, entryId, sessionId, lifecycle, blockers)
  return { blockers }
}

/** Projects one entry and records its state; its split parts are refreshed by the caller. */
function refreshManualEntry(
  tx: Transaction,
  workspaceId: string,
  entryId: string,
  memo: LifecycleMemo
): void {
  const view = getManualEntryView(tx, workspaceId, entryId)
  if (view.lifecycle === 'missing') return
  const lifecycle = manualEntryLifecycle(tx, workspaceId, entryId, memo)
  const outcome = projectManualEntry(tx, workspaceId, view, lifecycle)
  const state: ManualEntryState = {
    view,
    lifecycle,
    ...outcome,
    restoresLocalHistory: lifecycle.counting && lifecycle.restored
  }
  tx.insert(syncRecordStates)
    .values({
      workspaceId,
      entityType: 'manual-entry',
      entityId: entryId,
      stateJson: JSON.stringify(state)
    })
    .onConflictDoUpdate({
      target: [
        syncRecordStates.workspaceId,
        syncRecordStates.entityType,
        syncRecordStates.entityId
      ],
      set: { stateJson: JSON.stringify(state) }
    })
    .run()
}

/** An entry and every split part below it, parents first, in any arrival order. */
function refreshManualLineage(tx: Transaction, workspaceId: string, entryId: string): void {
  const memo: LifecycleMemo = new Map()
  const queue = [entryId]
  const seen = new Set<string>()
  while (queue.length) {
    const id = queue.shift() as string
    if (seen.has(id)) continue
    seen.add(id)
    refreshManualEntry(tx, workspaceId, id, memo)
    queue.push(...splitPartsOf(tx, workspaceId, id))
  }
}

function checkSplitParts(lookup: (id: string) => unknown, revision: ParsedRevision): void {
  const disposition = revision.fields.get(MANUAL_LIFECYCLE_FIELD)?.value
  if (!isManualSplit(disposition)) return
  for (const child of disposition.children) {
    const root = revision.dependencies
      .map((id) => lookup(id) as RevisionChange | undefined)
      .find(
        (change) =>
          change?.entityType === 'manual-entry' && change.entityId === child && isRootChange(change)
      )
    if (!root) malformed(`${revision.id} must depend on the identity root of split part ${child}`)
    if (root.payload.fields.parentId?.value !== revision.entityId)
      malformed(`${revision.id}: ${child} was not split from ${revision.entityId}`)
  }
}

/**
 * Store hook, called after the change is inserted into sync_changes. Parents, the deterministic
 * identity root, machine/parent and directory references are checked against applied changes.
 */
export function applyManualChange(tx: Transaction, workspaceId: string, change: unknown): void {
  const revision = validateManualChange(change)
  const lookup = (id: string): unknown => appliedChange(tx, workspaceId, id)
  if (lookup(revision.id) === undefined)
    malformed(`Record ${revision.id} in sync_changes before applying it`)
  try {
    const missing = checkRevision(change, MANUAL_ENTRY_SCHEMA, lookup)
    if (missing.length)
      throw new AppError(
        'SYNC_MISSING_DEPENDENCY',
        `${revision.id} waits for ${missing.join(', ')}`
      )
    if (isRoot(revision)) checkRoot(lookup, workspaceId, change as RevisionChange, revision)
    getManualEntryView(tx, workspaceId, revision.entityId)
  } catch (error) {
    if (error instanceof RevisionError) malformed(error.message)
    throw error
  }
  for (const [field, referenced] of REFERENCES) {
    const syncId = revision.fields.get(field)?.value
    if (typeof syncId === 'string') requireDirectoryDependency(lookup, revision, referenced, syncId)
  }
  checkSplitParts(lookup, revision)
  refreshManualLineage(tx, workspaceId, revision.entityId)
}

/** Handles only 'manual-entry' revisions; route other entity types elsewhere. */
export const manualRecordsAdapter: SyncDomainAdapter = {
  validate: (change) => void validateManualChange(change),
  apply: applyManualChange
}

export function journalManualSyncChanges<TSchema extends Record<string, unknown>>(
  db: Db<TSchema>,
  workspaceId: string,
  changes: readonly RevisionChange[]
): string[] {
  if (!changes.length) return []
  return recordLocalSyncChanges(db, workspaceId, [...changes], manualRecordsAdapter)
}

// ── Planning ──

function directoryDependencies(
  db: Reader,
  workspaceId: string,
  values: Values,
  requires?: ManualReference[]
): string[] {
  const dependencies: string[] = []
  for (const [field, entityType] of REFERENCES) {
    const syncId = values[field]
    if (syncId === null || syncId === undefined) continue
    if (!isSyncUuid(syncId)) invalid(`${field} must be a portable syncId`)
    const view = getDirectoryRecordView(db, workspaceId, entityType, syncId)
    if (view.lifecycle !== 'missing') dependencies.push(...view.heads[PRESENT])
    else if (requires) requires.push({ entityType, entityId: syncId })
    else
      throw new AppError(
        'SYNC_REFERENCE_UNAVAILABLE',
        `Export ${entityType} ${syncId} before assigning manual time to it`
      )
  }
  return dependencies
}

function planned(plan: Parameters<typeof planRevision>[0]): RevisionChange {
  try {
    const change = planRevision(plan)
    validateManualChange(change)
    return change
  } catch (error) {
    if (error instanceof RevisionError || error instanceof SyncError) invalid(error.message)
    throw error
  }
}

/** $present false plus its disposition, superseding exactly the observed heads of both. */
function retirement(
  id: string,
  entryId: string,
  history: readonly unknown[],
  observedHeads: HeadsByField,
  disposition: ManualDisposition,
  dependencies: readonly string[]
): RevisionChange {
  try {
    const base = planRevision({
      id,
      schema: MANUAL_ENTRY_SCHEMA,
      entityId: entryId,
      history,
      action: { type: 'delete', observedHeads }
    })
    const parents = [...(observedHeads[MANUAL_LIFECYCLE_FIELD] ?? [])].sort()
    const change: RevisionChange = {
      ...base,
      dependencies: [...new Set([...base.dependencies, ...parents, ...dependencies])].sort(),
      payload: {
        fields: {
          ...base.payload.fields,
          [MANUAL_LIFECYCLE_FIELD]: { value: disposition as unknown as JsonValue, parents }
        }
      }
    }
    validateManualChange(change)
    // Rejects a disposition parent that did not write it.
    materializeRecord(MANUAL_ENTRY_SCHEMA, entryId, [...history, change])
    return change
  } catch (error) {
    if (error instanceof RevisionError || error instanceof SyncError) invalid(error.message)
    throw error
  }
}

/** The split parts' applied identity roots: the split depends on them. */
function splitDependencies(
  db: Reader,
  workspaceId: string,
  disposition: ManualDisposition | null | undefined
): string[] {
  if (!isManualSplit(disposition)) return []
  return disposition.children.map((child) => {
    const root = appliedRootId(db, workspaceId, child)
    if (!root)
      throw new AppError(
        'SYNC_REFERENCE_UNAVAILABLE',
        'Share the split parts before recording the split'
      )
    return root
  })
}

/** A saved instant with an explicit zone, normalized; a timezone-naive value is never guessed. */
function zonedInstant(value: string): string | null {
  if (!ZONED.test(value.trim())) return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? new Date(at).toISOString() : null
}

/** This computer's own deletion or split of a local entry, from its audit rows. */
function localDisposition(
  db: Reader,
  entryId: string,
  sessionId: number
): ManualDisposition | null | 'unavailable' {
  const split = db
    .select()
    .from(sessionSplits)
    .where(eq(sessionSplits.parentSessionId, sessionId))
    .get()
  if (split) {
    const parts = [split.firstSessionId, split.secondSessionId].map((id) =>
      db.select().from(manualTimeEntries).where(eq(manualTimeEntries.sessionId, id)).get()
    )
    const splitAt = zonedInstant(split.splitAt)
    if (
      !splitAt ||
      parts.some(
        (part) => !part || part.parentId !== entryId || (part.basis === 'created' && !part.deviceId)
      )
    )
      return 'unavailable'
    return { kind: 'split', splitAt, children: parts.map((part) => part!.id) }
  }
  const deleted = db
    .select({ id: sessionDeletions.id })
    .from(sessionDeletions)
    .where(eq(sessionDeletions.sessionId, sessionId))
    .get()
  return deleted ? { kind: 'deleted' } : null
}

export type ManualBootstrap =
  | {
      status: 'ready'
      changes: RevisionChange[]
      /** Split parts whose identity roots are not known yet; `changes` then holds the root only. */
      awaiting?: string[]
    }
  | { status: 'has-history' }
  | { status: 'requires'; requires: ManualReference[] }
  | { status: 'withheld'; reason: 'running' | 'unattributed' | 'split-parts-unavailable' }
  | { status: 'not-found' }

/**
 * Initial export of one local entry: its deterministic identity root, a full-body values revision
 * and, for a locally deleted or split entry, a full-body retirement naming that disposition.
 * `pending` holds changes planned in the same export. A split needs its parts' roots, which need
 * this root: until they are known only the root is returned, with `awaiting`.
 */
export function planManualEntryBootstrap(
  db: Reader,
  workspaceId: string,
  entryId: string,
  pending: ReadonlySet<string> = new Set()
): ManualBootstrap {
  const entry = db.select().from(manualTimeEntries).where(eq(manualTimeEntries.id, entryId)).get()
  if (!entry) return { status: 'not-found' }
  const session = db.select().from(sessions).where(eq(sessions.id, entry.sessionId)).get()
  if (!session) return { status: 'not-found' }
  if (session.status !== 'completed') return { status: 'withheld', reason: 'running' }
  if (entry.basis === 'created' && !entry.deviceId)
    return { status: 'withheld', reason: 'unattributed' }
  const history = historyOf(db, workspaceId, entryId)
  // A root exported alone (while its split parts were not shareable) is not history yet.
  if (history.some((change) => !isRootChange(change))) {
    const held =
      readManualEntryState(db, workspaceId, entryId)?.projectionIssue?.code ===
      'unexported-local-values'
    if (!held || hasLocalOrigin(db, workspaceId, entryId)) return { status: 'has-history' }
  }
  const known = (id: string) => pending.has(id) || appliedChange(db, workspaceId, id) !== undefined
  const unapplied = (changes: RevisionChange[]) =>
    changes.filter((change) => appliedChange(db, workspaceId, change.id) === undefined)
  const root = manualEntryIdentityRoot(db, workspaceId, entryId)
  const requires: ManualReference[] = []
  const identity = localManualIdentity(db, entryId)!
  if (identity.deviceId && !known(syncFactChangeId(workspaceId, 'machine', identity.deviceId)))
    requires.push({ entityType: 'machine', entityId: identity.deviceId })
  if (identity.parentId && !known(manualEntryIdentityRoot(db, workspaceId, identity.parentId).id))
    requires.push({ entityType: 'manual-entry', entityId: identity.parentId })
  const values = {
    ...(portableValuesOf(db, session) as unknown as Values),
    [MANUAL_LIFECYCLE_FIELD]: null
  }
  const references = directoryDependencies(db, workspaceId, values, requires)
  if (requires.length) return { status: 'requires', requires }
  const disposition = localDisposition(db, entryId, session.id)
  if (disposition === 'unavailable')
    return { status: 'withheld', reason: 'split-parts-unavailable' }
  const partRoots = isManualSplit(disposition)
    ? disposition.children.map((child) => manualEntryIdentityRoot(db, workspaceId, child).id)
    : []
  const awaiting = isManualSplit(disposition)
    ? disposition.children.filter((_, index) => !known(partRoots[index]))
    : []
  if (awaiting.length) return { status: 'ready', changes: unapplied([root]), awaiting }

  const base = [root]
  const valuesChange = planned({
    id: PLACEHOLDER_ID,
    schema: MANUAL_ENTRY_SCHEMA,
    entityId: entryId,
    history: base,
    action: {
      type: 'edit',
      observedHeads: materializeRecord(MANUAL_ENTRY_SCHEMA, entryId, base).heads,
      values
    },
    dependencies: references
  })
  valuesChange.id = bodyId('clautime-manual-entry-baseline-1', workspaceId, valuesChange)
  const changes = [root, valuesChange]
  if (disposition) {
    // This computer's own deletion or split stays non-counting everywhere, split parts counting.
    const retired = retirement(
      PLACEHOLDER_ID,
      entryId,
      changes,
      materializeRecord(MANUAL_ENTRY_SCHEMA, entryId, changes).heads,
      disposition,
      partRoots
    )
    retired.id = bodyId('clautime-manual-entry-baseline-1', workspaceId, retired)
    changes.push(retired)
  }
  // An identity root imported earlier is already applied; only new changes are returned.
  return { status: 'ready', changes: unapplied(changes) }
}

export interface ManualExport {
  /** Record them with journalManualSyncChanges, which orders them by dependency. */
  changes: RevisionChange[]
  blocked: Array<{ entryId: string; requires: ManualReference[] }>
  withheld: Array<{
    entryId: string
    reason: 'running' | 'unattributed' | 'split-parts-unavailable'
  }>
}

/**
 * Bootstraps every local manual entry without causal history in this workspace, parents first.
 * A split parent is planned again once its parts' roots are planned; if a part cannot be shared,
 * only the parent's root is exported (it counts nowhere) and the parent is reported blocked.
 */
export function collectManualSyncChanges(db: Reader, workspaceId: string): ManualExport {
  const result: ManualExport = { changes: [], blocked: [], withheld: [] }
  const entries = db.select().from(manualTimeEntries).orderBy(manualTimeEntries.id).all()
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const depth = (id: string, seen = new Set<string>()): number => {
    const parent = byId.get(id)?.parentId
    return parent && !seen.has(parent) ? 1 + depth(parent, new Set([...seen, id])) : 0
  }
  const pending = new Set<string>()
  const add = (changes: RevisionChange[]) => {
    for (const change of changes)
      if (!pending.has(change.id)) {
        pending.add(change.id)
        result.changes.push(change)
      }
  }
  const awaiting: string[] = []
  for (const entry of [...entries].sort(
    (a, b) => depth(a.id) - depth(b.id) || (a.id < b.id ? -1 : 1)
  )) {
    const plan = planManualEntryBootstrap(db, workspaceId, entry.id, pending)
    if (plan.status === 'ready') {
      add(plan.changes)
      // A root that already exists still satisfies its children.
      pending.add(manualEntryIdentityRoot(db, workspaceId, entry.id).id)
      if (plan.awaiting) awaiting.push(entry.id)
    } else if (plan.status === 'requires')
      result.blocked.push({ entryId: entry.id, requires: plan.requires })
    else if (plan.status === 'withheld')
      result.withheld.push({ entryId: entry.id, reason: plan.reason })
  }
  for (const entryId of awaiting) {
    const plan = planManualEntryBootstrap(db, workspaceId, entryId, pending)
    if (plan.status === 'ready' && !plan.awaiting) add(plan.changes)
    else if (plan.status === 'ready')
      result.blocked.push({
        entryId,
        requires: plan.awaiting!.map((child) => ({
          entityType: 'manual-entry' as const,
          entityId: child
        }))
      })
  }
  return result
}

/** The agreed disposition of a deleted entry, if not conflicted. */
function agreedDisposition(view: RecordView): ManualDisposition | null {
  const state = view.fields[MANUAL_LIFECYCLE_FIELD]
  return state.status === 'resolved' && isObject(state.value)
    ? (state.value as unknown as ManualDisposition)
    : null
}

/**
 * A local edit/delete/split/resolve of one entry (random change ID), for the session-service
 * hooks and conflict review. Only value fields are editable; client and project are assigned
 * together. Delete names `disposition` (default deleted); a split names its parts, whose roots
 * must be applied. Resolving to removed names one (default: the agreed one); keeping writes null.
 */
export function planManualEntryRevision(
  db: Reader,
  workspaceId: string,
  request: { id: string; entryId: string; action: RevisionAction; disposition?: ManualDisposition }
): RevisionChange {
  const { action, entryId } = request
  const values: Values = action.type === 'delete' ? {} : { ...(action.values ?? {}) }
  const unknown = Object.keys(values).find(
    (field) => !(MANUAL_VALUE_FIELDS as readonly string[]).includes(field)
  )
  if (unknown !== undefined) invalid(`Cannot edit manual entry field ${unknown}`)
  if (Object.hasOwn(values, 'clientSyncId') !== Object.hasOwn(values, 'projectSyncId'))
    invalid('Assign a client and project together')
  if (request.disposition !== undefined && !isDisposition(request.disposition))
    invalid('The removal is invalid')
  const history = historyOf(db, workspaceId, entryId)
  const view = materializeRecord(MANUAL_ENTRY_SCHEMA, entryId, history)
  if (action.type === 'delete') {
    const disposition = request.disposition ?? { kind: 'deleted' }
    return retirement(
      request.id,
      entryId,
      history,
      { ...view.heads, ...action.observedHeads },
      disposition,
      splitDependencies(db, workspaceId, disposition)
    )
  }
  if (action.type !== 'resolve') {
    if (request.disposition !== undefined) invalid('Only a deletion or resolution names a removal')
    return planned({
      id: request.id,
      schema: MANUAL_ENTRY_SCHEMA,
      entityId: entryId,
      history,
      action,
      dependencies: directoryDependencies(db, workspaceId, values)
    })
  }
  let disposition: ManualDisposition | null | undefined
  if ((action.present ?? view.present.value) === false) {
    disposition =
      request.disposition ??
      agreedDisposition(view) ??
      invalid(`Choose how ${entryId} stops counting`)
  } else if (request.disposition !== undefined) invalid('A kept manual entry has no removal')
  else if (view.fields[MANUAL_LIFECYCLE_FIELD].heads.some((head) => head.value !== null))
    disposition = null
  let expectedHeads = action.expectedHeads
  if (disposition !== undefined) {
    values[MANUAL_LIFECYCLE_FIELD] = disposition as unknown as JsonValue
    // Every disposition write also writes $present, so exact $present heads pin these.
    expectedHeads = {
      [MANUAL_LIFECYCLE_FIELD]: view.heads[MANUAL_LIFECYCLE_FIELD],
      ...action.expectedHeads
    }
  }
  return planned({
    id: request.id,
    schema: MANUAL_ENTRY_SCHEMA,
    entityId: entryId,
    history,
    action: { ...action, expectedHeads, values },
    dependencies: [
      ...directoryDependencies(db, workspaceId, values),
      ...splitDependencies(db, workspaceId, disposition)
    ]
  })
}
