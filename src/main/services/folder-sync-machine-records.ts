import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { randomUUID } from 'node:crypto'
import { sourceMachines } from '../db/schema/activity-observers'
import { syncChanges, syncRecordStates } from '../db/schema/folder-sync'
import { AppError } from '../../shared/types/ipc'
import type { SourceMachineLabelHeads } from '../../shared/types/source-machine'
import { canonicalJson, isSyncUuid, parseChange, SyncError } from './folder-sync-protocol'
import { syncFactChangeId } from './folder-sync-activity-records'
import { historySyncWorkspace } from './folder-sync-history-records'
import {
  checkRevision,
  materializeRecord,
  planRevision,
  readRevisionChange,
  PRESENT,
  RevisionError,
  type RecordSchema,
  type RecordView,
  type RevisionAction,
  type RevisionChange
} from './folder-sync-revisions'
import { recordLocalSyncChanges, type SyncDomainAdapter } from './folder-sync-store'

/*
 * Shared friendly labels for source machines (plan decision F). A label is a causal revision
 * record (entity machine-label, ID = device UUID) with one field, `name`. It never deletes, and
 * every revision depends on that device's immutable machine fact, so a label can only name a
 * machine the history already knows. Renaming never changes device identity, activity identity
 * or source_machines.initial_name; the registration name stays the fallback display label.
 */

type Db<TSchema extends Record<string, unknown>> = BetterSQLite3Database<TSchema>
type Reader = Pick<Parameters<SyncDomainAdapter['apply']>[0], 'select'>

export const MACHINE_LABEL_MAX_LENGTH = 80

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

export function isMachineLabel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MACHINE_LABEL_MAX_LENGTH &&
    value === value.trim() &&
    value.isWellFormed() &&
    !hasControlCharacter(value)
  )
}

export const MACHINE_LABEL_SYNC_SCHEMA: RecordSchema = {
  entityType: 'machine-label',
  fields: ['name'],
  validate: (field, value) => field === 'name' && isMachineLabel(value)
}

function malformed(message: string): never {
  throw new SyncError('SYNC_MALFORMED', message)
}

/** The immutable machine fact every label revision of this device depends on. */
export function machineFactChangeId(workspaceId: string, deviceId: string): string {
  return syncFactChangeId(workspaceId, 'machine', deviceId)
}

/** Structural checks only; independent of any database. */
export function validateMachineLabelChange(value: unknown): void {
  const change = parseChange(value)
  if (
    change.kind !== 'revision' ||
    change.entityType !== 'machine-label' ||
    !isSyncUuid(change.entityId)
  )
    malformed('Expected a machine label revision')
  let fields: ReturnType<typeof readRevisionChange>['fields']
  try {
    fields = readRevisionChange(change, MACHINE_LABEL_SYNC_SCHEMA).fields
  } catch (error) {
    if (error instanceof RevisionError) malformed(error.message)
    throw error
  }
  if (fields.get(PRESENT)?.value !== true) malformed('A machine label cannot be removed')
  if (fields.size !== 2 || !fields.has('name'))
    malformed('A machine label revision writes its name')
}

function history(db: Reader, workspaceId: string, deviceId?: string): RevisionChange[] {
  return db
    .select({ json: syncChanges.changeJson })
    .from(syncChanges)
    .where(
      and(
        eq(syncChanges.workspaceId, workspaceId),
        eq(syncChanges.entityType, 'machine-label'),
        ...(deviceId ? [eq(syncChanges.entityId, deviceId)] : [])
      )
    )
    .all()
    .map((row) => JSON.parse(row.json) as RevisionChange)
}

export function machineLabelView(db: Reader, workspaceId: string, deviceId: string): RecordView {
  return materializeRecord(MACHINE_LABEL_SYNC_SCHEMA, deviceId, history(db, workspaceId, deviceId))
}

/** Every labelled machine of one shared history; an unreadable history is reported, not guessed. */
export function readMachineLabelViews(
  db: Reader,
  workspaceId: string
): Map<string, RecordView | { unreadable: true }> {
  const byDevice = new Map<string, RevisionChange[]>()
  for (const change of history(db, workspaceId)) {
    const list = byDevice.get(change.entityId)
    if (list) list.push(change)
    else byDevice.set(change.entityId, [change])
  }
  const views = new Map<string, RecordView | { unreadable: true }>()
  for (const [deviceId, changes] of byDevice) {
    try {
      views.set(deviceId, materializeRecord(MACHINE_LABEL_SYNC_SCHEMA, deviceId, changes))
    } catch {
      views.set(deviceId, { unreadable: true })
    }
  }
  return views
}

/**
 * Validates the revision, its machine-fact dependency and its parents, then refreshes the
 * rebuildable causal view. Never writes source_machines: the original name is immutable.
 */
