CREATE TABLE folder_sync_settings (
  slot INTEGER PRIMARY KEY CHECK (slot = 1),
  workspace_id TEXT NOT NULL,
  policy_workspace_id TEXT,
  folder_path TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  last_published_at TEXT,
  last_imported_at TEXT,
  error TEXT
);
--> statement-breakpoint
CREATE TABLE sync_changes (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'revision')),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  change_json TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('local', 'imported')),
  recorded_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_sync_changes_entity ON sync_changes(workspace_id, entity_type, entity_id);
--> statement-breakpoint
CREATE INDEX idx_sync_changes_manual_parent ON sync_changes(workspace_id, entity_type, json_extract(change_json, '$.payload.fields.parentId.value'));
--> statement-breakpoint
CREATE TABLE sync_batches (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  writer_epoch_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  device_id TEXT NOT NULL,
  checksum TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  recorded_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_sync_batches_writer_sequence ON sync_batches(workspace_id, writer_epoch_id, sequence);
--> statement-breakpoint
CREATE TABLE sync_batch_changes (
  batch_id TEXT NOT NULL REFERENCES sync_batches(id),
  change_id TEXT NOT NULL REFERENCES sync_changes(id),
  PRIMARY KEY (batch_id, change_id)
);
--> statement-breakpoint
CREATE INDEX idx_sync_batch_changes_change ON sync_batch_changes(change_id);
--> statement-breakpoint
CREATE TABLE sync_outbox (
  batch_id TEXT PRIMARY KEY NOT NULL REFERENCES sync_batches(id),
  published_at TEXT
);
--> statement-breakpoint
CREATE TABLE sync_receipts (
  batch_id TEXT PRIMARY KEY NOT NULL REFERENCES sync_batches(id),
  imported_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE sync_writer_state (
  writer_epoch_id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  next_sequence INTEGER NOT NULL CHECK (next_sequence > 0)
);
--> statement-breakpoint
CREATE TABLE sync_record_states (
  workspace_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  PRIMARY KEY (workspace_id, entity_type, entity_id)
);
--> statement-breakpoint
CREATE TABLE sync_local_links (
  workspace_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  local_id INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, entity_type, entity_id)
);
--> statement-breakpoint
CREATE TRIGGER sync_change_no_update BEFORE UPDATE ON sync_changes BEGIN SELECT RAISE(ABORT, 'Sync changes are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER sync_change_no_delete BEFORE DELETE ON sync_changes BEGIN SELECT RAISE(ABORT, 'Sync changes are retained'); END;
--> statement-breakpoint
CREATE TRIGGER sync_batch_no_update BEFORE UPDATE ON sync_batches BEGIN SELECT RAISE(ABORT, 'Sync batches are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER sync_batch_no_delete BEFORE DELETE ON sync_batches BEGIN SELECT RAISE(ABORT, 'Sync batches are retained'); END;
--> statement-breakpoint
CREATE TRIGGER sync_batch_change_no_update BEFORE UPDATE ON sync_batch_changes BEGIN SELECT RAISE(ABORT, 'Batch membership is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER sync_batch_change_no_delete BEFORE DELETE ON sync_batch_changes BEGIN SELECT RAISE(ABORT, 'Batch membership is retained'); END;
--> statement-breakpoint
CREATE TRIGGER sync_receipt_no_update BEFORE UPDATE ON sync_receipts BEGIN SELECT RAISE(ABORT, 'Sync receipts are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER sync_receipt_no_delete BEFORE DELETE ON sync_receipts BEGIN SELECT RAISE(ABORT, 'Sync receipts are retained'); END;
