import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { folderSyncSettings } from '../db/schema/folder-sync'
import { activitySyncAdapter } from './folder-sync-activity-records'
import { collectAvailableActivity } from './folder-sync-activity-export'
import { recordLocalSyncChanges } from './folder-sync-store'
import { SyncError } from './folder-sync-protocol'

/** Capture and its outgoing facts share a transaction, including when transfer is disabled. */
export function journalCapturedActivity<S extends Record<string, unknown>>(
  db: BetterSQLite3Database<S>,
  observationIds: string[]
): void {
  const connection = db
    .select()
    .from(folderSyncSettings)
    .where(eq(folderSyncSettings.slot, 1))
    .get()
  if (!connection || !observationIds.length) return
  try {
    const available = collectAvailableActivity(db, connection.workspaceId, observationIds)
    recordLocalSyncChanges(db, connection.workspaceId, available.changes, activitySyncAdapter)
    if (available.issues.length)
      db.update(folderSyncSettings)
        .set({ error: available.issues.map((issue) => issue.message).join('\n') })
        .where(eq(folderSyncSettings.slot, 1))
        .run()
  } catch (error) {
    // Unsupported local normalization stays durably captured for a later compatible export.
    // Never stop ordinary capture because folder transfer needs a newer build.
    if (!(error instanceof SyncError)) throw error
    db.update(folderSyncSettings)
      .set({ error: error.message })
      .where(eq(folderSyncSettings.slot, 1))
      .run()
  }
}
