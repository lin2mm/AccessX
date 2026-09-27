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
- `audit_events` has triggers that reject UPDATE/DELETE (DELETE only below a
  retention checkpoint, see below). Someone with raw database access can
  drop them — the hash chain pinpoints a single edit, and anchors catch a
  rewrite of the whole chain.

## Audit anchors, export and retention

A hash chain proves nothing against whoever controls the database: they can
edit an entry and **re-hash everything after it**, and `/api/audit/verify`
still says OK (the test suite does exactly this). What catches it is a copy
of the head hash held by someone else.

- **Anchor** (`audit-ops.js`, `audit-anchor-core.js`, migration 0006): the
  tenant's head `(seq, hash)` plus a timestamp, signed with Ed25519
  (`AUDIT_SIGNING_KEY`, a JWK; `npm run audit:keygen`). Signed bytes:
  `accessx-anchor-v1\n{tenant}\n{seq}\n{hash}\n{createdAt}` — the tenant
  is inside, so an anchor cannot be replayed for another tenant. Stored in
  `audit_anchors` (append-only), recorded in the chain as `audit.anchor`,
  and POSTed to the tenant's `anchorWebhook` (https, public host, no
  credentials, 5 s timeout, redirects not followed). Daily from the
  maintenance job when the chain moved; `POST /api/audit/anchor` on demand.
  The anchor's own chain entry does not count as activity (no daily
  self-perpetuating anchors).
- **Export** (`GET /api/audit/export?fromSeq&toSeq&limit`, audit.read,
  all-site scope, max 10 000 per page, `nextFromSeq` to continue): entries,
  anchors in range, the retention checkpoint, the public key. Every export is
  itself an `audit.export` entry.
- **Offline verification** (`npm run audit:verify -- export.json
  --anchors held.json --pubkey key.json`): recomputes every hash, checks the
  start (genesis / checkpoint / segment), verifies anchor signatures against a
  **pinned** key, and compares the anchors the customer kept with the chain.
  Without `--anchors` it warns that a full rewrite would go unnoticed.
- **Retention** (`PUT /api/audit/settings {retentionDays}`, owner, 365–3650
  or null = forever): the purge deletes entries older than the period, but
  only up to the newest anchor that was *delivered outside AccessX* (or any
  anchor, if an owner confirms `acknowledgeExport:true`). In one batch it
  writes `audit.purge`, inserts a checkpoint `(seq, hash)` into
  `audit_checkpoints` (append-only) and deletes the rows; the DELETE trigger
  only allows rows at or below a checkpoint. Verification then starts from
  the checkpoint instead of genesis. Anchors are kept forever (small).
- **Evidence pack** (`GET /api/reports/evidence?days=30`, `/evidence.html`,
  print → PDF): time-to-revoke, codes waiting for a site visit, administrators
  with flags (never signed in, 90 days idle, owner without SSO), SSO/SCIM
  state, doors without gateways and upcoming clock changes, audit chain and
  anchor status, and a mapping to ISO/IEC 27001:2022 A.5.16, A.5.18, A.7.2,
  A.8.2, A.8.15, A.8.17 and SOC 2 CC6.2–CC6.4, CC7.2. It says "supports
  evidence for", never "compliant".
- Key rotation: anchors carry `keyId`; publish the new public key before
  switching, and keep old public keys so old anchors still verify.

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
  `SECRETS_KEY` is a keyring (`new,old`): ciphertexts are `v2.<kid>.…`
  (kid = SHA-256 prefix of the key), legacy `v1.` values try each key.
  `secrets-rotation.js` lists every sealed value and re-seals with
  compare-and-set; a TTLock refresh that lands on a re-sealed copy of the
  pair it just spent writes over it (otherwise the live refresh token would
  be lost).
- **SCIM** (`scim-core.js`): Users/Groups/discovery under `/scim/v2`,
  `r_provisioner` tokens only. The directory manages only people it created
  or adopted by email; `directory_status` is separate from the operator's
  `suspended` flag (neither undoes the other). Mapped SCIM groups set the
  user groups of directory-managed people; manual members are untouched.
  Stored attributes: userName, externalId, name, one email.

## Domain proof and enforced SSO

