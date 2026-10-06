CREATE TABLE source_machines (
  device_id TEXT PRIMARY KEY NOT NULL,
  initial_name TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE activity_observers (
  observation_id TEXT NOT NULL REFERENCES activity_observations(id),
  device_id TEXT NOT NULL REFERENCES source_machines(device_id),
  basis TEXT NOT NULL CHECK (basis IN ('observed', 'imported')),
  PRIMARY KEY (observation_id, device_id, basis)
);
--> statement-breakpoint
CREATE INDEX idx_activity_observers_device ON activity_observers(device_id);
--> statement-breakpoint
-- Local upgrade queue only. These observations predate machine attribution.
CREATE TABLE activity_provenance_imports (
  observation_id TEXT PRIMARY KEY NOT NULL REFERENCES activity_observations(id)
);
--> statement-breakpoint
INSERT INTO activity_provenance_imports(observation_id) SELECT id FROM activity_observations;
