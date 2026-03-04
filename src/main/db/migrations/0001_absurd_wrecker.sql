CREATE TABLE `scan_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`file_path` text NOT NULL,
	`last_modified_at` text NOT NULL,
	`last_scanned_at` text NOT NULL,
	`session_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scan_state_file_path_unique` ON `scan_state` (`file_path`);--> statement-breakpoint
CREATE INDEX `idx_scan_state_file_path` ON `scan_state` (`file_path`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `claude_session_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `source_file` text;--> statement-breakpoint
CREATE INDEX `idx_sessions_claude_session_id` ON `sessions` (`claude_session_id`);