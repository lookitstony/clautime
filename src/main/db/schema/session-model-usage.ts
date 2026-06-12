import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { sessions } from './sessions'

export const sessionModelUsage = sqliteTable(
  'session_model_usage',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: integer('session_id')
      .notNull()
      .references(() => sessions.id),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheCreationInputTokens: integer('cache_creation_input_tokens').notNull().default(0),
    cacheReadInputTokens: integer('cache_read_input_tokens').notNull().default(0)
  },
  (table) => [index('idx_session_model_usage_session_id').on(table.sessionId)]
)

export type SessionModelUsageRow = typeof sessionModelUsage.$inferSelect
export type NewSessionModelUsage = typeof sessionModelUsage.$inferInsert
