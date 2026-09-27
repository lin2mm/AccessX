# AccessX demo

AccessX is an access-control demo with a browser-based PWA. The local Express
server and Cloudflare Worker run the **same API core** (`api-core.js`) over the
same SQL schema (Node's built-in `node:sqlite` locally, D1 on Cloudflare). Both
use demo data and do not control physical locks. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design.

## Run locally

```sh
npm ci
npm start
```

Requires Node 22+ (`node:sqlite`). State lives in `DATA_DIR/accessx.sqlite`;
migrations in `migrations/` are applied automatically on start. An older
install's `DATA_DIR/acl.json` + `audit.jsonl` are imported once (the audit
chain is verified and carried over) and renamed to `*.migrated`.

The demo serves read-only API data by default. Set `ADMIN_TOKEN` in the process
environment to enable writes; the browser's Admin token field keeps the token
in memory for the current page only. Do not put the token in source control.

## Cloudflare preview

The hosted build serves the PWA as static assets, the demo API from a Worker,
and demo state from D1. It is demo-only; TTLock credentials and real-lock
operations are intentionally not enabled in the Worker.

1. Install dependencies and log Wrangler in:

   ```sh
   npm ci
   npx wrangler login
   ```

2. Create a D1 database, then copy its `database_id` into `wrangler.jsonc`:

   ```sh
   npx wrangler d1 create accessx-demo
   ```

3. Apply the schema locally before `npm run dev:cloudflare`, or remotely before
   deployment (**always migrate before deploying new code**; `0003` moves the
   old JSON blob into tables on the first request and copies the audit chain
   unchanged):

   ```sh
   npm run cf:db:migrate:local
   npm run cf:db:migrate:remote
   ```

4. Set an admin token as a Cloudflare secret and deploy:

   ```sh
   npx wrangler secret put ADMIN_TOKEN
   npm run cf:deploy
   ```

   The Worker's cron trigger (`*/15 * * * *`) runs the credential reconciler.

Do not enable public writes. For live lock data, this prototype still needs a
separate production security review.

## Configuration

Node reads these from the environment; the Worker from `wrangler.jsonc` vars
and secrets (`npx wrangler secret put NAME`), locally from `.dev.vars`.

| Variable | Needed for | Notes |
|---|---|---|
| `ADMIN_TOKEN` | production | Owner token of the default tenant. Without it (and `OPERATORS`) the app runs as an open demo. |
| `OPERATORS` | optional | JSON list of seeded operators (`id`, `role`, `sites`, `token`). |
| `PLATFORM_TOKEN` | SaaS | Creates tenants and runs deployment-wide jobs (`/api/tenants`, `/api/platform/*`). Never a tenant role. |
| `SECRETS_KEY` | TTLock accounts, SSO, alerts, four-eyes passcodes | 32 random bytes, base64 (`openssl rand -base64 32`). May be a keyring `new,old`: the first key seals, all keys open. See *Rotating SECRETS_KEY*. |
| `AUDIT_SIGNING_KEY` | signed audit anchors | Ed25519 JWK pair from `npm run audit:keygen`. Keep an offline copy: old anchors verify with the public half only. |
| `PUBLIC_URL` | SSO, alerts | The public origin, e.g. `https://doors.example.com`. Used for the OIDC redirect URI and for links in alerts; without it links are left out and the redirect URI follows the request host. |
| `TTLOCK_CLIENT_ID` / `TTLOCK_CLIENT_SECRET` | platform TTLock app | Tenants may bring their own app instead. `TTLOCK_API_BASE` overrides the region URL (tests). |
| `COOKIE_SAMESITE` | iframes only | `None` only if the UI must run inside another site. |
| `AUTH_OPEN_READS` | demo | `1`: read routes without a token (Node default only in demo mode). |
| `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM` | email alerts | `resend` or `postmark` (HTTP APIs; Workers cannot use SMTP). `EMAIL_FROM` must be a sender verified with the provider, e.g. `AccessX <alerts@example.com>`. Without them only webhooks are offered. |
| `ALLOW_HTTP_WEBHOOKS` | local testing | `1` allows `http://` alert and anchor webhooks. **Never in production**: webhook URLs carry secrets. |
| `ALLOW_HTTP_ISSUERS` / `MOCK_IDP` | local testing | Allow `http://` OIDC issuers / mount a fake IdP. Never in production. |
| `DOH_URL` | SSO domain verification | DNS-over-HTTPS resolver for the TXT check (default Cloudflare). |
| `DATA_DIR`, `PORT` | Node | SQLite location and HTTP port. |
| `RECONCILE_INTERVAL_MIN` | Node | Reconciler period (default 15, `0` = off). The Worker uses the cron trigger in `wrangler.jsonc`. |
| `WRITE_QUEUE_MAX` | Node | Per-tenant write queue depth before 503 (default 256). |
| `SNAPSHOT_CACHE_ROWS` | both | Snapshot cache budget in rows across tenants (Node 500000, Worker 100000; `0` = off). See *Snapshot cache* in docs/ARCHITECTURE.md. |

### Rotating SECRETS_KEY

