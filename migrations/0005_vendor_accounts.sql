-- Per-tenant lock-vendor accounts (TTLock first).
--
-- The customer's TTLock password is used ONCE to obtain OAuth tokens and
-- is never stored. `sealed` holds the tokens (and an optional own client
-- secret), AES-256-GCM encrypted with SECRETS_KEY and bound to the tenant.
-- A separate table (not tenants.settings) so a token refresh can never
-- overwrite a concurrent SSO/settings change, and vice versa.
CREATE TABLE IF NOT EXISTS vendor_accounts (
  tenant_id TEXT PRIMARY KEY NOT NULL REFERENCES tenants(id),
  kind TEXT NOT NULL,                  -- ttlock
  region TEXT NOT NULL,                -- eu | cn
  account TEXT NOT NULL,               -- TTLock username (shown to owners; not a secret)
  account_uid TEXT NOT NULL,           -- TTLock uid from the token response
  client_id TEXT,                      -- NULL = the platform's TTLock app
  sealed TEXT NOT NULL,                -- encrypted {accessToken, refreshToken, clientSecret?}
  token_expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected', -- connected | needs_reconnect
  last_error TEXT,
  lock_count INTEGER,
  connected_by TEXT,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- One TTLock account belongs to exactly one tenant: lock ids are global at
-- TTLock, and two tenants driving the same locks would each see and open
-- the other's doors.
CREATE UNIQUE INDEX IF NOT EXISTS vendor_accounts_uid ON vendor_accounts (kind, region, account_uid);
