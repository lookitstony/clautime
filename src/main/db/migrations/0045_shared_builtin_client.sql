-- The built-in Unassigned client is identified by role, not name. Before this migration the
-- reserved name itself was that identity, so an existing "Unassigned" row is the built-in.
-- Local IDs, syncIds, folder mappings and invoice references are untouched.
ALTER TABLE `clients` ADD COLUMN `system_role` text CHECK (`system_role` IN ('unassigned'));
--> statement-breakpoint
UPDATE `clients` SET `system_role` = 'unassigned' WHERE `name` = 'Unassigned';
--> statement-breakpoint
CREATE UNIQUE INDEX `clients_system_role_unique` ON `clients` (`system_role`);
--> statement-breakpoint
CREATE TRIGGER `clients_system_role_immutable` BEFORE UPDATE OF `system_role` ON `clients`
WHEN NEW.system_role IS NOT OLD.system_role
BEGIN
  SELECT RAISE(ABORT, 'Client system role is immutable');
END;
