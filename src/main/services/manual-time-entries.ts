import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { getDb } from '../db'
import { manualTimeEntries } from '../db/schema/manual-time-entries'
import { sourceMachines } from '../db/schema/activity-observers'
import { getLocalDeviceSession } from './device-context'
import type { ObservingDevice } from './activity-provenance'

/** Called inside the transaction that creates the completed session or split child. */
export function recordManualTimeEntry(
  tx: Pick<ReturnType<typeof getDb>, 'insert'>,
  sessionId: number,
  parentId: string | null = null
): void {
  const device = getLocalDeviceSession()
  tx.insert(sourceMachines)
    .values({ deviceId: device.deviceId, initialName: device.machineName })
    .onConflictDoNothing()
    .run()
  tx.insert(manualTimeEntries)
    .values({ id: randomUUID(), sessionId, deviceId: device.deviceId, basis: 'created', parentId })
    .run()
}

export function getManualTimeEntry(
  db: Pick<ReturnType<typeof getDb>, 'select'>,
  sessionId: number
) {
  return db.select().from(manualTimeEntries).where(eq(manualTimeEntries.sessionId, sessionId)).get()
}

/** Attribute only migrated entries; a restart or copied DB never changes their provenance. */
export function initializeManualEntryProvenance<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  device: ObservingDevice
): void {
  db.transaction((tx) => {
    tx.insert(sourceMachines)
      .values({ deviceId: device.deviceId, initialName: device.machineName })
      .onConflictDoNothing()
      .run()
    tx.run(sql`UPDATE manual_time_entries SET device_id = ${device.deviceId}
      WHERE device_id IS NULL AND id IN (SELECT entry_id FROM manual_entry_provenance_imports)`)
    tx.run(sql`DELETE FROM manual_entry_provenance_imports`)
  })
}
