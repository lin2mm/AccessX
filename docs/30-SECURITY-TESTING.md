# Security testing plan

AccessX opens real doors. Before the first paying office, get an external
test by people who did not write the code. This page covers what we already
test ourselves, what the external test must cover, how to run it safely, and
the rate limits on the endpoints that need no login.

## What runs on every commit

| Check | What it proves |
|---|---|
| `npm run test:isolation` (merge gate) | **Tenants:** ~3,500 requests across all 128 routes, SCIM and sessions with tenant B's tokens against tenant A's data: 0 responses may contain A-only markers, nothing in A may change. **Sites** (`test/scope.fuzz.test.js`): ~1,980 requests from an operator holding *every* permission through a custom role but scoped to one site, with other sites' ids and "mixed" bodies (own group, other sites' doors/people inside): nothing outside that site may change and no new record may reach outside it. Mutation-checked: removing the door-group check (the R12 finding) or the "every group in scope" rule for deleting people makes it fail. |
| `npm test` | Role and site scope (RBAC), four-eyes on sensitive doors, the audit hash chain, SCIM, OIDC (issuer mix-up, nonce, PKCE), secrets encryption and rotation, the visitor links (one use, attempt limits, same 404 for every invalid state), the rate limits and the SSRF guards below. |
| `npm run test:worker` (`bash support/smoke-fresh.sh`) | The same API on Cloudflare (D1, Durable Object) against a fresh database, including overlapping reads and writes on a cold instance, the Nuki flow on workerd and a clean wrangler log. Run by hand before a release (not in CI). |
| `npm audit` | Run at each release; R22: 0 known vulnerabilities (68 production dependencies). |

## Scope for the external test

Ask for a grey-box test: testers get source code access, two tenants with an
owner, a manager scoped to one site, a viewer and a directory-sync (SCIM)
token each, and one bench TTLock lock with a gateway. **Never test against a
customer's tenant or doors.**

1. **Tenant isolation.** Read or change another tenant's people, doors,
   codes, audit or settings through any route, SCIM, the session, the TTLock
   callback or a visitor link. Our fuzz gate covers known routes; the tester
   should try IDs, pagination, filters and error messages we did not think of.
2. **Authentication and sessions.** Operator tokens, SSO (OpenID Connect:
   issuer mix-up, `state`/`nonce` replay, account linking by email, a
   disabled user signing in), enforced SSO with break-glass, session cookie
   (HttpOnly, SameSite, CSRF token), sign-out, SCIM token scope.
3. **Authorisation.** A site-scoped manager reaching another site's doors —
   **spend the most time here**: the one real escalation found so far (R12)
   was a custom role with `rule.manage` scoped to one site filing another
   site's door into its own door group. The site-scope gate now covers every
   route with one custom role; the tester should combine permissions, SCIM
   group mappings, approvals and invites in ways a single role does not; a
   viewer writing; a Front Desk (visitors-only) operator issuing staff codes;
   bypassing four-eyes on sensitive doors (including via SCIM group mapping,
   office setup and visitor invites, which act as the inviting operator).
