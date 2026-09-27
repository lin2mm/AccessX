-- Lock alarms reported by TTLock records (tamper, forced opening, keypad
-- locked, door left open). One row per reported alarm; `alerted` = 1 for the
-- ones that were announced (at most one per lock and kind per 30 min).
CREATE TABLE IF NOT EXISTS lock_alarms (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  lock_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  record_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  source TEXT NOT NULL,
  alerted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, lock_id, kind, record_at)
);
CREATE INDEX IF NOT EXISTS lock_alarms_recent ON lock_alarms (tenant_id, received_at);
