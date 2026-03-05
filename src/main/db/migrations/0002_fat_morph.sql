CREATE TABLE `clients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clients_name_unique` ON `clients` (`name`);--> statement-breakpoint
CREATE INDEX `idx_clients_name` ON `clients` (`name`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` integer NOT NULL,
	`name` text NOT NULL,
	`directory_path` text NOT NULL,
	`is_billable` integer DEFAULT true NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_directory_path_unique` ON `projects` (`directory_path`);--> statement-breakpoint
CREATE INDEX `idx_projects_client_id` ON `projects` (`client_id`);--> statement-breakpoint
CREATE INDEX `idx_projects_directory_path` ON `projects` (`directory_path`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `project_id` integer REFERENCES projects(id);--> statement-breakpoint
ALTER TABLE `sessions` ADD `client_id` integer REFERENCES clients(id);--> statement-breakpoint
CREATE INDEX `idx_sessions_project_id` ON `sessions` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_client_id` ON `sessions` (`client_id`);