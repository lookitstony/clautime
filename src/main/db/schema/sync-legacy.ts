import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { sessions } from './sessions'
import { sessionLegacyRecords } from './session-legacy'

/**
 * Rebuildable, non-counting state of portable legacy/manual history: queued or conflicting
 * legacy duplicates, resolved duplicates and synced manual-entry deletions. The session row and
 * its legacy snapshot are always retained for audit; activeSessionCondition excludes them.
 */
export const syncHistorySuppressions = sqliteTable(
  'sync_history_suppressions',
  {
    sessionId: integer('session_id')
      .primaryKey()
      .references(() => sessions.id),
    workspaceId: text('workspace_id').notNull(),
    recordType: text('record_type').notNull().$type<'legacy-session' | 'manual-entry'>(),
    recordId: text('record_id').notNull(),
    status: text('status').notNull().$type<'queued' | 'duplicate' | 'conflict' | 'deleted'>(),
    detailJson: text('detail_json').notNull()
  },
  (table) => [
    uniqueIndex('idx_sync_history_suppressions_record').on(
      table.workspaceId,
      table.recordType,
      table.recordId
    ),
    index('idx_sync_history_suppressions_workspace').on(table.workspaceId, table.recordType)
  ]
)

/** Legacy snapshots created by sync projection; every other legacy row is native local history. */
export const syncLegacyImports = sqliteTable('sync_legacy_imports', {
  legacyId: text('legacy_id')
    .primaryKey()
    .references(() => sessionLegacyRecords.id),
  workspaceId: text('workspace_id').notNull()
})