4. **Unauthenticated endpoints.** `/api/ttlock/notify/<secret>` (forged
   records, other tenants' lock IDs, replay, huge bodies),
   `/api/visit-checkout` and `/api/visit-invite` (token guessing,
   enumeration through timing or error differences, getting a code to an
   address the host did not enter), `/api/signup` and `/api/signup/verify`
   (account creation, email enumeration, the daily caps), `/api/kiosk` (a
   paired tablet's key: walk-in codes without reception, reading the visitor
   list), `/api/calendar-confirm` (the organiser's one-time link), calendar
   mail (the Worker's `email()` handler; on Node `POST /api/inbound/calendar`
   with its Bearer secret: forged senders, a meeting that names another
   tenant's address), `/api/stripe/webhook` (signature, replay window).
   Public by design: `/api/healthz`, `/.well-known/security.txt`.
5. **Server-side requests (SSRF).** Alert webhooks, the audit anchor webhook
   and the SSO issuer are owner-entered URLs the server fetches. Try private
   and metadata addresses, IPv6 forms, DNS names that resolve to private
   addresses, and redirects.
6. **Credentials and secrets.** Whether a passcode, TTLock password, webhook
   URL or SSO client secret can be read back through any response, export,
   log line or audit entry; what an attacker with a D1 dump alone can do
   (it should be: nothing without `SECRETS_KEY`).
7. **Browser.** XSS in every field shown in the UI (door names from TTLock,
   visitor names, company, SCIM display names), CSP bypasses, clickjacking
   of the approval buttons (R22: `frame-ancestors 'self'` + `X-Frame-Options`;
   check that no page escapes it), and the Chinese interface layer
   (`public/i18n.js` rewrites text nodes and attributes after rendering: it only
   uses `nodeValue` / `setAttribute`, never HTML, so check that no dictionary
   entry or pattern can turn user text into markup).
8. **Audit integrity.** Changing, deleting or reordering audit entries
   without `GET /api/audit/verify` and the external anchor noticing.

Out of scope: the TTLock cloud and lock firmware (report findings to TTLock),
Cloudflare's platform, denial of service beyond the rate limits below.

## Running it

- A staging deployment on its own Cloudflare account or Worker name, own D1,
  own `SECRETS_KEY`, with `EMAIL_API_BASE` pointed at a mailbox the testers
  can read. No `ALLOW_HTTP_WEBHOOKS` or `ALLOW_HTTP_ISSUERS` on staging:
  test the production settings.
- Pick a firm with web application and API testing experience (CREST or
  OSCP-certified testers); ask for a retest of fixes in the quote. Budget
  about 5–8 tester days for the scope above.
- Fix critical and high findings before the first office goes live. Set
  `SECURITY_CONTACT` (and optionally `SECURITY_POLICY`) so
  `/.well-known/security.txt` tells researchers where to report.

## Known limits (tell the testers)

- **SSRF on Node:** URL checks are on the literal host (including IPv4
  hidden in IPv6 literals: `[::ffff:a9fe:a9fe]` is refused). A DNS name that
  *resolves* to a private address is not caught on the Node server. On
  Cloudflare Workers, outgoing requests cannot reach private networks, so
  this only matters for self-hosted Node deployments; put those behind an
  egress firewall.
- **Failed sign-in counting on Workers** is per isolate (`auth-core.js`),
  so it is a weak brake at scale. Operator tokens are 192-bit random, so guessing is
  not practical, but add a Cloudflare WAF rate-limiting rule on `/api/*`
  responses with status 401 once on a plan that offers it.
- The TTLock callback has no signature (TTLock does not sign it). The URL
  secret is the only credential; records are only accepted for locks in the
  receiving tenant's own fleet, and at most change arrival and health data.

## Rate limits on the endpoints without a login

| Endpoint | Limit | Key |
|---|---|---|
| `POST /api/ttlock/notify/<secret>` | 600 per minute | client address |
| `POST /api/visit-checkout`, `POST /api/visit-invite`, `POST /api/calendar-confirm` | 20 per minute (together) | client address; IPv6 per /64 |
| `POST /api/stripe/webhook` | 600 per minute | client address |
| `POST /api/signup`, `POST /api/signup/verify` | 10 per minute (plus daily caps per address and in total, counted in the database) | client address |
| `POST /api/kiosk` | 120 per minute (plus per-kiosk walk-in caps in the database) | client address |
| `POST /api/inbound/calendar` (Node) | wrong or missing secret: 20 per minute, then 429 | client address |

Over the limit the answer is `429` with `Retry-After: 60`. Code:
`rate-limit-core.js`.

- **Cloudflare:** the Workers Rate Limiting bindings `RL_NOTIFY` and
  `RL_PUBLIC` in `wrangler.jsonc`. They count per Cloudflare location and are
  eventually consistent: a brake on scanners, not an exact quota. The
  `namespace_id`s must be unique in your Cloudflare account; change them if
  they collide. Without the bindings the Worker falls back to per-isolate
  counting.
- **Node:** exact counting in the one process, same limits. The client
  address is the first `X-Forwarded-For` entry, as for sign-in limits, so
  expose the Node server only behind a proxy that overwrites that header.
- A limiter error never blocks the endpoint (it fails open): the visitor
  links already lock after 5 wrong attempts per invite, and unknown secrets
  and tokens are a cheap `404`.

## Self-review before the pilot freeze (R22, 2026-09-27)

Not a substitute for the external test: the same person who wrote the code
checked it. Each area of the scope above, what backs it, and what is left for
the testers.

| Area | Evidence | Left open / for the testers |
|---|---|---|
| 1. Tenant isolation | Isolation gate on every commit: 3,502 requests, 128 routes + SCIM + session, 0 leaks | Pagination, filters and error texts the gate does not generate |
| 2. Authentication | OIDC tests (issuer mix-up, nonce, PKCE, no redirects followed), HttpOnly cookie + CSRF token, enforced SSO with break-glass, tokens stored as SHA-256 | Failed sign-in counting on Workers is per isolate (see Known limits); no dedicated test for a person disabled in the identity provider (or through SCIM) signing in by SSO |
| 3. Authorisation | Site-scope gate 1,980 requests, also watching vendor calls and audit (R18); the two real escalations found (R12 door group, R18 vendor call) are fixed and covered | Combinations of SCIM group mappings, approvals and invites across sites |
| 4. Endpoints without login | All listed above are rate-limited on both runtimes (same list in `server.js` and `worker.js`); link tokens are stored hashed, used once, and every invalid state answers the same 404 | TTLock callback has no signature (vendor limit) |
| 5. SSRF | Literal-host guards incl. IPv4-in-IPv6, redirects refused, tests in `test/ssrf.test.js` | DNS names resolving to private addresses on Node (Workers cannot reach private networks) |
| 6. Secrets | Vendor tokens and approval codes sealed with `SECRETS_KEY`, keyring rotation tested; a D1 dump holds no usable door code or token | The dump does hold personal data in plain text; R2 copies rely on a private bucket until SSE-C is added (`12-GO-LIVE.md` §5) |
| 7. Browser | `script-src 'self'`, no inline scripts or handlers (tested), output escaped; **R22 found no clickjacking protection** and added `frame-ancestors 'self'` + `X-Frame-Options` (Node and `_headers`, tested, mutation-checked; `FRAME_ANCESTORS` for intended embedding, doctor fails on `*`) | `style-src 'unsafe-inline'` remains (inline `style=` attributes in the UI) |
| 8. Audit integrity | Hash chain, `GET /api/audit/verify`, signed anchors to an external webhook, purge only up to a delivered anchor | Anchors are unsigned unless `AUDIT_SIGNING_KEY` is set |
| Dependencies | `npm audit`: one moderate advisory in `qs` (via Express) fixed by updating to 6.16.0; now 0 | Re-run monthly and before each release |
| Configuration | `npm run doctor` fails production on open anonymous reads, `FRAME_ANCESTORS=*`, missing secrets; the demo value `AUTH_OPEN_READS=1` in `wrangler.jsonc` is refused once real TTLock credentials are set | Run it against the live site after every deploy (`12-GO-LIVE.md`) |

