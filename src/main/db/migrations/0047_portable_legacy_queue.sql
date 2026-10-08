CREATE TABLE sync_history_suppressions (
  session_id INTEGER PRIMARY KEY NOT NULL REFERENCES sessions(id),
  workspace_id TEXT NOT NULL,
  record_type TEXT NOT NULL CHECK (record_type IN ('legacy-session', 'manual-entry')),
  record_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'duplicate', 'conflict', 'deleted')),
  detail_json TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_sync_history_suppressions_record ON sync_history_suppressions(workspace_id, record_type, record_id);
--> statement-breakpoint
CREATE INDEX idx_sync_history_suppressions_workspace ON sync_history_suppressions(workspace_id, record_type);
--> statement-breakpoint
CREATE TABLE sync_legacy_imports (
  legacy_id TEXT PRIMARY KEY NOT NULL REFERENCES session_legacy_records(id),
  workspace_id TEXT NOT NULL
);
