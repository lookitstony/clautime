import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { sourceMachines } from '../db/schema/activity-observers'
import { manualTimeEntries } from '../db/schema/manual-time-entries'
import { sessionLegacyRecords } from '../db/schema/session-legacy'
import { syncChanges } from '../db/schema/folder-sync'
import { syncLegacyImports } from '../db/schema/sync-legacy'
import { AppError } from '../../shared/types/ipc'
import {
  canonicalJson,
  isSyncUuid,
  parseChange,
  SyncError,
  type JsonObject,
  type SyncChange
} from './folder-sync-protocol'
import { recordLocalSyncChanges, type SyncDomainAdapter } from './folder-sync-store'
import { syncFactChangeId } from './folder-sync-activity-records'
import { manualEntryIdentityRoot } from './folder-sync-manual-records'

/*
 * Machine provenance of portable legacy/manual history (plan: Source Machine). A separate
 * immutable fact per (record, device, basis), so neither the legacy fact nor the manual entry
 * bakes in a computer label and clones labelled by different computers never conflict.
 *
 * history-observer payload is exactly { recordType, recordId, deviceId, basis }; the entity ID is
 * canonicalJson of those four values and the change ID is the deterministic workspace fact ID. It
 * depends on the machine fact and on the record's deterministic fact (legacy-session) or identity
 * root (manual-entry). Observers never contribute to totals.
 *
 * - legacy-session: 'imported' by each computer that held the snapshot before sync (its initial
 *   computer), never a claim about where the work happened.
 * - manual-entry: 'observed' by the creating computer (basis 'created', same as the entry's
 *   origin deviceId); 'imported' by the computer that labelled a migrated entry.
 */

type Db<TSchema extends Record<string, unknown>> = BetterSQLite3Database<TSchema>
type Transaction = Parameters<SyncDomainAdapter['apply']>[0]
type Reader = Pick<Transaction, 'select'>

export const HISTORY_OBSERVER_RECORD_TYPES = ['legacy-session', 'manual-entry'] as const
export type HistoryObserverRecordType = (typeof HISTORY_OBSERVER_RECORD_TYPES)[number]

export interface HistoryObserver {
  recordType: HistoryObserverRecordType
  recordId: string
  deviceId: string
  basis: 'observed' | 'imported'
}

const OBSERVER_KEYS = ['recordType', 'recordId', 'deviceId', 'basis']
const VOCABULARY = /^[a-z][a-z0-9-]*$/

function malformed(message: string): never {
  throw new SyncError('SYNC_MALFORMED', message)
}

export function historyObserverEntityId(observer: HistoryObserver): string {
  return canonicalJson([observer.recordType, observer.recordId, observer.deviceId, observer.basis])
}

function readObserver(change: SyncChange): HistoryObserver {
  const payload = change.payload
  const keys = Object.keys(payload)
  if (
    keys.length !== OBSERVER_KEYS.length ||
    !OBSERVER_KEYS.every((key) => Object.hasOwn(payload, key))
  )
    malformed('History observer has missing or unsupported fields')
  const { recordType, recordId, deviceId, basis } = payload
  if (!(HISTORY_OBSERVER_RECORD_TYPES as readonly unknown[]).includes(recordType)) {
    if (typeof recordType === 'string' && VOCABULARY.test(recordType))
      throw new SyncError(
        'SYNC_UPDATE_REQUIRED',
        `Shared history uses observed record type "${recordType}"; update ClauTime to continue syncing`
      )
    malformed('History observer has an invalid record type')
  }
  if (!isSyncUuid(recordId) || !isSyncUuid(deviceId)) malformed('History observer has invalid IDs')
  if (basis !== 'observed' && basis !== 'imported')
    malformed('History observer has an invalid basis')
  const observer = payload as unknown as HistoryObserver
  if (change.entityId !== historyObserverEntityId(observer))
    malformed('History observer entity ID does not match its contents')
  return observer
}

