CREATE TABLE `activity_identities` (
  `event_id` text PRIMARY KEY NOT NULL,
  `provider` text NOT NULL,
  `identity_version` integer NOT NULL,
  `conversation_id` text NOT NULL,
  `basis` text NOT NULL,
  `native_event_id` text
);
--> statement-breakpoint
CREATE TABLE `activity_observations` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL REFERENCES `activity_identities`(`event_id`),
  `version` integer NOT NULL,
  `kind` text NOT NULL,
  `payload_json` text NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_activity_observations_event` ON `activity_observations` (`event_id`);
--> statement-breakpoint
CREATE TABLE `activity_sources` (
  `observation_id` text NOT NULL REFERENCES `activity_observations`(`id`),
  `source_file` text NOT NULL,
  `is_subagent` integer NOT NULL,
  PRIMARY KEY (`observation_id`, `source_file`, `is_subagent`)
);
--> statement-breakpoint
CREATE INDEX `idx_activity_sources_file` ON `activity_sources` (`source_file`);
--> statement-breakpoint
-- Existing raw rows lack the original payload needed to recover identity.
-- Re-read available logs once; retain all saved history when logs are absent.
UPDATE `scan_state` SET `last_file_size` = 0, `last_scanned_at` = '';
