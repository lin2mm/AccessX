# 12 · Going live

Status: current (R14, 2026-09-27; deploy steps R23).  Owner: whoever deploys and runs AccessX.

What to do between "it works on my machine" and "an office relies on it":
check the configuration, watch it, and prove backups restore. About 2 hours
the first time, plus waiting for DNS and the TTLock callback.

Deploying itself (GitHub → Cloudflare, dashboard settings, secrets, rollback):
[13-CLOUDFLARE-GIT-DEPLOY.md](13-CLOUDFLARE-GIT-DEPLOY.md). Steps 1–3 and 8 below happen there.

Related: [10-PILOT.md](10-PILOT.md) (real locks), [11-OFFICE-SETUP.md](11-OFFICE-SETUP.md)
(one office), [30-SECURITY-TESTING.md](30-SECURITY-TESTING.md) (pentest, rate limits),
[40-BILLING.md](40-BILLING.md) (Stripe).

## 1. Checklist

| # | Step | How | Done when |
|---|---|---|---|
| 1 | Real database | automatic: the first `npm run deploy` (the Git build) creates D1 `accessx-demo` and every later deploy finds it by name. The repo has no `database_id`; `wrangler.deploy.jsonc` (gitignored) gets the real one. Region: build variable `D1_LOCATION` before the first build | build log `D1 "accessx-demo" created` / `found` |
| 2 | Demo closed | nothing to do since R23: `wrangler.jsonc` no longer sets `AUTH_OPEN_READS`, and a doctor check fails the build if it comes back. Set it in the dashboard only for a public demo | doctor: `AUTH_OPEN_READS` ok |
| 3 | Secrets | dashboard → Settings → Variables & Secrets (or `npx wrangler secret put`) for `ADMIN_TOKEN`, `SECRETS_KEY`, `PLATFORM_TOKEN` (each `openssl rand -base64 32`, generated on your own computer): [13](13-CLOUDFLARE-GIT-DEPLOY.md) section 3 | keep `SECRETS_KEY` **offline too**: without it, a restored backup cannot open TTLock tokens, SSO secrets or alert webhooks |
| 4 | Links and disclosure | vars `PUBLIC_URL=https://doors.<you>`, `SECURITY_CONTACT=mailto:security@<you>` | `/.well-known/security.txt` answers |
| 5 | Locks | `TTLOCK_CLIENT_ID`, `TTLOCK_CLIENT_SECRET`, `TTLOCK_NOTIFY_SECRET`; callback URL `https://<host>/api/ttlock/notify/<secret>` in the TTLock console | a test unlock shows up within seconds |
| 6 | Mail (SMS optional) | `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM` (SPF/DKIM on the sending domain); Twilio + `SMS_MONTHLY_CAP` | a visitor invite arrives |
| 7 | Audit evidence | `npm run audit:keygen` → `AUDIT_SIGNING_KEY`; anchor webhook in *Settings → Audit* | first daily anchor delivered |
| 8 | Migrate, deploy | merge to `main`: the build runs `npm run deploy` = migrate, deploy, health check, in that order (by hand: `npm run deploy`) | build log `[deploy] healthy:` |
| 9 | Doctor on the live site | `npm run doctor -- --url https://<host> --platform-token …` | `✓ ready`, warnings understood |
| 10 | Monitor | uptime check on `/api/healthz` (section 3) | test alert received |
| 11 | Backup drill | R2 bucket bound as `BACKUPS`, `POST /api/platform/backups/run`, download, `npm run backup -- verify` (section 4) | `✓ restorable`, date written in section 6 |
| 12 | Remove dev switches | no `ALLOW_HTTP_WEBHOOKS`, `ALLOW_HTTP_ISSUERS`, `MOCK_IDP*`, `*_API_BASE` | doctor has no errors |
| 13 | Billing (later) | [40-BILLING.md](40-BILLING.md) | doctor: billing active |

## 2. `npm run doctor`

