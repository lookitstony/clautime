CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_path` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text NOT NULL,
	`duration_minutes` integer NOT NULL,
	`source` text DEFAULT 'auto' NOT NULL,
	`description` text,
	`status` text DEFAULT 'completed' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_project_path` ON `sessions` (`project_path`);--> statement-breakpoint
CREATE INDEX `idx_sessions_started_at` ON `sessions` (`started_at`);