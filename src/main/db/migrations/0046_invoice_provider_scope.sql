ALTER TABLE invoices ADD COLUMN provider_account_id TEXT;
--> statement-breakpoint
ALTER TABLE invoices ADD COLUMN operation_id TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX idx_invoices_operation ON invoices(operation_id);
--> statement-breakpoint
ALTER TABLE invoices ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1));
--> statement-breakpoint
CREATE TABLE client_provider_references (
  client_id INTEGER NOT NULL REFERENCES clients(id),
  account_id TEXT NOT NULL,
  test_mode INTEGER NOT NULL CHECK (test_mode IN (0, 1)),
  customer_id TEXT NOT NULL,
  PRIMARY KEY (client_id, account_id, test_mode)
);
