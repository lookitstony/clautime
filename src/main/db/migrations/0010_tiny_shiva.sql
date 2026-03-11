CREATE TABLE `secret_findings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_file` text NOT NULL,
	`line_number` integer NOT NULL,
	`secret_type` text NOT NULL,
	`redacted_preview` text NOT NULL,
	`severity` text NOT NULL,
	`context` text NOT NULL,
	`scanned_at` text NOT NULL,
	`status` text DEFAULT 'found' NOT NULL,
	`redacted_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_secret_findings_source_file` ON `secret_findings` (`source_file`);--> statement-breakpoint
CREATE INDEX `idx_secret_findings_severity` ON `secret_findings` (`severity`);--> statement-breakpoint
CREATE INDEX `idx_secret_findings_status` ON `secret_findings` (`status`);--> statement-breakpoint
CREATE TABLE `secret_scan_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`file_path` text NOT NULL,
	`last_modified_at` text NOT NULL,
	`last_scanned_at` text NOT NULL,
	`last_file_size` integer DEFAULT 0 NOT NULL,
	`finding_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `secret_scan_state_file_path_unique` ON `secret_scan_state` (`file_path`);--> statement-breakpoint
CREATE INDEX `idx_secret_scan_state_file_path` ON `secret_scan_state` (`file_path`);