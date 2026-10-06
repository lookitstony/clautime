-- Device IDs are registered outside the portable database. Legacy paths cannot
-- be assigned to a device until explicit local setup; do not infer mappings here.
CREATE TABLE `project_folder_mappings` (
  `device_id` text NOT NULL,
  `project_sync_id` text NOT NULL REFERENCES `projects` (`sync_id`) ON DELETE CASCADE,
  `directory_path` text NOT NULL,
  `directory_key` text NOT NULL,
  `updated_at` text NOT NULL,
  PRIMARY KEY (`device_id`, `project_sync_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_folder_mappings_device_directory_unique`
  ON `project_folder_mappings` (`device_id`, `directory_key`);
