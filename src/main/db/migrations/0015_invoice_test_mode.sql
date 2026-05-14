ALTER TABLE `invoices` ADD `test_mode` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_invoices_test_mode` ON `invoices` (`test_mode`);
