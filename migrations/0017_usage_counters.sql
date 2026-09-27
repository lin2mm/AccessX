-- Metered usage per tenant and calendar month (UTC), e.g. SMS for billing
-- and the monthly cap. kind: sms (messages accepted by the provider),
-- sms_segments (what the provider bills).
CREATE TABLE IF NOT EXISTS usage_counters (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  period TEXT NOT NULL,
  kind TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, period, kind)
);
