import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** Initial shared policy only. Future changes require preview and revision handling. */
export const workspacePolicy = sqliteTable('workspace_policy', {
  slot: integer('slot').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  revisionId: text('revision_id').notNull(),
  policyJson: text('policy_json').notNull()
})
