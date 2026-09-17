CREATE TABLE `session_derivations` (
  `session_id` integer PRIMARY KEY NOT NULL REFERENCES `sessions`(`id`) ON DELETE CASCADE,
  `started_at` text NOT NULL,
  `ended_at` text NOT NULL,
  `duration_minutes` integer NOT NULL
);
