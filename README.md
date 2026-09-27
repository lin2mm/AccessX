# AccessX demo

AccessX is an access-control demo with a browser-based PWA. The local Express
server and Cloudflare Worker run the **same API core** (`api-core.js`) over the
same SQL schema (Node's built-in `node:sqlite` locally, D1 on Cloudflare). The
default tenant runs on demo locks; a tenant that connects its own TTLock
account (owner: People → Operators & sign-in; needs `TTLOCK_CLIENT_ID` /
`TTLOCK_CLIENT_SECRET`), or its own **Nuki** account with a Nuki Web API token
(see [docs/25-NUKI.md](docs/25-NUKI.md)), controls its real locks on either runtime.

**Docs:** [docs/00-INDEX.md](docs/00-INDEX.md) lists every document and the
naming scheme; [docs/90-ROUNDS.md](docs/90-ROUNDS.md) is the change history by
round and [docs/91-ROADMAP.md](docs/91-ROADMAP.md) the plan. See
[docs/01-ARCHITECTURE.md](docs/01-ARCHITECTURE.md) for the design,
[docs/10-PILOT.md](docs/10-PILOT.md) for trying it with real locks, and
[docs/20-PREREGISTRATION.md](docs/20-PREREGISTRATION.md) for the visitor pre-registration design,
[docs/21-SIGNUP.md](docs/21-SIGNUP.md) for self-service signup and the demo reset (off unless `SIGNUP_ENABLED=1`),
[docs/22-KIOSK.md](docs/22-KIOSK.md) for the front-desk tablet (visitor check-in, walk-ins, notice, printable list) and Turnstile,
[docs/23-CALENDAR.md](docs/23-CALENDAR.md) for calendar invitations → visitor pre-registration (off unless `CALENDAR_INBOUND_DOMAIN` is set),
[docs/24-ACCESS-REVIEW.md](docs/24-ACCESS-REVIEW.md) for access reviews, the passcode sweep, data retention and bulk invitations,
[docs/25-NUKI.md](docs/25-NUKI.md) for Nuki as a second lock vendor (API token, limits, checks before the first real site),
[docs/11-OFFICE-SETUP.md](docs/11-OFFICE-SETUP.md) for setting up an office (about 45 minutes),
[docs/12-GO-LIVE.md](docs/12-GO-LIVE.md) for the production checklist, `npm run doctor`, monitoring and backups,
[docs/30-SECURITY-TESTING.md](docs/30-SECURITY-TESTING.md) for the external security test and rate limits, and
[docs/40-BILLING.md](docs/40-BILLING.md) for Stripe billing (off unless `BILLING_ENABLED=1`).

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

The hosted build serves the PWA as static assets, the API from a Worker, and
state from D1 (one Durable Object per tenant serialises writes). The default
tenant uses demo locks; tenants that connect a TTLock or Nuki account use real ones.

1. Install dependencies and log Wrangler in:

   ```sh
   npm ci
   npx wrangler login
   ```

2. Create a D1 database, then copy its `database_id` into `wrangler.jsonc`:

   ```sh
   npx wrangler d1 create accessx-demo
   ```

   The rate-limit bindings `RL_NOTIFY` / `RL_PUBLIC` in `wrangler.jsonc` use
   `namespace_id` 4101 and 4102; change them if another Worker in your
   Cloudflare account already uses those numbers.

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

   The Worker's cron trigger (`*/15 * * * *`) runs the credential reconciler and
   each tenant's maintenance (alert retries, lock health, audit anchors, visitor
   retention, billing usage and notices).

Do not enable public writes. For live lock data, this prototype still needs a
separate production security review. Before a real deployment, work through
[docs/12-GO-LIVE.md](docs/12-GO-LIVE.md): the shipped `wrangler.jsonc` is a
**demo** config (placeholder D1 id, `AUTH_OPEN_READS=1`) and `npm run doctor -- --worker`
fails it until you change both.

## Configuration

Node reads these from the environment; the Worker from `wrangler.jsonc` vars
and secrets (`npx wrangler secret put NAME`), locally from `.dev.vars`.