function validateObserverChange(change: SyncChange): void {
  if (change.kind !== 'fact' || change.entityType !== 'history-observer')
    malformed(`Sync change ${change.id} is not a history observer`)
  readObserver(change)
  if (change.dependencies.length !== 2)
    malformed('History observer depends on its machine and its record')
}

/** The store has checked both dependencies are applied; this checks what they are. */
function applyObserverChange(tx: Transaction, workspaceId: string, change: SyncChange): void {
  validateObserverChange(change)
  if (change.id !== syncFactChangeId(workspaceId, 'history-observer', change.entityId))
    malformed(`History observer change ${change.id} is not derived from its fact`)
  const observer = readObserver(change)
  const machineId = syncFactChangeId(workspaceId, 'machine', observer.deviceId)
  const found = new Map(
    tx
      .select({
        id: syncChanges.id,
        workspaceId: syncChanges.workspaceId,
        entityType: syncChanges.entityType,
        entityId: syncChanges.entityId,
        json: syncChanges.changeJson
      })
      .from(syncChanges)
      .where(inArray(syncChanges.id, change.dependencies))
      .all()
      .map((row) => [row.id, row])
  )
  const machine = found.get(machineId)
  const recordId = change.dependencies.find((id) => id !== machineId)
  const record = recordId ? found.get(recordId) : undefined
  const recordOk =
    record?.workspaceId === workspaceId &&
    record.entityType === observer.recordType &&
    record.entityId === observer.recordId &&
    (observer.recordType === 'legacy-session'
      ? record.id === syncFactChangeId(workspaceId, 'legacy-session', observer.recordId)
      : // The manual identity root: the only revision whose $present has no parents.
        (
          JSON.parse(record.json) as {
            payload?: { fields?: Record<string, { parents?: unknown[] }> }
          }
        ).payload?.fields?.$present?.parents?.length === 0)
  if (
    !machine ||
    machine.workspaceId !== workspaceId ||
    machine.entityType !== 'machine' ||
    !recordOk
  )
    throw new AppError(
      'SYNC_MISSING_DEPENDENCY',
      `History observer ${change.entityId} does not depend on its machine and record`
    )
}

export const historyObserversAdapter: SyncDomainAdapter = {
  validate: validateObserverChange,
  apply: applyObserverChange
}

/** Deterministic fact; `recordChangeId` is the legacy fact or the manual identity root. */
export function planHistoryObserverFact(
  workspaceId: string,
  observer: HistoryObserver,
  recordChangeId: string
): SyncChange {
  if (!isSyncUuid(workspaceId)) malformed('A shared history ID is required')
  const payload: JsonObject = {
    recordType: observer.recordType,
    recordId: observer.recordId,
    deviceId: observer.deviceId,
    basis: observer.basis
  }
  const entityId = historyObserverEntityId(observer)
  const change: SyncChange = {
    id: syncFactChangeId(workspaceId, 'history-observer', entityId),
    kind: 'fact',
    entityType: 'history-observer',
    entityId,
    dependencies: [
      syncFactChangeId(workspaceId, 'machine', observer.deviceId),
      recordChangeId
    ].sort(),
    payload
  }
  parseChange(change)
  validateObserverChange(change)
  return change
}

function applied(db: Reader, workspaceId: string, id: string): boolean {
  return !!db
    .select({ id: syncChanges.id })
    .from(syncChanges)
    .where(and(eq(syncChanges.workspaceId, workspaceId), eq(syncChanges.id, id)))
    .get()
}

export interface HistoryObserverExport {
  changes: SyncChange[]
  /** Observers waiting for a machine or record fact that is not recorded yet. */
  requires: Array<{ observer: HistoryObserver; missing: string[] }>
}

/**
 * Observers of this computer's native history, after its legacy facts and manual roots are
 * recorded: native legacy snapshots are 'imported' by `localDeviceId`; manual entries use their
 * stable origin/label device. Already-recorded observers are skipped.
 */
