CREATE TABLE `session_legacy_records` (
  `id` text PRIMARY KEY NOT NULL,
  `session_id` integer NOT NULL UNIQUE REFERENCES `sessions`(`id`),
  `version` integer NOT NULL,
  `session_json` text NOT NULL,
  `model_usage_json` text NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `session_deletions` ADD `legacy_record_id` text REFERENCES `session_legacy_records`(`id`);
--> statement-breakpoint
INSERT INTO session_legacy_records (id, session_id, version, session_json, model_usage_json, created_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', (random() & 3) + 1, 1) ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  s.id, 1,
  json_object(
    'id', s.id, 'projectPath', s.project_path, 'startedAt', s.started_at,
    'endedAt', s.ended_at, 'durationMinutes', s.duration_minutes,
    'source', s.source, 'description', s.description, 'status', s.status,
    'tool', s.tool, 'claudeSessionId', s.claude_session_id,
    'promptCount', s.prompt_count, 'inputTokens', s.input_tokens,
    'outputTokens', s.output_tokens, 'sourceFile', s.source_file,
    'billable', s.billable, 'projectId', s.project_id, 'clientId', s.client_id,
    'createdAt', s.created_at, 'updatedAt', s.updated_at
  ),
  (SELECT json_group_array(json_object(
    'model', u.model, 'inputTokens', u.input_tokens, 'outputTokens', u.output_tokens,
    'cacheCreationInputTokens', u.cache_creation_input_tokens,
    'cacheReadInputTokens', u.cache_read_input_tokens
  )) FROM session_model_usage u WHERE u.session_id = s.id),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM sessions s
WHERE s.source = 'auto' AND NOT EXISTS (
  SELECT 1 FROM session_derivations d WHERE d.session_id = s.id
);
