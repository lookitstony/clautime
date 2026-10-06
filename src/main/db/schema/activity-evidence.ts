import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** Logical keys only. Parent links and measurements belong to immutable observations. */
export const activityIdentities = sqliteTable(
  'activity_identities',
  {
    eventId: text('event_id').primaryKey(),
    provider: text('provider').notNull(),
    identityVersion: integer('identity_version').notNull(),
    conversationId: text('conversation_id').notNull(),
    basis: text('basis').notNull(),
    nativeEventId: text('native_event_id')
  },
  (table) => [
    index('idx_activity_identities_conversation').on(table.conversationId, table.provider)
  ]
)

export const activityObservations = sqliteTable(
  'activity_observations',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => activityIdentities.eventId),
    version: integer('version').notNull(),
    kind: text('kind').notNull().$type<'message' | 'activity' | 'checkpoint'>(),
    payloadJson: text('payload_json').notNull(),
    createdAt: text('created_at').notNull()
  },
  (table) => [index('idx_activity_observations_event').on(table.eventId)]
)

/** Local provenance only; source paths never enter portable identity/observation hashes. */
export const activitySources = sqliteTable(
  'activity_sources',
  {
    observationId: text('observation_id')
      .notNull()
      .references(() => activityObservations.id),
    sourceFile: text('source_file').notNull(),
    isSubagent: integer('is_subagent').notNull()
  },
  (table) => [
    primaryKey({ columns: [table.observationId, table.sourceFile, table.isSubagent] }),
    index('idx_activity_sources_file').on(table.sourceFile)
  ]
)