| Variable | Needed for | Notes |
|---|---|---|
| `ADMIN_TOKEN` | production | Owner token of the default tenant. Without it (and `OPERATORS`) the app runs as an open demo. |
| `SECURITY_CONTACT` | production | Published as `/.well-known/security.txt` (RFC 9116): `mailto:` / `https:` / `tel:` URIs, comma-separated. Unset: no file. `SECURITY_POLICY` (optional) adds the disclosure-policy URL. |
| `OPERATORS` | optional | JSON list of seeded operators: `id`, `name`, `role`, `siteIds` (omit or `["*"]` = all sites), `tokenSha256` (SHA-256 hex of the token; plaintext tokens are refused). |
| `PLATFORM_TOKEN` | SaaS | Creates tenants and runs deployment-wide jobs (`/api/tenants`, `/api/platform/*`). Never a tenant role. |
| `BILLING_ENABLED` | SaaS, optional | `1` turns on Stripe billing per door-day and SMS segment ([docs/40-BILLING.md](docs/40-BILLING.md)). Needs `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_DOOR_DAYS`; optional `STRIPE_PRICE_SMS`, `STRIPE_METER_DOOR_DAYS` / `STRIPE_METER_SMS` (default `accessx_door_days` / `accessx_sms_segments`), `STRIPE_AUTOMATIC_TAX=1`. Non-payment pauses additions after 15 days; doors keep working. |
| `STRIPE_THIN_WEBHOOK_SECRET` | billing, optional | Signing secret of a second Stripe event destination (thin payload) for meter errors; same URL `/api/stripe/webhook`. |
| `PLATFORM_ALERT_WEBHOOK` | SaaS, optional | https URL (Slack-compatible `{text}`) that gets platform-side billing problems once: meter errors, reports stuck for 24 h, accounts due for closure. |
| `SECRETS_KEY` | TTLock accounts, SSO, alerts, four-eyes passcodes | 32 random bytes, base64 (`openssl rand -base64 32`). May be a keyring `new,old`: the first key seals, all keys open. See *Rotating SECRETS_KEY*. |
| `AUDIT_SIGNING_KEY` | signed audit anchors | Ed25519 JWK pair from `npm run audit:keygen`. Keep an offline copy: old anchors verify with the public half only. |
| `PUBLIC_URL` | SSO, alerts | The public origin, e.g. `https://doors.example.com`. Used for the OIDC redirect URI, links in alerts, visitors' self check-out links and visitor invitations; without it those links are left out and the redirect URI follows the request host. |
| `TTLOCK_CLIENT_ID` / `TTLOCK_CLIENT_SECRET` | platform TTLock app | Tenants may bring their own app instead. `TTLOCK_API_BASE` overrides the region URL (tests). |
| `NUKI_API_BASE`, `NUKI_POLL_MS` | optional | Nuki tenants connect with their own Nuki Web API token (no platform app). `NUKI_API_BASE` overrides `https://api.nuki.io` (tests only); `NUKI_POLL_MS` is the interval for confirming a new code (default 1500) ([docs/25-NUKI.md](docs/25-NUKI.md)). |
| `TTLOCK_NOTIFY_SECRET` | instant visitor arrival | Random string (`openssl rand -hex 24`). Enter `https://<host>/api/ttlock/notify/<secret>` as the **Callback URL** of the TTLock developer app (open.ttlock.com → Management → your app); one URL serves all tenants. Without it, arrivals are found by reading lock records on each scheduled run. Arrival detection needs `SECRETS_KEY`. |
| `COOKIE_SAMESITE` | iframes only | `None` only if the UI must run inside another site. |
| `AUTH_OPEN_READS` | demo | `1`: read routes without a token (public demo). Explicit opt-in on the Worker; on Node the default only in demo mode. **Ignored whenever `TTLOCK_CLIENT_ID` is set** (R14). Production: `0`. |
| `SIGNUP_ENABLED` | SaaS, optional | `1` opens `/signup`: company + email → emailed link (24 h, once) → new empty tenant and its owner key ([docs/21-SIGNUP.md](docs/21-SIGNUP.md)). Needs email and `PUBLIC_URL`. `SIGNUP_DAILY_LIMIT` (default 50 per 24 h), `SIGNUP_TERMS_URL` (https). |
| `CALENDAR_INBOUND_DOMAIN` | calendar, optional | Mail domain routed to the Worker's `email()` handler (Cloudflare Email Routing catch-all), e.g. `in.doors.example.com`. Also needs `PUBLIC_URL` and `EMAIL_PROVIDER` ([docs/23-CALENDAR.md](docs/23-CALENDAR.md)). |
| `CALENDAR_INBOUND_SECRET` | calendar on Node | Bearer secret for `POST /api/inbound/calendar` (your mail provider's inbound webhook); at least 24 characters. Not needed on the Worker. |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | signup, optional | Cloudflare Turnstile human check on `/signup`, verified server-side; fails closed if Cloudflare is unreachable. Both or neither ([docs/22-KIOSK.md](docs/22-KIOSK.md)). |
| `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM` | email alerts | `resend` or `postmark` (HTTP APIs; Workers cannot use SMTP). `EMAIL_FROM` must be a sender verified with the provider, e.g. `AccessX <alerts@example.com>`. Without them only webhooks are offered. |
| `SMS_PROVIDER`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `SMS_FROM` | texting visitor codes | `twilio`. `SMS_FROM` is a Twilio number (+E.164), an alphanumeric sender ID where the country allows it, or a Messaging Service SID (`MG…`). An API key may replace the auth token (`TWILIO_API_KEY` + `TWILIO_API_SECRET`). Codes are sent once and never queued; Twilio keeps message bodies in its logs according to your account settings. |
| `SMS_MONTHLY_CAP` | optional | Texts per tenant per calendar month (default unlimited). The platform can set a tenant's own cap (`PUT /api/platform/tenants/:id/limits`); usage for billing: `GET /api/platform/usage?period=YYYY-MM`. At the cap, visits are still created and the code is shown on screen. |
| `ALLOW_HTTP_WEBHOOKS` | local testing | `1` allows `http://` alert and anchor webhooks. **Never in production**: webhook URLs carry secrets. |
| `ALLOW_HTTP_ISSUERS` / `MOCK_IDP` | local testing | Allow `http://` OIDC issuers / mount a fake IdP. Never in production. |
| `DOH_URL` | SSO domain verification | DNS-over-HTTPS resolver for the TXT check (default Cloudflare). |
| `DATA_DIR`, `PORT` | Node | SQLite location and HTTP port. |
| `RECONCILE_INTERVAL_MIN` | Node | Reconciler period (default 15, `0` = off). The Worker uses the cron trigger in `wrangler.jsonc`. |
| `WRITE_QUEUE_MAX` | Node | Per-tenant write queue depth before 503 (default 256). |
| `SNAPSHOT_CACHE_ROWS` | both | Snapshot cache budget in rows across tenants (Node 500000, Worker 100000; `0` = off). See *Snapshot cache* in docs/01-ARCHITECTURE.md. |

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
  `test/scim.conformance.test.js` replays the Okta SCIM spec test and group
  push, and Microsoft Entra's PATCH styles with and without the
  `aadOptscim062020` flag (`"False"` strings, capitalised ops, path-less
  replace, `members[value eq …]` removal).
- Built-in roles: `r_owner`, `r_manager` (site manager), `r_installer`, `r_view`
  (auditor), `r_front_desk` (reception: visitors only), `r_provisioner` (SCIM only). Every API route maps to one permission in `rbac-core.js`; routes
  not listed there require the owner (fail closed).
- Site-scoped operators only see, unlock, issue codes for and read records of
  doors at their sites. They see people with at least one group at their sites
  and may change/remove only people whose groups are **all** at their sites.
  Their audit view shows their own actions.
- A remote unlock without a `userId` (operator override) requires a `reason`.
- Demo mode allows anonymous read-only access (`AUTH_OPEN_READS=1`, refused once
  real-lock credentials are configured). Writes always need a token. Failed token attempts are rate-limited per client IP.

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
  retried for about a day, then recorded as `alerts.dropped`. Visitor
  arrivals are opt-in (they name a person). **Daily summary**: approval
  requests, overdue removals and arrivals can wait for one message a day at
  a local hour; break-glass, failed revocations and TTLock disconnections are
  always sent at once. Erasing a visitor also deletes their waiting alerts.
- **Rules editor** — Access → *Access rules* (add/remove who can open what,
  when), *Door groups* (move doors between groups, rename, mark sensitive,
  create/delete) and *Holidays*; People → new people groups and schedules.
  Door groups change through `PATCH /api/doorGroups/:id` (`name`,
  `lockIds`, `sensitive`; the site is fixed). Adding a sensitive door,
  removing a door from a sensitive group or un-marking a group waits for a
  second operator; narrowing an ordinary group is immediate and reconciles
  codes. A site-scoped operator can only put doors of their own sites into a
  group.
- **Office setup pack** — the owner's *Get started* card lists what is left
  (TTLock, door groups, rules, sensitive doors, people, SCIM, SSO, alerts,
  callback, visitors) and builds an office from the connected fleet in one
  reviewed step: sites from TTLock groups, door groups from door names
  (entrances, offices, facilities; server/comms/IT rooms **sensitive**, no
  access), Office hours and Cleaning schedules, Staff and Cleaners rules.
  Preview first (`GET /api/onboarding/office?timeZone=`), apply
  (`POST /api/onboarding/office`, owner only); everything audited, doors
  already grouped are never touched. See [docs/11-OFFICE-SETUP.md](docs/11-OFFICE-SETUP.md).
- **Lock health** — one battery reading per lock per day (lock list and
  callback records); a trend line since the last battery change warns about
  three weeks before a lock reaches 10%, and at 20% / 10%. Alerts only
  escalate (at most three per battery, weekly while critical), grouped into
  one message, and may go in the daily summary. **Silent callback**: TTLock
  takes one callback URL per app, and when it stops calling, alarms and
  arrivals go quiet with no error. After 8 business hours (Mon–Fri 08–18 at
  the site) without a callback, AccessX reads the gateway doors' records;
  records TTLock never sent raise one `callback_silent` alert (and are
  back-filled), no records (a holiday) raise nothing.
- **Lock alarms** — with the TTLock callback, a tamper alarm, a forced
  opening or a keypad locked after repeated wrong codes alerts at once
  (`lock_alarm`, on by default, never batched; at most once per door and kind
  per 30 min); a door left open is opt-in. Only the tenant whose TTLock
  account holds the lock hears about it.
- **Visitors** — reception (`r_front_desk`, or anyone who may issue codes)
  registers a visitor with a host, doors and a window; each door gets a code
  valid only for the visit, so the lock ends it by itself, even offline.
  Checking out early revokes over the gateway (a door without one is flagged
  for removal at the lock, honestly). Visitor codes follow the host: suspend
  the host and their visitors lose access. No sensitive doors (those need a
  rule and four-eyes), at most 24 h by default, codes optionally emailed or texted (SMS)
  (never queued or stored). Visitor details never enter the audit chain or
  TTLock, and are erased 30 days after the visit (configurable) or on request.
  **Arrival**: the first unlock with the visitor's code (TTLock callback, or
  lock records every scheduled run) marks them arrived and emails the host;
  a Slack/Teams `visitor_arrived` alert is available opt-in.
  **Invitations** (`PUBLIC_URL` needed): instead of typing the visitor's
  details, reception enters only an email *or* mobile number; the visitor
  opens the link, gives their name and arrival time, and the code is sent to
  that address only — a forwarded link cannot redirect it, and the page never
  shows a code. One use, expires with the window, revocable; the visit is
  re-checked against the inviter's current rights at registration. Sites with
  sensitive doors wait for reception's approval by default. See
  [docs/20-PREREGISTRATION.md](docs/20-PREREGISTRATION.md).
  **Self check-out**: with `PUBLIC_URL`, the email/text carries a link;
  one tap ends the visit and removes the codes (no login, one use, shows no
  names or codes; the token sits in the URL fragment, so it is never in
  server logs). **SMS** is metered per tenant (messages and billed segments)
  with an optional monthly cap, and owners can send a test text.
  **Front-desk kiosk**: a paired tablet at reception lets visitors sign in
  with their invitation email (host emailed, notice ticked), register as a
  walk-in (reception then issues the code or dismisses) or sign out, on the
  tablet or on their phone via a 10-minute QR pass. The tablet key can never
  create a code or read the visitor list. `/visitors-print` is the roll-call
  sheet. See [docs/22-KIOSK.md](docs/22-KIOSK.md). The Visitors screen
  refreshes the walk-in queue every 20 seconds, marks new walk-ins, and counts
  them in the tab title while the tab is in the background.
  **Calendar invitations**: hosts add the office's `cal-…@` address to a
  Google or Outlook meeting. The organiser gets a one-time link and picks which
  outside guests get a visitor invitation. Nothing is sent without that click.
  Moved and cancelled meetings are followed. See
  [docs/23-CALENDAR.md](docs/23-CALENDAR.md). **Bulk invitations**: paste up
  to 100 addresses; a wrong shared setting sends nothing.
