CREATE TABLE `invoices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` integer NOT NULL REFERENCES `clients`(`id`),
	`stripe_invoice_id` text NOT NULL,
	`status` text NOT NULL DEFAULT 'draft',
	`amount_due_cents` integer NOT NULL DEFAULT 0,
	`amount_paid_cents` integer NOT NULL DEFAULT 0,
	`currency` text NOT NULL DEFAULT 'usd',
	`memo` text,
	`hosted_url` text,
	`due_date` text,
	`paid_at` text,
	`period_start` text,
	`period_end` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_stripe_invoice_id_unique` ON `invoices` (`stripe_invoice_id`);--> statement-breakpoint
CREATE INDEX `idx_invoices_client_id` ON `invoices` (`client_id`);--> statement-breakpoint
CREATE INDEX `idx_invoices_status` ON `invoices` (`status`);--> statement-breakpoint
CREATE TABLE `invoice_line_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`invoice_id` integer NOT NULL REFERENCES `invoices`(`id`),
	`line_date` text,
	`description` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`duration_minutes` integer,
	`session_ids` text,
	`sort_order` integer NOT NULL DEFAULT 0,
	`created_at` text NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_invoice_line_items_invoice_id` ON `invoice_line_items` (`invoice_id`);