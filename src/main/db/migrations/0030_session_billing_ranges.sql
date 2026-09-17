ALTER TABLE `session_billing_refs` ADD `billed_ranges` text;
--> statement-breakpoint
-- Older invoices did not freeze intervals. Conservatively adopt the currently
-- saved bounds once; later growth must not extend this billing exclusion.
UPDATE session_billing_refs
SET billed_ranges = (
  SELECT json_array(json_object(
    'sessionId', s.id, 'projectId', s.project_id, 'clientId', s.client_id,
    'startedAt', s.started_at, 'endedAt', s.ended_at
  )) FROM sessions s WHERE s.id = session_billing_refs.session_id
);
