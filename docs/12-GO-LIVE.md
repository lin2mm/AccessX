# 12 · Going live

Status: current (R14, 2026-09-27). Owner: whoever deploys and runs AccessX.

What to do between "it works on my machine" and "an office relies on it":
check the configuration, watch it, and prove backups restore. About 2 hours
the first time, plus waiting for DNS and the TTLock callback.

Related: [10-PILOT.md](10-PILOT.md) (real locks), [11-OFFICE-SETUP.md](11-OFFICE-SETUP.md)
(one office), [30-SECURITY-TESTING.md](30-SECURITY-TESTING.md) (pentest, rate limits),
[40-BILLING.md](40-BILLING.md) (Stripe).

## 1. Checklist

| # | Step | How | Done when |
|---|---|---|---|
| 1 | Real database | `npx wrangler d1 create accessx` → put its name and id in `wrangler.jsonc` (`database_name`, `database_id`). The `cf:db:*` scripts and `npm run backup -- d1` use the binding `DB`, so they follow | doctor: `wrangler.d1` ok |
| 2 | Close the demo | `wrangler.jsonc` `"vars": { "AUTH_OPEN_READS": "0" }` | doctor: `AUTH_OPEN_READS` ok |
| 3 | Secrets | `npx wrangler secret put` for `ADMIN_TOKEN`, `SECRETS_KEY`, `PLATFORM_TOKEN` (each `openssl rand -base64 32`) | keep `SECRETS_KEY` **offline too**: without it, a restored backup cannot open TTLock tokens, SSO secrets or alert webhooks |
| 4 | Links and disclosure | vars `PUBLIC_URL=https://doors.<you>`, `SECURITY_CONTACT=mailto:security@<you>` | `/.well-known/security.txt` answers |
| 5 | Locks | `TTLOCK_CLIENT_ID`, `TTLOCK_CLIENT_SECRET`, `TTLOCK_NOTIFY_SECRET`; callback URL `https://<host>/api/ttlock/notify/<secret>` in the TTLock console | a test unlock shows up within seconds |
| 6 | Mail (SMS optional) | `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM` (SPF/DKIM on the sending domain); Twilio + `SMS_MONTHLY_CAP` | a visitor invite arrives |
| 7 | Audit evidence | `npm run audit:keygen` → `AUDIT_SIGNING_KEY`; anchor webhook in *Settings → Audit* | first daily anchor delivered |
| 8 | Migrate, deploy | `npm run cf:db:migrate:remote`, then `npm run cf:deploy` (always in that order) | `GET /api/healthz` → 200 |
| 9 | Doctor on the live site | `npm run doctor -- --url https://<host> --platform-token …` | `✓ ready`, warnings understood |
| 10 | Monitor | uptime check on `/api/healthz` (section 3) | test alert received |
| 11 | Backup drill | `npm run backup -- d1`, restore test (section 4) | `✓ restorable`, date written in section 6 |
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
| Off-site copy | weekly `npm run backup -- d1` (runs `wrangler d1 export DB --remote`), stored outside Cloudflare, encrypted | nightly `npm run backup -- node --data-dir /var/lib/accessx` (`VACUUM INTO`: consistent while running), copied off the host |
| Check an old file | `npm run backup -- verify backups/d1-….sql --secrets-key "$SECRETS_KEY"` | same with the `.sqlite` |
| RPO / RTO target | ~1 min / ~15 min | 24 h (hourly if you can) / ~15 min |

Backups contain personal data (names, emails, phone numbers, visit history)
and sealed secrets: encrypt them at rest, limit who can read them, and delete
them on the same retention as the live data.

**Restore, Cloudflare (Time Travel):**

```sh
npx wrangler d1 time-travel info accessx --timestamp "2026-10-20T09:00:00+11:00"   # find the bookmark
npx wrangler d1 time-travel restore accessx --timestamp "2026-10-20T09:00:00+11:00" # prints an undo bookmark: keep it
```

**Restore, Cloudflare (from an export):** `npx wrangler d1 create accessx-restore`,
then `npx wrangler d1 execute accessx-restore --remote --file backups/d1-….sql`.
Put the new id in `wrangler.jsonc`, run `npm run cf:db:migrate:remote`, then deploy.

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

- Automatic off-site export: a scheduled Workflow to R2 (Cloudflare's guide
  "Export and save D1 database") would replace the weekly manual step.
- Codes set at the keypad in admin mode, or deleted over Bluetooth without a
  sync, are invisible to the passcode sweep (R18): it reads the vendor cloud.
- A status page for tenants.

## 6. Drill log

| Date | Who | What | Result |
|---|---|---|---|
| 2026-09-27 | R14 (sandbox) | Node: backup while running → restore into a new `DATA_DIR` → healthz 200, audit chain intact (17 entries), sealed webhook readable. Tampered copy → chain broken at the edited entry, missing trigger reported. Wrong key → "not restorable". | ✓ |
| 2026-09-27 | R14 (sandbox) | D1 (local): `wrangler d1 export` after the smoke suite → restore test: 2 tenants, 55 + 3 audit entries intact, all 91 schema objects present | ✓ |
