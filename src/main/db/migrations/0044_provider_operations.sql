CREATE TABLE provider_operations (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  test_mode INTEGER NOT NULL CHECK (test_mode IN (0, 1)),
  kind TEXT NOT NULL,
  request_json TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE provider_operation_steps (
  operation_id TEXT NOT NULL REFERENCES provider_operations(id),
  name TEXT NOT NULL,
  request_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  started_provider_at TEXT NOT NULL,
  PRIMARY KEY (operation_id, name)
);
--> statement-breakpoint
CREATE TABLE provider_operation_results (
  operation_id TEXT NOT NULL,
  name TEXT NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY (operation_id, name),
  FOREIGN KEY (operation_id, name) REFERENCES provider_operation_steps(operation_id, name)
);
--> statement-breakpoint
CREATE TRIGGER provider_operations_no_update BEFORE UPDATE ON provider_operations
BEGIN SELECT RAISE(ABORT, 'Provider operation audit is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER provider_operations_no_delete BEFORE DELETE ON provider_operations
BEGIN SELECT RAISE(ABORT, 'Provider operation audit is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER provider_operation_steps_no_update BEFORE UPDATE ON provider_operation_steps
BEGIN SELECT RAISE(ABORT, 'Provider operation audit is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER provider_operation_steps_no_delete BEFORE DELETE ON provider_operation_steps
BEGIN SELECT RAISE(ABORT, 'Provider operation audit is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER provider_operation_results_no_update BEFORE UPDATE ON provider_operation_results
BEGIN SELECT RAISE(ABORT, 'Provider operation audit is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER provider_operation_results_no_delete BEFORE DELETE ON provider_operation_results
BEGIN SELECT RAISE(ABORT, 'Provider operation audit is immutable'); END;
