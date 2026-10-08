import type Database from 'better-sqlite3'

/** Disposable fixtures only: restore the schema preceding migration 0052. */
export function removeProjectRootCommit(sqlite: Database.Database): void {
  if (
    sqlite.prepare("SELECT 1 FROM pragma_table_info('projects') WHERE name = 'root_commit'").get()
  )
    sqlite.exec('ALTER TABLE projects DROP COLUMN root_commit')
  sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at = ?').run(1790640000003)
}

/** Disposable fixtures only: restore the schema preceding migration 0048. */
export function removeProviderOperationResolutions(sqlite: Database.Database): void {
  removeProjectRootCommit(sqlite)
  sqlite.exec(
    'DROP INDEX IF EXISTS idx_activity_identities_conversation; DROP INDEX IF EXISTS idx_sync_changes_type; DROP INDEX IF EXISTS idx_session_legacy_conversation'
  )
  sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at >= ?').run(1790640000000)
  sqlite.exec(
    'DROP TRIGGER provider_operation_results_not_rejected; DROP TABLE provider_operation_resolutions; DROP TABLE provider_operation_rejections'
  )
  sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at = ?').run(1790467200007)
}

/** Disposable fixtures only: restore the schema preceding migration 0047. */
export function removePortableLegacyQueue(sqlite: Database.Database): void {
  removeProviderOperationResolutions(sqlite)
  sqlite.exec('DROP TABLE sync_legacy_imports; DROP TABLE sync_history_suppressions')
  sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at = ?').run(1790467200006)
}

/** Disposable fixtures only: restore the schema preceding migration 0046. */
export function removeInvoiceProviderScope(sqlite: Database.Database): void {
  removePortableLegacyQueue(sqlite)
  sqlite.exec(
    'DROP TABLE client_provider_references; DROP INDEX idx_invoices_operation; ALTER TABLE invoices DROP COLUMN operation_id; ALTER TABLE invoices DROP COLUMN provider_account_id; ALTER TABLE invoices DROP COLUMN hidden'
  )
  sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at = ?').run(1790467200005)
}

/** Disposable fixtures only: restore the schema preceding migration 0045. */
export function removeSharedBuiltinClient(sqlite: Database.Database): void {
  removeInvoiceProviderScope(sqlite)
  sqlite.exec(
    'DROP TRIGGER clients_system_role_immutable; DROP INDEX clients_system_role_unique; ALTER TABLE clients DROP COLUMN system_role'
  )
  sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at = ?').run(1790467200004)
}

/** Disposable fixtures only: restore the schema preceding migration 0044. */
export function removeProviderOperations(sqlite: Database.Database): void {
  removeSharedBuiltinClient(sqlite)
  sqlite.exec(
    'DROP TABLE provider_operation_results; DROP TABLE provider_operation_steps; DROP TABLE provider_operations'
  )
  sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at = ?').run(1790467200003)
}

/** Disposable fixtures only: restore the schema preceding migration 0043. */
export function removeFolderSyncJournal(sqlite: Database.Database): void {
  removeProviderOperations(sqlite)
  sqlite.exec(
    'DROP TABLE sync_local_links; DROP TABLE sync_record_states; DROP TABLE sync_writer_state; DROP TABLE sync_receipts; DROP TABLE sync_outbox; DROP TABLE sync_batch_changes; DROP TABLE sync_batches; DROP TABLE sync_changes; DROP TABLE folder_sync_settings'
  )
  sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at = ?').run(1790467200002)
}

/** Disposable fixtures only: restore the schema preceding migration 0042. */
export function removeSessionMappingRevisions(sqlite: Database.Database): void {
  removeFolderSyncJournal(sqlite)
  sqlite.exec(
    'DROP TABLE session_mapping_outcomes; DROP TABLE session_mapping_edges; DROP TABLE session_mapping_revisions; DROP TABLE session_mapping_decisions; DROP TABLE workspace_policy_revisions'
  )
  sqlite.exec('ALTER TABLE session_activity_mappings DROP COLUMN revision_id')
  if (
    sqlite
      .prepare(
        "SELECT 1 FROM pragma_table_info('session_reconciliation_cases') WHERE name = 'mapping_review'"
      )
      .get()
  )
    sqlite.exec('ALTER TABLE session_reconciliation_cases DROP COLUMN mapping_review')
  sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at = ?').run(1790467200001)
}

/** Disposable fixtures only: restore the schema preceding migration 0041. */
export function removeSessionActivityMappings(sqlite: Database.Database): void {
  removeSessionMappingRevisions(sqlite)
  sqlite.exec('DROP TABLE session_activity_mappings')
  sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at = ?').run(1790467200000)
}

/** Disposable migration fixtures only: restore the schema preceding migration 0035. */
export function removeProjectFolderMappings(sqlite: Database.Database): void {
  removeSessionActivityMappings(sqlite)
  sqlite.exec('DROP TABLE workspace_policy')
  sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at = ?').run(1790380800002)
  sqlite.exec('DROP TABLE manual_entry_provenance_imports; DROP TABLE manual_time_entries')
  sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at = ?').run(1790380800001)
  sqlite.exec(
    'DROP TABLE activity_provenance_imports; DROP TABLE activity_observers; DROP TABLE source_machines'
  )
  sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at = ?').run(1790380800000)
  sqlite.exec('DROP TABLE local_folder_discovery_blocks')
  sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at = ?').run(1790294400001)
  sqlite.exec('DROP TABLE local_project_setup')
  sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at = ?').run(1790294400000)
  sqlite.exec('DROP TABLE project_folder_mappings')
  sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at = ?').run(1789603200009)
}

/** Disposable migration fixtures only: restore the schema preceding migration 0034. */
export function removeClientProjectSyncIds(sqlite: Database.Database): void {
  removeProjectFolderMappings(sqlite)
  sqlite.exec(`
    DROP TRIGGER clients_sync_id_required;
    DROP TRIGGER projects_sync_id_required;
    DROP TRIGGER clients_sync_id_immutable;
    DROP TRIGGER projects_sync_id_immutable;
    DROP INDEX clients_sync_id_unique;
    DROP INDEX projects_sync_id_unique;
    ALTER TABLE clients DROP COLUMN sync_id;
    ALTER TABLE projects DROP COLUMN sync_id;
  `)
  sqlite.prepare('DELETE FROM __drizzle_migrations WHERE created_at = ?').run(1789603200008)
}
