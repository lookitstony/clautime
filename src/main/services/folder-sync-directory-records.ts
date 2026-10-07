import { createHash } from 'node:crypto'
import { and, eq, inArray, ne } from 'drizzle-orm'
import { clients, type ClientRow } from '../db/schema/clients'
import { projects, type ProjectRow } from '../db/schema/projects'
import { sessions } from '../db/schema/sessions'
import { activeSessionCondition } from '../db/schema/session-deletions'
import { syncChanges, syncRecordStates } from '../db/schema/folder-sync'
import { AppError } from '../../shared/types/ipc'
import { isSyncUuid } from './folder-sync-protocol'
import type { SyncDomainAdapter } from './folder-sync-store'
import {
  UNASSIGNED_CLIENT_ROLE,
  UNASSIGNED_CLIENT_SYNC_ID,
  findClientByPortableId,
  findProjectByPortableId,
  portableIdOfClientRow,
  portableIdOfProjectRow
} from './folder-sync-builtin-client'
import { isJoinReviewPending } from './folder-sync-identity-links'
import {
  PRESENT,
  RevisionError,
  checkRevision,
  materializeRecord,
  planRevision,
  readRevisionChange,
  type JsonValue,
  type ParsedRevision,
  type RecordSchema,
  type RecordView,
  type RevisionAction,
  type RevisionChange
} from './folder-sync-revisions'

/*
 * Portable client/project records (folder-sync-plan.md decisions E and H).
 *
 * Only the allowlisted fields below leave this computer. Local integer IDs, directory paths,
 * folder mappings, Stripe customer IDs and settings are never exported; a remote project arrives
 * with no path and no folder mapping. Business rows are projections of the causal view, matched
 * by syncId: local IDs and createdAt are preserved, unlisted columns are never reset, deletion
 * only deactivates, and anything that cannot be projected safely is held with a visible
 * projectionIssue instead of merging identities or guessing a value.
 *
 * Client entity IDs are portable IDs (folder-sync-builtin-client.ts): the built-in Unassigned
 * client travels under a reserved UUID and maps to this computer's role row, whatever its syncId.
 * A row explicitly linked during join review (folder-sync-identity-links.ts) is the projection
 * of its shared record. While that review is pending, shared records with no local row are not
 * inserted and never-exported local rows are not bootstrapped.
 */

type Transaction = Parameters<SyncDomainAdapter['apply']>[0]
type Reader = Pick<Transaction, 'select'>
type Values = Record<string, JsonValue>

export const DIRECTORY_ENTITY_TYPES = ['client', 'project'] as const
export type DirectoryEntityType = (typeof DIRECTORY_ENTITY_TYPES)[number]

export interface DirectoryReference {
  entityType: DirectoryEntityType
  entityId: string
}

export type PortableClient = {
  name: string
  stageName: string | null
  color: string
  billableRate: number | null
  email: string | null
  isActive: boolean
}

export type PortableProject = {
  clientSyncId: string
  name: string
  invoiceName: string | null
  stageName: string | null
  hourlyRate: number | null
  rootCommit: string | null
  isBillable: boolean
  isActive: boolean
}

export type ProjectionIssue =
  /** Another local client already holds this name; identities are never merged implicitly. */
  | { code: 'name-collision'; conflictingSyncId: string }
  /** The referenced client has no local row (it is itself held). */
  | { code: 'client-unavailable'; clientSyncId: string }
  /** A new row needs a value that is conflicted without an agreed common value. */
  | { code: 'unresolved-field'; fields: string[] }
  /** A pre-existing local row differs and was never exported; bootstrap it to compete. */
  | { code: 'unexported-local-values' }
  /** Held until the join review links a local row to it or keeps local rows separate. */
  | { code: 'join-review-pending' }

/** Persisted in sync_record_states.state_json. */
export interface DirectoryRecordState {
  view: RecordView
  projectionIssue?: ProjectionIssue
}