One set of checks (`doctor-core.js`), three places to run it. Exit code 1 while
there are errors, so it can gate a deploy script.

| Command | Checks | Sees secret values? |
|---|---|---|
| `npm run doctor -- --env-file /etc/accessx.env` (or the shell env) | Node deployment settings | yes (local) |
| `npm run doctor -- --worker` | `wrangler.jsonc` (D1 id, rate limits, cron, `run_worker_first`, Durable Object, Workers Logs) + vars + **names** from `wrangler secret list` | no: a secret is only "set" |
| `npm run doctor -- --url https://<host> [--platform-token T]` | the running site: `/api/healthz`, `security.txt`, CSP, HSTS; with the platform token also `GET /api/platform/doctor` | yes, **on the server**: findings name settings, never values |

`--dev` turns errors into warnings (local work); `--json` for scripts.

Errors (do not go live): weak or demo tokens (`owner-token`, < 24 characters);
anonymous reads on; `SECRETS_KEY` missing or not 32 bytes; `PUBLIC_URL` not a
bare https origin, or a placeholder host; no `SECURITY_CONTACT`; dev switches
on; short `TTLOCK_NOTIFY_SECRET`; email/SMS half configured; unparseable
`OPERATORS` or `AUDIT_SIGNING_KEY`; billing enabled but inactive; D1 placeholder
id; missing rate limits, cron or Durable Object.

Warnings (works; decide): no TTLock app (demo locks only), no callback (arrivals
and alarms by polling), unsigned audit anchors, no email, no SMS cap, Stripe in
test mode, no thin-event secret or platform alert webhook, `COOKIE_SAMESITE=None`.

**Behaviour change in R14:** anonymous read-only access (the public demo) is
now explicit opt-in on both runtimes (`AUTH_OPEN_READS=1`) and is **refused
whenever `TTLOCK_CLIENT_ID` is set**. Before R14 the Worker had it on unless
`AUTH_OPEN_READS=0`, and the shipped `wrangler.jsonc` sets `1`: a production
deploy that forgot to change it would have shown doors, reports and the audit
log to anyone. The repo's `wrangler.jsonc` stays a demo config; the doctor
fails it until you change it.

## 3. Health and monitoring

`GET /api/healthz`: public, no token, `cache-control: no-store`:

```json
{ "ok": true, "db": "ok", "schema": { "expected": "0021_billing_ops", "applied": "0021_billing_ops" }, "ms": 4, "at": "…" }
```

- **503 `db: unreachable`**: D1/SQLite is down or bootstrap failed.
- **503 `database is behind`**: the code was deployed before its migration.
  Run `npm run cf:db:migrate:remote`. (`SCHEMA_VERSION` in `api-core.js` must
  be bumped with every new migration; a test enforces it.)
- It says nothing about tenants, doors or settings. `/api/health` (with a
  token) is the separate *fleet* health: batteries, offline doors.

**Uptime monitor:** any external checker (UptimeRobot, Better Stack, Pingdom,
Cloudflare Health Checks on Pro plans). Check `https://<host>/api/healthz`
every 1–5 min, alert on non-200 or missing `"ok":true`, and send alerts to a
phone. External, so it also catches DNS and certificate problems.

**Logs:**

- *Cloudflare:* Workers Logs is on in `wrangler.jsonc` (`observability.enabled`,
  sampling 1 = every request). The dashboard shows Workers & Pages → the Worker
  → Observability; live output via `npx wrangler tail`. Retention is 3 days
  (Free, 200k events/day) or 7 days (Paid, 20M/month included). For longer
  retention or one place for all logs, use OpenTelemetry export, Workers
  Logpush or a Tail Worker to your log store.
- *Node:* everything goes to stdout/stderr; let systemd/journald or Docker
  keep it, and ship it with your usual agent.
