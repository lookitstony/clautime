import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

export const secretFindings = sqliteTable(
  'secret_findings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sourceFile: text('source_file').notNull(),
    lineNumber: integer('line_number').notNull(),
    secretType: text('secret_type').notNull(),
    redactedPreview: text('redacted_preview').notNull(),
    severity: text('severity').notNull(),
    context: text('context').notNull(),
    scannedAt: text('scanned_at').notNull(),
    status: text('status').notNull().default('found'),
    redactedAt: text('redacted_at'),
    occurrences: integer('occurrences').notNull().default(1)
  },
  (table) => [
    index('idx_secret_findings_source_file').on(table.sourceFile),
    index('idx_secret_findings_severity').on(table.severity),
    index('idx_secret_findings_status').on(table.status)
  ]
)

export const secretScanState = sqliteTable(
  'secret_scan_state',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    filePath: text('file_path').notNull().unique(),
    lastModifiedAt: text('last_modified_at').notNull(),
    lastScannedAt: text('last_scanned_at').notNull(),
    lastFileSize: integer('last_file_size').notNull().default(0),
    findingCount: integer('finding_count').notNull().default(0)
  },
  () => [] // unique constraint on filePath already creates an index
)

export type SecretFindingRow = typeof secretFindings.$inferSelect
export type NewSecretFinding = typeof secretFindings.$inferInsert
export type SecretScanStateRow = typeof secretScanState.$inferSelect
export type NewSecretScanState = typeof secretScanState.$inferInsert
