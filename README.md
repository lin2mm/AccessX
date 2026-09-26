# AccessX demo

AccessX is an access-control demo with a browser-based PWA. The local Express
server and Cloudflare Worker both use demo data and do not control physical locks.

## Run locally

```sh
npm ci
npm start
```

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
   deployment:

   ```sh
   npm run cf:db:migrate:local
   npm run cf:db:migrate:remote
   ```

4. Set an admin token as a Cloudflare secret and deploy:

   ```sh
   npx wrangler secret put ADMIN_TOKEN
   npm run cf:deploy
   ```

Do not enable public writes. For live lock data, this prototype still needs
role-based authorization, stronger audit controls, and a separate production
security review.

## Authentication and roles

Operators (people who administer the system) are separate from door users.

- `ADMIN_TOKEN` — an implicit **Account Owner** (all permissions, all sites).
- `OPERATORS` — JSON array of additional operators, each with a role and an
  optional site scope. Only the SHA-256 of each token is stored:

  ```sh
  npm run operator:new -- --id op_gym --name "Gym manager" --role r_manager --sites site_gym
  # prints the token once + the JSON entry to add to OPERATORS
  ```

- Built-in roles: `r_owner`, `r_manager` (site manager), `r_installer`, `r_view`
  (auditor). Every API route maps to one permission in `rbac-core.js`; routes
  not listed there require the owner (fail closed).
- Site-scoped operators only see, unlock, issue codes for and read records of
  doors at their sites.
- Demo mode allows anonymous read-only access (`AUTH_OPEN_READS`). Writes always
  need a token. Failed token attempts are rate-limited per client IP.

## What the policy engine guarantees

- **Site time zones** — every site has an IANA `timezone`; schedules and
  holidays are evaluated in local wall-clock time (overnight windows included).
- **No bypass through credentials** — `POST /api/passcode` requires a person and
  a rule that grants the door. If the rule has a daily schedule the lock cannot
  enforce, the API returns `409` until the operator acknowledges the gap.
  Every credential is registered (the full code is never stored), and
  `GET /api/credentials` flags codes current policy would no longer issue.
- **Enforcement map** — `GET /api/compile` reports, per rule and per lock,
  whether the rule is enforced by the lock (`lock`), depends on the cloud
  pushing changes through a gateway (`synced`), or only applies to remote
  unlocks (`cloud`). It also flags daylight-saving drift on fixed-offset lock clocks.
- **Tamper-evident audit** — hash-chained, append-only (`DATA_DIR/audit.jsonl`
  locally; D1 `audit_log` with UPDATE/DELETE-blocking triggers on Cloudflare).
  `GET /api/audit/verify` checks the chain and returns the head hash; export it
  regularly to storage the app cannot write to.
- **Input validation + strict CSP** — collection writes are allow-listed and
  type-checked; the UI escapes all data and runs with `script-src 'self'`.

## Data and tests

- `data/*.json` are read-only seeds. Runtime state lives in `DATA_DIR`
  (default `data/runtime/`, git-ignored).
- `npm test` — unit + in-process API tests.
- `npm run test:worker` — smoke test against a running `wrangler dev`
  (`BASE`, `OWNER`, `GYM`, `AUDIT` env vars; see `support/worker-smoke.js`).
- Cloudflare: apply migrations (`npm run cf:db:migrate:local|remote`) after
  pulling — `0002_audit_log.sql` adds the audit table.

This is still a prototype, not a production access-control service. Before
connecting real locks or real user data: move state to a real database with
multi-tenancy, verify TTLock capability flags per lock model, anchor the audit
head externally, and complete an independent security review.
