# 13 · Deploying from GitHub (Cloudflare Workers Builds)

Status: current (R23, 2026-09-27; checked against the wrangler 4.141 source in R24). Owner: whoever owns the Cloudflare account.

The repository is connected to Cloudflare (GitHub App *Cloudflare Workers and
Pages*). Once the settings below are in place, **every merge to `main` deploys
production**. There is no separate "release" button, so treat merging as releasing.

Related: [12-GO-LIVE.md](12-GO-LIVE.md) (everything after the first deploy),
[40-BILLING.md](40-BILLING.md) (costs), `scripts/cf-deploy.js` (what the build runs).

## 1. What a push to `main` does

```
push / merge to main
  └─ Workers Builds: npm ci  →  npm run deploy  (scripts/cf-deploy.js)
       1. find the D1 database "accessx-demo" by name (create it on the first build)
       2. write wrangler.deploy.jsonc = wrangler.jsonc + the real database_id (never committed)
       3. wrangler d1 migrations apply DB --remote        ← schema first
       4. wrangler deploy                                 ← then code
       5. GET https://accessx-demo.<account>.workers.dev/api/healthz until 200 {"ok":true}
     any step fails → the build fails → the previous version keeps serving
     (step 5: an HTTP error fails the build; no answer at all, e.g. DNS for a brand-new
      workers.dev subdomain, only warns. The code is live by then either way)
```

Why not the default `npx wrangler deploy`:

