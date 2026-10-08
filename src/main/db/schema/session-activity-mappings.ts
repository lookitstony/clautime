import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { sessions } from './sessions'

/** Explicit adoption snapshots, never automatic ownership inferred during a scan. */
export const sessionActivityMappings = sqliteTable('session_activity_mappings', {
  id: text('id').primaryKey(),
  sessionId: integer('session_id')
    .notNull()
    .unique()
    .references(() => sessions.id),
  version: integer('version').notNull(),
  workspaceId: text('workspace_id').notNull(),
  policyRevisionId: text('policy_revision_id').notNull(),
  policyJson: text('policy_json').notNull(),
  provider: text('provider').notNull(),
  conversationId: text('conversation_id').notNull(),
  intervalJson: text('interval_json').notNull(),
  previewFingerprint: text('preview_fingerprint').notNull(),
  createdAt: text('created_at').notNull(),
  revisionId: text('revision_id')
})