- **Search for / alert on:** `maintenance … failed`, `cron` errors,
  `BILLING_ENABLED=1 but billing is off`, `AUTH_OPEN_READS=1 ignored`,
  `AUDIT_SIGNING_KEY unusable`, `health: database`, and any 5xx. Tenant-facing
  problems (lock offline, TTLock reconnect, alert delivery) already reach the
  tenant's own alerts; platform billing problems reach `PLATFORM_ALERT_WEBHOOK`.
- Logs carry ids and error messages, not tokens or door codes. Keep it that
  way in code review. Short retention helps data minimisation (GDPR/APP 11).

## 4. Backup and restore

`npm run backup` writes a backup and immediately **restores it into a scratch
database** to check:

1. it loads, and integrity and foreign-key checks pass;
2. every table, index and trigger of `migrations/` is present (the append-only
   audit triggers must survive);
3. the schema version;
4. each tenant's audit chain (the same check as `GET /api/audit/verify`);
5. every sealed secret's key id is in `SECRETS_KEY`.

| | Cloudflare D1 | Node (SQLite file) |
|---|---|---|
| Automatic | **Time Travel**: always on, free, restore to any minute in the last 30 days (Workers Paid) or 7 (Free) | none: schedule it |
| Off-site copy | **automatic weekly export to R2** (R20, below). Monthly: also keep one copy outside Cloudflare (`npm run backup -- d1`, runs `wrangler d1 export DB --remote`), encrypted | nightly `npm run backup -- node --data-dir /var/lib/accessx` (`VACUUM INTO`: consistent while running), copied off the host |
| Check an old file | `npm run backup -- verify backups/d1-….sql[.gz] --secrets-key "$SECRETS_KEY"` | same with the `.sqlite` |
| RPO / RTO target | ~1 min / ~15 min | 24 h (hourly if you can) / ~15 min |

Backups contain personal data (names, emails, phone numbers, visit history)
and sealed secrets: encrypt them at rest, limit who can read them, and delete
them on the same retention as the live data.

**Weekly export to R2 (R20, `backup-export-core.js`).** Once a week, in the
quiet hour `BACKUP_HOUR_UTC` (default 17 UTC = 03:00/04:00 Sydney), the cron
dumps the database as gzipped SQL to `d1/accessx-<time>.sql.gz`. It keeps the
newest `BACKUP_KEEP` (default 8). Measured: 16,317 rows → 0.5 MB in 0.3 s. The
dump is streamed through gzip, so memory holds only the compressed bytes.

```sh
npx wrangler r2 bucket create accessx-backups
# wrangler.jsonc: "r2_buckets": [{ "binding": "BACKUPS", "bucket_name": "accessx-backups" }]
# (not in the repo's wrangler.jsonc: a deploy fails if the bucket does not exist)
curl -X POST -H "authorization: Bearer $PLATFORM_TOKEN" https://…/api/platform/backups/run   # first copy now
curl -H "authorization: Bearer $PLATFORM_TOKEN" https://…/api/platform/backups               # keys, sizes, row counts
npx wrangler r2 object get accessx-backups/d1/accessx-….sql.gz --remote --file latest.sql.gz
npm run backup -- verify latest.sql.gz --secrets-key "$SECRETS_KEY"
```

`GET /api/platform/doctor` warns while no bucket is bound. Limits: D1 has no
snapshot across queries, so a write during the export can leave the copy
slightly inconsistent. That is why it runs in the quiet hour, and why `verify`
re-checks every audit chain. If a copy fails verification, use Time Travel.
The bucket must stay private: the copy holds personal data. Secrets in it are
sealed, not plain text, and need the same `SECRETS_KEY`.

**Restore, Cloudflare (Time Travel):**

```sh
npx wrangler d1 time-travel info accessx-demo --timestamp "2026-10-20T09:00:00+11:00"   # find the bookmark
npx wrangler d1 time-travel restore accessx-demo --timestamp "2026-10-20T09:00:00+11:00" # prints an undo bookmark: keep it
```