1. Generate a key and deploy with `SECRETS_KEY="<new>,<old>"`. Everything
   keeps working; new secrets are sealed with the new key.
2. `POST /api/platform/secrets/reseal` (platform token) re-encrypts every
   stored secret: TTLock tokens, SSO client secrets, alert webhooks, waiting
   passcodes. It is idempotent and never overwrites a value that changed
   meanwhile.
3. `GET /api/platform/secrets` must show `"onOldKeys": 0` (run the re-seal
   again if not), then deploy with `SECRETS_KEY="<new>"`.

A key that was removed too early is reported by name (`sealed with key …,
which is not in SECRETS_KEY`); put it back in the ring and re-seal.

## Authentication and roles

Operators (people who administer the system) are separate from door users.

- **In the app (normal path):** owners create operators with
  `POST /api/operators {name, role, siteIds}`. The token is returned once;
  only its SHA-256 is stored. `DELETE /api/operators/:id` revokes instantly.
  Nobody can grant permissions or sites they do not hold themselves.
- **Bootstrap:** `ADMIN_TOKEN` is the default tenant's owner; `OPERATORS` (env
  JSON, `npm run operator:new`) adds fixed operators. Use these to get in,
  then create real operators in the app.
- **Tenants:** with `PLATFORM_TOKEN` set, `POST /api/tenants {name}` creates an
  isolated tenant and returns its owner token once. Every request is bound to
  the operator's tenant; data, audit chains and lock fleets never cross.

- **Browser sign-in:** the UI exchanges a token for an **HttpOnly session
  cookie** (`POST /api/auth/login`; 12 h absolute, 60 min idle). No token is
  kept in the page; writes need the `X-CSRF-Token` returned at login.
  `COOKIE_SAMESITE=None` only if the app must run inside another site's iframe.
- **Single sign-on (OIDC):** owners configure `PUT /api/sso {issuer,
  clientId, clientSecret?, domains}` (Entra ID, Okta, Google…; redirect URI
  `https://<host>/api/auth/sso/callback`) and invite operators by email
  (`POST /api/operators {…, email, auth:'sso'}`). First login links the
  invite only if the IdP marks the email **verified**; after that the
  identity is the IdP's `(issuer, subject)`. Client secrets are encrypted
  with `SECRETS_KEY` (32 random bytes, base64).
- **Directory sync (SCIM 2.0):** create a token with the *Directory sync*
  role (`r_provisioner`) and give your directory the base URL
  `https://<host>/scim/v2`. People deactivated or deleted there lose their
  door codes in the same request. SCIM groups grant nothing until an owner
  maps them to a user group (People → Operators & sign-in).
- Built-in roles: `r_owner`, `r_manager` (site manager), `r_installer`, `r_view`
  (auditor), `r_front_desk` (reception: visitors only), `r_provisioner` (SCIM only). Every API route maps to one permission in `rbac-core.js`; routes
  not listed there require the owner (fail closed).
- Site-scoped operators only see, unlock, issue codes for and read records of
  doors at their sites. They see people with at least one group at their sites
  and may change/remove only people whose groups are **all** at their sites.
  Their audit view shows their own actions.
- A remote unlock without a `userId` (operator override) requires a `reason`.
- Demo mode allows anonymous read-only access (`AUTH_OPEN_READS`). Writes always
  need a token. Failed token attempts are rate-limited per client IP.

## What the policy engine guarantees

- **Site time zones** — every site has an IANA `timezone`; schedules and
  holidays are evaluated in local wall-clock time (overnight windows included).
- **No bypass through credentials** — `POST /api/passcode` requires a person and
  a rule that grants the door. If the rule has a daily schedule the lock cannot
  enforce, the API returns `409` until the operator acknowledges the gap.
  Every credential is registered (the full code is never stored).
- **Access removal is automatic** — suspending/deleting a person or removing a
  rule revokes affected credentials at once (reconciler, `reconcile-core.js`),
  and a timer/cron re-checks every 15 minutes (`RECONCILE_INTERVAL_MIN`, 0 =
  off). Locks without a gateway get `pending_removal` until someone confirms
  on site (`POST /api/credentials/:id/confirm-removed`). Vendor failures are
  audited and retried. `POST /api/reconcile {dryRun:true}` previews.
- **Enforcement map** — `GET /api/compile` reports, per rule and per lock,
  whether the rule is enforced by the lock (`lock`), depends on the cloud
  pushing changes through a gateway (`synced`), or only applies to remote
  unlocks (`cloud`). It also flags daylight-saving drift on fixed-offset lock clocks.
- **Time to revoke** — `GET /api/reports/revocation?days=30` measures, from
  the audit chain, how long it took from "person suspended/deactivated" to
  "code gone from the lock" (remote and on-site p50/p95/max) and lists every
  code that still works.
- **Tamper-evident audit** — one hash chain per tenant in `audit_events`,
  written in the same transaction as the change, with UPDATE/DELETE-blocking
  triggers.
  `GET /api/audit/verify` checks the chain and returns the head hash.
