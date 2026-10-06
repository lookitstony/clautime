CREATE INDEX IF NOT EXISTS `idx_session_legacy_conversation` ON `session_legacy_records` (json_extract(`session_json`, '$.claudeSessionId'));
