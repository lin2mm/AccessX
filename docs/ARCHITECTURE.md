# AccessX architecture

## One core, two thin runtimes

```
            ┌────────────── api-core.js ──────────────┐
 request →  │ auth-core → tenant → RBAC/site scope →  │ → { status, body }
            │ handler (snapshot + unit of work)       │
            └──────┬──────────────┬──────────────┬────┘
                   │              │              │
        store/repo.js     reconcile-core.js   vendor (demo / TTLock)
                   │
        store/sql.js  ── D1 (Worker)
        store/sqlite-node.js ── node:sqlite (server)
```

- `server.js` (Express) and `worker.js` (Cloudflare) only translate HTTP,
  wire storage/vendors, and schedule the reconciler. All behaviour is in
  `api-core.js`, so both runtimes behave the same and are tested once.
- Pure modules (`policy-core`, `compiler-core`, `credentials-core`,
  `reconcile-core`, `rbac-core`, `validate-core`, `audit-core`) have no I/O.

## Data model

- `migrations/*.sql` are the only schema definition. Wrangler applies them to
  D1; `store/sqlite-node.js` applies the same files to `node:sqlite` and
  records them in `schema_migrations`.
- **Every business table's primary key starts with `tenant_id`.** A query
  that forgets the tenant finds nothing. `store.tenant(id)` is the only data
  access path and adds `tenant_id` to every statement.
- Arrays (`door_groups.lock_ids`, `users.group_ids`, …) are JSON columns for
  now. Move them to join tables (`door_group_locks`, `user_group_members`)
  when reverse queries ("who can open lock 9001?") show up in profiles —
  roughly thousands of users per tenant.
- `tenants.settings` holds per-tenant settings; `tenants.seeded` makes
  first-run seeding / legacy import idempotent.

## Writes, audit and concurrency

- A handler builds a **unit of work**: row inserts/updates/deletes plus audit
  entries. `commit()` reads the tenant's audit head, seals the entries onto
  it (SHA-256 chain), and runs everything in **one transaction** (D1 batch /
  `BEGIN IMMEDIATE`). A change without its audit entry cannot be stored.
- Two writers that read the same head collide on the `(tenant_id, seq)`
  primary key; the loser re-seals on the new head and retries with full-jitter
  exponential backoff. Measured on local D1: 60 parallel writes to one tenant
  all succeed, chain intact (~20 writes/s under full contention).
- **Scale limit:** that is a per-tenant write ceiling. If one tenant needs
  more (large sites, bulk imports, HR sync), serialise writes per tenant
  with a Durable Object (one DO per tenant owns the audit head) instead of
  optimistic retries.
- **Read-modify-write** (SCIM group members, mappings) uses
  `tenant.transact(fn)`: read the audit head, then the snapshot, compute,
  and commit with `expectHead`. Any commit in between moves the head, so the
  commit conflicts and `fn` re-runs on fresh state. The audit chain doubles
  as the tenant's version number — no per-row version columns. Measured on
  local D1: 8 parallel PATCHes on one group all land, the slowest after
  ~730 ms (they serialise).
- `audit_events` has triggers that reject UPDATE/DELETE. Someone with raw
  database access can drop them — the hash chain still pinpoints the edit
  (`GET /api/audit/verify`). Anchor the head hash daily somewhere the app
  cannot write (object-lock bucket, signed email, transparency log).

## GDPR

- Audit details about people contain **ids only** (`users.create` records
  the id, groups and which fields were set — never name/email). Deleting the
  `users` row therefore erases the person without breaking the chain.
- Free text (override unlock `reason`) can still contain personal data by
  mistake. If that matters, validate it or move to crypto-shredding
  (encrypt personal audit fields with a per-person key; delete the key).
- `GET /api/users/:id/export` is the subject access request.
- Deployments that ran the previous version may have names/emails in old
  `users.create` entries (immutable). Document this in the privacy notice or
  start a fresh chain per tenant with a signed hand-over entry.

## Tenancy and identity

- Auth order: `ADMIN_TOKEN` (default tenant owner) → `OPERATORS` env
  (bootstrap) → `operators` table. Token hashes only; revocation is a column.