- **Domain verification**: saving SSO settings gives every domain a token;
  the owner publishes `TXT _accessx.<domain> = accessx-verification=<token>`
  and presses *Check DNS* (`POST /api/sso/domains/verify`, DoH via
  `dns-core.js`, `DOH_URL` to change the resolver). Unverified claims block
  nobody; the first tenant to prove a domain owns it, and after that nobody
  else can claim or verify it. Only verified domains (a) route
  `/api/auth/sso/start?email=` to a tenant and (b) let SCIM adopt a manually
  created person by email (otherwise a new record is created and
  `scim.link_skipped` is audited — a directory could otherwise take over
  anyone by sending their address).
- **Enforcement** (`PUT /api/sso/enforcement`): people must sign in through
  the IdP; token login and bearer API calls return 403 `sso_required`.
  Exempt: SCIM machine tokens (`r_provisioner`), break-glass owners
  (`operators.break_glass`, migration 0007) and bootstrap operators from the
  server config (`ADMIN_TOKEN`/`OPERATORS` — treat them as break-glass and
  keep them offline). Switching on requires the owner to be signed in via SSO
  right now and a break-glass owner to exist; token sessions of people end
  immediately. While on, the last break-glass owner cannot be revoked and SSO
  cannot be removed. Every break-glass sign-in is audited as
  `operator.break_glass`.

## Four-eyes approvals

- A door group can be `sensitive` (migration 0008). Sensitivity is per
  **lock**: a lock is sensitive if any sensitive group contains it, so an
  unflagged "alias" group around the same lock does not bypass the rule
  (creating one needs approval itself).
- Requests that would grant new access to a sensitive lock return **202**
  with an approval record instead of running: passcodes, assignments, new
  users in groups that reach it, **reinstating a suspended person** whose
  groups reach it (otherwise "create suspended, then unsuspend" would skip
  the new-user approval), directory-group mapping, unflagged door groups
  containing it, deleting a sensitive group, and **deleting a future
  holiday** that closes it (schedules with `denyOnHolidays`, same site or a
  site-less holiday — the only way to widen a schedule, since schedules are
  create/delete only). Removing access never waits.
- `POST /api/approvals/:id/approve` — a different operator holding the
  original route's permission (and scope). The decision is taken inside
  `tenant.transact` (audit-head CAS): racing approvers → one wins. The
  stored request is then re-run **as the requester** through the same route
  handler, so policy, scope and validation are re-checked against current
  data (a person suspended meanwhile gets nothing; `approval.failed`).
  The approver never sees a passcode: it is sealed with `SECRETS_KEY`
  (AES-GCM, bound to tenant + approval id) and only the requester can
  collect it, once (`POST /api/approvals/:id/collect`, audited
  `approval.collect`; the ciphertext is wiped in the same transaction).
  Uncollected codes are discarded 72 h after approval
  (`approval.code_discarded`). Without `SECRETS_KEY`, passcodes for sensitive
  doors fail closed (503 `secrets_key_missing`) instead of falling back to
  showing the approver the code.
- `reject` (with note), `cancel` (requester only), 72 h expiry
  (`approval.expire`). All steps are audit entries; the action's own entry
  carries `approval=<id> approvedBy=<op>`.
- Directory-driven changes are not gated one by one: a SCIM group reaches a
  sensitive door only through a mapping that was itself approved, and SCIM
  reactivation never clears a local suspension (`directoryStatus` and
  `suspended` are separate).

## Time, SLAs and the RBAC gate

**Local times.** Anything a person types as a wall-clock time (schedule
windows, holiday dates, a passcode's last day) is interpreted in the door's
site time zone, never the browser's or the server's. `zonedTimeToDate` in
`policy-core.js` follows RFC 5545 / Temporal `disambiguation: 'compatible'`:
in the repeated fall-back hour the **earlier** instant wins (a code "valid
until 02:30" on the first Sunday of April in Sydney ends at the first 02:30,
not an hour later), and a time inside the spring-forward gap moves forward by
the gap. The passcode API takes `endLocal` (`YYYY-MM-DDTHH:mm`, site time);
`endAt` (an absolute instant) is still accepted. `GET /api/doors` returns each
door's `timeZone` so the console can say so: the passcode and evaluate forms
show the door's zone (flagged when it differs from the browser's), the
evaluate time is prefilled with *now at that door*, and issued codes and the
credentials list show times at the door with the zone abbreviation — never a
bare UTC date that can read as the next day.