- It never applies migrations. New code on an old schema answers 503 on `/api/healthz`.
- `wrangler d1 migrations apply --remote` refuses a config without `database_id`
  ([workers-sdk #13632](https://github.com/cloudflare/workers-sdk/issues/13632)).
  The repo therefore has no id at all, not even a placeholder, and the script resolves it by name.
- Migrations only add, never rename or drop. So for the few seconds between steps 3
  and 4, the old code runs fine on the new schema.

The repo-side guarantees are tested in `test/cf-deploy.test.js`. The wrangler output formats
the script parses (`d1 list --json`, the deploy target list) were read from the wrangler 4.141
source. `d1 create` runs with `--update-config=false`, so wrangler never writes an id into the repo file.
Migrations auto-confirm when there is no terminal (Wrangler's fallback answer is "yes"):
- the order of the steps;
- a failed migration blocks the deploy;
- a missing D1 permission gets a precise error;
- a failed health check fails the build;
- the shipped config has no id and no `AUTH_OPEN_READS`, and sets `keep_vars`.

## 2. One-time dashboard setup (about 20 minutes)

State seen from GitHub on 2026-09-27: the Cloudflare check suite on every commit is
"queued" with no runs, so **nothing has been built yet**. Most likely the Worker
isn't linked to a branch that received commits, or its build settings aren't saved.

| # | Where (dash.cloudflare.com) | Set | Why |
|---|---|---|---|
| 1 | Workers & Pages → the Worker linked to `lin2mm/AccessX` (or *Create → Import a repository*) | Worker name **`accessx-demo`** | should equal `"name"` in `wrangler.jsonc`. If it doesn't, wrangler warns "Failed to match Worker name", **deploys under the dashboard name anyway**, and Cloudflare opens a pull request that changes `"name"`. Merge that PR (it only renames), or rename the Worker. The name is part of the workers.dev URL, so `PUBLIC_URL` must use the real one. The Durable Object stores nothing (all data is in D1), so a rename loses no data |
| 2 | Worker → Settings → Build | Git branch **`main`** · Build command **`npm ci`** · Deploy command **`npm run deploy`** · Root directory `/` | `npm ci` installs the pinned wrangler; `npm run deploy` migrates before deploying |
| 3 | My Profile → API Tokens → **"Workers Builds - …"** → Edit | add **Account · D1 · Edit** (same account) | the token Cloudflare generates for builds has no D1 access. Without this the build stops at "Listing D1 databases" and prints this step |
| 4 | Settings → Build → **builds for non-production branches** | **off** | a preview build would run the default preview command against the same production database. Turn it on when a staging Worker exists (section 6) |
| 5 | Settings → Build → Build variables (optional, first build only) | `D1_LOCATION` = `oc` (Oceania) or `wnam`, `enam`, `weur`… | where the database is created. It can't be moved later; pick the region of the customers |
| 6 | Settings → Variables & Secrets (**runtime**, not build variables) | the table in section 3 | build variables don't reach the running Worker |
| 7 | GitHub: merge the pull request into `main` | | first build. Watch its log for `[deploy] healthy:` |

The first build creates the D1 database and applies all migrations. From then on,
builds find it by name. **Never rename `database_name`**: the next build would
create a new, empty database and the Worker would switch to it.
(The old one still exists; to recover, rename back and deploy.)

## 3. Runtime variables and secrets

Generate every secret **on your own computer**, for example with `openssl rand -base64 32`.
Paste it only into the Cloudflare dashboard, or use `npx wrangler secret put NAME`.
Never put one in chat, an issue, a commit or a screenshot.
`"keep_vars": true` in `wrangler.jsonc` means Git deploys never remove what you set here.

| Name | Type | Needed | Value |
|---|---|---|---|
| `ADMIN_TOKEN` *or* `OPERATORS` | Secret | yes (no writes without it) | 32 random bytes / `npm run operator:new` |
| `SECRETS_KEY` | Secret | yes, before connecting any lock or SSO | 32 random bytes. **Also keep an offline copy**: backups can't be opened without it |
| `PLATFORM_TOKEN` | Secret | yes (platform admin, doctor, backups) | 32 random bytes |
| `PUBLIC_URL` | Text | yes | `https://accessx-demo.<account>.workers.dev` now, your own domain later |
| `SECURITY_CONTACT` | Text | yes | `mailto:security@<you>` |
| `AUDIT_SIGNING_KEY` | Secret | before the first customer | `npm run audit:keygen` |
| `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM` | Text / Secret / Text | before invites | [12-GO-LIVE.md](12-GO-LIVE.md) step 6 |
| `TTLOCK_CLIENT_ID`, `TTLOCK_CLIENT_SECRET`, `TTLOCK_NOTIFY_SECRET` | Text / Secret / Secret | before real locks | [10-PILOT.md](10-PILOT.md) |
| `AUTH_OPEN_READS` | Text | **only** for a public demo | `1` lets anyone read doors and the audit log without signing in. Leave it unset for a pilot |

Before any secrets exist, the first deploy is safe: the site loads, reads need a
token, and there is nothing to write with.

## 4. When a build fails

| Build log says | Cause | Fix |
|---|---|---|
| `Listing D1 databases failed. The Cloudflare API token cannot use D1…` | step 3 of section 2 not done | add D1 Edit to the build token, *Retry build* |
| `wrangler.jsonc database_id "…" is a placeholder` | someone put a fake id back | remove the line (or paste the real id) |
| `Applying D1 migrations failed` | a migration errors on real data | nothing was deployed. Fix it with a **new** migration; published migrations are never edited |
| `deployed, but …/api/healthz is not healthy: HTTP 503` | new code, schema behind, or D1 down | rarely the code is live but unhealthy: roll back (section 5), then read `wrangler tail` |
| `Failed to match Worker name … Overriding using the CI provided Worker name` (warning, build continues) | dashboard name ≠ `"name"` | merge the pull request Cloudflare opens, or rename the Worker (section 2 step 1) |
| `…failed: not logged in to Cloudflare` | running `npm run deploy` by hand without logging in | `npx wrangler login`, then retry |
| `WARNING: deployed, but …/api/healthz never answered` (build passes) | a brand-new workers.dev subdomain isn't resolvable yet | open the URL a few minutes later; run `npm run doctor -- --url …` |
| `No workers.dev URL … health check skipped` | `workers_dev` off (custom domain only) | build variable `HEALTH_URL=https://doors.<you>` |

## 5. Rollback

- **Code:** Worker → Deployments → pick the previous version → *Rollback*. Safe,
  because migrations are additive and the old code ignores the new columns.
  Then revert the commit on `main` so the next build doesn't redeploy it.
- **Data:** D1 Time Travel, 30 days: [12-GO-LIVE.md](12-GO-LIVE.md) section 4.

## 6. Other ways to deploy

- **By hand**, the same steps: `npx wrangler login`, then `npm run deploy`.
  `npm run deploy -- --dry-run` makes no Cloudflare calls and bundles only.
  `npm run cf:db:migrate:remote` runs steps 1–3.
  `npm run backup -- d1` resolves the id the same way.
- **Staging (later):** create a second Worker (for example `accessx-staging`)
  with its own `database_name`, in a Wrangler environment. Point its build at a
  `staging` branch, then turn preview builds on. Until then `main` is the only
  place code runs on Cloudflare, so the pull-request checks (tests, isolation fuzz,
  `wrangler deploy --dry-run`) are the gate.
