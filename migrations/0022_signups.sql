-- R15 self-service signup (docs/21-SIGNUP.md). One row per request; the
-- tenant is only created when the emailed link is opened (email verified).
-- Rows hold personal data (email, name) and are deleted after 7 days by the
-- scheduled maintenance, whether used or not.
CREATE TABLE IF NOT EXISTS signups (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  company TEXT NOT NULL,
  name TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE,
  ip_key TEXT NOT NULL,
  sent TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  claim TEXT,
  tenant_id TEXT
);
CREATE INDEX IF NOT EXISTS signups_created ON signups (created_at);
CREATE INDEX IF NOT EXISTS signups_email ON signups (email, created_at);
CREATE INDEX IF NOT EXISTS signups_ip ON signups (ip_key, created_at);
