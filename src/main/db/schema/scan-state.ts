import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

export const scanState = sqliteTable(
  'scan_state',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    filePath: text('file_path').notNull().unique(),
    lastModifiedAt: text('last_modified_at').notNull(),
    lastScannedAt: text('last_scanned_at').notNull(),
    sessionCount: integer('session_count').notNull().default(0)
  },
  (table) => [index('idx_scan_state_file_path').on(table.filePath)]
)

export type ScanState = typeof scanState.$inferSelect
export type NewScanState = typeof scanState.$inferInsert
