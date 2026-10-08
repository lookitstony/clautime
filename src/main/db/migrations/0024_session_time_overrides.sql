CREATE TABLE `session_time_overrides` (
  `session_id` integer PRIMARY KEY NOT NULL REFERENCES `sessions`(`id`) ON DELETE CASCADE,
  `started_at` integer NOT NULL DEFAULT 0,
  `ended_at` integer NOT NULL DEFAULT 0,
  `duration_minutes` integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
INSERT INTO `session_time_overrides` (`session_id`, `started_at`, `ended_at`, `duration_minutes`)
SELECT s.id, s.started_at != d.started_at, s.ended_at != d.ended_at,
       s.duration_minutes != d.duration_minutes
FROM sessions s JOIN session_derivations d ON d.session_id = s.id
WHERE s.started_at != d.started_at OR s.ended_at != d.ended_at
   OR s.duration_minutes != d.duration_minutes;