- **Access review** — site managers confirm who still has their doors,
  and owners confirm the administrators. Nobody confirms themselves.
  *Remove* takes effect at once: the person leaves that site's groups and
  their codes there are revoked. Reviewers get a reminder, owners get an
  overdue notice, and unconfirmed lines can be removed after the due date.
  Reviews can start every quarter automatically and go into the evidence
  pack. The **passcode sweep** compares the codes on each lock (vendor cloud
  list) with the registry: it finds codes set outside AccessX, revokes that
  never reached the lock, and codes the lock lost. Digits are never shown.
  **Data retention** lists what is kept for how long. See
  [docs/24-ACCESS-REVIEW.md](docs/24-ACCESS-REVIEW.md).
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
  (`npm run load:scim`, numbers in docs/01-ARCHITECTURE.md).
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
  (`.github/workflows/ci.yml`). New routes are covered automatically. The same
  command runs the **site-scope gate** (`test/scope.fuzz.test.js`): an operator
  with every permission but one site may not change anything at other sites.
- `MOCK_IDP=1` mounts a fake OIDC provider at `/mock-idp` for demos/tests
  (`MOCK_IDP_AUTOCONFIGURE=1` wires the default tenant to it). Never in production.
- `npm run doctor` — production configuration check (`--env-file`, `--worker`,
  or `--url https://<host> --platform-token …` for the running site); exit 1 on errors.
