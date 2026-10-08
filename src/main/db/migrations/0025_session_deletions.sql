CREATE TABLE `session_deletions` (
  `id` text PRIMARY KEY NOT NULL,
  `session_id` integer NOT NULL UNIQUE REFERENCES `sessions`(`id`),
  `source_file` text,
  `tool` text NOT NULL,
  `claude_session_id` text,
  `started_at` text NOT NULL,
  `ended_at` text NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_session_deletions_source_file` ON `session_deletions` (`source_file`);
