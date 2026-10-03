-- Lock health (lock-health-core.js). One battery reading per lock per day
-- (the lock list and TTLock callback records carry electricQuantity), kept
-- 120 days; and per lock the battery band last announced, so alerts only
-- escalate (ok -> forecast -> low -> critical) and restart on a new battery.
CREATE TABLE IF NOT EXISTS lock_battery (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  lock_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  level INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, lock_id, day)
);
CREATE TABLE IF NOT EXISTS lock_health (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  lock_id INTEGER NOT NULL,
  battery_band TEXT NOT NULL DEFAULT 'ok',
  battery_alerted_at TEXT,
  replaced_on TEXT,
  PRIMARY KEY (tenant_id, lock_id)
);