- `npm run backup -- node|d1|verify` — backup, then a restore test (integrity,
  schema objects, every tenant's audit chain, sealed secrets vs `SECRETS_KEY`).
- `GET /api/healthz` — public liveness for uptime monitors; 503 if the database
  is unreachable or behind the code's migration (`SCHEMA_VERSION`).
- `npm run test:worker` — smoke test against a running `wrangler dev`
  (`BASE`, `OWNER`, `GYM`, `AUDIT`, `PLATFORM`, optional `IDP` env vars; see `support/worker-smoke.js`).
  With `MAIL_PORT=8799` (and `EMAIL_API_BASE=http://127.0.0.1:8799`, `SIGNUP_ENABLED=1` in `.dev.vars`)
  it also runs a signup on D1. Fails on any new `[ERROR]` line in the wrangler log (`WRANGLER_LOG` to point at it).
- `POST /api/platform/tenants/:id/demo-reset` `{"confirm":":id"}` — put a demo tenant back to the sample data
  (refused for tenants with TTLock or billing; audit chain kept).
- Cloudflare: apply migrations (`npm run cf:db:migrate:local|remote`) after
  pulling — `0003_multitenant.sql` adds the relational multi-tenant schema,
  `0004_identity.sql` sessions, SSO and directory tables, `0005` per-tenant
  vendor accounts, `0006` audit anchors and retention checkpoints, `0007`
  break-glass operators, `0008` approvals and sensitive door groups, `0009`–`0011`
  sealed approval codes, alert outbox and snapshot versions, `0012`–`0018`
  visitors (arrivals, phone, alarms, check-out, SMS usage, invites), `0019` lock
  health, `0020`–`0021` billing, `0022` signups, `0023` kiosks and walk-ins, `0024` calendar invitations, `0025` access reviews and passcode sweeps. Set `SECRETS_KEY`
  as a Worker secret before configuring SSO with a client secret.

This is still a prototype, not a production access-control service. Before
connecting real locks or real user data: `npm run doctor` must pass and a
backup must have been restored ([docs/12-GO-LIVE.md](docs/12-GO-LIVE.md)); run `npm run ttlock:check` against
each lock model on site, set `AUDIT_SIGNING_KEY` and an anchor webhook,
verify your SSO domains (TXT record) and turn on *Require single sign-on*
with a break-glass owner, and complete an independent security review
([docs/30-SECURITY-TESTING.md](docs/30-SECURITY-TESTING.md) has the scope).
