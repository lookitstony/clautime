import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { sessions, type Session } from './sessions'
import type { SessionModelUsage } from '../../../shared/types/session'

/** Original saved history without a detector anchor; never fabricated activity. */
export const sessionLegacyRecords = sqliteTable(
  'session_legacy_records',
  {
    id: text('id').primaryKey(),
    sessionId: integer('session_id')
      .notNull()
      .unique()
      .references(() => sessions.id),
    version: integer('version').notNull(),
    session: text('session_json', { mode: 'json' }).notNull().$type<Session>(),
    modelUsage: text('model_usage_json', { mode: 'json' }).notNull().$type<SessionModelUsage[]>(),
    createdAt: text('created_at').notNull()
  },
  (table) => [
    index('idx_session_legacy_conversation').on(
      sql`json_extract(${table.session}, '$.claudeSessionId')`
    )
  ]
)
