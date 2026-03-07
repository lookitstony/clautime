import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const rawMessages = sqliteTable(
  'raw_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sourceFile: text('source_file').notNull(),
    claudeSessionId: text('claude_session_id'),
    type: text('type').notNull(),
    timestamp: text('timestamp').notNull(),
    cwd: text('cwd'),
    gitBranch: text('git_branch'),
    model: text('model'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheCreationInputTokens: integer('cache_creation_input_tokens').notNull().default(0),
    cacheReadInputTokens: integer('cache_read_input_tokens').notNull().default(0),
    uuid: text('uuid'),
    parentUuid: text('parent_uuid'),
    isToolResult: integer('is_tool_result').notNull().default(0),
    hasToolUse: integer('has_tool_use').notNull().default(0),
    toolNames: text('tool_names'),
    isSubagent: integer('is_subagent').notNull().default(0),
    projectPathEncoded: text('project_path_encoded'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString())
  },
  (table) => [
    index('idx_raw_messages_source_timestamp').on(table.sourceFile, table.timestamp),
    index('idx_raw_messages_claude_session_id').on(table.claudeSessionId)
  ]
)

export const progressEvents = sqliteTable(
  'progress_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sourceFile: text('source_file').notNull(),
    timestamp: text('timestamp').notNull(),
    isSubagent: integer('is_subagent').notNull().default(0)
  },
  (table) => [
    index('idx_progress_events_source_timestamp').on(table.sourceFile, table.timestamp),
    uniqueIndex('idx_progress_events_unique').on(table.sourceFile, table.timestamp, table.isSubagent)
  ]
)

export type RawMessage = typeof rawMessages.$inferSelect
export type NewRawMessage = typeof rawMessages.$inferInsert
export type ProgressEvent = typeof progressEvents.$inferSelect
export type NewProgressEvent = typeof progressEvents.$inferInsert
