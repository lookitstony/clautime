CREATE TABLE `git_commits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer,
	`hash` text NOT NULL,
	`message` text NOT NULL,
	`author_name` text NOT NULL,
	`author_email` text NOT NULL,
	`committed_at` text NOT NULL,
	`session_id` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_git_commits_project_id` ON `git_commits` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_git_commits_hash` ON `git_commits` (`hash`);--> statement-breakpoint
CREATE INDEX `idx_git_commits_committed_at` ON `git_commits` (`committed_at`);--> statement-breakpoint
CREATE INDEX `idx_git_commits_session_id` ON `git_commits` (`session_id`);