CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER IF NOT EXISTS app_state_update_timestamp
AFTER UPDATE ON app_state
FOR EACH ROW
BEGIN
  UPDATE app_state SET updated_at = CURRENT_TIMESTAMP WHERE key = NEW.key;
END;

-- Deliberate no-op: a trigger must not be the last statement of a migration
-- (D1 remote splitter, cloudflare/workers-sdk#15314). Harmless where already applied.
UPDATE app_state SET key = key WHERE 0;
