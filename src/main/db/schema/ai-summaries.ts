import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { sessions } from './sessions'

export const aiSummaries = sqliteTable(
  'ai_summaries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: integer('session_id')
      .notNull()
      .references(() => sessions.id),
    summary: text('summary').notNull(),
    model: text('model'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString())
  },
  (table) => [index('idx_ai_summaries_session_id').on(table.sessionId)]
)

export type AiSummary = typeof aiSummaries.$inferSelect
