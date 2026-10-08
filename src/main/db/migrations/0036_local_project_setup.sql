-- Keep dependent history while replacing the legacy global path constraint.
PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint
CREATE TABLE `__project_mapping_backup` AS SELECT * FROM `project_folder_mappings`;
--> statement-breakpoint
CREATE TABLE `__project_sequence_backup` AS SELECT seq FROM sqlite_sequence WHERE name = 'projects';
--> statement-breakpoint
CREATE TABLE `__new_projects` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `client_id` integer NOT NULL REFERENCES `clients` (`id`),
  `name` text NOT NULL,
  `directory_path` text,
  `is_billable` integer DEFAULT 1 NOT NULL,
  `is_active` integer DEFAULT 1 NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `invoice_name` text,
  `stage_name` text,
  `hourly_rate` real,
  `sync_id` text NOT NULL DEFAULT ''
);
--> statement-breakpoint
INSERT INTO `__new_projects` SELECT id, client_id, name, directory_path, is_billable, is_active,
  created_at, updated_at, invoice_name, stage_name, hourly_rate, sync_id FROM projects;
--> statement-breakpoint
DROP TABLE `projects`;
--> statement-breakpoint
ALTER TABLE `__new_projects` RENAME TO `projects`;
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_sync_id_unique` ON `projects` (`sync_id`);
--> statement-breakpoint
CREATE INDEX `idx_projects_client_id` ON `projects` (`client_id`);
--> statement-breakpoint
CREATE INDEX `idx_projects_directory_path` ON `projects` (`directory_path`);
--> statement-breakpoint
CREATE TRIGGER `projects_sync_id_required` BEFORE INSERT ON `projects`
WHEN length(trim(NEW.sync_id)) = 0
BEGIN
  SELECT RAISE(ABORT, 'Project sync identity is required');
END;
--> statement-breakpoint
CREATE TRIGGER `projects_sync_id_immutable` BEFORE UPDATE OF `sync_id` ON `projects`
WHEN NEW.sync_id IS NOT OLD.sync_id
BEGIN
  SELECT RAISE(ABORT, 'Project sync identity is immutable');
END;
--> statement-breakpoint
INSERT OR IGNORE INTO project_folder_mappings SELECT * FROM __project_mapping_backup;
--> statement-breakpoint
UPDATE sqlite_sequence SET seq = max(seq, coalesce((SELECT seq FROM __project_sequence_backup), 0))
WHERE name = 'projects';
--> statement-breakpoint
DROP TABLE `__project_mapping_backup`;
--> statement-breakpoint
DROP TABLE `__project_sequence_backup`;
--> statement-breakpoint
CREATE TABLE `local_project_setup` (
  `device_id` text PRIMARY KEY NOT NULL,
  `completed_at` text NOT NULL
);
--> statement-breakpoint
-- Rebuilding a referenced parent can leave deferred violation counters even
-- after its rows are restored. Validate every real reference before clearing them.
CREATE TABLE `__project_fk_check` (`violations` integer NOT NULL CHECK (`violations` = 0));
--> statement-breakpoint
INSERT INTO `__project_fk_check` SELECT count(*) FROM pragma_foreign_key_check;
--> statement-breakpoint
DROP TABLE `__project_fk_check`;
--> statement-breakpoint
PRAGMA defer_foreign_keys = OFF;
