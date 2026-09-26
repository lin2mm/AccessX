-- Identity: browser sessions, SSO (OIDC) and directory provisioning (SCIM).

-- Browser sessions. The cookie carries a random id; only its SHA-256 is
-- stored, so a database leak does not hand out live sessions.
CREATE TABLE IF NOT EXISTS sessions (
  id_sha256 TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  operator_id TEXT NOT NULL,
  via TEXT NOT NULL,                 -- token | sso
  csrf TEXT NOT NULL,                -- must accompany every unsafe request
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS sessions_operator ON sessions (tenant_id, operator_id);

-- In-flight OIDC logins (state/nonce/PKCE). Single use, ~10 minutes.
CREATE TABLE IF NOT EXISTS auth_flows (
  state TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Operators can sign in with SSO: invited by email, bound to the IdP's
-- (issuer, subject) on first login. Afterwards the email is not trusted
-- for matching any more (it can change or be re-assigned at the IdP).
ALTER TABLE operators ADD COLUMN email TEXT;
ALTER TABLE operators ADD COLUMN sso_issuer TEXT;
ALTER TABLE operators ADD COLUMN sso_subject TEXT;
ALTER TABLE operators ADD COLUMN last_login_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS operators_email ON operators (tenant_id, email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS operators_sso ON operators (sso_issuer, sso_subject) WHERE sso_subject IS NOT NULL;

-- Door users provisioned from a directory (Entra ID / Okta / Google via SCIM).
ALTER TABLE users ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';   -- manual | scim
ALTER TABLE users ADD COLUMN external_id TEXT;
ALTER TABLE users ADD COLUMN user_name TEXT;                          -- personal data (usually the UPN/email)
CREATE UNIQUE INDEX IF NOT EXISTS users_user_name ON users (tenant_id, user_name) WHERE user_name IS NOT NULL;

-- Directory groups pushed by SCIM. An owner maps each to (at most) one
-- local user group; membership then flows into users.group_ids.
CREATE TABLE IF NOT EXISTS directory_groups (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  id TEXT NOT NULL,
  external_id TEXT,
  display_name TEXT NOT NULL,
  user_group_id TEXT,                -- NULL = not mapped (no door access)
  member_ids TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (tenant_id, id)
);
