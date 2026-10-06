import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/** Local connection details are never part of a portable change. */
export const folderSyncSettings = sqliteTable('folder_sync_settings', {
  slot: integer('slot').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  /** Local mapping workspace bound during setup; existing audit identities stay intact. */
  policyWorkspaceId: text('policy_workspace_id'),
  folderPath: text('folder_path').notNull(),
  enabled: integer('enabled').notNull().default(0),
  lastPublishedAt: text('last_published_at'),
  lastImportedAt: text('last_imported_at'),
  error: text('error')
})

/** Durable local changes are the outgoing queue before an immutable batch is assembled. */
export const syncChanges = sqliteTable(
  'sync_changes',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    kind: text('kind').notNull().$type<'fact' | 'revision'>(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    changeJson: text('change_json').notNull(),
    origin: text('origin').notNull().$type<'local' | 'imported'>(),
    recordedAt: text('recorded_at').notNull()
  },
  (table) => [
    index('idx_sync_changes_type').on(table.entityType),
    index('idx_sync_changes_entity').on(table.workspaceId, table.entityType, table.entityId),
    index('idx_sync_changes_manual_parent').on(
      table.workspaceId,
      table.entityType,
      sql`json_extract(${table.changeJson}, '$.payload.fields.parentId.value')`
    )
  ]
)

/** Retain complete received and outgoing envelopes. Missing folder files never erase these. */
export const syncBatches = sqliteTable(
  'sync_batches',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    writerEpochId: text('writer_epoch_id').notNull(),
    sequence: integer('sequence').notNull(),
    deviceId: text('device_id').notNull(),
    checksum: text('checksum').notNull(),
    envelopeJson: text('envelope_json').notNull(),
    direction: text('direction').notNull().$type<'incoming' | 'outgoing'>(),
    recordedAt: text('recorded_at').notNull()
  },
  (table) => [
    uniqueIndex('idx_sync_batches_writer_sequence').on(
      table.workspaceId,
      table.writerEpochId,
      table.sequence
    )
  ]
)

export const syncBatchChanges = sqliteTable(
  'sync_batch_changes',
  {
    batchId: text('batch_id')
      .notNull()
      .references(() => syncBatches.id),
    changeId: text('change_id')
      .notNull()
      .references(() => syncChanges.id)
  },
  (table) => [
    primaryKey({ columns: [table.batchId, table.changeId] }),
    index('idx_sync_batch_changes_change').on(table.changeId)
  ]
)

/** Publication is only an observed local rename, never a claim of cloud delivery. */
export const syncOutbox = sqliteTable('sync_outbox', {
  batchId: text('batch_id')
    .primaryKey()
    .references(() => syncBatches.id),
  publishedAt: text('published_at')
})

/** Inserted in the same transaction as the batch's logical changes and projections. */
export const syncReceipts = sqliteTable('sync_receipts', {
  batchId: text('batch_id')
    .primaryKey()
    .references(() => syncBatches.id),
  importedAt: text('imported_at').notNull()
})

export const syncWriterState = sqliteTable('sync_writer_state', {
  writerEpochId: text('writer_epoch_id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  nextSequence: integer('next_sequence').notNull()
})

/** Rebuildable causal view. Domain adapters validate fields before writing business tables. */
export const syncRecordStates = sqliteTable(
  'sync_record_states',
  {
    workspaceId: text('workspace_id').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    stateJson: text('state_json').notNull()
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.entityType, table.entityId] })]
)

/** Local compatibility IDs do not enter portable payloads. */
export const syncLocalLinks = sqliteTable(
  'sync_local_links',
  {
    workspaceId: text('workspace_id').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    localId: integer('local_id').notNull()
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.entityType, table.entityId] })]
)