**48 h removal SLA.** A revoked code on a lock the cloud cannot reach stays
`pending_removal` until someone confirms it was removed at the door.
`overdueRemovals()` (reconcile-core) lists those older than
`REMOVAL_SLA_HOURS` (48). Each reconcile run adds `removal_overdue` notices
to the plan (the SLA is per tenant, see below), and the first run that sees a credential overdue writes one
`credential.removal_overdue` audit entry (deduplicated on the credential id),
so webhook/anchor consumers and SIEMs see it. The revocation report tags the
row *over 48 h*; the evidence pack counts `overdueOnSite`.

**Per-tenant SLA and alerts.** The removal target is a tenant setting
(`PUT /api/alerts {slaHours}`, 1–720, default 48): a pharmacy may want 24 h.
`alerts-core.js` pushes the events a person must act on — approval requested,
removal overdue, first failed revoke of a credential, break-glass sign-in —
to one webhook per tenant in Slack (`{text}`), Microsoft Teams Workflows
(Adaptive Card attachment; the Office 365 connector format is retired) or
plain JSON (SIEM/ticketing). The URL is a bearer secret, so it is sealed with
`SECRETS_KEY` and only its host is ever shown. Delivery is best effort (4 s
timeout, result kept in `alerts.lastDelivery` via `json_set` so it never
clobbers a concurrent settings change) and never fails the change that
triggered it; the audit log stays the record. Repeating conditions alert
once: overdue removals ride on the one-time `credential.removal_overdue`
entry, failed revokes alert only when the credential had no earlier
`credential.revoke_failed`. `vendor_needs_reconnect` fires from
`markNeedsReconnect` only for the request whose compare-and-set won, so an
incident alerts once however many requests hit the dead token.

**Email and retries.** Email goes through an HTTP API (`EMAIL_PROVIDER` =
`resend` | `postmark`; Workers cannot open SMTP connections), plain text
only, up to 10 recipients per tenant; recipients are personal data, so the
audit records their number, not the addresses. A delivery that fails
transiently (network, timeout, 5xx, 408, 429) is written to `alert_outbox`
(migration 0010) and retried by the scheduled maintenance (`maintainOne`,
i.e. inside the tenant's Durable Object on Cloudflare): 5, 10, 20 … minutes,
at most 6 h apart, 8 attempts (~17 h), then deleted with an `alerts.dropped`
audit entry. Other 4xx mean a misconfigured channel and are not retried. The
outbox holds the message but never the URL or the recipients, so a retry goes
where the channel points *now*, and nothing goes to a channel removed
meanwhile. One alert id is reused on every attempt: the JSON format carries
it as `id`, Resend gets it as `Idempotency-Key` (24 h), Postmark as metadata.
Queued messages may contain a person's name for up to ~17 h after they are
erased (the audit log never does). At most 500 queued alerts per tenant.

**RBAC coverage gate.** `rbac-core.js` fails closed: a path matching no rule
needs the owner. That is safe but hides mistakes — a new manager-level route
would silently be owner-only, or an intended owner-only route would change
meaning if a broad rule were added above it. `test/rbac-coverage.test.js`
walks every route in the API table and fails if any resolves through the
default (owner-only routes are listed explicitly), if a rule matches no route,
if a permission is used by nothing, or if a non-GET route becomes reachable
with the anonymous demo permissions.

## Write serialization (per-tenant queue / Durable Object)

Every write appends to the tenant's audit chain, and `transact()` uses the
chain head as the tenant's version number (optimistic concurrency, no lost
updates). That is correct under any load, but under a burst the writers keep
invalidating each other. `npm run load:scim` (support/scim-load.js) replays an
IdP's first sync of 2,000 people; on the Worker with local D1:

| 2,000-user SCIM sync, 8 in flight | before | per-tenant Durable Object |
|---|---|---|
| failed writes (409 "conflicting change") | 25 creates + 3 deactivations | **0** |
| create throughput | 7.7 req/s | 10.5 req/s |
| create p99 | 5.1 s | 1.6 s |
| deactivate p99 | 10.7 s | 2.7 s |

A failed SCIM write is not retried soon: Entra ID parks it ("escrow") for a
later cycle and quarantines the job if many fail, so a failed deactivation
means a leaver's code keeps working for another cycle or longer.

Now writes go through `tenant-queue.js`, one at a time per tenant, FIFO,
bounded (429 + `Retry-After` past `WRITE_QUEUE_MAX`, default 256):