function applyMachineLabelChange(
  tx: Parameters<SyncDomainAdapter['apply']>[0],
  workspaceId: string,
  change: Parameters<SyncDomainAdapter['apply']>[2]
): void {
  validateMachineLabelChange(change)
  const deviceId = change.entityId
  const machineFact = machineFactChangeId(workspaceId, deviceId)
  const revision = readRevisionChange(change, MACHINE_LABEL_SYNC_SCHEMA)
  const parents = [...revision.fields.values()].flatMap((field) => field.parents)
  const expected = [...new Set([...parents, machineFact])].sort()
  if (canonicalJson([...change.dependencies].sort()) !== canonicalJson(expected))
    malformed('A machine label depends on exactly its machine and observed labels')
  const fact = tx
    .select({
      workspaceId: syncChanges.workspaceId,
      entityType: syncChanges.entityType,
      entityId: syncChanges.entityId
    })
    .from(syncChanges)
    .where(eq(syncChanges.id, machineFact))
    .get()
  const machine = tx
    .select({ deviceId: sourceMachines.deviceId })
    .from(sourceMachines)
    .where(eq(sourceMachines.deviceId, deviceId))
    .get()
  if (
    !fact ||
    fact.workspaceId !== workspaceId ||
    fact.entityType !== 'machine' ||
    fact.entityId !== deviceId ||
    !machine
  )
    throw new AppError(
      'SYNC_MISSING_DEPENDENCY',
      `Machine ${deviceId} is not in this shared history`
    )
  const revisions = history(tx, workspaceId, deviceId)
  const byId = new Map(revisions.map((row) => [row.id, row]))
  if (checkRevision(change, MACHINE_LABEL_SYNC_SCHEMA, (id) => byId.get(id)).length)
    throw new AppError('SYNC_MISSING_DEPENDENCY', 'The machine label is missing earlier revisions')
  const view = materializeRecord(MACHINE_LABEL_SYNC_SCHEMA, deviceId, revisions)
  const stateJson = canonicalJson(view)
  tx.insert(syncRecordStates)
    .values({ workspaceId, entityType: 'machine-label', entityId: deviceId, stateJson })
    .onConflictDoUpdate({
      target: [
        syncRecordStates.workspaceId,
        syncRecordStates.entityType,
        syncRecordStates.entityId
      ],
      set: { stateJson }
    })
    .run()
}

/** Register in folder-sync-domains for entity type 'machine-label'. */
export const machineLabelSyncAdapter: SyncDomainAdapter = {
  validate: validateMachineLabelChange,
  apply: applyMachineLabelChange
}

export interface MachineRenameInput {
  deviceId: string
  name: string
  /** Heads the user saw (labelHeads); a creation passes {} or the empty heads of a new record. */
  observedHeads: SourceMachineLabelHeads
}

function stale(message: string): never {
  throw new AppError('MACHINE_LABEL_STALE', message)
}

/**
 * Plans (never records) a rename. A first label creates the record; a later rename supersedes
 * only the heads the user saw, so an unseen concurrent rename becomes a conflict; a conflicted
 * label accepts only a resolution naming exactly its current heads. Returns null when the
 * agreed label already equals the name.
 */
export function planMachineRename(
  db: Reader,
  workspaceId: string,
  input: MachineRenameInput,
  id: string = randomUUID()
): (RevisionChange & { entityType: 'machine-label' }) | null {
  if (!isSyncUuid(workspaceId))
    throw new AppError('INVALID_SYNC_WORKSPACE', 'A shared history ID is required')
  if (!isSyncUuid(input.deviceId))
    throw new AppError('SOURCE_MACHINE_NOT_FOUND', 'Choose a known machine to rename')
  const known = db
    .select({ deviceId: sourceMachines.deviceId })
    .from(sourceMachines)
    .where(eq(sourceMachines.deviceId, input.deviceId))
    .get()
  if (!known) throw new AppError('SOURCE_MACHINE_NOT_FOUND', 'Choose a known machine to rename')
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!isMachineLabel(name))
    throw new AppError(
      'INVALID_MACHINE_LABEL',
      `Enter a machine name of 1 to ${MACHINE_LABEL_MAX_LENGTH} characters`
    )
  const revisions = history(db, workspaceId, input.deviceId)
  const view = materializeRecord(MACHINE_LABEL_SYNC_SCHEMA, input.deviceId, revisions)
  const observed = input.observedHeads ?? {}
  let action: RevisionAction
  if (view.lifecycle === 'missing') {
    if (Object.values(observed).some((heads) => heads?.length))
      stale('This machine label changed; review the current name and try again')
    action = { type: 'create', values: { name } }
  } else if (view.fields.name.status === 'conflict') {
    action = { type: 'resolve', expectedHeads: observed, values: { name } }
  } else {
    if (view.fields.name.value === name && canonicalJson(observed) === canonicalJson(view.heads))
      return null
    action = { type: 'edit', observedHeads: observed, values: { name } }
  }
  try {
    const change = {
      ...planRevision({
        id,
        schema: MACHINE_LABEL_SYNC_SCHEMA,
        entityId: input.deviceId,
        history: revisions,
        action,
        dependencies: [machineFactChangeId(workspaceId, input.deviceId)]
      }),
      entityType: 'machine-label' as const
    }
    validateMachineLabelChange(change)
    return change
  } catch (error) {
    if (error instanceof RevisionError) stale(error.message)
    throw error
  }
}

/**
 * Settings rename API. Records the revision in the shared-history journal (also while transfer
 * is off) and returns the new view. Requires a shared-history connection whose journal already
 * holds this machine's fact.
 */
export function journalMachineRename<TSchema extends Record<string, unknown>>(
  db: Db<TSchema>,
  input: MachineRenameInput
): RecordView {
  const workspaceId = historySyncWorkspace(db)
  if (!workspaceId)
    throw new AppError(
      'SYNC_WORKSPACE_REQUIRED',
      'Machine names are shared labels; connect shared history before renaming a machine'
    )
  const change = planMachineRename(db, workspaceId, input)
  if (change) recordLocalSyncChanges(db, workspaceId, [change], machineLabelSyncAdapter)
  return machineLabelView(db, workspaceId, input.deviceId)
}
