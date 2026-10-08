CREATE TABLE provider_operation_rejections (
  operation_id TEXT NOT NULL,
  name TEXT NOT NULL,
  proof_json TEXT NOT NULL,
  PRIMARY KEY (operation_id, name),
  FOREIGN KEY (operation_id, name) REFERENCES provider_operation_steps(operation_id, name)
);
--> statement-breakpoint
CREATE TABLE provider_operation_resolutions (
  operation_id TEXT PRIMARY KEY NOT NULL REFERENCES provider_operations(id),
  resolution TEXT NOT NULL CHECK (resolution IN ('cancelled')),
  proof_json TEXT NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER provider_operation_rejections_no_update BEFORE UPDATE ON provider_operation_rejections
BEGIN SELECT RAISE(ABORT, 'Provider operation audit is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER provider_operation_rejections_no_delete BEFORE DELETE ON provider_operation_rejections
BEGIN SELECT RAISE(ABORT, 'Provider operation audit is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER provider_operation_resolutions_no_update BEFORE UPDATE ON provider_operation_resolutions
BEGIN SELECT RAISE(ABORT, 'Provider operation audit is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER provider_operation_resolutions_no_delete BEFORE DELETE ON provider_operation_resolutions
BEGIN SELECT RAISE(ABORT, 'Provider operation audit is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER provider_operation_rejections_not_completed BEFORE INSERT ON provider_operation_rejections
WHEN EXISTS (SELECT 1 FROM provider_operation_results WHERE operation_id = NEW.operation_id AND name = NEW.name)
BEGIN SELECT RAISE(ABORT, 'A completed provider step cannot be rejected'); END;
--> statement-breakpoint
CREATE TRIGGER provider_operation_results_not_rejected BEFORE INSERT ON provider_operation_results
WHEN EXISTS (SELECT 1 FROM provider_operation_rejections WHERE operation_id = NEW.operation_id AND name = NEW.name)
BEGIN SELECT RAISE(ABORT, 'A rejected provider step cannot complete'); END;