**Restore, Cloudflare (from an export):** `npx wrangler d1 create accessx-restore`,
then `npx wrangler d1 execute accessx-restore --remote --file backups/d1-….sql`
(an R2 copy: `gunzip -k accessx-….sql.gz` first).
Switch the Worker to it: set `"database_name": "accessx-restore"` in `wrangler.jsonc` and merge. The build finds it by name, migrates and deploys. (Or rename nothing and restore with Time Travel above, which keeps the same database.)

**Restore, Node:** stop the service; move `accessx.sqlite`, `-wal` and `-shm`
aside; copy the backup to `$DATA_DIR/accessx.sqlite`; start (migrations apply
themselves); `curl /api/healthz`.

**After any restore:**

1. `npm run doctor -- --url … --platform-token …`, then `GET /api/audit/verify` per tenant.
2. **Door codes issued after the restore point still work on the locks**, but
   AccessX no longer knows them, so it will not revoke them. Run
   **Activity → Passcode sweep** (`POST /api/passcode-sweep`, see
   `24-ACCESS-REVIEW.md` §2): it lists them as "not from AccessX", and you can
   remove them through the gateway. Codes AccessX lists but the lock lacks
   (revoked after the restore point) show as "missing from the lock". Record
   them as gone, and the next reconcile issues new ones. The sweep sees only
   the vendor cloud's list: for locks without a gateway, or if staff used the
   keypad admin mode, also check the lock in the TTLock app.
3. External audit anchors received after the restore point will not match: the
   chain was rewound. That is expected, and it is evidence of what was lost.
   Record the restore (time, reason, restore point) as an incident; an auditor
   will ask.
4. Tell affected tenants what was lost (changes between the restore point and now).

**Drill:** once before go-live and then quarterly. Restore the latest
off-site copy with `verify`, and on Cloudflare restore into a *new* database.
Write the date and result in section 6.

## 5. What this does not cover (yet)

- The R2 export is not encrypted by AccessX (only by R2 at rest), and it is
  not a consistent snapshot (see section 4). A copy outside Cloudflare is still
  a monthly manual step.
  **What a leaked copy exposes (R22 review):** personal data in plain text (names,
  emails and phone numbers of people and visitors), the audit trail, door and
  schedule layout. **Not** usable door codes (only hints and keyed fingerprints),
  not operator or link tokens (SHA-256 only), not TTLock/Nuki tokens or approval
  codes (sealed with `SECRETS_KEY`, which is not in the dump). So a leak is a privacy
  incident (in Australia: assess under the Notifiable Data Breaches scheme), not a
  way to open doors.
  **Until then:** keep the bucket private (no `r2.dev` URL, no public custom
  domain), give R2 API tokens to people only when needed and scoped to this bucket.
  **Next step, in the deployment week:** R2 server-side encryption with a customer key
  (SSE-C: the Workers binding takes `ssecKey` on `put`/`get`), key as a Worker
  secret with an offline copy. It was not built in R22 because the local emulator
  does not support SSE-C, so it could not be tested, and a mistake there means
  unreadable backups at the worst moment. Build it against the real bucket and
  repeat the restore drill (section 4) with the key.
- Codes set at the keypad in admin mode, or deleted over Bluetooth without a
  sync, are invisible to the passcode sweep (R18): it reads the vendor cloud.
- A status page for tenants.

## 6. Drill log

| Date | Who | What | Result |
|---|---|---|---|
| 2026-09-27 | R14 (sandbox) | Node: backup while running → restore into a new `DATA_DIR` → healthz 200, audit chain intact (17 entries), sealed webhook readable. Tampered copy → chain broken at the edited entry, missing trigger reported. Wrong key → "not restorable". | ✓ |
| 2026-09-27 | R14 (sandbox) | D1 (local): `wrangler d1 export` after the smoke suite → restore test: 2 tenants, 55 + 3 audit entries intact, all 91 schema objects present | ✓ |