- **Cloudflare:** the front Worker resolves the tenant from the bearer token
  or session (`auth.tenantHint`, no side effects) and forwards writes to
  `TenantWriter` (`idFromName(tenantId)`), which runs the normal `api.handle`
  under the queue. A Durable Object is one instance worldwide, so this holds
  across isolates and colos. It keeps no state; data stays in D1. Reads and
  writes without a resolvable tenant (login, platform calls, bad tokens) are
  handled at the edge — bad credentials never reach a DO.
- **Node:** the same queue in-process (a single Node process; several
  processes behind a load balancer fall back to optimistic retries).
- The scheduled reconciler and audit maintenance run in the same queue:
  on Cloudflare `scheduled()` sends each tenant's work to its TenantWriter
  (`/__tenant/cron`, reachable only through the binding — the front Worker
  forwards nothing but `/api/*` and `/scim/*`); on Node `reconcileAll()` and
  `maintenance()` go through `writeQueue`.
- `transact()` stays: unqueued paths (login, platform calls, several Node
  processes) still rely on it,
  and `test/approvals.api.test.js` runs with `WRITE_QUEUE=off` so the
  in-transaction guard keeps its own race test.

### Snapshot cache

Every handler used to re-read the whole tenant (ten tables) per request:
O(people) time and D1 rows read, and — because writes are serialized per
tenant — a hard cap on write throughput as a tenant grows.
`store/snapshot-cache.js` keeps a per-process copy and makes staleness
structural rather than a matter of discipline:

- **Versioning in the database.** `migrations/0011` adds triggers on all ten
  snapshot tables: any insert/update/delete — any code path, a manual
  `wrangler d1 execute` included — bumps `tenants.data_version` and logs
  `(version, table, row id)` in `snapshot_changes`.
- **Check on every read.** `snapshot()` reads the tenant row (settings +
  `data_version`) exactly as before. Same version → cached collections, no
  table reads. Newer → fetch only the logged rows (≤ 90 ids per statement:
  D1 allows 100 bound parameters) and patch copy-on-write, keeping full-load
  (`rowid`) order. Settings are never cached (they have side writes via
  `json_set`).
- **Fallbacks to a full reload:** a hole in the log (pruned — maintenance
  keeps the newest 5,000 rows per tenant), more than 2,000 changes, an entry
  older than 15 min, or a restored database (the cached version's log row is
  gone). A database without migration 0011 is served uncached, not failed.
- **Many processes, no coordination.** Every Worker isolate and the
  tenant's Durable Object keep their own cache; since each read checks the
  database version, a suspension written through the DO is visible to the
  next read in any isolate (tested on the Worker).
- **Shared objects are read-only.** Items are deep-frozen and every caller
  gets its own arrays. The modules are sloppy-mode, where writes to frozen
  objects fail silently, so tests and CI run with `ACCESSX_SNAPSHOT_GUARD=1`:
  items become proxies that throw on any write. The whole suite passes in
  that mode.
- **Budget.** `SNAPSHOT_CACHE_ROWS` (Node 500k, Worker 100k — isolates have
  128 MB): least recently used tenants are evicted; a tenant larger than the
  budget is served uncached.

Measured (`support/snapshot-bench.js`, Node/SQLite, people + as many
credentials; median per request):

| people | read before → after | write before → after |
|---:|---:|---:|
| 1,000 | 23 → 8 ms | 22 → 7 ms |
| 10,000 | 246 → 7 ms | 223 → 8 ms |
| 30,000 | 814 → 7 ms | 888 → 21 ms |

Local D1 through `wrangler dev` (5,000 people): read 178 → 18 ms, write
through the Durable Object 188 → 26 ms; D1 rows read per cached request drop
from ~10,000 to 1. Cost: each row write also writes one `tenants` update and
one log row (3× rows written on D1).

