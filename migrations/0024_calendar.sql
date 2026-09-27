-- R17 calendar → visitor pre-registration (docs/23-CALENDAR.md).
-- One calendar address per tenant: cal-<address_key>@<CALENDAR_INBOUND_DOMAIN>.
-- configured_by is the operator whose standing approval the calendar uses: the
-- invitations it creates are theirs, and are re-checked against their rights.
CREATE TABLE IF NOT EXISTS calendar_inboxes (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  address_key TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  door_sets TEXT NOT NULL DEFAULT '[]', -- [{siteId, lockIds}]
  configured_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- A meeting invitation received for the tenant. Only 'pending' drafts hold a
-- confirmation token (SHA-256). Guests' addresses follow visitor retention.
CREATE TABLE IF NOT EXISTS calendar_drafts (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  id TEXT NOT NULL,
  uid_sha256 TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  host_user_id TEXT,
  summary TEXT,
  location TEXT,
  start_at TEXT,
  end_at TEXT,
  guests TEXT, -- JSON [{email, name}]
  tz_assumed INTEGER NOT NULL DEFAULT 0,
  recurring INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL, -- pending | confirmed | declined | cancelled | superseded | expired | unusable
  reason TEXT,
  token_sha256 TEXT UNIQUE,
  site_id TEXT,
  invite_ids TEXT, -- JSON [inviteId]
  host_notified TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  erased_at TEXT,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS calendar_drafts_uid ON calendar_drafts (tenant_id, uid_sha256, created_at);
CREATE INDEX IF NOT EXISTS calendar_drafts_recent ON calendar_drafts (tenant_id, created_at);
