import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { sql } from 'drizzle-orm'
import { sourceMachines } from '../db/schema/activity-observers'

export type ObservingDevice = { deviceId: string; machineName: string }

/** Attribute only the exact pre-upgrade observations; never infer their original machine. */
export function initializeActivityProvenance<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  device: ObservingDevice
): void {
  db.transaction((tx) => {
    tx.insert(sourceMachines)
      .values({ deviceId: device.deviceId, initialName: device.machineName })
      .onConflictDoNothing()
      .run()
    tx.run(sql`INSERT OR IGNORE INTO activity_observers(observation_id, device_id, basis)
      SELECT observation_id, ${device.deviceId}, 'imported' FROM activity_provenance_imports`)
    tx.run(sql`DELETE FROM activity_provenance_imports`)
  })
}
