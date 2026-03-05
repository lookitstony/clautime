import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { projects } from './projects'

export const gitCommits = sqliteTable(
  'git_commits',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id').references(() => projects.id),
    hash: text('hash').notNull(),
    message: text('message').notNull(),
    authorName: text('author_name').notNull(),
    authorEmail: text('author_email').notNull(),
    committedAt: text('committed_at').notNull(),
    sessionId: integer('session_id'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString())
  },
  (table) => [
    index('idx_git_commits_project_id').on(table.projectId),
    index('idx_git_commits_hash').on(table.hash),
    index('idx_git_commits_committed_at').on(table.committedAt),
    index('idx_git_commits_session_id').on(table.sessionId)
  ]
)

export type GitCommit = typeof gitCommits.$inferSelect
export type NewGitCommit = typeof gitCommits.$inferInsert