const MAX_TEXT = 200
const MAX_EMAIL = 320
const MAX_RATE = 1_000_000
// One or more sorted SHA-1/SHA-256 commit hashes separated by spaces.
const ROOT_COMMITS = /^[0-9a-f]{40}(?:[0-9a-f]{24})?(?: [0-9a-f]{40}(?:[0-9a-f]{24})?)*$/
const COLOR = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|var\(--[a-z0-9-]{1,40}\))$/i
// Stands in for the derived bootstrap ID while the change body is planned.
const PLACEHOLDER_ID = '00000000-0000-8000-8000-000000000000'

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

const text =
  (max: number) =>
  (value: JsonValue): boolean =>
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= max &&
    value.isWellFormed() &&
    !hasControlCharacter(value)
const optional =
  (check: (value: JsonValue) => boolean) =>
  (value: JsonValue): boolean =>
    value === null || check(value)
const isRate = (value: JsonValue): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_RATE
const isBoolean = (value: JsonValue): boolean => typeof value === 'boolean'

function validator(
  checks: Record<string, (value: JsonValue) => boolean>
): RecordSchema['validate'] {
  return (field, value) => Object.hasOwn(checks, field) && checks[field](value)
}

export const CLIENT_SYNC_SCHEMA: RecordSchema = Object.freeze({
  entityType: 'client',
  fields: Object.freeze(['name', 'stageName', 'color', 'billableRate', 'email', 'isActive']),
  defaults: Object.freeze({ stageName: null, billableRate: null, email: null, isActive: true }),
  validate: validator({
    name: text(MAX_TEXT),
    stageName: optional(text(MAX_TEXT)),
    color: (value) => typeof value === 'string' && COLOR.test(value),
    billableRate: optional(isRate),
    email: optional(text(MAX_EMAIL)),
    isActive: isBoolean
  })
})

export const PROJECT_SYNC_SCHEMA: RecordSchema = Object.freeze({
  entityType: 'project',
  fields: Object.freeze([
    'clientSyncId',
    'name',
    'invoiceName',
    'stageName',
    'hourlyRate',
    'rootCommit',
    'isBillable',
    'isActive'
  ]),
  defaults: Object.freeze({
    invoiceName: null,
    stageName: null,
    hourlyRate: null,
    rootCommit: null,
    isBillable: true,
    isActive: true
  }),
  validate: validator({
    clientSyncId: isSyncUuid,
    name: text(MAX_TEXT),
    invoiceName: optional(text(MAX_TEXT)),
    stageName: optional(text(MAX_TEXT)),
    hourlyRate: optional(isRate),
    rootCommit: optional(isPortableRootCommit),
    isBillable: isBoolean,
    isActive: isBoolean
  })
})

/** Sorted root commit hashes as synced; also caps what git output is recorded. */
export function isPortableRootCommit(value: JsonValue): boolean {
  return typeof value === 'string' && value.length <= 1000 && ROOT_COMMITS.test(value)
}

function invalid(message: string): never {
  throw new AppError('SYNC_INVALID_DIRECTORY_CHANGE', message)
}

export function isDirectoryEntityType(value: unknown): value is DirectoryEntityType {
  return (DIRECTORY_ENTITY_TYPES as readonly unknown[]).includes(value)
}

