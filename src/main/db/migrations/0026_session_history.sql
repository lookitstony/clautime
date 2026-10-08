CREATE TABLE `session_revisions` (
  `id` text PRIMARY KEY NOT NULL,
  `session_id` integer NOT NULL REFERENCES `sessions`(`id`),
  `sequence` integer NOT NULL,
  `parent_revision_id` text REFERENCES `session_revisions`(`id`),
  `kind` text NOT NULL,
  `source_file` text,
  `tool` text NOT NULL,
  `claude_session_id` text,
  `started_at` text,
  `ended_at` text,
  `before_json` text NOT NULL,
  `after_json` text NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_session_revisions_sequence` ON `session_revisions` (`session_id`, `sequence`);
--> statement-breakpoint
CREATE TABLE `session_splits` (
  `revision_id` text PRIMARY KEY NOT NULL REFERENCES `session_revisions`(`id`),
  `parent_session_id` integer NOT NULL UNIQUE REFERENCES `sessions`(`id`),
  `first_session_id` integer NOT NULL UNIQUE REFERENCES `sessions`(`id`),
  `second_session_id` integer NOT NULL UNIQUE REFERENCES `sessions`(`id`),
  `source_file` text,
  `tool` text NOT NULL,
  `claude_session_id` text,
  `started_at` text NOT NULL,
  `ended_at` text NOT NULL,
  `split_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_billing_refs` (
  `session_id` integer NOT NULL REFERENCES `sessions`(`id`),
  `stripe_invoice_id` text NOT NULL,
  `test_mode` integer NOT NULL,
  PRIMARY KEY (`session_id`, `stripe_invoice_id`, `test_mode`)
);
--> statement-breakpoint
WITH RECURSIVE parts(stripe_id, test_mode, value, rest) AS (
  SELECT i.stripe_invoice_id, i.test_mode, '', coalesce(l.session_ids, '') || ','
  FROM invoice_line_items l JOIN invoices i ON i.id = l.invoice_id
  UNION ALL
  SELECT stripe_id, test_mode, trim(substr(rest, 1, instr(rest, ',') - 1)), substr(rest, instr(rest, ',') + 1)
  FROM parts WHERE rest <> ''
)
INSERT OR IGNORE INTO session_billing_refs (session_id, stripe_invoice_id, test_mode)
SELECT s.id, p.stripe_id, p.test_mode FROM parts p JOIN sessions s ON s.id = CAST(p.value AS INTEGER)
WHERE p.value <> '' AND p.value NOT GLOB '*[^0-9]*'
  AND CAST(p.value AS INTEGER) BETWEEN 1 AND 9007199254740991;
