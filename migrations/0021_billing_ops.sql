-- Billing operations (docs/40-BILLING.md): owner notices per non-payment
-- stage, Stripe meter errors on the report they belong to, and platform-side
-- problems (meter errors, reports stuck unsent, accounts due for closure).
ALTER TABLE billing_accounts ADD COLUMN notice_stage TEXT;
ALTER TABLE billing_reports ADD COLUMN error TEXT;
CREATE TABLE IF NOT EXISTS billing_problems (
  problem_key TEXT PRIMARY KEY,
  tenant_id TEXT,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL,
  notified_at TEXT,
  resolved_at TEXT,
  resolved_by TEXT
);
CREATE INDEX IF NOT EXISTS billing_problems_open ON billing_problems (resolved_at, created_at);
