-- Empty on upgrade: workspace creation/join must be an explicit setup operation.
CREATE TABLE workspace_policy (
  slot INTEGER PRIMARY KEY NOT NULL CHECK (slot = 1),
  workspace_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  policy_json TEXT NOT NULL
);
