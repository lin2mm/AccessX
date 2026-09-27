# Billing plan (Stripe): per door per month, SMS at cost plus

Status: **implemented behind a flag** (`BILLING_ENABLED=1`, off by default;
tested against Stripe test mode through a fake Stripe server). See
[Implemented](#implemented) at the end for where the code differs from this
plan. Prices are placeholders created in the Stripe dashboard, not in code.

## What we charge

| Line | Unit | Why |
|---|---|---|
| Doors | per door per month, billed on **door-days** (a door that exists for 10 days of a 30-day month costs a third) | What competitors charge for, and it scales with the customer's value. Door-days need no proration logic: add or remove a lock and the next day's count follows. |
| SMS | per message segment sent (visitor codes, invites) | Real cost per text varies by country (Twilio). Pass it through with a margin; email stays free. |
| Minimum | e.g. 5 doors | A 2-door customer costs as much to support as a 5-door one. |

Price points are a pilot decision, not a code decision: test them in the
pilot calls (docs/10-PILOT.md) against what the office pays today (keys, fobs,
locksmith visits, the Kisi/Brivo quote it didn't sign). Keep one price list
per currency (AUD, USD) instead of converting.

**Never tie door access to payment.** An unpaid invoice must never lock
people out or stop code removals. See *Non-payment* below.

## Stripe objects

- **Two meters** (Billing → Meters), aggregation *sum*:
  `accessx_door_days` and `accessx_sms_segments`, customer mapping by
  `stripe_customer_id`. Since API version `2025-03-31.basil` every metered
  price must have a meter; the old usage-record API is gone.
- **Prices:** door-days: monthly price ÷ 30 per unit (e.g. 12.00/30 = 0.40
  per door-day; Stripe accepts decimal unit amounts). SMS: per segment. Add
  the minimum as a fixed monthly price with the first 5 doors' worth of
  door-days (150) as billing credits, or as a flat base plan; decide after
  the pilot.
- **Customer** per tenant, `metadata.tenant_id`, created by Checkout.
- **Stripe Tax** for GST (Australia) and US sales tax on software.
- **Customer portal** for cards, invoices and cancellation.
- Pin `Stripe-Version` on every request. No SDK in the Worker: plain `fetch`
  with form-encoded bodies keeps the bundle small, like the Twilio and TTLock
  clients.

## Data (one migration)

```sql
CREATE TABLE billing_accounts (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  stripe_customer_id TEXT NOT NULL,
  stripe_subscription_id TEXT,
  status TEXT NOT NULL,            -- trialing | active | past_due | canceled
  past_due_since TEXT,
  updated_at TEXT NOT NULL
);
-- What has been sent to Stripe. The primary key is the idempotency guard;
-- Stripe's own identifier de-duplication is only a second line.
CREATE TABLE billing_reports (
  tenant_id TEXT NOT NULL,
  meter TEXT NOT NULL,             -- door_days | sms_segments
  report_key TEXT NOT NULL,        -- door_days: YYYY-MM-DD; sms: YYYY-MM:<cumulative n>
  value INTEGER NOT NULL,
  sent_at TEXT,
  PRIMARY KEY (tenant_id, meter, report_key)
);
```

## Metering (daily cron, per tenant, in its Durable Object)

1. **Door-days.** Once per UTC day: the number of doors in the tenant's
   connected fleet (not the demo doors). Insert `billing_reports` row
   `(tenant, 'door_days', <date>, n)`, then send a meter event with
   `identifier = <tenant>:door_days:<date>` and `timestamp` = that day at
   12:00 UTC. Mark `sent_at` on success. A missed day is retried the next
   day; Stripe accepts timestamps up to 35 days back.
2. **SMS.** `usage_counters.sms_segments` is cumulative per month. Send
   `n - (sum already reported for the month)` with
   `identifier = <tenant>:sms:<YYYY-MM>:<n>`: a retry after a timeout
   repeats the same identifier, so it cannot double-bill.
3. **Month end.** Stripe has a grace period (1 hour by default,
   configurable) after the billing period for late events. Run the SMS
   report hourly on the last day and at 00:05 UTC on the 1st.
4. Stripe allows one concurrent meter-event call per customer per meter;
   the per-tenant Durable Object already serializes these.
5. Corrections (e.g. a refund for a failed batch of texts) are negative
   meter events with their own identifier; they are audited like any other
   change.

## Sign-up and webhooks

- `POST /api/billing/checkout` (owner): Checkout Session in `subscription`
  mode with both metered prices; returns the Stripe URL.
- `POST /api/stripe/webhook`: verify `Stripe-Signature` (HMAC-SHA256 of
  `<t>.<raw body>` with the endpoint secret, WebCrypto, 5-minute tolerance,
  constant-time compare); de-duplicate by event ID. Handle
  `checkout.session.completed` (create `billing_accounts`),
  `customer.subscription.updated|deleted`, `invoice.paid`,
  `invoice.payment_failed`, and `v1.billing.meter.error_report_triggered`
  (usage Stripe rejected: raise a platform alert, do not drop it).
- Rate-limit the webhook like the other unauthenticated endpoints
  (`rate-limit-core.js`).

## Non-payment

| Days past due | Effect |
|---|---|
| 0–14 | Banner for owners; Stripe retries the card (Smart Retries) and emails. |
| 15–45 | Admin is **read-only for adding**: no new people, visitors, invites or texts. Removing access, offboarding, SCIM deprovisioning, exports and the audit stay available. Door codes keep working. |
| 45+ | Owner gets an export; the tenant is closed after notice. Codes on locks are removed only when the customer asks, or at closure with 30 days' written notice. |

## Tests before launch

- Unit: signature verification (good, wrong secret, old timestamp,
  replayed event), report keys, SMS delta after a retry, month rollover in
  the tenant's and UTC time.
- Stripe test clocks: advance a subscription through a month with a door
  added on day 10 and removed on day 20; the invoice must show the exact
  door-days and SMS segments.
- `GET /api/platform/usage` gains `doorDays` next to `sms` so what we bill
  is visible before Stripe sees it.

## Implemented

Code: `billing-core.js` (Stripe client without the SDK, webhook signatures,
standing), `migrations/0020_billing.sql`, routes in `api-core.js`, raw-body
webhook endpoints in `server.js` and `worker.js`. Tests:
`test/billing.test.js` against `support/fake-stripe.js`.

**Setup (test mode first):**

1. Stripe dashboard → Billing → Meters: create `accessx_door_days` and
   `accessx_sms_segments` (aggregation *sum*), then one metered monthly price
   on each. The per-unit price is the business decision (e.g. 10–15 per door
   per month ÷ 30 per door-day).
2. Webhook endpoint `https://<your host>/api/stripe/webhook` with
   `checkout.session.completed` and `customer.subscription.*`.
3. Customer portal: enable card update, invoice history and cancel.
4. Set `BILLING_ENABLED=1`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
   `STRIPE_PRICE_DOOR_DAYS`, optionally `STRIPE_PRICE_SMS`,
   `STRIPE_AUTOMATIC_TAX=1` (after Stripe Tax is configured). A misconfigured
   flag logs the problems and stays inactive rather than half-billing.

**API:** `GET /api/billing` (owner: standing, month usage, unsent reports),
`POST /api/billing/checkout` and `/portal` (owner, return a Stripe URL),
`POST /api/stripe/webhook` (Stripe only: signature within 5 minutes, event id
deduplicated in `billing_events`, rate-limited on `RL_NOTIFY`).
`GET /api/platform/usage` gains `doorDays` and `billing` when the flag is on.

**Differences from the plan above:**

- Door-day events carry the time the report row was created (within the
  35-day window), not 12:00 UTC; the identifier is still
  `<tenant>:door_days:<date>`, so a retry can never double-count. Missed
  days are backfilled for up to 30 days (`MAX_BACKFILL_DAYS`).
- SMS identifier is `<tenant>:sms_segments:<YYYY-MM>:<running total>`, value
  = the delta since the last report; the running total makes it idempotent.
- `invoice.*` events are not needed: `customer.subscription.updated` already
  carries `past_due` / `unpaid` / `active`. They are recorded and ignored.
- Reports Stripe did not accept stay in `billing_reports` with `sent_at`
  empty (`unsentReports`); errors Stripe finds later arrive as thin events
  (see Operations below).
- Out-of-order events: an event older than `last_event_at` is recorded but
  does not change the status.
- No account (pilot / trial / flag off) restricts nothing. The 402 gate
  covers additions only (`POST` people, visitors, visit invites, codes,
  rules, office onboarding, SCIM create; list in `billing-core.js`
  `ADDITIONS`). Removals, suspensions, exports, reads and the doors
  themselves are never gated. Deliberately open: approving requests that
  were already pending (four-eyes, reception approval of pre-registrations)
  and adding operators, so an owner can bring in a bookkeeper to fix
  billing. Closing after 45 days stays a manual step.
- The owner sees a Billing card (People view) and a banner on Doors during
  the 15-day grace period and while additions are paused.

**Before live mode:** run a test-clock month (door added day 10, removed day
20) and compare the invoice with `GET /api/platform/usage`; decide the price
and the minimum (e.g. 5 doors); write the terms that say non-payment never
locks anyone out.

## Operations (R13)

**Owner notices.** One alert per stage change through the tenant's alert
channels (event `billing_problem`, on by default, never in the daily
summary), audited as `billing.notice`:

| Stage | When | Notice |
|---|---|---|
| grace | payment failed (0–14 days) | doors keep working; adding pauses in N days |
| restricted | 15–44 days | adding is paused; removing still works |
| closure | 45+ days or cancelled | due for closure, 30 days' written notice, keep the audit export / evidence pack; also a platform problem `closure_due` |
| ok | paid again | adding works again |

**Meter errors (thin events).** Stripe validates meter events later and
reports bad ones as thin events. Stripe dashboard → Workbench → Webhooks →
*Create new destination* → advanced: payload style **Thin**, events
`v1.billing.meter.error_report_triggered` and `v1.billing.meter.no_meter_found`,
URL = the same `https://<host>/api/stripe/webhook`. Put its signing secret in
`STRIPE_THIN_WEBHOOK_SECRET`. AccessX fetches the full event
(`GET /v2/core/events/:id`; a failed fetch answers 502 so Stripe retries),
maps each sample error's `identifier` (`<tenant>:<meter>:<key>`) to the
report row (`billing_reports.error`) and opens a platform problem. Test with
`stripe trigger v1.billing.meter.error_report_triggered`.

**Platform problems** (`billing_problems`, one row per key, never repeated):
`meter_error`, `unsent_reports` (a report Stripe has not taken for 24 h,
checked by each tenant's maintenance run), `closure_due`. With
`PLATFORM_ALERT_WEBHOOK` (https; Slack-compatible `{text}`) new problems are
posted once, batched. `GET /api/platform/billing` lists open problems and the
subscribed tenants worst-first (stage, usage, estimate, unsent and failed
reports); `POST /api/platform/billing/problems/:key/resolve {note}` closes
one. Both need `PLATFORM_TOKEN`.

**Estimate.** Per-unit Stripe prices (`GET /v1/prices/:id`, cached for an
hour) times this month's door-days and SMS segments, before tax and
discounts; shown to the owner (People → Billing, with the per-door-month
price) and on the platform views. Tiered or non-per-unit prices show no
estimate rather than a wrong one. The Stripe invoice is what counts.


## Cloudflare cost per tenant (R20)

The price floor: what one more tenant costs us on Cloudflare. Short answer:
**$5/month flat for the whole account up to roughly 70-120 tenants (the
first allowances to run out are Worker CPU, and Durable Object duration in the
worst case), then about $0.07 per tenant per month ($0.13 worst case).** Infrastructure does not set
the price; SMS, email, Stripe fees, installs and support time do.

**Prices** (Workers Paid, checked 2026-09-27; re-check before quoting):
Workers $5/month base, 10 M requests and 30 M CPU-ms included, then $0.30 per
M requests and $0.02 per M CPU-ms. Durable Objects: 1 M requests and 400,000
GB-s included, then $0.15 per M and $12.50 per M GB-s; billed while running,
not while idle and able to hibernate (TenantWriter holds no WebSockets). D1:
25 B rows read, 50 M rows written, 5 GB included, then $0.001 per M read, $1
per M written, $0.75 per GB-month. R2: 10 GB, 1 M class A and 10 M class B
operations free, then $0.015 per GB-month. Sources: developers.cloudflare.com
D1 pricing, R2 pricing, Durable Objects lifecycle.

**Measured** (`npm run load:test`, local workerd + D1, R20; the
`x-accessx-d1` header with `USAGE_METER=1`):

| Request | D1 queries | Rows read | Rows written |
|---|---|---|---|
| Any warm read (doors, users, compile, a person's doors) | 3 | 3 | 0 |
| Door health / reconcile dry-run | 5 | 5 | 0 |
| Audit page (100 entries) | 4 | 103 | 0 |
| Revocation report (5,000 people) | 9 | 5,236 | 0 |
| Add a person | 8 | 9 | 8 |
| Nuki code: create / delete | 11 / 9 | 12 / 11 | 9 / 8 |
| Cold snapshot load (new isolate, or after 15 min) | ~10 | ~2 x the tenant's rows (about 15,000 at 7,000 people) | 0 |
| Weekly export, 16,317 rows | 76 | 16,605 | 0 |

**A typical pilot tenant** (50 people, 10 doors, 300 visits, ~1,000 changes a
month, reception with the Visitors tab open in office hours):

| Meter | Per tenant per month | Covered by the $5 plan | Beyond that, per tenant |
|---|---|---|---|
| Worker requests | ~45,000 (walk-in refresh every 20 s ≈ 40,000, admin ~1,500, visitors ~3,000) | ~220 tenants | $0.014 |
| Worker CPU | ~0.25 M ms (~5 ms a request, estimate) | ~120 tenants | $0.005 |
| DO requests | ~3,900 (cron: 96 a day = 2,880; writes ~1,000) | ~250 tenants | $0.001 |
| DO duration | ~750 GB-s (128 MB x ~2 s per cron tick with vendor calls); worst case, if idle time is billed: ~5,600 | ~530 tenants (worst ~70) | $0.009 (worst $0.07) |
| D1 rows read | up to ~24 M (worst case: every request and cron tick is a cold load of ~500 rows) | ~1,000 tenants | $0.024 |
| D1 rows written | ~15,000 | ~3,000 tenants | $0.015 |
| D1 storage | 1-2 MB a year (audit grows) | ~2,500 tenant-years | $0.002 |
| R2 (weekly export, 8 kept) | ~20 KB a copy | thousands | ~0 |

**What to watch as it grows:**

1. **The cron is the biggest cost driver:** 96 Durable Object wake-ups per
   tenant per day even when nothing changes. Beyond ~100 tenants, skip tenants
   with nothing due, or run every 30 minutes. That halves the DO lines.
2. **One D1 database holds at most 10 GB** (hard limit). At 1-2 MB per tenant
   per year that is thousands of tenant-years, but big tenants and long audit
   retention add up. Watch `GET /api/platform/usage` and the D1 dashboard; the
   way out is one database per region or per large tenant.
3. **Large tenants:** 5,000 people means a 656 KB `GET /api/users` (not
   paginated) and a 275 KB compile. Cheap on Cloudflare, slow on a phone.
   Pagination goes in the backlog before the first tenant above ~1,000 people.
4. **Latency:** D1 has one primary location. Create it near the customers
   (`wrangler d1 create accessx --location oc` for Australia; check the
   current location hints first). Local numbers above do not include that
   round trip.

**Not Cloudflare, and larger:** SMS (pass-through with margin, capped by
`SMS_MONTHLY_CAP`), the email provider's plan, Stripe fees, and installs and
support time. The door minimum (e.g. 5 doors) covers those.
