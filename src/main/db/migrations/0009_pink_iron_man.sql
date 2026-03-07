CREATE TABLE `progress_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_file` text NOT NULL,
	`timestamp` text NOT NULL,
	`is_subagent` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_progress_events_source_timestamp` ON `progress_events` (`source_file`,`timestamp`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_progress_events_unique` ON `progress_events` (`source_file`,`timestamp`,`is_subagent`);--> statement-breakpoint
CREATE TABLE `raw_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_file` text NOT NULL,
	`claude_session_id` text,
	`type` text NOT NULL,
	`timestamp` text NOT NULL,
	`cwd` text,
	`git_branch` text,
	`model` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_creation_input_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_input_tokens` integer DEFAULT 0 NOT NULL,
	`uuid` text,
	`parent_uuid` text,
	`is_tool_result` integer DEFAULT 0 NOT NULL,
	`has_tool_use` integer DEFAULT 0 NOT NULL,
	`tool_names` text,
	`is_subagent` integer DEFAULT 0 NOT NULL,
	`project_path_encoded` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_raw_messages_source_timestamp` ON `raw_messages` (`source_file`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_raw_messages_claude_session_id` ON `raw_messages` (`claude_session_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_project_alert_config` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`alert_sound` text DEFAULT 'system' NOT NULL,
	`is_watching` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_project_alert_config`("id", "project_id", "alert_sound", "is_watching") SELECT "id", "project_id", "alert_sound", "is_watching" FROM `project_alert_config`;--> statement-breakpoint
DROP TABLE `project_alert_config`;--> statement-breakpoint
ALTER TABLE `__new_project_alert_config` RENAME TO `project_alert_config`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_alert_config_project_id` ON `project_alert_config` (`project_id`);--> statement-breakpoint
ALTER TABLE `scan_state` ADD `last_file_size` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_raw_messages_source_uuid` ON `raw_messages`(`source_file`, `uuid`) WHERE `uuid` IS NOT NULL;