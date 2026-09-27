-- Alerts that could not be delivered (network, timeout, 5xx, 429) wait here
-- and are retried by the scheduled maintenance with backoff. The message is
-- stored, never the webhook URL or the recipients: a retry goes to the channel
-- as configured at that moment. Rows are deleted once delivered or given up
-- (`alerts.dropped` audit entry).
CREATE TABLE IF NOT EXISTS alert_outbox (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  id TEXT NOT NULL,              -- <alert id>:<channel>
  channel TEXT NOT NULL,         -- webhook | email
  event TEXT NOT NULL,
  message TEXT NOT NULL,         -- JSON {title, text, facts, path, at}
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  next_at TEXT NOT NULL,
  last_error TEXT,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS alert_outbox_due ON alert_outbox (tenant_id, next_at);
