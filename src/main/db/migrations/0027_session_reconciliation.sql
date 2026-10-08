CREATE TABLE `session_reconciliation_cases` (
  `source_file` text PRIMARY KEY NOT NULL,
  `message` text NOT NULL,
  `saved_json` text NOT NULL,
  `detected_json` text NOT NULL,
  `idle_timeout_minutes` integer NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `resolved_at` text
);
