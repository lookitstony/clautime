ALTER TABLE `session_splits` ADD `legacy_record_id` text REFERENCES `session_legacy_records`(`id`);