export function directorySchema(entityType: unknown): RecordSchema {
  if (entityType === 'client') return CLIENT_SYNC_SCHEMA
  if (entityType === 'project') return PROJECT_SYNC_SCHEMA
  return invalid(`${String(entityType)} is not a client or project`)
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** Structural and domain check without database access. Facts are never accepted. */
export function validateDirectoryChange(change: unknown): ParsedRevision {
  const entityType = (change as { entityType?: unknown } | null)?.entityType
  const schema = directorySchema(entityType)
  const revision = readRevisionChange(change, schema)
  if (!isSyncUuid(revision.entityId)) invalid(`${revision.id} must name a ${entityType} syncId`)
  const present = revision.fields.get(PRESENT)!
  if (!present.parents.length) {
    if (present.value !== true) invalid(`${revision.id} must create ${revision.entityId}`)
    // A field added within protocol 1 (rootCommit) has a default: older creates omit it.
    const missing = schema.fields.filter(
      (field) => !revision.fields.has(field) && !Object.hasOwn(schema.defaults ?? {}, field)
    )
    if (missing.length)
      invalid(`${revision.id} creates ${entityType} without ${missing.join(', ')}`)
  }
  if (revision.fields.has('clientSyncId')) {
    const parents = new Set([...revision.fields.values()].flatMap((field) => field.parents))
    if (revision.dependencies.every((id) => parents.has(id)))
      invalid(`${revision.id} must depend on a revision of its client`)
  }
  return revision
}

function appliedChange(db: Reader, workspaceId: string, id: string): unknown {
  const row = db
    .select({ json: syncChanges.changeJson })
    .from(syncChanges)
    .where(and(eq(syncChanges.workspaceId, workspaceId), eq(syncChanges.id, id)))
    .get()
  return row ? JSON.parse(row.json) : undefined
}

function historyOf(
  db: Reader,
  workspaceId: string,
  entityType: DirectoryEntityType,
  entityId: string
): unknown[] {
  return db
    .select({ json: syncChanges.changeJson })
    .from(syncChanges)
    .where(
      and(
        eq(syncChanges.workspaceId, workspaceId),
        eq(syncChanges.entityType, entityType),
        eq(syncChanges.entityId, entityId)
      )
    )
    .all()
    .map((row) => JSON.parse(row.json))
}

function hasLocalOrigin(
  db: Reader,
  workspaceId: string,
  entityType: DirectoryEntityType,
  entityId: string
): boolean {
  return !!db
    .select({ id: syncChanges.id })
    .from(syncChanges)
    .where(
      and(
        eq(syncChanges.workspaceId, workspaceId),
        eq(syncChanges.entityType, entityType),
        eq(syncChanges.entityId, entityId),
        eq(syncChanges.origin, 'local')
      )
    )
    .get()
}

/** The authoritative causal view from applied changes (lifecycle 'missing' without history). */
export function getDirectoryRecordView(
  db: Reader,
  workspaceId: string,
  entityType: DirectoryEntityType,
  entityId: string
): RecordView {
  return materializeRecord(
    directorySchema(entityType),
    entityId,
    historyOf(db, workspaceId, entityType, entityId)
  )
}

/** The persisted view plus any reason the business row is not (fully) projected. */
export function readDirectoryRecordState(
  db: Reader,
  workspaceId: string,
  entityType: DirectoryEntityType,
  entityId: string
): DirectoryRecordState | null {
  const row = db
    .select({ json: syncRecordStates.stateJson })
    .from(syncRecordStates)
    .where(
      and(
        eq(syncRecordStates.workspaceId, workspaceId),
        eq(syncRecordStates.entityType, entityType),
        eq(syncRecordStates.entityId, entityId)
      )
    )
    .get()
  return row ? (JSON.parse(row.json) as DirectoryRecordState) : null
}

// ── Read-only portable projections of existing rows ──

export function portableClientValues(row: ClientRow): PortableClient {
  return {
    name: row.name,
    stageName: row.stageName ?? null,
    color: row.color,
    billableRate: row.billableRate ?? null,
    email: row.email ?? null,
    isActive: row.isActive
  }
}

export function portableProjectValues(db: Reader, row: ProjectRow): PortableProject {
  const client = db
    .select({ id: clients.id, syncId: clients.syncId, systemRole: clients.systemRole })
    .from(clients)
    .where(eq(clients.id, row.clientId))
    .get()
  if (!client) throw new AppError('CLIENT_NOT_FOUND', `Client of project ${row.syncId} not found`)
  return {
    clientSyncId: portableIdOfClientRow(db, client),
    name: row.name,
    invoiceName: row.invoiceName ?? null,
    stageName: row.stageName ?? null,
    hourlyRate: row.hourlyRate ?? null,
    rootCommit: row.rootCommit ?? null,
    isBillable: row.isBillable,
    isActive: row.isActive
  }
}

// ── Planning local revisions ──

/** Current client heads, from applied history plus not-yet-recorded planned changes. */
function clientHeads(
  db: Reader,
  workspaceId: string,
  clientSyncId: string,
  pending: readonly RevisionChange[]
): string[] {
  const history = [
    ...historyOf(db, workspaceId, 'client', clientSyncId),
    ...pending.filter(
      (change) => change.entityType === 'client' && change.entityId === clientSyncId
    )
  ]
  if (!history.length) return []
  return materializeRecord(CLIENT_SYNC_SCHEMA, clientSyncId, history).heads[PRESENT]
}

export interface DirectoryRevisionRequest {
  /** New random change ID. */
  id: string
  entityType: DirectoryEntityType
  /** The record's syncId. */
  entityId: string
  /** Edits/deletes pass observedHeads, resolutions/restores expectedHeads, from the current view. */
  action: RevisionAction
}

/**
 * Plans a local create/edit/delete/resolve against the record's applied history. Assigning a
 * client adds that client's current heads as explicit dependencies; an unexported client is an
 * error rather than an invented record. Record the result with recordLocalSyncChanges.
 */
export function planDirectoryRevision(
  db: Reader,
  workspaceId: string,
  request: DirectoryRevisionRequest
): RevisionChange {
  const { id, entityType, entityId, action } = request
  const schema = directorySchema(entityType)
  const values = action.type === 'delete' ? undefined : action.values
  let dependencies: string[] = []
  if (entityType === 'project' && values && Object.hasOwn(values, 'clientSyncId')) {
    const clientSyncId = values.clientSyncId
    if (!isSyncUuid(clientSyncId)) invalid('Projects reference clients by syncId')
    dependencies = clientHeads(db, workspaceId, clientSyncId, [])
    if (!dependencies.length)
      throw new AppError(
        'SYNC_REFERENCE_UNAVAILABLE',
        `Export client ${clientSyncId} before assigning projects to it`
      )
  }
  const change = planRevision({
    id,
    schema,
    entityId,
    history: historyOf(db, workspaceId, entityType, entityId),
    action,
    dependencies
  })
  validateDirectoryChange(change)
  return change
}

export type DirectoryBootstrap =
  | { status: 'ready'; change: RevisionChange }
  /** Already has this computer's causal history; plan edits with planDirectoryRevision. */
  | { status: 'has-history' }
  | { status: 'requires'; requires: DirectoryReference[] }
  | { status: 'not-found' }
  /** Never exported, and the join review has not decided its identity yet. */
  | { status: 'join-review-pending' }

/** Version 8 UUID over the workspace and complete change body, so exact clones dedupe. */
function bootstrapChangeId(workspaceId: string, body: Omit<RevisionChange, 'id'>): string {
  const hex = createHash('sha256')
    .update(canonical({ purpose: 'clautime-directory-bootstrap-1', workspaceId, body }))
    .digest('hex')
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/**
 * Plans the initial root revision of an existing local row. Identical rows on cloned databases
 * produce the identical change; differing pre-sync values produce competing roots, which the
 * engine shows as conflicts. `pending` supplies client roots planned in the same export.
 */
export function planDirectoryBootstrap(
  db: Reader,
  workspaceId: string,
  entityType: DirectoryEntityType,
  syncId: string,
  pending: readonly RevisionChange[] = []
): DirectoryBootstrap {
  const schema = directorySchema(entityType)
  let values: Values
  if (entityType === 'client') {
    // The built-in's local syncId is not portable: it is exported only under the reserved ID.
    const row = findClientByPortableId(db, syncId)
    if (!row) return { status: 'not-found' }
    values = portableClientValues(row)
  } else {
    const row = findProjectByPortableId(db, syncId)
    if (!row) return { status: 'not-found' }
    values = portableProjectValues(db, row)
  }
  if (historyOf(db, workspaceId, entityType, syncId).length) {
    // Imported history held against differing, never-exported local values may still compete.
    const held =
      readDirectoryRecordState(db, workspaceId, entityType, syncId)?.projectionIssue?.code ===
      'unexported-local-values'
    if (!held || hasLocalOrigin(db, workspaceId, entityType, syncId))
      return { status: 'has-history' }
  } else if (isJoinReviewPending(db, workspaceId)) {
    // Never publish a possible duplicate before the user links it or keeps it separate.
    return { status: 'join-review-pending' }
  }
  let dependencies: string[] = []
  if (entityType === 'project') {
    const clientSyncId = values.clientSyncId as string
    dependencies = clientHeads(db, workspaceId, clientSyncId, pending)
    if (!dependencies.length)
      return { status: 'requires', requires: [{ entityType: 'client', entityId: clientSyncId }] }
  }
  const { id: _placeholder, ...body } = planRevision({
    id: PLACEHOLDER_ID,
    schema,
    entityId: syncId,
    history: [],
    action: { type: 'create', values },
    dependencies
  })
  const change: RevisionChange = { id: bootstrapChangeId(workspaceId, body), ...body }
  validateDirectoryChange(change)
  return { status: 'ready', change }
}

export interface DirectoryExport {
  /** Clients before projects; record them together with recordLocalSyncChanges. */
  changes: RevisionChange[]
  blocked: Array<DirectoryReference & { requires: DirectoryReference[] }>
  invalid: Array<DirectoryReference & { message: string }>
}

/** Bootstraps every local client/project that has no causal history on this computer yet. */
export function planDirectoryExport(db: Reader, workspaceId: string): DirectoryExport {
  const result: DirectoryExport = { changes: [], blocked: [], invalid: [] }
  const collect = (entityType: DirectoryEntityType, entityId: string): void => {
    try {
      const plan = planDirectoryBootstrap(db, workspaceId, entityType, entityId, result.changes)
      if (plan.status === 'ready') result.changes.push(plan.change)
      else if (plan.status === 'requires')
        result.blocked.push({ entityType, entityId, requires: plan.requires })
    } catch (error) {
      if (!(error instanceof RevisionError || error instanceof AppError)) throw error
      result.invalid.push({ entityType, entityId, message: error.message })
    }
  }
  for (const row of db
    .select({ id: clients.id, syncId: clients.syncId, systemRole: clients.systemRole })
    .from(clients)
    .orderBy(clients.id)
    .all())
    collect('client', portableIdOfClientRow(db, row))
  for (const row of db
    .select({ id: projects.id, syncId: projects.syncId })
    .from(projects)
    .orderBy(projects.id)
    .all())
    collect('project', portableIdOfProjectRow(db, row))
  return result
}

// ── Projection into business tables ──

/** Agreed values only: conflicted fields without a common value are omitted, never guessed. */
function agreedValues(view: RecordView): Values {
  const values: Values = {}
  for (const [field, state] of Object.entries(view.fields))
    if (state.value !== undefined) values[field] = state.value
  // Causal deletion only deactivates. A conflicted presence keeps its last agreed value.
  if (view.present.value === false) values.isActive = false
  else if (view.present.value !== true) delete values.isActive
  return values
}

function differs(current: Record<string, unknown>, values: Values): boolean {
  return Object.keys(values).some((field) => current[field] !== values[field])
}

function changedColumns(current: Record<string, unknown>, values: Values): Values {
  return Object.fromEntries(
    Object.entries(values).filter(([field]) => current[field] !== values[field])
  )
}

function missingFields(values: Values, required: readonly string[]): ProjectionIssue | undefined {
  const fields = required.filter((field) => !Object.hasOwn(values, field))
  return fields.length ? { code: 'unresolved-field', fields } : undefined
}

function projectClient(
  tx: Transaction,
  workspaceId: string,
  view: RecordView,
  guarded: boolean
): ProjectionIssue | undefined {
  const values = agreedValues(view)
  const row = findClientByPortableId(tx, view.entityId)
  if (row && guarded && differs(portableClientValues(row), values))
    return { code: 'unexported-local-values' }
  // A pending join review may still link a local row to this record: never insert a twin.
  if (!row && view.entityId !== UNASSIGNED_CLIENT_SYNC_ID && isJoinReviewPending(tx, workspaceId))
    return { code: 'join-review-pending' }
  let issue: ProjectionIssue | undefined
  if (typeof values.name === 'string') {
    // Names never merge identities, including an ordinary client named like the built-in.
    const sameName = eq(clients.name, values.name)
    const holder = tx
      .select({ id: clients.id, syncId: clients.syncId, systemRole: clients.systemRole })
      .from(clients)
      .where(row ? and(sameName, ne(clients.id, row.id)) : sameName)
      .get()
    if (holder) {
      issue = { code: 'name-collision', conflictingSyncId: portableIdOfClientRow(tx, holder) }
      delete values.name
    }
  }
  const now = new Date().toISOString()
  if (!row) {
    issue ??= missingFields(values, ['name', 'color', 'isActive'])
    if (issue) return issue
    // A synced built-in becomes this computer's role row; its syncId is local only.
    tx.insert(clients)
      .values({
        syncId: view.entityId,
        systemRole: view.entityId === UNASSIGNED_CLIENT_SYNC_ID ? UNASSIGNED_CLIENT_ROLE : null,
        stageName: null,
        billableRate: null,
        email: null,
        ...(values as Pick<ClientRow, 'name' | 'color' | 'isActive'>),
        createdAt: now,
        updatedAt: now
      })
      .run()
    return undefined
  }
  const set = changedColumns(portableClientValues(row), values)
  if (Object.keys(set).length)
    tx.update(clients)
      .set({ ...(set as Partial<ClientRow>), updatedAt: now })
      .where(eq(clients.id, row.id))
      .run()
  return issue
}

function projectProject(
  tx: Transaction,
  workspaceId: string,
  view: RecordView,
  guarded: boolean
): ProjectionIssue | undefined {
  const values = agreedValues(view)
  const row = findProjectByPortableId(tx, view.entityId)
  if (row && guarded && differs(portableProjectValues(tx, row), values))
    return { code: 'unexported-local-values' }
  if (!row && isJoinReviewPending(tx, workspaceId)) return { code: 'join-review-pending' }
  let issue: ProjectionIssue | undefined
  const { clientSyncId, ...columns } = values
  if (typeof clientSyncId === 'string') {
    const client = findClientByPortableId(tx, clientSyncId)
    if (client) columns.clientId = client.id
    else issue = { code: 'client-unavailable', clientSyncId }
  }
  const now = new Date().toISOString()
  if (!row) {
    issue ??= missingFields(values, ['clientSyncId', 'name', 'isBillable', 'isActive'])
    if (issue) return issue
    // Remote projects have no local path or folder mapping until the user links one.
    tx.insert(projects)
      .values({
        syncId: view.entityId,
        directoryPath: null,
        invoiceName: null,
        stageName: null,
        hourlyRate: null,
        rootCommit: null,
        ...(columns as Pick<ProjectRow, 'clientId' | 'name' | 'isBillable' | 'isActive'>),
        createdAt: now,
        updatedAt: now
      })
      .run()
    return undefined
  }
  const set = changedColumns(row as unknown as Record<string, unknown>, columns)
  if (!Object.keys(set).length) return issue
  tx.update(projects)
    .set({ ...(set as Partial<ProjectRow>), updatedAt: now })
    .where(eq(projects.id, row.id))
    .run()
  // Matches a local reassignment: the project's active sessions follow its client.
  if (set.clientId !== undefined)
    tx.update(sessions)
      .set({ clientId: set.clientId as number, updatedAt: now })
      .where(and(eq(sessions.projectId, row.id), activeSessionCondition))
      .run()
  return issue
}

function refreshRecord(
  tx: Transaction,
  workspaceId: string,
  entityType: DirectoryEntityType,
  entityId: string
): void {
  const view = getDirectoryRecordView(tx, workspaceId, entityType, entityId)
  if (view.lifecycle === 'missing') return
  const previous = readDirectoryRecordState(tx, workspaceId, entityType, entityId)
  // Never overwrite a pre-existing row this computer has not exported with imported values.
  const guarded =
    !hasLocalOrigin(tx, workspaceId, entityType, entityId) &&
    (!previous || previous.projectionIssue?.code === 'unexported-local-values')
  const projectionIssue =
    entityType === 'client'
      ? projectClient(tx, workspaceId, view, guarded)
      : projectProject(tx, workspaceId, view, guarded)
  const state: DirectoryRecordState = projectionIssue ? { view, projectionIssue } : { view }
  tx.insert(syncRecordStates)
    .values({ workspaceId, entityType, entityId, stateJson: JSON.stringify(state) })
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

/** A rename or newly projected client can release held records; clients go first. */
function refreshHeldRecords(tx: Transaction, workspaceId: string, except: string): void {
  const held = tx
    .select()
    .from(syncRecordStates)
    .where(
      and(
        eq(syncRecordStates.workspaceId, workspaceId),
        inArray(syncRecordStates.entityType, [...DIRECTORY_ENTITY_TYPES])
      )
    )
    .all()
    .filter(
      (row) =>
        `${row.entityType}:${row.entityId}` !== except &&
        (JSON.parse(row.stateJson) as DirectoryRecordState).projectionIssue
    )
    .sort((left, right) =>
      left.entityType === right.entityType ? 0 : left.entityType === 'client' ? -1 : 1
    )
  for (const row of held)
    refreshRecord(tx, workspaceId, row.entityType as DirectoryEntityType, row.entityId)
}

/** Re-projects every held client/project, clients first; used after join review decisions. */
export function refreshDirectoryProjections(tx: Transaction, workspaceId: string): void {
  refreshHeldRecords(tx, workspaceId, '')
}

/**
 * Store hook, called after the change is inserted into sync_changes. Parents and the client
 * reference are checked against applied changes in this workspace.
 */
export function applyDirectoryChange(tx: Transaction, workspaceId: string, change: unknown): void {
  const revision = validateDirectoryChange(change)
  const entityType = revision.entityType as DirectoryEntityType
  const lookup = (id: string): unknown => appliedChange(tx, workspaceId, id)
  if (lookup(revision.id) === undefined)
    invalid(`Record ${revision.id} in sync_changes before applying it`)
  const missing = checkRevision(change, directorySchema(entityType), lookup)
  if (missing.length)
    throw new AppError('SYNC_MISSING_DEPENDENCY', `${revision.id} waits for ${missing.join(', ')}`)
  const assigned = revision.fields.get('clientSyncId')?.value
  if (
    assigned !== undefined &&
    !revision.dependencies.some((id) => {
      const dependency = lookup(id) as Partial<RevisionChange> | undefined
      return (
        dependency?.kind === 'revision' &&
        dependency.entityType === 'client' &&
        dependency.entityId === assigned
      )
    })
  )
    invalid(`${revision.id} does not depend on client ${String(assigned)}`)
  refreshRecord(tx, workspaceId, entityType, revision.entityId)
  refreshHeldRecords(tx, workspaceId, `${entityType}:${revision.entityId}`)
}

/** Handles only 'client' and 'project' revisions; route other entity types elsewhere. */
export const directoryRecordsAdapter: SyncDomainAdapter = {
  validate: (change) => void validateDirectoryChange(change),
  apply: applyDirectoryChange
}