- **Signed anchors, export, retention** — the head is signed (Ed25519,
  `AUDIT_SIGNING_KEY` from `npm run audit:keygen`) daily and sent to a webhook
  you control; `GET /api/audit/export` + `npm run audit:verify` let an auditor
  check the trail offline, including a full rewrite of the chain. Retention
  (≥ 365 days) purges only below a delivered anchor, via a checkpoint.
- **Four-eyes approvals** — mark a door group *sensitive* and every new way
  into its doors (code, rule, group membership, reinstating a suspended
  person, directory mapping, removing a holiday closure) waits for
  a second operator; approved requests are re-checked before they run. The
  approver never sees an approved passcode — only the requester can collect
  it, once.
- **Removal SLA (default 48 h, per tenant)** — a code that still has to be
  removed at an offline lock is flagged in the revocation report and evidence
  pack once it passes the target, and escalated once in the audit log
  (`credential.removal_overdue`).
- **Alerts to Slack / Teams / SIEM / email** — approval requests, overdue
  removals, failed revocations, break-glass sign-ins and a TTLock account
  that must be reconnected go to one webhook per tenant (URL stored
  encrypted) and/or up to 10 email recipients. Undelivered alerts are
  retried for about a day, then recorded as `alerts.dropped`.
- **Visitors** — reception (`r_front_desk`, or anyone who may issue codes)
  registers a visitor with a host, doors and a window; each door gets a code
  valid only for the visit, so the lock ends it by itself, even offline.
  Checking out early revokes over the gateway (a door without one is flagged
  for removal at the lock, honestly). Visitor codes follow the host: suspend
  the host and their visitors lose access. No sensitive doors (those need a
  rule and four-eyes), at most 24 h by default, codes optionally emailed
  (never queued or stored). Visitor details never enter the audit chain or
  TTLock, and are erased 30 days after the visit (configurable) or on request.
- **Codes run on whole hours** — TTLock period codes are valid on whole
  hours only and must be used once within 24 h of their start, or the lock
  voids them. Windows are rounded on the door's clock (start down, end up,
  never past a person's contract end); the operator is told when rounding
  changes a time and when the 24 h rule applies.
- **Local times mean the site's clock** — passcode end dates and schedules
  are converted in the door's time zone, and the console labels every time
  field and result with that zone; on a daylight-saving fall-back the
  ambiguous hour uses the *earlier* instant, a skipped hour moves forward
  (RFC 5545 / Temporal "compatible").
- **Burst-safe writes** — each tenant's writes run one at a time (a Durable
  Object per tenant on Cloudflare, an in-process queue on Node), so a
  2,000-person SCIM sync completes with zero failed writes
  (`npm run load:scim`, numbers in docs/ARCHITECTURE.md).
- **Stays fast at 10k+ people** — a version-checked snapshot cache (database
  triggers log every change; readers patch only changed rows): reads and
  writes ~7–8 ms at 10,000 people instead of ~230 ms.
- **RBAC coverage gate** — `test/rbac-coverage.test.js` fails when a new API
  route has no explicit permission rule, a rule is stale, or an anonymous
  demo visitor could reach a write.
- **Evidence pack** — Activity → *Evidence pack* (`/evidence.html`): one
  printable page per period for ISO 27001 / SOC 2 access-control evidence.
- **GDPR-ready audit** — entries about people carry ids only, so deleting a
  person erases their personal data without breaking the chain.
  `GET /api/users/:id/export` answers a subject access request.
- **Input validation + strict CSP** — collection writes are allow-listed and
  type-checked; the UI escapes all data and runs with `script-src 'self'`.

## Data and tests

- `data/*.json` are read-only seeds. Runtime state lives in `DATA_DIR`
  (default `data/runtime/`, git-ignored).
- `npm test` — unit, storage, tenancy, SSO, SCIM and in-process API tests.
- `npm run test:isolation` — the **cross-tenant gate**: every route is called
  as tenant B with tenant A's ids; any leak or change to A fails CI
  (`.github/workflows/ci.yml`). New routes are covered automatically.
- `MOCK_IDP=1` mounts a fake OIDC provider at `/mock-idp` for demos/tests
  (`MOCK_IDP_AUTOCONFIGURE=1` wires the default tenant to it). Never in production.
- `npm run test:worker` — smoke test against a running `wrangler dev`
  (`BASE`, `OWNER`, `GYM`, `AUDIT`, `PLATFORM`, optional `IDP` env vars; see `support/worker-smoke.js`).
- Cloudflare: apply migrations (`npm run cf:db:migrate:local|remote`) after
  pulling — `0003_multitenant.sql` adds the relational multi-tenant schema,
  `0004_identity.sql` sessions, SSO and directory tables, `0005` per-tenant
  vendor accounts, `0006` audit anchors and retention checkpoints, `0007`
  break-glass operators, `0008` approvals and sensitive door groups. Set `SECRETS_KEY`
  as a Worker secret before configuring SSO with a client secret.

This is still a prototype, not a production access-control service. Before
connecting real locks or real user data: run `npm run ttlock:check` against
each lock model on site, set `AUDIT_SIGNING_KEY` and an anchor webhook,
verify your SSO domains (TXT record) and turn on *Require single sign-on*
with a break-glass owner, and complete an independent security review.
