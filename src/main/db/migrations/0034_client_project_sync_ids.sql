-- A constant default permits an additive upgrade without rebuilding referenced tables.
-- Backfill before enforcing insert/update guards; application inserts supply randomUUID().
ALTER TABLE `clients` ADD COLUMN `sync_id` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `projects` ADD COLUMN `sync_id` text NOT NULL DEFAULT '';
--> statement-breakpoint
UPDATE `clients` SET `sync_id` = lower(
  hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) ||
  '-' || substr('89ab', (random() & 3) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))
);
--> statement-breakpoint
UPDATE `projects` SET `sync_id` = lower(
  hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) ||
  '-' || substr('89ab', (random() & 3) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clients_sync_id_unique` ON `clients` (`sync_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_sync_id_unique` ON `projects` (`sync_id`);
--> statement-breakpoint
CREATE TRIGGER `clients_sync_id_required` BEFORE INSERT ON `clients`
WHEN length(trim(NEW.sync_id)) = 0
BEGIN
  SELECT RAISE(ABORT, 'Client sync identity is required');
END;
--> statement-breakpoint
CREATE TRIGGER `projects_sync_id_required` BEFORE INSERT ON `projects`
WHEN length(trim(NEW.sync_id)) = 0
BEGIN
  SELECT RAISE(ABORT, 'Project sync identity is required');
END;
--> statement-breakpoint
CREATE TRIGGER `clients_sync_id_immutable` BEFORE UPDATE OF `sync_id` ON `clients`
WHEN NEW.sync_id IS NOT OLD.sync_id
BEGIN
  SELECT RAISE(ABORT, 'Client sync identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `projects_sync_id_immutable` BEFORE UPDATE OF `sync_id` ON `projects`
WHEN NEW.sync_id IS NOT OLD.sync_id
BEGIN
  SELECT RAISE(ABORT, 'Project sync identity is immutable');
END;
