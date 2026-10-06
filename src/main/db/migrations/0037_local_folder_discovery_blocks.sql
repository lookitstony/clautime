CREATE TABLE local_folder_discovery_blocks (
  device_id TEXT NOT NULL,
  directory_key TEXT NOT NULL,
  PRIMARY KEY (device_id, directory_key)
);
