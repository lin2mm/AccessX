# Changelog

All work is on branch `arena/01a0de29-accessx`, starting from `main` at `b74185b`
("Add Cloudflare Workers demo deployment"). Rounds are one instruction and one
delivery each; details per round in [docs/90-ROUNDS.md](docs/90-ROUNDS.md) and
`docs/rounds/`. Dates are 2026-09-27, Sydney time.

## R24 — deploy script checked against the wrangler source (part of v1.0-pilot)

- `d1 list --json` parsing tolerates lines before the JSON, including `[WARNING]`.
- `d1 create --update-config=false`: wrangler never writes an id into `wrangler.jsonc`.
- The health URL comes from the deploy target list (after `Deployed <name> triggers`).
- Health check: an unhealthy HTTP answer fails the build. No answer at all (DNS for a
  new workers.dev subdomain) only warns.
- A clear message when `npm run deploy` runs without `wrangler login`.
- Doc 13: a Worker-name mismatch doesn't fail the build. Wrangler deploys under the
  dashboard name and Cloudflare opens a pull request that renames it.

## R23 — deploy from GitHub (part of v1.0-pilot)

The repository is connected to Cloudflare Workers Builds, so a merge to `main`
deploys production ([docs/13-CLOUDFLARE-GIT-DEPLOY.md](docs/13-CLOUDFLARE-GIT-DEPLOY.md)).

**Security**
- `wrangler.jsonc` no longer sets `AUTH_OPEN_READS=1`. A Git deploy would have
  turned anonymous reads on in production. A public demo sets it in the dashboard.
  `npm run doctor -- --worker` and CI fail if it comes back.
- `"keep_vars": true`: variables and secrets set in the dashboard survive deploys.

**Deploy**
- `npm run deploy` (`scripts/cf-deploy.js`), also `cf:deploy`:
  1. find the D1 database by name, or create it (`D1_LOCATION`);
  2. apply migrations;
  3. deploy;
  4. wait for `/api/healthz` 200.

  Any failure fails the build and keeps the previous version.
  `--dry-run`, `--migrate-only` (`cf:db:migrate:remote`) and `--resolve-only`
  (used by `npm run backup -- d1`).
- No placeholder `database_id` in the repo. The real id is written only to the
  gitignored `wrangler.deploy.jsonc`. This works around workers-sdk #13632.
- A missing D1 permission on the Workers Builds token gets a precise fix in the build log.
- CI: `npm run deploy -- --dry-run` and a `wrangler.jsonc` doctor check on every push and PR.

**Local**
- `support/dev-vars.js` writes `AUTH_OPEN_READS=1` to `.dev.vars` for the smoke test.
  Existing checkouts: `node support/dev-vars.js --force`.

## v1.0-pilot — R22 (pilot freeze)

The version meant for the first pilot office. From here on: fixes from pilot
feedback, the external security test and dependency updates only
([docs/91-ROADMAP.md](docs/91-ROADMAP.md)).

**Security**
- Clickjacking protection: `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`
  on every page (Node and Cloudflare `_headers`). `FRAME_ANCESTORS` (Node) allows an
  intended embedding; `npm run doctor` fails on `*`.
- `qs` 6.15.3 → 6.16.0 (moderate advisories, via Express). `npm audit`: 0.
- Self-review against the external test scope, recorded in
  [docs/30-SECURITY-TESTING.md](docs/30-SECURITY-TESTING.md); the unauthenticated
  endpoint and rate-limit lists brought up to date.
- R2 backup encryption evaluated: what a leaked copy exposes, why SSE-C waits for the
  real bucket ([docs/12-GO-LIVE.md](docs/12-GO-LIVE.md) §5).

**Changed**
- Chinese interface: admin name cells are `translate="no"`.
- Worker smoke test: overlapping reads and writes on a cold instance; runtime detection
  for the R20 fix is pinned by a unit test.

**Tooling**
- `support/smoke-fresh.sh` (smoke on a new D1 and a fresh wrangler),
  `support/dev-vars.js` (local `.dev.vars`), `support/agent-recover.sh` (after a
  sandbox reset). How the work was run and what needs a person:
  [docs/92-AUTONOMY.md](docs/92-AUTONOMY.md).

## R13–R21

| Round | Added |
|---|---|
| R21 | Chinese / English interface on all pages (`?lang=zh`, browser language, switch button), dictionary with one glossary, dates follow the language, coverage tool ([docs/26-I18N.md](docs/26-I18N.md)) |
| R20 | Load test (200 doors / 5,000 people / 100 tenants) and D1 usage meter; **fixed ~11 % 500s on Workers under concurrent reads and writes**; time-zone validation cache (compile 379 → 44 ms); smoke test log check fixed; weekly D1 → R2 export with restore check; per-tenant cost model; `npm run nuki:check` |
| R19 | Nuki as the second lock vendor (API token, confirmed writes, offline handling), vendor limits shown in the UI ([docs/25-NUKI.md](docs/25-NUKI.md)) |
| R18 | Access reviews, passcode sweep on the locks, data retention overview, bulk invitations; site-scope gate also watches vendor calls (found and fixed an escalation) ([docs/24-ACCESS-REVIEW.md](docs/24-ACCESS-REVIEW.md)) |
| R17 | Calendar invitations → visitor pre-registration (Google / Outlook, reschedule, cancel); SCIM compatibility replay for Okta and Entra ([docs/23-CALENDAR.md](docs/23-CALENDAR.md)) |
| R16 | Reception kiosk: pairing, self check-in, walk-ins, check-out, phone QR code, printable visitor list; optional Turnstile on signup ([docs/22-KIOSK.md](docs/22-KIOSK.md)) |
| R15 | Self-service signup with email confirmation; demo tenant reset ([docs/21-SIGNUP.md](docs/21-SIGNUP.md)) |
| R14 | `npm run doctor`, `GET /api/healthz`, `npm run backup` with restore check; Worker no longer allows anonymous reads by default ([docs/12-GO-LIVE.md](docs/12-GO-LIVE.md)) |
| R13 | Site-scope security gate; billing operations; numbered documentation; rounds log and roadmap |

## R1–R12

| Round | Added |
|---|---|
| R12 | Rules editor UI; **fixed an escalation** (a one-site custom role could file another site's door into its own group); `security.txt`; Stripe billing (off by default) |
| R11 | Visitor pre-registration; battery trend alerts; silent TTLock callback detection; office setup pack; rate limits on endpoints without login; SSRF fixes; security test plan |
| R10 | Lock alarms; visitor self check-out link; monthly SMS metering and caps; Worker cold-start fix; pilot runbook |
| R9 | Delayed-start passcodes (TTLock 24-hour first-use rule); first unlock = arrival, host notified; SMS codes (Twilio); daily alert digest |
| R8 | Visitors: time-limited codes that end with the visit; reception UI |
| R7 | Snapshot cache with version checks and row-level updates |
| R6 | Every time in the console labelled with the door's time zone |
| R5 | Email alerts with a retry queue; four-eyes also for restoring people and deleting holidays |
| R4 | Per-tenant TTLock accounts; audit anchors; domain-verified SSO; **four-eyes approval**; Slack / Teams alerts; `SECRETS_KEY` keyring |
| R3 | HttpOnly session cookie + CSRF; OIDC SSO; SCIM 2.0; revocation report; **cross-tenant isolation gate in CI** |
| R2 | Relational multi-tenant database; one API core for Node and Cloudflare Workers; automatic revocation |
| R1 | Site time zones; roles and site scope; codes only through the policy engine; hash-chained audit; strict CSP; policy compiler |