D1 remote migrations: the server-side splitter mis-parses triggers with a
lowercase `BEGIN`, CRLF line endings, or a trigger as the file's last
statement (cloudflare/workers-sdk#15314); `test/snapshot-cache.test.js`
lints every migration for these. After a D1 Time Travel restore, caches
notice on their own (above); redeploying also clears them.

## TTLock outages

Every TTLock call has a 15 s timeout (a hung call would otherwise also hold
the tenant's write queue in the Durable Object). Network errors, timeouts,
gateway error pages and the call limit (30006) become `503` with
`reason: "unavailable"` and `Retry-After: 30`; `needs_reconnect` and a missing
`SECRETS_KEY` get no `Retry-After` because only a person can fix them.
Suspensions and SCIM deactivations still succeed during an outage: the
credential stays `active` (it is still on the lock), the failure is recorded,
and the reconciler retries. A lost write race answers `409` with
`Retry-After: 2` (SCIM included).

## TTLock token refresh across instances

TTLock refresh tokens are single use. Two instances (isolates, processes)
that refresh at the same moment used to break the account: the loser's
refresh is rejected *before* the winner has saved the new pair, the loser
re-read the unchanged row and marked the account `needs_reconnect` — every
revocation of that tenant then failed with 503 until an owner reconnected.
Now (`vendor-accounts.js` `tokenSource`):

1. one refresh per tenant per instance (single-flight);
2. on rejection, poll the row for up to `refreshGraceMs` (3 s) and adopt the
   winner's tokens when they appear;
3. `needs_reconnect` is set only if the stored tokens are still the ones that
   failed (compare on `sealed`), and the winner's save sets `connected` again,
   so even a winner slower than the grace window heals the account.

Tests reproduce the race with two `vendorAccounts` instances on one database
and a fake TTLock that rotates refresh tokens.

## Visitors

- A **visit** (table `visits`, migration 0012) is an invitation: visitor
  name/email/company, host, site, doors, window, status
  (`scheduled | checked_out | cancelled`; `active`/`ended` are derived from
  the clock). It is not in the tenant snapshot (it grows with every visit):
  routes query it directly, always with `tenant_id`.
- Its codes are ordinary `credentials` rows with `visit_id` set and
  `userId` = the host. So review, reconciler, removal SLA, alerts and the
  revocation report cover visitor codes with no extra code. The review
  treats them differently in one way: they are authorised by the visit, not
  by rules, and are flagged only when the **host** is suspended or removed
  (or they expired). Suspending a host therefore revokes their visitors.
- `POST /api/visits` checks: host active and visible to the operator, every
  door in this tenant's fleet and the operator's sites, all doors at one
  site (one time zone), **no sensitive doors** (409: those need a rule and
  four-eyes), at most `maxHours` (default 24, owner-settable up to 168),
  starts at most 30 days ahead. Then one TTLock period code per door, with
  the visit window as validity, and one unit of work: visit row +
  credentials + `passcode.create` per door + `visit.create`. If the vendor
  fails halfway, codes already on locks are deleted (gateway) or recorded as
  `pending_removal` — never left untracked.
- **Personal data** stays in `visits` only. Audit entries carry the visit
  id, host id and lock ids; TTLock gets `AccessX visit <id>` as the code
  name. `POST /api/visits/:id/erase` nulls name/email/company on request;
  maintenance does it `retentionDays` (default 30) after the visit ends and
  audits `visits.erased` with a count.
- **Email** (`alerts.emailTo`): one attempt after the commit, never through
  the alert outbox — a queued message would store the code. On failure the
  code is still shown and the operator is told to hand it over.
- **Checkout / cancel**: gateway → `deletePasscode` → `revoked`; no gateway →
  `pending_removal` plus a warning that the code works until its end time
  unless removed at the lock. A failed delete keeps the progress, leaves
  the visit open and returns the error, so a retry finishes the job.
- RBAC: `visitor.manage` (implied by `credential.issue`); `r_front_desk` =
  `door.read` + `visitor.manage` — no people, rules, reports or sensitive
  doors. `PUT /api/visits/settings` is owner-only.

### Visitor arrival

- TTLock reports each unlock with the code that was typed
  (`lockRecord/list`, and the "lock records notify" callback: a form POST
  with `records=<JSON array>` of `{lockId, recordType, success, keyboardPwd,
  lockDate, …}`; recordType 4 = passcode unlock). We never store codes, so
  a visit keeps **keyed fingerprints** of its codes (`visits.code_macs`,
  `secrets-core.codeMac`: HMAC-SHA256 under a subkey of each `SECRETS_KEY`
  entry, input = tenant | lock | code). A 6-digit code cannot be recovered
  from the fingerprint without the key; with the key nothing new is exposed
  (it already unseals the TTLock tokens, which can list every code).
  Rotation-safe: matching tries every key in the ring.
- **Callback** (`POST /api/ttlock/notify/<TTLOCK_NOTIFY_SECRET>`): TTLock
  accepts one callback URL per developer app, so it serves every tenant.
  The request is unauthenticated apart from the secret path, so it is
  treated as information only: it can mark an arrival and send a notice,
  never change access. Matching is read-only and cross-tenant (open visits
  covering that lock at that time, then the fingerprint — which binds the
  tenant — must match). The write (`visit.arrived` + audit + host email +
  opt-in `visitor_arrived` alert) runs in the tenant's queue: `serialize()`
  on Node, the tenant's Durable Object (`/__tenant/arrival`) on Workers.
  Responds `success` as TTLock expects.
- **Polling fallback** (maintenance): for visits on site now and not yet
  arrived, read the last 100 records of up to 10 gateway doors per tenant.
  Doors without a gateway only upload records when a phone syncs, so their
  arrivals may show late or never.
- Recorded once (CAS on `arrived_at IS NULL`); cancelled/checked-out visits
  and unlocks outside the window are ignored.

### Office setup pack

- `onboarding-core.js` is pure: `plan(locks, snapshot, {timeZone, hours})`.
  Sites come from TTLock `groupName` (from `/v3/lock/list`), door groups
  from door-name patterns (secure checked first), schedules and people
  groups are reused by name. Locks already in any door group are skipped,
  which makes re-running a no-op.
- `POST /api/onboarding/office` recomputes the plan server-side (the client
  sends only time zone and hours), validates every item with
  `validate-core` against a working copy of the snapshot, and commits one
  unit of work: one `<collection>.create` audit entry per item plus an
  `onboarding.office` summary. It refuses (409) if a non-sensitive group
  would contain an already sensitive door, and never assigns anyone to the
  sensitive group, so no four-eyes gate is bypassed.

### Lock health (battery trend, silent callback)

- `lock-health-core.js` is pure; `checkLockHealth` runs in the tenant's
  maintenance (inside its write queue). Battery: at most every 6 h the lock
  list levels are upserted into `lock_battery` (tenant, lock, day), plus any
  `electricQuantity` on callback records; 120 days kept. A least-squares
  slope over the samples since the last jump of ≥ 15 points (a new battery)
  gives days to 10%. Bands ok → forecast (≤ 21 days) → low (≤ 20%) →
  critical (≤ 10%); `lock_health` stores the band last announced, so alerts
  only escalate, reset on a new battery, and repeat weekly while critical.
  Doors without a gateway report the level of their last app sync (flagged).
- Silent callback: `ttlockCallbackAt` (set by the callback) is compared with
  business hours at the tenant's first site. Past 8 business hours, at most
  hourly, up to 5 gateway doors' records are read; records newer than the
  last callback prove TTLock is not calling. One alert per silence
  (`callbackSilentFor` = the `ttlockCallbackAt` it was raised for, so the
  next callback starts a new episode), audited `ttlock.callback_silent`, and
  the missed records are run through arrival matching and alarm detection
  (flagged late). No records → the doors were idle → nothing.
- `GET /api/doors/health` (door.read, site-scoped): forecasts per door and
  the callback state for the dashboard.

### Lock alarms

- Same TTLock records, other record types: 29 forced opening, 44 tamper,
  48 keypad locked after repeated wrong codes, 64 door left open
  (`lock-events-core.js`). The callback routes each alarm to tenants whose
  door groups contain the lock (read-only), then **inside the tenant's
  queue** the lock must be in that tenant's own TTLock fleet — a door group
  can name any number, so without this check a tenant could subscribe to a
  stranger's alarms.
- `lock_alarms` keeps every report (primary key tenant+lock+kind+time, so a
  resent record is ignored); one alert per lock and kind per 30 min;
  `lock.alarm` is audited for announced alarms. Records uploaded more than an
  hour after the event (no gateway, phone sync) are marked late.
- Polling only reads doors with a visitor on site, so alarms on other doors
  need the callback.
- Adding a default-on alert event: owners who saved an event list earlier get
  it too (`eventsSeen`); once they untick it, it stays off.

### Visitor self check-out

- With `PUBLIC_URL`, creating a visit that is emailed/texted (or
  `checkoutLink: true`) stores `sha256("visit-checkout|" + token)` for a
  144-bit random token and sends `PUBLIC_URL/checkout#<token>`. The fragment
  is never sent to a server (no access logs, no Referer), the page removes it
  from the address bar and POSTs it in the body to `/api/visit-checkout`
  (`status` or `checkout`).
- It can only **reduce** access: end the visit, delete codes on gateway doors,
  mark the rest for removal. It never returns names or codes. Valid while the
  visit is scheduled and until one hour after its end; cleared by check-out,
  cancel and erasure. The write runs in the tenant's queue (Node
  `serialize`, Worker DO `/__tenant/job`), audited with actor `visitor`.

### Visitor invitations (pre-registration)

- `visit_invites` (migration 0018) holds the envelope (host, site, doors,
  local window), the fixed contact and `sha256("visit-invite|" + token)`.
  Created with the same `planVisit` checks as a visit; the link
  `PUBLIC_URL/invite#<token>` is sent to the contact and shown once to the
  operator.
- `POST /api/visit-invite` (public, outside `api.routes`, registered before
  the JSON parser on Node; `handlePublicJson` on the Worker): `status`
  returns site, doors, window and the *masked* contact; `submit` runs in the
  tenant queue (`invite_submit` job). Without approval it calls the shared
  `createVisit` with a ctx built for the inviting operator (current role and
  scope), actor `invite:<id>`; delivery goes only to the invite's channel,
  and an undelivered visit is cancelled immediately. With approval
  (default on sites with sensitive doors) it stores the details; approve
  runs `createVisit` with the approver's own ctx.
- Erasing the visit nulls the invite's contact and submitted details;
  maintenance expires stale invites and erases them after `retentionDays`.

### TTLock validity rules (all passcodes)

TTLock's keyboardPwd/get documents two rules the lock enforces regardless of
what we send: validity is **whole hours** ("set the minute and second to
0"), and a period code must be **used once within 24 h of its start** or it
is voided. `credentials-core.ttlockWindow()` computes the window the lock
will actually enforce — rounded on the door's wall clock (start down, end
up; if rounding up would pass a person's `validTo`, round down) — and that
is what is recorded and sent. Before this, "valid until 23:59" was recorded
while the lock enforced something else. `ttlockWarnings()` tells the
operator when rounding moved a time and, for windows over 24 h, the
first-use deadline. Half-hour zones (Adelaide, India) round on the local
clock; confirm on a real lock in such a zone before selling there.

## Vendors

- Interface: `listLocks, unlock, createPasscode, deletePasscode, records,
  info, status, mirror?` (`vendor-demo.js`, `vendor-ttlock-core.js`).
- **Per-tenant TTLock accounts** (`vendor-accounts.js`, table
  `vendor_accounts`): an owner connects the tenant's own TTLock account
  (`PUT /api/vendor-account`). The password is used once (OAuth password
  grant) and discarded; only the access/refresh tokens are stored, sealed
  with `SECRETS_KEY` (AAD = tenant). The platform's TTLock app
  (`TTLOCK_CLIENT_ID/SECRET`) is used unless the tenant brings its own.
- One TTLock account (uid) belongs to one tenant (unique index): lock ids
  are global at TTLock.
- Tokens are refreshed 7 days before expiry and on a rejected token; the
  refreshed tokens are written back with compare-and-swap so other
  instances pick them up. If TTLock refuses the refresh (password changed,
  access revoked) the account becomes `needs_reconnect`: lock calls return
  **503 with a reason**, the rest of the app keeps working.
- The lock list is cached for 60 s per instance (TTLock rate limit 30006).
- The TTLock client (`ttlock.js`, `md5.js`) runs in Node and Workers.
  OAuth uses snake_case `client_id/client_secret` (the v3 API uses
  `clientId`) — the old client got this wrong, so the legacy live mode could
  never log in.
- Legacy: the server's default tenant can still use env credentials
  (`TTLOCK_USER/PASS`); a connected account overrides them. The record
  mirror is file-based and default-tenant only (501 elsewhere).
- `scripts/ttlock-check.js`: run on site with the real account — login,
  lock clocks vs server clock (DST), and with `--write <lockId>` a
  create → delete(deleteType=2) round trip to confirm on the keypad.

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

- Visitor codes are one per door; TTLock has no multi-lock code. A visit is
  capped at 5 doors. For recurring contractors, use a person + rule instead.
- Auth rate limiting is in-memory (per process / per isolate). Use a
  Durable Object or Cloudflare rate-limiting rules in production.
- SAML is not supported (OIDC covers Entra, Okta, Google; add SAML only when
  a customer needs it). DNS proof is checked once; re-check periodically and
  un-verify domains whose TXT record disappears (domain sold/expired).
- SCIM has no ETags and no `/Bulk`; filters are `attr eq "value"` only.
- The mock IdP (`support/mock-idp.js`) must never be enabled in production.
