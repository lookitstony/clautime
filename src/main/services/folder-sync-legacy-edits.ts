import { createHash, randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { sessions, type Session } from '../db/schema/sessions'
import { sessionLegacyRecords } from '../db/schema/session-legacy'
import { sessionDeletions } from '../db/schema/session-deletions'
import { sessionSplits } from '../db/schema/session-history'
import { syncChanges, syncRecordStates } from '../db/schema/folder-sync'
import { syncLegacyImports } from '../db/schema/sync-legacy'
import { AppError } from '../../shared/types/ipc'
import { canonicalJson, isSyncUuid, SyncError, type SyncChange } from './folder-sync-protocol'
import type { SyncDomainAdapter } from './folder-sync-store'
import { syncFactChangeId } from './folder-sync-activity-records'
import { getDirectoryRecordView } from './folder-sync-directory-records'
import {
  findClientByPortableId,
  getPortableClientId,
  findProjectByPortableId,
  getPortableProjectId
} from './folder-sync-builtin-client'
import {
  checkRevision,
  materializeRecord,
  planRevision,
  PRESENT,
  readRevisionChange,
  RevisionError,
  type HeadsByField,
  type JsonValue,
  type ParsedRevision,
  type RecordSchema,
  type RecordView,
  type RevisionAction,
  type RevisionChange
} from './folder-sync-revisions'
import {
  journalLegacySyncChanges,
  planLegacySnapshotFacts,
  portableInstant,
  readLegacySnapshot,
  type LegacyJournalOptions,
  type PortableLegacySnapshot
} from './folder-sync-legacy-records'

/*
 * Causal edits and lifecycle of portable legacy history (folder-sync-plan.md decisions A, D, E).
 *
 * legacy-edit is a revision record keyed by the legacy UUID. Its fields are the saved row's
 * editable values (times, description, billable, client/project) plus `disposition`, which
 * says why a record stopped counting: deleted, split into named child snapshots, adopted by
 * ledger activity, or replaced by a recalculation. `$present` false always names a disposition;
 * a restore writes it back to null. The immutable legacy-session fact stays the audit snapshot.
 *
 * - The baseline (first revision) writes every field, depends on the legacy fact and on the
 *   referenced client/project revisions, and takes a content-derived ID, so exact clones dedupe
 *   and diverged copies become visible same-field conflicts. A historical deletion, split or
 *   adoption that already happened before export is a content-derived retirement of it.
 * - Later edits, deletions, splits and resolutions made through the root hooks use random IDs
 *   and supersede exactly the heads this computer observed.
 * - A lifecycle conflict (edit versus delete, split versus delete, two different splits) keeps
 *   the last agreed state: the record keeps counting and its split children do not, until an
 *   explicit resolution names the current heads. A conflicted value shows the last common value,
 *   falling back to the immutable snapshot when the alternatives share no revision.
 * - Records are never deleted: retired rows remain non-counting audit history, so invoice
 *   references and billed ranges on them are untouched.
 */

type Db<TSchema extends Record<string, unknown>> = BetterSQLite3Database<TSchema>
type Transaction = Parameters<SyncDomainAdapter['apply']>[0]
type Reader = Pick<Transaction, 'select'>
type Values = Record<string, JsonValue>

export type LegacyDisposition =
  | { kind: 'deleted' }
  | { kind: 'split'; splitAt: string; children: string[] }
  | { kind: 'adopted'; coverageHash: string | null }
  | { kind: 'replaced' }

export interface LegacyEditValues {
  startedAt: string
  endedAt: string
  durationMinutes: number
  description: string | null
  billable: boolean
  clientSyncId: string | null
  projectSyncId: string | null
}

export interface LegacyReference {
  entityType: 'client' | 'project'
  entityId: string
}

export interface LegacyEditState {
  view: RecordView
  /** Conflicted fields ($present/disposition included) and unavailable references. */
  blockers: string[]
  /** This computer journaled its own baseline (or found an identical one already applied). */
  localBaseline?: boolean
  restoresLocalHistory?: boolean
  projectionIssue?: { code: 'unexported-local-values' | 'invalid-times' }
}

export const LEGACY_EDIT_VALUE_FIELDS = [
  'startedAt',
  'endedAt',
  'durationMinutes',
  'description',
  'billable',
  'clientSyncId',
  'projectSyncId'
] as const
const LEGACY_EDIT_FIELDS = [...LEGACY_EDIT_VALUE_FIELDS, 'disposition'] as const
export const LEGACY_DISPOSITION_KINDS = ['deleted', 'split', 'adopted', 'replaced'] as const

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const COVERAGE_HASH = /^[0-9a-f]{64}$/
const VOCABULARY = /^[a-z][a-z0-9-]*$/
const MAX_DESCRIPTION = 20_000
const MAX_DURATION_MINUTES = 1_000_000
const MAX_SPLIT_CHILDREN = 16
const PLACEHOLDER_ID = '00000000-0000-8000-8000-000000000000'
const REFERENCES = [
  ['clientSyncId', 'client'],
  ['projectSyncId', 'project']
] as const

function malformed(message: string): never {
  throw new SyncError('SYNC_MALFORMED', message)
}

function invalid(message: string): never {
  throw new AppError('SYNC_INVALID_LEGACY_EDIT', message)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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

function isDisposition(value: unknown): boolean {
  if (value === null) return true
  if (!isObject(value)) return false
  const keys = Object.keys(value).sort().join()
  switch (value.kind) {
    case 'deleted':
    case 'replaced':
      return keys === 'kind'
    case 'adopted':
      return (
        keys === 'coverageHash,kind' &&
        (value.coverageHash === null ||
          (typeof value.coverageHash === 'string' && COVERAGE_HASH.test(value.coverageHash)))
      )
    case 'split': {
      const children = value.children
      return (
        keys === 'children,kind,splitAt' &&
        isTimestamp(value.splitAt) &&
        Array.isArray(children) &&
        children.length >= 2 &&
        children.length <= MAX_SPLIT_CHILDREN &&
        children.every(isSyncUuid) &&
        new Set(children).size === children.length
      )
    }
    default:
      return false
  }
}

const isNullableSyncId = (value: JsonValue): boolean => value === null || isSyncUuid(value)
const CHECKS: Record<string, (value: JsonValue) => boolean> = {
  startedAt: isTimestamp,
  endedAt: isTimestamp,
  durationMinutes: (value) =>
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= MAX_DURATION_MINUTES,
  description: isDescription,
  billable: (value) => typeof value === 'boolean',
  clientSyncId: isNullableSyncId,
  projectSyncId: isNullableSyncId,
  disposition: isDisposition
}

/** No defaults: the baseline writes every value explicitly. */
export const LEGACY_EDIT_SCHEMA: RecordSchema = Object.freeze({
  entityType: 'legacy-edit',
  fields: Object.freeze([...LEGACY_EDIT_FIELDS]),
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

function isBaseline(revision: ParsedRevision): boolean {
  return revision.fields.get(PRESENT)!.parents.length === 0
}

/** Structural and domain check without database access. */
export function validateLegacyEditChange(change: unknown): ParsedRevision {
  // A newer disposition kind pauses sync instead of reading as damage.
  const payload = isObject(change) && isObject(change.payload) ? change.payload : null
  const fieldsJson = payload && isObject(payload.fields) ? payload.fields : null
  const dispositionJson =
    fieldsJson && isObject(fieldsJson.disposition) ? fieldsJson.disposition : null
  const kind =
    dispositionJson && isObject(dispositionJson.value) ? dispositionJson.value.kind : undefined
  if (
    typeof kind === 'string' &&
    VOCABULARY.test(kind) &&
    !(LEGACY_DISPOSITION_KINDS as readonly string[]).includes(kind)
  )
    throw new SyncError(
      'SYNC_UPDATE_REQUIRED',
      `Shared history uses legacy disposition "${kind}"; update ClauTime to continue syncing`
    )
  let revision: ParsedRevision
  try {
    revision = readRevisionChange(change, LEGACY_EDIT_SCHEMA)
  } catch (error) {
    if (error instanceof RevisionError) malformed(error.message)
    throw error
  }
  const { id, entityId, fields } = revision
  if (!isSyncUuid(entityId)) malformed(`${id} must name a legacy UUID`)
  const present = fields.get(PRESENT)!
  if (isBaseline(revision)) {
    if (
      present.value !== true ||
      fields.size !== LEGACY_EDIT_FIELDS.length + 1 ||
      LEGACY_EDIT_FIELDS.some((field) => fields.get(field)?.parents.length !== 0) ||
      fields.get('disposition')!.value !== null
    )
      malformed(`${id}: a legacy baseline writes every field once and no disposition`)
  } else if ([...fields.values()].some((field) => !field.parents.length))
    malformed(`${id}: only the baseline writes a field without parents`)
  const disposition = fields.get('disposition')
  if (present.value === false && (!disposition || disposition.value === null))
    malformed(`${id}: retiring ${entityId} must name its disposition`)
  if (disposition && disposition.value !== null && present.value !== false)
    malformed(`${id}: a disposition retires the record`)
  if (fields.has('clientSyncId') !== fields.has('projectSyncId'))
    malformed(`${id} must write clientSyncId and projectSyncId together`)
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

function historyOf(db: Reader, workspaceId: string, legacyId: string): unknown[] {
  return db
    .select({ json: syncChanges.changeJson })
    .from(syncChanges)
    .where(
      and(
        eq(syncChanges.workspaceId, workspaceId),
        eq(syncChanges.entityType, 'legacy-edit'),
        eq(syncChanges.entityId, legacyId)
      )
    )
    .all()
    .map((row) => JSON.parse(row.json))
}

function hasLocalOrigin(db: Reader, workspaceId: string, legacyId: string): boolean {
  return !!db
    .select({ id: syncChanges.id })
    .from(syncChanges)
    .where(
      and(
        eq(syncChanges.workspaceId, workspaceId),
        eq(syncChanges.entityType, 'legacy-edit'),
        eq(syncChanges.entityId, legacyId),
        eq(syncChanges.origin, 'local')
      )
    )
    .get()
}

export function getLegacyEditView(db: Reader, workspaceId: string, legacyId: string): RecordView {
  return materializeRecord(LEGACY_EDIT_SCHEMA, legacyId, historyOf(db, workspaceId, legacyId))
}

export function readLegacyEditState(
  db: Reader,
  workspaceId: string,
  legacyId: string
): LegacyEditState | null {
  const row = db
    .select({ json: syncRecordStates.stateJson })
    .from(syncRecordStates)
    .where(
      and(
        eq(syncRecordStates.workspaceId, workspaceId),
        eq(syncRecordStates.entityType, 'legacy-edit'),
        eq(syncRecordStates.entityId, legacyId)
      )
    )
    .get()
  return row ? (JSON.parse(row.json) as LegacyEditState) : null
}

/** Records with a conflicted field or lifecycle, for the root's conflict UI. */
export function readLegacyEditConflicts(
  db: Reader,
  workspaceId: string
): Array<{ legacyId: string; state: LegacyEditState }> {
  return db
    .select({ entityId: syncRecordStates.entityId, json: syncRecordStates.stateJson })
    .from(syncRecordStates)
    .where(
      and(
        eq(syncRecordStates.workspaceId, workspaceId),
        eq(syncRecordStates.entityType, 'legacy-edit')
      )
    )
    .orderBy(syncRecordStates.entityId)
    .all()
    .map((row) => ({ legacyId: row.entityId, state: JSON.parse(row.json) as LegacyEditState }))
    .filter(({ state }) => state.view.conflicts.length > 0)
}

/** Whether this computer's own values for a native record are part of the shared history. */
export function localLegacyBaselineRecorded(
  db: Reader,
  workspaceId: string,
  legacyId: string
): boolean {
  return (
    hasLocalOrigin(db, workspaceId, legacyId) ||
    readLegacyEditState(db, workspaceId, legacyId)?.localBaseline === true
  )
}

/** Own lifecycle of one record, before split lineage is considered. */
export function ownLegacyLifecycle(view: RecordView): {
  state: 'missing' | 'present' | 'retired' | 'conflict'
  disposition: LegacyDisposition | null
} {
  if (view.lifecycle === 'missing') return { state: 'missing', disposition: null }
  if (view.conflicts.includes(PRESENT) || view.conflicts.includes('disposition'))
    return { state: 'conflict', disposition: null }
  if (view.lifecycle === 'deleted') {
    const value = view.fields.disposition?.value
    return {
      state: 'retired',
      disposition: isObject(value) ? (value as unknown as LegacyDisposition) : { kind: 'deleted' }
    }
  }
  return { state: 'present', disposition: null }
}

/** Agreed values, else the last common value, else the immutable snapshot. */
export function effectiveLegacyValues(
  view: RecordView,
  snapshot: PortableLegacySnapshot
): LegacyEditValues {
  const pick = <T>(field: keyof LegacyEditValues, fallback: T): T => {
    const value = view.fields[field]?.value
    return value === undefined ? fallback : (value as T)
  }
  return {
    startedAt: pick('startedAt', snapshot.startedAt),
    endedAt: pick('endedAt', snapshot.endedAt),
    durationMinutes: pick('durationMinutes', snapshot.durationMinutes),
    description: pick('description', snapshot.description),
    billable: pick('billable', snapshot.billable),
    clientSyncId: pick('clientSyncId', snapshot.clientSyncId),
    projectSyncId: pick('projectSyncId', snapshot.projectSyncId)
  }
}

// ── Local projection ──

function writeState(
  tx: Transaction,
  workspaceId: string,
  legacyId: string,
  state: LegacyEditState
): void {
  const json = JSON.stringify(state)
  tx.insert(syncRecordStates)
    .values({ workspaceId, entityType: 'legacy-edit', entityId: legacyId, stateJson: json })
    .onConflictDoUpdate({
      target: [
        syncRecordStates.workspaceId,
        syncRecordStates.entityType,
        syncRecordStates.entityId
      ],
      set: { stateJson: json }
    })
    .run()
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

/**
 * Writes the record's effective values onto its local row. A native row this computer has not
 * exported yet is never overwritten by another copy's values (a diverged clone, for example).
 * Lifecycle (non-counting state) belongs to folder-sync-legacy-records.
 */
export function projectLegacyEditValues(
  tx: Transaction,
  workspaceId: string,
  legacyId: string
): LegacyEditState | null {
  const snapshot = readLegacySnapshot(tx, workspaceId, legacyId)
  if (!snapshot) return null
  const previous = readLegacyEditState(tx, workspaceId, legacyId)
  const view = getLegacyEditView(tx, workspaceId, legacyId)
  const state: LegacyEditState = {
    view,
    blockers: [...view.conflicts],
    restoresLocalHistory:
      view.lifecycle === 'present' &&
      !view.conflicts.includes('disposition') &&
      historyOf(tx, workspaceId, legacyId).some(
        (change) =>
          readRevisionChange(change, LEGACY_EDIT_SCHEMA).fields.get(PRESENT)?.value === false
      ),
    ...(previous?.localBaseline ? { localBaseline: true } : {})
  }
  const local = tx
    .select({ sessionId: sessionLegacyRecords.sessionId, imported: syncLegacyImports.legacyId })
    .from(sessionLegacyRecords)
    .leftJoin(syncLegacyImports, eq(syncLegacyImports.legacyId, sessionLegacyRecords.id))
    .where(eq(sessionLegacyRecords.id, legacyId))
    .get()
  if (!local) {
    writeState(tx, workspaceId, legacyId, state)
    return state
  }
  if (!local.imported && !localLegacyBaselineRecorded(tx, workspaceId, legacyId)) {
    if (view.lifecycle !== 'missing') state.projectionIssue = { code: 'unexported-local-values' }
    writeState(tx, workspaceId, legacyId, state)
    return state
  }
  const values = effectiveLegacyValues(view, snapshot)
  const columns: Partial<Session> = {
    description: values.description,
    billable: values.billable ? 1 : 0
  }
  if (values.endedAt < values.startedAt) state.projectionIssue = { code: 'invalid-times' }
  else {
    columns.startedAt = values.startedAt
    columns.endedAt = values.endedAt
    columns.durationMinutes = values.durationMinutes
  }
  for (const [field, entityType] of REFERENCES) {
    const syncId = values[field]
    const id = syncId === null ? null : resolveReference(tx, workspaceId, entityType, syncId)
    if (syncId !== null && id === null) state.blockers.push(`${field}:unavailable`)
    else if (entityType === 'client') columns.clientId = id
    else columns.projectId = id
  }
  const row = tx.select().from(sessions).where(eq(sessions.id, local.sessionId)).get()
  if (row) {
    const current = row as unknown as Record<string, unknown>
    const changed = Object.fromEntries(
      Object.entries(columns).filter(
        ([column, value]) => !sameColumn(column, current[column], value)
      )
    )
    if (Object.keys(changed).length)
      tx.update(sessions)
        .set({ ...changed, updatedAt: new Date().toISOString() })
        .where(eq(sessions.id, local.sessionId))
        .run()
  }
  writeState(tx, workspaceId, legacyId, state)
  return state
}

/** Journal hook: this computer's baseline is now shared, so its row follows the record. */
export function markLocalLegacyBaseline(
  tx: Transaction,
  workspaceId: string,
  legacyId: string
): void {
  const state = readLegacyEditState(tx, workspaceId, legacyId) ?? {
    view: getLegacyEditView(tx, workspaceId, legacyId),
    blockers: []
  }
  writeState(tx, workspaceId, legacyId, { ...state, localBaseline: true })
  projectLegacyEditValues(tx, workspaceId, legacyId)
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

/**
 * Store hook body, called after the change is inserted into sync_changes. Checks parents, the
 * legacy fact, directory references and split children against applied changes, then projects
 * values. The caller (legacyRecordsAdapter) refreshes lifecycle and the queue afterwards.
 */
export function applyLegacyEditChange(tx: Transaction, workspaceId: string, change: unknown): void {
  const revision = validateLegacyEditChange(change)
  const lookup = (id: string): unknown => appliedChange(tx, workspaceId, id)
  if (lookup(revision.id) === undefined)
    malformed(`Record ${revision.id} in sync_changes before applying it`)
  try {
    const missing = checkRevision(change, LEGACY_EDIT_SCHEMA, lookup)
    if (missing.length)
      throw new AppError(
        'SYNC_MISSING_DEPENDENCY',
        `${revision.id} waits for ${missing.join(', ')}`
      )
  } catch (error) {
    if (error instanceof RevisionError) malformed(error.message)
    throw error
  }
  const factId = syncFactChangeId(workspaceId, 'legacy-session', revision.entityId)
  const allowed = new Set([...revision.fields.values()].flatMap((field) => field.parents))
  if (isBaseline(revision)) {
    if (!revision.dependencies.includes(factId))
      malformed(`${revision.id} must depend on legacy snapshot ${revision.entityId}`)
    allowed.add(factId)
  }
  if (lookup(factId) === undefined)
    throw new AppError('SYNC_MISSING_DEPENDENCY', `${revision.id} waits for its legacy snapshot`)
  for (const [field, entityType] of REFERENCES) {
    const syncId = revision.fields.get(field)?.value
    if (typeof syncId !== 'string') continue
    requireDirectoryDependency(lookup, revision, entityType, syncId)
    for (const id of revision.dependencies) {
      const dependency = lookup(id) as Partial<RevisionChange> | undefined
      if (dependency?.entityType === entityType && dependency.entityId === syncId) allowed.add(id)
    }
  }
  const disposition = revision.fields.get('disposition')?.value
  if (isObject(disposition) && disposition.kind === 'split') {
    for (const child of disposition.children as string[]) {
      const childFactId = syncFactChangeId(workspaceId, 'legacy-session', child)
      if (!revision.dependencies.includes(childFactId))
        malformed(`${revision.id} must depend on split child ${child}`)
      const childFact = lookup(childFactId) as { payload?: { splitFrom?: unknown } } | undefined
      if (!childFact)
        throw new AppError('SYNC_MISSING_DEPENDENCY', `${revision.id} waits for ${child}`)
      if (childFact.payload?.splitFrom !== revision.entityId)
        malformed(`${revision.id}: ${child} was not split from ${revision.entityId}`)
      allowed.add(childFactId)
    }
  }
  const unexpected = revision.dependencies.find((id) => !allowed.has(id))
  if (unexpected) malformed(`${revision.id} has an unexpected dependency ${unexpected}`)
  projectLegacyEditValues(tx, workspaceId, revision.entityId)
}

// ── Planning ──

function directoryDependencies(
  db: Reader,
  workspaceId: string,
  values: Partial<LegacyEditValues>,
  requires?: LegacyReference[]
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
        `Export ${entityType} ${syncId} before assigning legacy history to it`
      )
  }
  return dependencies
}

function checked(change: RevisionChange, history: readonly unknown[]): RevisionChange {
  try {
    validateLegacyEditChange(change)
    // Rejects a parent that did not write the field it is named for.
    materializeRecord(LEGACY_EDIT_SCHEMA, change.entityId, [...history, change])
    return change
  } catch (error) {
    if (error instanceof RevisionError || error instanceof SyncError) invalid(error.message)
    throw error
  }
}

function planned(plan: Parameters<typeof planRevision>[0]): RevisionChange {
  try {
    return checked(planRevision(plan), plan.history)
  } catch (error) {
    if (error instanceof RevisionError) invalid(error.message)
    throw error
  }
}

/** $present false plus the disposition, superseding exactly the observed heads of both. */
function retirement(
  id: string,
  legacyId: string,
  history: readonly unknown[],
  observedHeads: HeadsByField,
  disposition: LegacyDisposition,
  dependencies: readonly string[] = []
): RevisionChange {
  let base: RevisionChange
  try {
    base = planRevision({
      id,
      schema: LEGACY_EDIT_SCHEMA,
      entityId: legacyId,
      history,
      action: { type: 'delete', observedHeads },
      dependencies
    })
  } catch (error) {
    if (error instanceof RevisionError) invalid(error.message)
    throw error
  }
  const parents = [...(observedHeads.disposition ?? [])].sort()
  if (!parents.length) invalid(`Observed heads for disposition of ${legacyId} are required`)
  return checked(
    {
      ...base,
      dependencies: [...new Set([...base.dependencies, ...parents])].sort(),
      payload: {
        fields: {
          ...base.payload.fields,
          disposition: { value: disposition as unknown as JsonValue, parents }
        }
      }
    },
    history
  )
}

/** Portable current values of a local row; null when times are ambiguous or unexportable. */
export function portableLegacyValues(
  db: Reader,
  row: Session,
  options: { assumeUtc?: boolean } = {}
): { values: LegacyEditValues } | { withheld: 'timezone-naive' | 'reference-missing' } {
  const startedAt = portableInstant(row.startedAt, options.assumeUtc)
  const endedAt = portableInstant(row.endedAt, options.assumeUtc)
  if (!startedAt || !endedAt) return { withheld: 'timezone-naive' }
  const clientSyncId = row.clientId === null ? null : getPortableClientId(db, row.clientId)
  const projectSyncId = row.projectId === null ? null : getPortableProjectId(db, row.projectId)
  if ((row.clientId !== null && !clientSyncId) || (row.projectId !== null && !projectSyncId))
    return { withheld: 'reference-missing' }
  return {
    values: {
      startedAt,
      endedAt,
      durationMinutes: row.durationMinutes,
      description: row.description?.trim() ? row.description : null,
      billable: !!row.billable,
      clientSyncId,
      projectSyncId
    }
  }
}

export type LegacyEditBootstrap =
  | { status: 'ready'; changes: RevisionChange[] }
  | { status: 'has-history' }
  | { status: 'requires'; requires: LegacyReference[] }

/**
 * Initial export of one native record: a content-derived baseline of its current values and, for
 * a deletion/split/adoption that already happened, a content-derived retirement of that baseline.
 * `retire.dependencies` carries the split children's legacy facts.
 */
export function planLegacyEditBaseline(
  db: Reader,
  workspaceId: string,
  legacyId: string,
  values: LegacyEditValues,
  retire: { disposition: LegacyDisposition; dependencies: string[] } | null = null
): LegacyEditBootstrap {
  if (localLegacyBaselineRecorded(db, workspaceId, legacyId)) return { status: 'has-history' }
  const requires: LegacyReference[] = []
  const references = directoryDependencies(db, workspaceId, values, requires)
  if (requires.length) return { status: 'requires', requires }
  const baseline = planned({
    id: PLACEHOLDER_ID,
    schema: LEGACY_EDIT_SCHEMA,
    entityId: legacyId,
    history: [],
    action: { type: 'create', values: { ...values, disposition: null } as unknown as Values },
    dependencies: [syncFactChangeId(workspaceId, 'legacy-session', legacyId), ...references]
  })
  baseline.id = bodyId('clautime-legacy-edit-baseline-1', workspaceId, baseline)
  const changes = [baseline]
  if (retire) {
    const history = [baseline]
    const change = retirement(
      PLACEHOLDER_ID,
      legacyId,
      history,
      materializeRecord(LEGACY_EDIT_SCHEMA, legacyId, history).heads,
      retire.disposition,
      retire.dependencies
    )
    change.id = bodyId('clautime-legacy-edit-baseline-1', workspaceId, change)
    changes.push(change)
  }
  // Journaling applied IDs again is harmless; it also marks an identical clone baseline local.
  return { status: 'ready', changes }
}

/**
 * A later local edit, deletion or resolution (random change ID unless given). Edits supersede
 * the observed heads; deletion names a disposition; resolve must name the exact current heads.
 */
export function planLegacyEditRevision(
  db: Reader,
  workspaceId: string,
  request: {
    id?: string
    legacyId: string
    action: RevisionAction
    disposition?: LegacyDisposition
  }
): RevisionChange {
  const id = request.id ?? randomUUID()
  const { legacyId, action } = request
  const history = historyOf(db, workspaceId, legacyId)
  const view = materializeRecord(LEGACY_EDIT_SCHEMA, legacyId, history)
  if (action.type === 'delete')
    return retirement(
      id,
      legacyId,
      history,
      { ...view.heads, ...action.observedHeads },
      request.disposition ?? { kind: 'deleted' }
    )
  if (action.type === 'create') invalid('Legacy history is created by its baseline export only')
  const values: Values = { ...(action.values ?? {}) }
  const editable = action.type === 'edit' ? LEGACY_EDIT_VALUE_FIELDS : LEGACY_EDIT_FIELDS
  const unknown = Object.keys(values).find(
    (field) => !(editable as readonly string[]).includes(field)
  )
  if (unknown !== undefined) invalid(`Cannot write legacy field ${unknown}`)
  if (Object.hasOwn(values, 'clientSyncId') !== Object.hasOwn(values, 'projectSyncId'))
    invalid('Assign a client and project together')
  let expectedHeads: HeadsByField | undefined
  if (action.type === 'resolve') {
    const present = action.present ?? view.present.value
    if (present === false && (values.disposition === undefined || values.disposition === null))
      values.disposition = (request.disposition ??
        ownLegacyLifecycle(view).disposition ?? { kind: 'deleted' }) as unknown as JsonValue
    if (
      present === true &&
      !Object.hasOwn(values, 'disposition') &&
      view.fields.disposition.heads.some((head) => head.value !== null)
    )
      values.disposition = null
    // The disposition is implied by the lifecycle choice; its heads come from the same view.
    expectedHeads = Object.hasOwn(values, 'disposition')
      ? { disposition: view.heads.disposition, ...action.expectedHeads }
      : action.expectedHeads
  }
  return planned({
    id,
    schema: LEGACY_EDIT_SCHEMA,
    entityId: legacyId,
    history,
    action:
      action.type === 'resolve'
        ? { ...action, expectedHeads: expectedHeads!, values }
        : { ...action, values },
    dependencies: [
      ...directoryDependencies(db, workspaceId, values as Partial<LegacyEditValues>),
      ...(isObject(values.disposition) && values.disposition.kind === 'split'
        ? (values.disposition.children as string[]).map((child) =>
            syncFactChangeId(workspaceId, 'legacy-session', child)
          )
        : [])
    ]
  })
}

// ── Root hooks (called by session-service inside the mutation's transaction) ──

export type LegacyHookResult =
  | { status: 'journaled'; changeIds: string[] }
  | { status: 'unchanged' | 'not-legacy' | 'not-exported' }
  | { status: 'conflict'; message: string; conflicts: string[] }
  | { status: 'withheld'; reason: string }
  | { status: 'requires'; requires: LegacyReference[] }

/**
 * Keep-all planning for only the conversations of these records' snapshots, applied or planned
 * in `changes`: a local edit, deletion or split cannot change another conversation's overlaps.
 */
function affectedOrigin(
  db: Reader,
  workspaceId: string,
  legacyIds: readonly string[],
  changes: readonly SyncChange[] = []
): LegacyJournalOptions {
  const origin = new Map<string, { provider: string; conversationId: string }>()
  const add = (provider: unknown, conversationId: unknown) => {
    if (typeof provider === 'string' && typeof conversationId === 'string')
      origin.set(JSON.stringify([provider, conversationId]), { provider, conversationId })
  }
  for (const legacyId of legacyIds) {
    const snapshot = readLegacySnapshot(db, workspaceId, legacyId)
    if (snapshot) add(snapshot.provider, snapshot.conversationId)
  }
  for (const change of changes)
    if (change.entityType === 'legacy-session')
      add(change.payload.provider, change.payload.conversationId)
  return { origin: [...origin.values()] }
}

function legacyOfSession(db: Reader, sessionId: number) {
  return db
    .select()
    .from(sessionLegacyRecords)
    .where(eq(sessionLegacyRecords.sessionId, sessionId))
    .get()
}

/** Restored rows follow shared history; native rows once this computer's baseline is shared. */
function isShared(db: Reader, workspaceId: string, legacyId: string): boolean {
  if (!readLegacySnapshot(db, workspaceId, legacyId)) return false
  const imported = db
    .select({ id: syncLegacyImports.legacyId })
    .from(syncLegacyImports)
    .where(eq(syncLegacyImports.legacyId, legacyId))
    .get()
  return imported
    ? getLegacyEditView(db, workspaceId, legacyId).lifecycle !== 'missing'
    : localLegacyBaselineRecorded(db, workspaceId, legacyId)
}

function sameValue(field: keyof LegacyEditValues, left: unknown, right: unknown): boolean {
  if (field === 'startedAt' || field === 'endedAt')
    return Date.parse(left as string) === Date.parse(right as string)
  return left === right
}

/**
 * After a local edit of a legacy row (description, billable, client/project, times): journals the
 * difference from the shared view as a causal edit of the heads this computer displayed.
 * A locally deleted row is journaled as a deletion instead.
 */
export function afterLocalLegacyMutation<TSchema extends Record<string, unknown>>(
  db: Db<TSchema>,
  workspaceId: string,
  sessionId: number,
  id: string = randomUUID()
): LegacyHookResult {
  const legacy = legacyOfSession(db, sessionId)
  if (!legacy) return { status: 'not-legacy' }
  if (
    db.select().from(sessionDeletions).where(eq(sessionDeletions.sessionId, sessionId)).get() &&
    !readLegacyEditState(db, workspaceId, legacy.id)?.restoresLocalHistory
  )
    return afterLocalLegacyDeletion(db, workspaceId, sessionId, id)
  const snapshot = readLegacySnapshot(db, workspaceId, legacy.id)
  if (!snapshot || !isShared(db, workspaceId, legacy.id)) return { status: 'not-exported' }
  const row = db.select().from(sessions).where(eq(sessions.id, sessionId)).get()
  if (!row) return { status: 'not-legacy' }
  const current = portableLegacyValues(db, row)
  if ('withheld' in current) return { status: 'withheld', reason: current.withheld }
  const view = getLegacyEditView(db, workspaceId, legacy.id)
  const shared = effectiveLegacyValues(view, snapshot)
  const values: Partial<LegacyEditValues> = {}
  for (const field of LEGACY_EDIT_VALUE_FIELDS)
    if (!sameValue(field, current.values[field], shared[field]))
      (values as Record<string, unknown>)[field] = current.values[field]
  if (Object.hasOwn(values, 'clientSyncId') || Object.hasOwn(values, 'projectSyncId')) {
    values.clientSyncId = current.values.clientSyncId
    values.projectSyncId = current.values.projectSyncId
  }
  if (!Object.keys(values).length) return { status: 'unchanged' }
  let change: RevisionChange
  try {
    change = planLegacyEditRevision(db, workspaceId, {
      id,
      legacyId: legacy.id,
      action: { type: 'edit', observedHeads: view.heads, values: values as unknown as Values }
    })
  } catch (error) {
    if (error instanceof AppError && error.code === 'SYNC_INVALID_LEGACY_EDIT')
      return { status: 'conflict', message: error.message, conflicts: view.conflicts }
    throw error
  }
  return {
    status: 'journaled',
    changeIds: journalLegacySyncChanges(
      db,
      workspaceId,
      [change as unknown as SyncChange],
      affectedOrigin(db, workspaceId, [legacy.id])
    )
  }
}

/** After a local "Delete from history" of a legacy row. */
export function afterLocalLegacyDeletion<TSchema extends Record<string, unknown>>(
  db: Db<TSchema>,
  workspaceId: string,
  sessionId: number,
  id: string = randomUUID()
): LegacyHookResult {
  const legacy = legacyOfSession(db, sessionId)
  if (!legacy) return { status: 'not-legacy' }
  if (!isShared(db, workspaceId, legacy.id)) return { status: 'not-exported' }
  const view = getLegacyEditView(db, workspaceId, legacy.id)
  if (view.lifecycle === 'deleted') return { status: 'unchanged' }
  if (view.lifecycle !== 'present')
    return {
      status: 'conflict',
      message: 'This legacy history has a conflicting lifecycle; resolve it first.',
      conflicts: view.conflicts
    }
  const change = planLegacyEditRevision(db, workspaceId, {
    id,
    legacyId: legacy.id,
    action: { type: 'delete', observedHeads: view.heads }
  })
  return {
    status: 'journaled',
    changeIds: journalLegacySyncChanges(
      db,
      workspaceId,
      [change as unknown as SyncChange],
      affectedOrigin(db, workspaceId, [legacy.id])
    )
  }
}

/**
 * After a local split of a legacy row (session_splits.legacy_record_id): exports both child
 * snapshots and baselines, then retires the parent with the exact heads this computer observed.
 * Nothing is journaled unless every part can be exported; the local split itself stands.
 */
export function afterLocalLegacySplit<TSchema extends Record<string, unknown>>(
  db: Db<TSchema>,
  workspaceId: string,
  parentSessionId: number,
  id: string = randomUUID(),
  currentSplit?: {
    legacyRecordId: string
    firstSessionId: number
    secondSessionId: number
    splitAt: string
  }
): LegacyHookResult {
  const split =
    currentSplit ??
    db.select().from(sessionSplits).where(eq(sessionSplits.parentSessionId, parentSessionId)).get()
  if (!split?.legacyRecordId) return { status: 'not-legacy' }
  const parentId = split.legacyRecordId
  if (!isShared(db, workspaceId, parentId)) return { status: 'not-exported' }
  const view = getLegacyEditView(db, workspaceId, parentId)
  if (view.lifecycle !== 'present')
    return {
      status: 'conflict',
      message: 'This legacy history has a conflicting lifecycle; resolve it first.',
      conflicts: view.conflicts
    }
  const children = [split.firstSessionId, split.secondSessionId].map((sessionId) =>
    legacyOfSession(db, sessionId)
  )
  if (children.some((child) => !child))
    return { status: 'withheld', reason: 'split-children-unavailable' }
  const childIds = children.map((child) => child!.id)
  const facts = planLegacySnapshotFacts(db, workspaceId, childIds)
  if (facts.withheld.length) return { status: 'withheld', reason: facts.withheld[0].reason }
  const changes: SyncChange[] = [...facts.changes]
  for (const child of children) {
    const row = db.select().from(sessions).where(eq(sessions.id, child!.sessionId)).get()!
    const current = portableLegacyValues(db, row)
    if ('withheld' in current) return { status: 'withheld', reason: current.withheld }
    const plan = planLegacyEditBaseline(db, workspaceId, child!.id, current.values)
    if (plan.status === 'requires') return plan
    if (plan.status === 'ready') changes.push(...(plan.changes as unknown as SyncChange[]))
  }
  const splitAt = portableInstant(split.splitAt)
  if (!splitAt) return { status: 'withheld', reason: 'timezone-naive' }
  const retire = retirement(
    id,
    parentId,
    historyOf(db, workspaceId, parentId),
    view.heads,
    { kind: 'split', splitAt, children: childIds },
    childIds.map((child) => syncFactChangeId(workspaceId, 'legacy-session', child))
  )
  changes.push(retire as unknown as SyncChange)
  return {
    status: 'journaled',
    changeIds: journalLegacySyncChanges(
      db,
      workspaceId,
      changes,
      affectedOrigin(db, workspaceId, [parentId, ...childIds], changes)
    )
  }
}

/**
 * Explicit resolution of a conflicted legacy record: `expectedHeads` must be the current heads of
 * every field written ($present included when choosing the lifecycle). present false keeps it
 * deleted (or names `disposition`), present true restores it.
 */
export function resolveLegacyEditConflict<TSchema extends Record<string, unknown>>(
  db: Db<TSchema>,
  workspaceId: string,
  request: {
    legacyId: string
    expectedHeads: HeadsByField
    values?: Partial<LegacyEditValues>
    present?: boolean
    disposition?: LegacyDisposition
    id?: string
  }
): string[] {
  const change = planLegacyEditRevision(db, workspaceId, {
    id: request.id,
    legacyId: request.legacyId,
    disposition: request.disposition,
    action: {
      type: 'resolve',
      expectedHeads: request.expectedHeads,
      values: (request.values ?? {}) as unknown as Values,
      ...(request.present === undefined ? {} : { present: request.present })
    }
  })
  return journalLegacySyncChanges(db, workspaceId, [change as unknown as SyncChange])
}
