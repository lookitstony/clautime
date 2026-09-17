ALTER TABLE `session_reconciliation_cases` ADD `fingerprint` text;
--> statement-breakpoint
CREATE TABLE `session_reconciliation_resolutions` (
  `id` text PRIMARY KEY NOT NULL,
  `source_file` text NOT NULL,
  `sequence` integer NOT NULL,
  `parent_id` text REFERENCES `session_reconciliation_resolutions`(`id`),
  `action` text NOT NULL,
  `fingerprint` text NOT NULL,
  `comparison_json` text NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_reconciliation_resolution_sequence` ON `session_reconciliation_resolutions` (`source_file`, `sequence`);
