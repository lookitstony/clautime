import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { sessions } from './sessions'
import { sessionActivityMappings } from './session-activity-mappings'

export const workspacePolicyRevisions = sqliteTable('workspace_policy_revisions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  parentRevisionId: text('parent_revision_id'),
  policyJson: text('policy_json').notNull(),
  decisionId: text('decision_id'),
  createdAt: text('created_at').notNull()
})

export const sessionMappingDecisions = sqliteTable('session_mapping_decisions', {
  id: text('id').primaryKey(),
  requestJson: text('request_json').notNull(),
  previewFingerprint: text('preview_fingerprint').notNull(),
  basePolicyRevisionId: text('base_policy_revision_id').notNull(),
  targetPolicyRevisionId: text('target_policy_revision_id').notNull(),
  baseHeadsJson: text('base_heads_json').notNull(),
  planJson: text('plan_json').notNull(),
  heldJson: text('held_json').notNull(),
  observedDecisionIdsJson: text('observed_decision_ids_json').notNull().default('[]'),
  createdAt: text('created_at').notNull()
})

/** Immutable versions; the existing mappings table is the current local projection. */
export const sessionMappingRevisions = sqliteTable('session_mapping_revisions', {
  id: text('id').primaryKey(),
  mappingId: text('mapping_id')
    .notNull()
    .references(() => sessionActivityMappings.id),
  sessionId: integer('session_id')
    .notNull()
    .references(() => sessions.id),
  kind: text('kind').notNull().$type<'adopt' | 'continue' | 'policy' | 'split' | 'merge'>(),
  snapshotJson: text('snapshot_json').notNull(),
  decisionId: text('decision_id').references(() => sessionMappingDecisions.id),
  createdAt: text('created_at').notNull()
})

export const sessionMappingEdges = sqliteTable(
  'session_mapping_edges',
  {
    childRevisionId: text('child_revision_id')
      .notNull()
      .references(() => sessionMappingRevisions.id),
    parentRevisionId: text('parent_revision_id')
      .notNull()
      .references(() => sessionMappingRevisions.id)
  },
  (table) => [primaryKey({ columns: [table.childRevisionId, table.parentRevisionId] })]
)

export const sessionMappingOutcomes = sqliteTable('session_mapping_outcomes', {
  decisionId: text('decision_id')
    .primaryKey()
    .references(() => sessionMappingDecisions.id),
  resultJson: text('result_json').notNull(),
  createdAt: text('created_at').notNull()
})
