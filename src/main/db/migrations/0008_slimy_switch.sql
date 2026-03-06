CREATE TABLE `project_alert_config` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`alert_sound` text DEFAULT 'default' NOT NULL,
	`is_watching` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_alert_config_project_id` ON `project_alert_config` (`project_id`);