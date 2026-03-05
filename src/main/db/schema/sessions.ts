import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { clients } from './clients'
import { projects } from './projects'

export const sessions = sqliteTable(
  'sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectPath: text('project_path').notNull(),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at').notNull(),
    durationMinutes: integer('duration_minutes').notNull(),
    source: text('source').notNull().$type<'auto' | 'manual'>().default('auto'),
    description: text('description'),
    status: text('status').notNull().$type<'active' | 'completed'>().default('completed'),
    claudeSessionId: text('claude_session_id'),
    sourceFile: text('source_file'),
    projectId: integer('project_id').references(() => projects.id),
    clientId: integer('client_id').references(() => clients.id),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString())
  },
  (table) => [
    index('idx_sessions_project_path').on(table.projectPath),
    index('idx_sessions_started_at').on(table.startedAt),
    index('idx_sessions_claude_session_id').on(table.claudeSessionId),
    index('idx_sessions_project_id').on(table.projectId),
    index('idx_sessions_client_id').on(table.clientId)
  ]
)

export type Session = typeof sessions.$inferSelect
export type NewSession = typeof sessions.$inferInsert
