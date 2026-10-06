import { and, eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { activityObservations } from '../db/schema/activity-evidence'
import { activityObservers } from '../db/schema/activity-observers'
import { syncBatches, syncReceipts } from '../db/schema/folder-sync'
import { sessions } from '../db/schema/sessions'
import { manualTimeEntries } from '../db/schema/manual-time-entries'
import { sessionLegacyRecords } from '../db/schema/session-legacy'
import type { SourceMachineCoverage } from '../../shared/types/source-machine'
import { listSourceMachines } from './folder-sync-machine-view'
import { readHistoryObservers } from './folder-sync-history-observers'
import { historySyncWorkspace } from './folder-sync-history-records'

/** Latest retained evidence is a lower bound, never proof that a remote computer is current. */
export function sourceMachineCoverage<S extends Record<string, unknown>>(
  db: BetterSQLite3Database<S>,
  localDeviceId: string | null
): SourceMachineCoverage[] {
  const latest = new Map<string, number>()
  function include(deviceId: string, value: string | null) {
    const time = value ? Date.parse(value) : NaN
    if (Number.isFinite(time))
      latest.set(deviceId, Math.max(latest.get(deviceId) ?? -Infinity, time))
  }
  for (const row of db
    .select({
      deviceId: activityObservers.deviceId,
      // Measurements, rather than the sending computer's import clock.
      time: sql<
        string | null
      >`strftime('%Y-%m-%dT%H:%M:%fZ', max(max(coalesce(julianday(json_extract(${activityObservations.payloadJson}, '$.timestamp')), 0), coalesce(julianday(json_extract(${activityObservations.payloadJson}, '$.timing.startedAt')), 0), coalesce(julianday(json_extract(${activityObservations.payloadJson}, '$.timing.endedAt')), 0), coalesce(julianday(json_extract(${activityObservations.payloadJson}, '$.timing.completedAt')), 0))))`
    })
    .from(activityObservers)
    .innerJoin(activityObservations, eq(activityObservations.id, activityObservers.observationId))
    .groupBy(activityObservers.deviceId)
    .all())
    include(row.deviceId, row.time)
  const manual = db
    .select({
      id: manualTimeEntries.id,
      deviceId: manualTimeEntries.deviceId,
      endedAt: sessions.endedAt
    })
    .from(manualTimeEntries)
    .innerJoin(sessions, eq(sessions.id, manualTimeEntries.sessionId))
    .all()
  const saved = db
    .select({ id: sessionLegacyRecords.id, endedAt: sessions.endedAt })
    .from(sessionLegacyRecords)
    .innerJoin(sessions, eq(sessions.id, sessionLegacyRecords.sessionId))
    .all()
  const bounds = new Map([
    ...manual.map((row) => [`manual-entry:${row.id}`, row.endedAt] as const),
    ...saved.map((row) => [`legacy-session:${row.id}`, row.endedAt] as const)
  ])
  for (const row of manual) if (row.deviceId) include(row.deviceId, row.endedAt)
  const workspaceId = historySyncWorkspace(db)
  for (const row of readHistoryObservers(db, { workspaceId: workspaceId ?? undefined }))
    include(row.deviceId, bounds.get(`${row.recordType}:${row.recordId}`) ?? null)
  const receipts = new Map(
    db
      .select({
        deviceId: syncBatches.deviceId,
        importedAt: sql<string>`max(${syncReceipts.importedAt})`
      })
      .from(syncBatches)
      .innerJoin(syncReceipts, eq(syncReceipts.batchId, syncBatches.id))
      .where(
        and(
          eq(syncBatches.direction, 'incoming'),
          workspaceId ? eq(syncBatches.workspaceId, workspaceId) : undefined
        )
      )
      .groupBy(syncBatches.deviceId)
      .all()
      .map((row) => [row.deviceId, row.importedAt])
  )
  return listSourceMachines(db, localDeviceId).map((machine) => ({
    ...machine,
    latestActivityAt: latest.has(machine.deviceId)
      ? new Date(latest.get(machine.deviceId)!).toISOString()
      : null,
    lastReceivedAt: receipts.get(machine.deviceId) ?? null
  }))
}
