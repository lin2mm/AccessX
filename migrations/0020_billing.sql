-- Stripe billing (docs/BILLING.md). One account per tenant once it subscribes.
CREATE TABLE IF NOT EXISTS billing_accounts (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  stripe_customer_id TEXT NOT NULL,
  stripe_subscription_id TEXT,
  status TEXT NOT NULL,
  past_due_since TEXT,
  last_event_at INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS billing_accounts_customer ON billing_accounts (stripe_customer_id);

-- Usage sent to Stripe. The primary key is the idempotency guard: a row is
-- written before the meter event is sent and marked sent afterwards; unsent
-- rows are retried with the same Stripe identifier.
CREATE TABLE IF NOT EXISTS billing_reports (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  meter TEXT NOT NULL,
  report_key TEXT NOT NULL,
  value INTEGER NOT NULL,
  event_at TEXT NOT NULL,
  sent_at TEXT,
  PRIMARY KEY (tenant_id, meter, report_key)
);

-- Stripe webhook events already applied (Stripe retries; delivery order is not guaranteed).
CREATE TABLE IF NOT EXISTS billing_events (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT,
  type TEXT NOT NULL,
  received_at TEXT NOT NULL
);
