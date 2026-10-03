# Self-service signup and demo reset

Status: **implemented in R15** (migration 0022, `test/signup.test.js`, Worker
smoke checks). Off unless `SIGNUP_ENABLED=1`.

## What a new customer sees

1. On the sign-in screen: **Create an account** (shown only when signup is on).
2. `/signup`: company, their name, work email, office time zone (detected from
   the browser), terms checkbox. → "Check your inbox".
3. The email: "Confirm your AccessX account for <company>", with a link
   `PUBLIC_URL/signup#t=<token>`, valid **24 hours**, **once**.
4. Opening the link creates the account (tenant) and its owner, then shows the
   owner's **sign-in key once**, with Copy / Download / "I have saved my key".
   The page warns before closing until that box is ticked.
5. **Open AccessX** signs them in (HttpOnly session) and the existing
   **Get started** list takes over: connect TTLock, sites, doors, people
   (see [11-OFFICE-SETUP.md](11-OFFICE-SETUP.md), about 45 minutes).
6. With billing on (`BILLING_ENABLED=1`), they subscribe later from Settings.
   A tenant without a billing account is an unrestricted trial
   ([40-BILLING.md](40-BILLING.md)). Non-payment never locks doors.

Nothing is created until the link is opened, so a typo or a stranger's
address never produces an account.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SIGNUP_ENABLED` | off | `1` opens `/signup`. Also needs `EMAIL_PROVIDER` (+ key, from) and `PUBLIC_URL`, otherwise signup stays off. |
| `SIGNUP_DAILY_LIMIT` | 50 | All signup requests per 24 h, across the deployment. Beyond it: 429 and an error log line. |
| `SIGNUP_TERMS_URL` | — | https link shown next to the terms checkbox. |

`npm run doctor` reports: **error** when signup is on without email or
`PUBLIC_URL`; **warning** without a terms link, and when billing is off
("every new account is free with no end date").

## Abuse and privacy rules

| Rule | Behaviour | Why |
|---|---|---|
| Email must be confirmed | Account only created from the emailed link | Proves the address; no accounts for addresses the person does not own |
| Link | 24 h, single use (compare-and-set claim; two tabs → one account), stored as SHA-256 only | A leaked database row cannot be used |
| Token in the URL fragment (`#t=`) | Browsers do not send fragments to servers or in `Referer` | Keeps the token out of access logs |
| Same address > 3 times a day | Same "check your inbox" answer, no email sent | Nobody can flood someone's inbox; the answer does not reveal anything |
| Same network > 5 a day (IPv4 address / IPv6 /64) | 429, `retry-after: 3600` | Slows scripted signups |
| Burst limit | Node: 10 requests / minute / IP. Workers: the `RL_PUBLIC` binding shared with the visitor links (20 / minute / IP, per Cloudflare location) | Same as the other public endpoints |
| Hidden form field filled | Same "check your inbox" answer, nothing stored or sent | Cheap bot filter |
| Email provider fails | 502 "we could not send the email" | Otherwise a real person waits for nothing |
| Retention | Requests (email, name, company) deleted **7 days** after creation, used or not, by the scheduled maintenance | Data minimisation; the tenant itself keeps only the owner operator record |

The owner operator is created with `createdBy: 'signup'` and an
`operator.create` audit entry ("self-service signup") on the **new tenant's**
audit chain. New tenants start empty (no demo data), with the chosen time zone
as `defaultTimezone`.

## Platform view

`GET /api/platform/signups` (platform token only):

```json
{ "signups": { "enabled": true, "last24h": 3, "dailyLimit": 50, "keepDays": 7,
  "recent": [ { "id": "…", "email": "…", "company": "…", "name": "…",
    "timeZone": "Australia/Sydney", "sent": "delivered", "createdAt": "…",
    "expiresAt": "…", "usedAt": "…", "tenantId": "t_…" } ] } }
```

The newest 100. Tokens and their hashes are never returned. `sent` is `delivered`,
`failed: …`, or `skipped: address limit`.

## Demo reset

`POST /api/platform/tenants/:id/demo-reset` with body `{"confirm": ":id"}`
(platform token only). For the public demo or a sales demo tenant after a
prospect has clicked around.

- **Restores** people, groups, sites, doors, schedules, rules, credentials,
  visits and the other data collections from `data/acl.json` in one
  transaction (in the tenant's Durable Object on Workers).
- **Keeps** settings, operators (so the demo keys still work), sessions and
  billing.
- **Keeps the audit chain.** Audit history cannot be deleted by design; the
  reset is appended as `demo.reset` and `/api/audit/verify` still passes.
- **Refuses (409)** a tenant that has a connected TTLock account, is using a
  live lock vendor, or has a billing account. Real customers can never be
  reset by mistake.
- `400` when `confirm` does not repeat the id, `404` for an unknown tenant.

Known limitation: the seed refers to the demo lock ids (9001…). Resetting a
non-default demo tenant gives it those demo doors too, which is intended for
demos only.

## Tests

- `test/signup.test.js` (6 tests): off by default; the full flow including
  login, tenant isolation and audit; reuse, expiry and parallel opens; per
  address, per network and daily limits; hidden field; email failure; 7-day
  deletion; demo reset refusal, restore and audit chain; doctor.
  Mutation-checked: raising the per-address limit and skipping the `confirm`
  check each make the tests fail.
- Worker smoke (`npm run test:worker`, with `MAIL_PORT=8799` and
  `EMAIL_API_BASE=http://127.0.0.1:8799`): signup → email → new tenant on D1,
  and demo reset through the Durable Object. The smoke run now **fails on any
  new `[ERROR]` line in the wrangler log** (cron included).
