import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn
} from 'drizzle-orm/sqlite-core'
import type {
  ReconciliationPreview,
  SessionReconciliationCase,
  SessionActivityMapping,
  SessionReplacementChoice
} from '../../../shared/types/session'

/** Last failed comparison per source; successful reconciliation retains the resolved record. */
export const sessionReconciliationCases = sqliteTable('session_reconciliation_cases', {
  sourceFile: text('source_file').primaryKey(),
  message: text('message').notNull(),
  saved: text('saved_json', { mode: 'json' }).notNull().$type<ReconciliationPreview[]>(),
  detected: text('detected_json', { mode: 'json' }).notNull().$type<ReconciliationPreview[]>(),
  idleTimeoutMinutes: integer('idle_timeout_minutes').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  resolvedAt: text('resolved_at'),
  fingerprint: text('fingerprint')
})

/** Append-only explicit choices, linked by source-local revision sequence. */
export const sessionReconciliationResolutions = sqliteTable(
  'session_reconciliation_resolutions',
  {
    id: text('id').primaryKey(),
    sourceFile: text('source_file').notNull(),
    sequence: integer('sequence').notNull(),
    parentId: text('parent_id').references(
      (): AnySQLiteColumn => sessionReconciliationResolutions.id
    ),
    action: text('action').notNull().$type<'keep_saved' | 'map_saved' | 'replace_saved'>(),
    fingerprint: text('fingerprint').notNull(),
    comparison: text('comparison_json', { mode: 'json' }).notNull().$type<
      SessionReconciliationCase & {
        mappings?: SessionActivityMapping[]
        choices?: SessionReplacementChoice[]
      }
    >(),
    createdAt: text('created_at').notNull()
  },
  (table) => [
    uniqueIndex('idx_reconciliation_resolution_sequence').on(table.sourceFile, table.sequence)
  ]
)
