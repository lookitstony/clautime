DROP INDEX `idx_secret_scan_state_file_path`;--> statement-breakpoint
ALTER TABLE `secret_findings` ADD `occurrences` integer DEFAULT 1 NOT NULL;