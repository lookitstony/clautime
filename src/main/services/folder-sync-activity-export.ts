import { inArray, sql, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { activityIdentities, activityObservations } from '../db/schema/activity-evidence'
import { activityObservers, sourceMachines } from '../db/schema/activity-observers'
import { AppError } from '../../shared/types/ipc'
import {
  activitySyncAdapter,
  collectActivitySyncChanges,
  syncFactChangeId
} from './folder-sync-activity-records'
import { isSyncUuid, SyncError, type JsonObject, type SyncChange } from './folder-sync-protocol'
import { recordLocalSyncChanges, type SyncDomainAdapter } from './folder-sync-store'

type Issue = { source: string; code: string; message: string }

const WITHHELD = 'SYNC_LOCAL_ACTIVITY_WITHHELD'
const MAX_ISSUES = 10

function chunked<T, R>(values: readonly T[], read: (part: T[]) => R[]): R[] {
  const result: R[] = []
  for (let index = 0; index < values.length; index += 500)
    result.push(...read(values.slice(index, index + 500)))
  return result
}

/** Unsupported captures stay retained; independent exports and imports can still proceed. */
export function collectAvailableActivity<S extends Record<string, unknown>>(
  db: BetterSQLite3Database<S>,
  workspaceId: string,
  observationIds?: string[]
): {
  changes: SyncChange[]
  issues: Array<{ source: string; code: string; message: string }>
} {
  try {
    return { changes: collectActivitySyncChanges(db, workspaceId, observationIds), issues: [] }
  } catch (error) {
    if (!(error instanceof SyncError)) throw error
  }
  const changes = new Map<string, SyncChange>()
  const issues: Array<{ source: string; code: string; message: string }> = []
  let omittedIssues = 0
  const issue = (source: string, message: string): void => {
    if (issues.length < 10)
      issues.push({
        source,
        code: 'SYNC_LOCAL_ACTIVITY_WITHHELD',
        message: `Local captured activity could not be shared: ${message}`
      })
    else omittedIssues++
  }
  // A scoped call reads only the selected observations' identities, observers and machines.
  const selected = observationIds && [...new Set(observationIds)]
  const observationColumns = { id: activityObservations.id, eventId: activityObservations.eventId }
  const observations = selected
    ? chunked(selected, (part) =>
        db
          .select(observationColumns)
          .from(activityObservations)
          .where(inArray(activityObservations.id, part))
          .all()
      )
    : db.select(observationColumns).from(activityObservations).all()
  const observers = selected
    ? chunked(selected, (part) =>
        db
          .select()
          .from(activityObservers)
          .where(inArray(activityObservers.observationId, part))
          .all()
      )
    : db.select().from(activityObservers).all()
  const machines = selected
    ? chunked([...new Set(observers.map((row) => row.deviceId))], (part) =>
        db.select().from(sourceMachines).where(inArray(sourceMachines.deviceId, part)).all()
      )
    : db.select().from(sourceMachines).all()
  const identities = selected
    ? chunked([...new Set(observations.map((row) => row.eventId))], (part) =>
        db.select().from(activityIdentities).where(inArray(activityIdentities.eventId, part)).all()
      )
    : db.select().from(activityIdentities).all()
  // Validate common references once, rather than retrying every observation with the same error.
  const badMachines = new Set<string>()
  const badIdentities = new Set<string>()
  const validate = (
    entityType: 'machine' | 'activity-identity',
    entityId: string,
    payload: SyncChange['payload'],
    invalid: Set<string>
  ) => {
    try {
      activitySyncAdapter.validate({
        id: syncFactChangeId(workspaceId, entityType, entityId),
        kind: 'fact',
        entityType,
        entityId,
        payload,
        dependencies: []
      })
    } catch (error) {
      if (!(error instanceof SyncError)) throw error
      invalid.add(entityId)
      issue(entityId, error.message)
    }
  }
  for (const row of machines)
    validate(
      'machine',
      row.deviceId,
      { deviceId: row.deviceId, initialName: row.initialName },
      badMachines
    )
  for (const row of identities)
    validate('activity-identity', row.eventId, { ...row }, badIdentities)
  const badObservations = new Set(
    observers.filter((row) => badMachines.has(row.deviceId)).map((row) => row.observationId)
  )
  const ids = observations
    .filter((row) => !badIdentities.has(row.eventId) && !badObservations.has(row.id))
    .map((row) => row.id)
  function collect(scope: string[]) {
    try {
      for (const change of collectActivitySyncChanges(db, workspaceId, scope))
        changes.set(change.id, change)
    } catch (error) {
      if (!(error instanceof SyncError)) throw error
      if (scope.length > 1) {
        const middle = Math.ceil(scope.length / 2)
        collect(scope.slice(0, middle))
        collect(scope.slice(middle))
      } else issue(scope[0], error.message)
    }
  }
  for (let i = 0; i < ids.length; i += 200) collect(ids.slice(i, i + 200))
  if (omittedIssues)
    issues.push({
      source: 'local activity',
      code: 'SYNC_LOCAL_ACTIVITY_WITHHELD',
      message: `${omittedIssues} additional local activity records need review before sharing.`
    })
  return { changes: [...changes.values()], issues }
}

/**
 * Observations first (each with its identity, observers and machines), then the identities and
 * machines no observation carried. Run each phase from cursor 0 until done.
 */
export type ActivityExportPhase = 'observations' | 'identities' | 'machines'

export interface ActivityExportPage {
  /** Pass back as the next cursor for the same phase. Never moves backwards. */
  cursor: number
  /** No backlog remains after the cursor in this phase. */
  done: boolean
  issues: Issue[]
  /** Facts newly journaled by this page. */
  exported: number
}

type Group = { source: string; changes: SyncChange[] }
type Row = { rowid: number } & Record<string, string | number | null>

function withheld(source: string, message: string): Issue {
  return {
    source,
    code: WITHHELD,
    message: `Local captured activity could not be shared: ${message}`
  }
}

/**
 * The ledger rows already exist, so apply does nothing; the store still rejects a change ID
 * recorded with other contents and any missing dependency. A failing group is isolated by
 * halving so it cannot hold back the rest of the page. Returns the newly journaled count.
 */
function journal<S extends Record<string, unknown>>(
  db: BetterSQLite3Database<S>,
  workspaceId: string,
  groups: Group[],
  issues: Issue[]
): number {
  let exported = 0
  const adapter: SyncDomainAdapter = {
    validate: activitySyncAdapter.validate,
    apply: () => {
      exported++
    }
  }
  const attempt = (part: Group[]): void => {
    const before = exported
    try {
      const changes = new Map(part.flatMap((group) => group.changes).map((c) => [c.id, c]))
      recordLocalSyncChanges(db, workspaceId, [...changes.values()], adapter)
    } catch (error) {
      if (!(error instanceof AppError)) throw error
      exported = before
      if (part.length > 1) {
        const middle = Math.ceil(part.length / 2)
        attempt(part.slice(0, middle))
        attempt(part.slice(middle))
      } else issues.push(withheld(part[0].source, error.message))
    }
  }
  if (groups.length) attempt(groups)
  return exported
}

/** Each observation with the identity, observers and machines it depends on. */
function observationGroups(changes: SyncChange[]): Group[] {
  const facts = new Map(
    changes.map((change) => [`${change.entityType}\0${change.entityId}`, change])
  )
  const observers = new Map<string, SyncChange[]>()
  for (const change of changes)
    if (change.entityType === 'activity-observer') {
      const id = change.payload.observationId as string
      observers.set(id, [...(observers.get(id) ?? []), change])
    }
  return changes
    .filter((change) => change.entityType === 'activity-observation')
    .map((observation) => {
      const own = observers.get(observation.entityId) ?? []
      const related = [
        facts.get(`activity-identity\0${observation.payload.eventId as string}`),
        ...own.map((observer) => facts.get(`machine\0${observer.payload.deviceId as string}`)),
        observation,
        ...own
      ]
      return {
        source: observation.entityId,
        changes: related.filter((change): change is SyncChange => !!change)
      }
    })
}

/** A machine or identity fact has no dependencies; invalid rows are reported, not journaled. */
function standaloneGroup(
  workspaceId: string,
  entityType: 'machine' | 'activity-identity',
  entityId: string,
  payload: JsonObject,
  issues: Issue[]
): Group[] {
  const change: SyncChange = {
    id: syncFactChangeId(workspaceId, entityType, entityId),
    kind: 'fact',
    entityType,
    entityId,
    dependencies: [],
    payload
  }
  try {
    activitySyncAdapter.validate(change)
    return [{ source: entityId, changes: [change] }]
  } catch (error) {
    if (!(error instanceof SyncError)) throw error
    issues.push(withheld(entityId, error.message))
    return []
  }
}

/** Rows after `cursor` missing at least one journaled fact, via the sync_changes entity index. */
function backlog<S extends Record<string, unknown>>(
  db: BetterSQLite3Database<S>,
  workspaceId: string,
  phase: ActivityExportPhase,
  cursor: number,
  limit: number,
  end: number
): Row[] {
  const missing = (entityType: string, entityId: SQL) =>
    sql`NOT EXISTS (SELECT 1 FROM sync_changes c WHERE c.workspace_id = ${workspaceId}
      AND c.entity_type = ${entityType} AND c.entity_id = ${entityId})`
  if (phase === 'observations')
    // A new observer of an already-journaled observation brings that observation back.
    return db.all<Row>(sql`SELECT o.rowid AS rowid, o.id AS id FROM activity_observations o
      WHERE o.rowid > ${cursor} AND o.rowid <= ${end} AND (${missing('activity-observation', sql`o.id`)}
        OR EXISTS (SELECT 1 FROM activity_observers v WHERE v.observation_id = o.id
          AND ${missing('activity-observer', sql`json_array(v.observation_id, v.device_id, v.basis)`)}))
      ORDER BY o.rowid LIMIT ${limit}`)
  if (phase === 'identities')
    return db.all<Row>(sql`SELECT i.rowid AS rowid, i.event_id AS eventId, i.provider AS provider,
        i.identity_version AS identityVersion, i.conversation_id AS conversationId,
        i.basis AS basis, i.native_event_id AS nativeEventId
      FROM activity_identities i
      WHERE i.rowid > ${cursor} AND i.rowid <= ${end} AND ${missing('activity-identity', sql`i.event_id`)}
      ORDER BY i.rowid LIMIT ${limit}`)
  return db.all<Row>(sql`SELECT m.rowid AS rowid, m.device_id AS deviceId,
      m.initial_name AS initialName
    FROM source_machines m
    WHERE m.rowid > ${cursor} AND m.rowid <= ${end} AND ${missing('machine', sql`m.device_id`)}
    ORDER BY m.rowid LIMIT ${limit}`)
}

/**
 * Journals one bounded page of local activity facts not yet in the shared history, in one
 * immediate transaction on `db`. Rows that cannot be shared are reported and passed, so one pass
 * selects each backlog row at most once. Run 'observations' until done, then 'identities', then
 * 'machines'; start a new pass from cursor 0 after new local activity is captured.
 */
export function exportActivityPage<S extends Record<string, unknown>>(
  db: BetterSQLite3Database<S>,
  workspaceId: string,
  cursor = 0,
  limit = 100,
  phase: ActivityExportPhase = 'observations'
): ActivityExportPage {
  if (!isSyncUuid(workspaceId))
    throw new AppError('INVALID_SYNC_WORKSPACE', 'A workspace UUID is required')
  if (!Number.isSafeInteger(cursor) || cursor < 0)
    throw new AppError('INVALID_SYNC_CURSOR', 'An activity export cursor must be a row position')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000)
    throw new AppError('INVALID_SYNC_BATCH_SIZE', 'Choose between 1 and 5000 rows per page')
  return db.transaction(
    (tx) => {
      const issues: Issue[] = []
      // Bound rows examined as well as rows exported. A LIMIT on missing facts alone
      // scans the whole ledger in one turn when nothing remains to export.
      const table =
        phase === 'observations'
          ? 'activity_observations'
          : phase === 'identities'
            ? 'activity_identities'
            : 'source_machines'
      const window = tx.all<{ rowid: number }>(sql`
        SELECT rowid FROM ${sql.identifier(table)} WHERE rowid > ${cursor}
        ORDER BY rowid LIMIT ${limit}
      `)
      const end = window.length ? window[window.length - 1].rowid : cursor
      const rows = window.length ? backlog(tx, workspaceId, phase, cursor, limit, end) : []
      let groups: Group[]
      if (phase === 'observations') {
        const ids = rows.map((row) => row.id as string)
        const available = ids.length
          ? collectAvailableActivity(tx, workspaceId, ids)
          : { changes: [], issues: [] }
        issues.push(...available.issues)
        groups = observationGroups(available.changes)
      } else if (phase === 'identities')
        groups = rows.flatMap((row) =>
          standaloneGroup(
            workspaceId,
            'activity-identity',
            row.eventId as string,
            {
              eventId: row.eventId,
              provider: row.provider,
              identityVersion: row.identityVersion,
              conversationId: row.conversationId,
              basis: row.basis,
              nativeEventId: row.nativeEventId
            },
            issues
          )
        )
      else
        groups = rows.flatMap((row) =>
          standaloneGroup(
            workspaceId,
            'machine',
            row.deviceId as string,
            { deviceId: row.deviceId, initialName: row.initialName },
            issues
          )
        )
      const exported = journal(tx, workspaceId, groups, issues)
      if (issues.length > MAX_ISSUES + 1)
        issues.splice(MAX_ISSUES, Infinity, {
          source: 'local activity',
          code: WITHHELD,
          message: `${issues.length - MAX_ISSUES} additional local activity issues need review before sharing.`
        })
      return {
        cursor: end,
        done: window.length < limit,
        issues,
        exported
      }
    },
    { behavior: 'immediate' }
  )
}
