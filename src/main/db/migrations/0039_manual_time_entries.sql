CREATE TABLE manual_time_entries (
  id TEXT PRIMARY KEY NOT NULL,
  session_id INTEGER NOT NULL UNIQUE REFERENCES sessions(id),
  device_id TEXT REFERENCES source_machines(device_id),
  basis TEXT NOT NULL CHECK (basis IN ('created', 'imported')),
  parent_id TEXT REFERENCES manual_time_entries(id)
);
--> statement-breakpoint
INSERT INTO manual_time_entries(id, session_id, basis)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) ||
  '-' || substr('89ab', (random() & 3) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  id, 'imported' FROM sessions WHERE source = 'manual';
--> statement-breakpoint
-- Preserve the existing manual split lineage using portable entry IDs.
UPDATE manual_time_entries AS child SET parent_id = (
  SELECT parent.id FROM session_splits split
  JOIN manual_time_entries parent ON parent.session_id = split.parent_session_id
  WHERE child.session_id IN (split.first_session_id, split.second_session_id)
);
--> statement-breakpoint
CREATE TRIGGER manual_time_entry_identity_immutable BEFORE UPDATE OF id, session_id, parent_id ON manual_time_entries
WHEN NEW.id IS NOT OLD.id OR NEW.session_id IS NOT OLD.session_id OR NEW.parent_id IS NOT OLD.parent_id
BEGIN
  SELECT RAISE(ABORT, 'Manual time entry identity is immutable');
END;
--> statement-breakpoint
-- Exact local upgrade queue; never portable data.
CREATE TABLE manual_entry_provenance_imports (
  entry_id TEXT PRIMARY KEY NOT NULL REFERENCES manual_time_entries(id)
);
--> statement-breakpoint
INSERT INTO manual_entry_provenance_imports(entry_id) SELECT id FROM manual_time_entries;
