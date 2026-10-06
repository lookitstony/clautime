-- Empty on upgrade. A fresh reviewed preview and explicit selection precede adoption.
CREATE TABLE session_activity_mappings (
  id TEXT PRIMARY KEY NOT NULL,
  session_id INTEGER NOT NULL UNIQUE REFERENCES sessions(id),
  version INTEGER NOT NULL CHECK (version > 0),
  workspace_id TEXT NOT NULL,
  policy_revision_id TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  provider TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  interval_json TEXT NOT NULL,
  preview_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL
);
