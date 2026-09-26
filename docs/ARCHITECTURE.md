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
  successful delete, the next run deletes again — vendor deletes must be
  idempotent ("not found" = success). For create-type side effects use an
  outbox table instead.
- `dstNotices()` warns 14 days before a site's clock change.

## Known gaps

- Snapshot per request (~11 small queries). Fine for small tenants; add a
  per-tenant version counter + cache when it shows up in latency.
- Auth rate limiting is in-memory (per process / per isolate). Use a
  Durable Object or Cloudflare rate-limiting rules in production.
- Bearer tokens in the browser. Move to HttpOnly session cookies + CSRF, then
  SSO (OIDC/SAML) for operators.
