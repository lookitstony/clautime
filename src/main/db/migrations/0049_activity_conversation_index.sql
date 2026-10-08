CREATE INDEX IF NOT EXISTS `idx_activity_identities_conversation` ON `activity_identities` (`conversation_id`, `provider`);