- `PLATFORM_TOKEN` is a separate identity that can only create/list tenants.
- Authorization (roles) happens after the tenant is known, because roles
  live in the tenant's own `roles` table.
- Site scope: a person is visible if any of their groups is at the
  operator's sites, and manageable only if **all** are. User groups belong
  to a site (`user_groups.site_id`); groups without a site are managed by
  all-site operators only. Legacy groups get a site inferred from their rules.
- Locks must belong to the tenant's vendor fleet; site scope alone is not
  enough because an all-site owner's scope is "everything".
- **Sessions:** `sessions` stores SHA-256(cookie), CSRF token, via
  (token|sso), expiry. Cookie auth never applies to platform routes or
  `/scim`. Revoking an operator or removing SSO revokes their sessions.
- **OIDC** (`oidc-core.js`, WebCrypto only): code + PKCE S256, state bound
  to the browser by a 10-minute HttpOnly cookie (login CSRF), single-use
  `auth_flows` row, nonce, RS256 against JWKS (refetch on unknown kid at
  most once a minute), iss/aud/azp/exp/iat checks, discovery must name the
  configured issuer. Identity = `(sso_issuer, sso_subject)`; the email is
  only used once, to claim an invitation, and only if `email_verified`
  (nOAuth). Email domains route `/api/auth/sso/start?email=` to a tenant;
  a domain can be claimed by one tenant (**not DNS-verified yet**).
- **Secrets** (`secrets-core.js`): AES-256-GCM with `SECRETS_KEY`, AAD =
  tenant + purpose, so ciphertexts cannot be moved between tenants.
  Rotation = re-encrypt with a key id prefix (`v1.` today).
- **SCIM** (`scim-core.js`): Users/Groups/discovery under `/scim/v2`,
  `r_provisioner` tokens only. The directory manages only people it created
  or adopted by email; `directory_status` is separate from the operator's
  `suspended` flag (neither undoes the other). Mapped SCIM groups set the
  user groups of directory-managed people; manual members are untouched.
  Stored attributes: userName, externalId, name, one email.

## Vendors

- Interface: `listLocks, unlock, createPasscode, deletePasscode, records,
  info, status, mirror?` (`vendor-demo.js`, `vendor-ttlock.js`).
- **Limitation:** TTLock credentials are per deployment, so only the default
  tenant can use the live vendor and the record mirror. Next step: a
  `vendor_accounts` table (per tenant, secrets encrypted with a KMS key or
  Cloudflare secrets store) and `vendorFor(tenantId)` reading from it.
- Other tenants get an empty simulated fleet.

## Reconciler

- `plan()` compares policy with the credential registry: online lock →
  revoke through the vendor; no gateway → `pending_removal` until someone
  confirms on site; expired → `expired` (the lock already refuses it).
- Runs right after writes that can remove access, and every 15 minutes
  (server `setInterval`, Worker cron). Vendor failures are audited as
  `credential.revoke_failed` and retried next run.
- Vendor calls happen before the DB commit. If the commit fails after a
  successful delete, the next run deletes again. TTLock deletes are
  idempotent: `deleteType=2` (gateway; TTLock's default 1 only works via the
  phone app over Bluetooth), `-2012` (no gateway) → `pending_removal`, any
  other failure is checked against `listKeyboardPwd` — not present = done.
  For create-type side effects use an outbox table instead.
- `dstNotices()` warns 14 days before a site's clock change
  (`test/dst.sydney.test.js` covers the 4 Oct 2026 gap and 5 Apr fall-back).

## Known gaps

- Snapshot per request (~11 small queries). Fine for small tenants; add a
  per-tenant version counter + cache when it shows up in latency.
- Auth rate limiting is in-memory (per process / per isolate). Use a
  Durable Object or Cloudflare rate-limiting rules in production.
- SSO email domains are first-come, not DNS-verified. SAML is not supported
  (OIDC covers Entra, Okta, Google; add SAML only when a customer needs it).
- SCIM has no ETags and no `/Bulk`; filters are `attr eq "value"` only.
- The mock IdP (`support/mock-idp.js`) must never be enabled in production.