export function collectHistoryObserverChanges(
  db: Reader,
  workspaceId: string,
  localDeviceId: string,
  scope?: { legacyIds: string[]; manualIds: string[] }
): HistoryObserverExport {
  const result: HistoryObserverExport = { changes: [], requires: [] }
  const plan = (observer: HistoryObserver, recordChangeId: string) => {
    const change = planHistoryObserverFact(workspaceId, observer, recordChangeId)
    if (applied(db, workspaceId, change.id)) return
    const missing = change.dependencies.filter((id) => !applied(db, workspaceId, id))
    if (missing.length) result.requires.push({ observer, missing })
    else result.changes.push(change)
  }
  const legacy = db
    .select({ id: sessionLegacyRecords.id })
    .from(sessionLegacyRecords)
    .leftJoin(syncLegacyImports, eq(syncLegacyImports.legacyId, sessionLegacyRecords.id))
    .where(
      and(
        isNull(syncLegacyImports.legacyId),
        scope && inArray(sessionLegacyRecords.id, scope.legacyIds)
      )
    )
    .orderBy(sessionLegacyRecords.id)
    .all()
  for (const { id } of legacy) {
    const factId = syncFactChangeId(workspaceId, 'legacy-session', id)
    // Only snapshots that were exported; withheld history gets no label either.
    if (applied(db, workspaceId, factId))
      plan(
        { recordType: 'legacy-session', recordId: id, deviceId: localDeviceId, basis: 'imported' },
        factId
      )
  }
  const entries = db
    .select()
    .from(manualTimeEntries)
    .where(scope && inArray(manualTimeEntries.id, scope.manualIds))
    .orderBy(manualTimeEntries.id)
    .all()
  for (const entry of entries) {
    if (!entry.deviceId) continue
    let rootId: string
    try {
      rootId = manualEntryIdentityRoot(db, workspaceId, entry.id).id
    } catch (error) {
      if (error instanceof AppError) continue
      throw error
    }
    if (!applied(db, workspaceId, rootId)) continue
    plan(
      {
        recordType: 'manual-entry',
        recordId: entry.id,
        deviceId: entry.deviceId,
        basis: entry.basis === 'created' ? 'observed' : 'imported'
      },
      rootId
    )
  }
  const byEntity = (a: SyncChange, b: SyncChange) => (a.entityId < b.entityId ? -1 : 1)
  result.changes.sort(byEntity)
  return result
}

export function journalHistoryObservers<TSchema extends Record<string, unknown>>(
  db: Db<TSchema>,
  workspaceId: string,
  changes: readonly SyncChange[]
): string[] {
  if (!changes.length) return []
  return recordLocalSyncChanges(db, workspaceId, [...changes], historyObserversAdapter)
}

export interface HistoryObserverRow extends HistoryObserver {
  /** The machine's original registration label, when that machine fact is known here. */
  initialName: string | null
}

/**
 * For the Source Machine UI: observers of legacy/manual records, re-validated on read. Without
 * `workspaceId`, every workspace this database recorded is included.
 */
export function readHistoryObservers(
  db: Reader,
  options: {
    workspaceId?: string
    recordType?: HistoryObserverRecordType
    recordIds?: readonly string[]
  } = {}
): HistoryObserverRow[] {
  const scope = options.recordIds ? new Set(options.recordIds) : null
  const rows = db
    .select({ json: syncChanges.changeJson })
    .from(syncChanges)
    .where(
      and(
        eq(syncChanges.entityType, 'history-observer'),
        options.workspaceId ? eq(syncChanges.workspaceId, options.workspaceId) : undefined
      )
    )
    .all()
  const names = new Map(
    db
      .select()
      .from(sourceMachines)
      .all()
      .map((row) => [row.deviceId, row.initialName])
  )
  const seen = new Map<string, HistoryObserverRow>()
  for (const row of rows) {
    const observer = readObserver(parseChange(JSON.parse(row.json)))
    if (options.recordType && observer.recordType !== options.recordType) continue
    if (scope && !scope.has(observer.recordId)) continue
    seen.set(historyObserverEntityId(observer), {
      recordType: observer.recordType,
      recordId: observer.recordId,
      deviceId: observer.deviceId,
      basis: observer.basis,
      initialName: names.get(observer.deviceId) ?? null
    })
  }
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, value]) => value)
}
