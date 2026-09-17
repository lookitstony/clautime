CREATE TABLE `session_replacements` (
  `predecessor_session_id` integer NOT NULL REFERENCES `sessions`(`id`),
  `successor_session_id` integer NOT NULL REFERENCES `sessions`(`id`),
  `revision_id` text NOT NULL REFERENCES `session_revisions`(`id`),
  PRIMARY KEY (`predecessor_session_id`, `successor_session_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_session_replacements_successor` ON `session_replacements` (`successor_session_id`);
