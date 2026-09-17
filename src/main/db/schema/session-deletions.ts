import { sql } from 'drizzle-orm'
import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core'
import { sessions } from './sessions'
import { sessionSplits, sessionReplacements } from './session-history'
import { sessionLegacyRecords } from './session-legacy'

/** Local deletion intent. Keep the original row and its invoice references. */
export const sessionDeletions = sqliteTable(
  'session_deletions',
  {
    id: text('id').primaryKey(),
    sessionId: integer('session_id')
      .notNull()
      .unique()
      .references(() => sessions.id),
    sourceFile: text('source_file'),
    tool: text('tool').notNull(),
    claudeSessionId: text('claude_session_id'),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at').notNull(),
    createdAt: text('created_at').notNull(),
    // With a legacy reference, saved times are audit metadata, not detector anchors.
    legacyRecordId: text('legacy_record_id').references(() => sessionLegacyRecords.id)
  },
  (table) => [index('idx_session_deletions_source_file').on(table.sourceFile)]
)

/** Apply to active-history queries; audit lookups deliberately retain rows. */
export const activeSessionCondition = sql`NOT EXISTS (
  SELECT 1 FROM ${sessionDeletions} WHERE ${sessionDeletions.sessionId} = ${sessions.id}
) AND NOT EXISTS (
  SELECT 1 FROM ${sessionSplits} WHERE ${sessionSplits.parentSessionId} = ${sessions.id}
) AND NOT EXISTS (
  SELECT 1 FROM ${sessionReplacements} WHERE ${sessionReplacements.predecessorSessionId} = ${sessions.id}
)`
