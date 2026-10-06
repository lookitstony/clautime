CREATE TABLE workspace_policy_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  parent_revision_id TEXT,
  policy_json TEXT NOT NULL,
  decision_id TEXT,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE session_mapping_decisions (
  id TEXT PRIMARY KEY NOT NULL,
  request_json TEXT NOT NULL,
  preview_fingerprint TEXT NOT NULL,
  base_policy_revision_id TEXT NOT NULL,
  target_policy_revision_id TEXT NOT NULL,
  base_heads_json TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  held_json TEXT NOT NULL,
  observed_decision_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE session_mapping_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  mapping_id TEXT NOT NULL REFERENCES session_activity_mappings(id),
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  kind TEXT NOT NULL CHECK (kind IN ('adopt', 'continue', 'policy', 'split', 'merge')),
  snapshot_json TEXT NOT NULL,
  decision_id TEXT REFERENCES session_mapping_decisions(id),
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE session_mapping_edges (
  child_revision_id TEXT NOT NULL REFERENCES session_mapping_revisions(id),
  parent_revision_id TEXT NOT NULL REFERENCES session_mapping_revisions(id),
  PRIMARY KEY (child_revision_id, parent_revision_id),
  CHECK (child_revision_id <> parent_revision_id)
);
--> statement-breakpoint
CREATE TABLE session_mapping_outcomes (
  decision_id TEXT PRIMARY KEY NOT NULL REFERENCES session_mapping_decisions(id),
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
ALTER TABLE session_activity_mappings ADD COLUMN revision_id TEXT;
--> statement-breakpoint
ALTER TABLE session_reconciliation_cases ADD COLUMN mapping_review INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
INSERT INTO workspace_policy_revisions (id, workspace_id, policy_json, created_at)
SELECT revision_id, workspace_id, policy_json, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM workspace_policy;
--> statement-breakpoint
INSERT INTO workspace_policy_revisions (id, workspace_id, policy_json, created_at)
SELECT policy_revision_id, workspace_id, policy_json, min(created_at)
FROM session_activity_mappings AS m
WHERE NOT EXISTS (SELECT 1 FROM workspace_policy_revisions AS p WHERE p.id = m.policy_revision_id)
GROUP BY policy_revision_id, workspace_id, policy_json;
--> statement-breakpoint
UPDATE session_activity_mappings SET revision_id = id;
--> statement-breakpoint
INSERT INTO session_mapping_revisions (id, mapping_id, session_id, kind, snapshot_json, created_at)
SELECT id, id, session_id, 'adopt', json_object(
  'id', id, 'sessionId', session_id, 'version', version, 'workspaceId', workspace_id,
  'policyRevisionId', policy_revision_id, 'policyJson', policy_json,
  'provider', provider, 'conversationId', conversation_id, 'intervalJson', interval_json,
  'previewFingerprint', preview_fingerprint, 'createdAt', created_at, 'revisionId', revision_id
), created_at FROM session_activity_mappings;
--> statement-breakpoint
CREATE TRIGGER policy_revision_no_update BEFORE UPDATE ON workspace_policy_revisions BEGIN SELECT RAISE(ABORT, 'Policy revisions are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER policy_revision_no_delete BEFORE DELETE ON workspace_policy_revisions BEGIN SELECT RAISE(ABORT, 'Policy revisions are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER mapping_revision_no_update BEFORE UPDATE ON session_mapping_revisions BEGIN SELECT RAISE(ABORT, 'Mapping revisions are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER mapping_revision_no_delete BEFORE DELETE ON session_mapping_revisions BEGIN SELECT RAISE(ABORT, 'Mapping revisions are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER mapping_edge_no_update BEFORE UPDATE ON session_mapping_edges BEGIN SELECT RAISE(ABORT, 'Mapping edges are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER mapping_edge_no_delete BEFORE DELETE ON session_mapping_edges BEGIN SELECT RAISE(ABORT, 'Mapping edges are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER mapping_decision_no_update BEFORE UPDATE ON session_mapping_decisions BEGIN SELECT RAISE(ABORT, 'Mapping decisions are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER mapping_decision_no_delete BEFORE DELETE ON session_mapping_decisions BEGIN SELECT RAISE(ABORT, 'Mapping decisions are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER mapping_outcome_no_update BEFORE UPDATE ON session_mapping_outcomes BEGIN SELECT RAISE(ABORT, 'Mapping outcomes are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER mapping_outcome_no_delete BEFORE DELETE ON session_mapping_outcomes BEGIN SELECT RAISE(ABORT, 'Mapping outcomes are immutable'); END;
