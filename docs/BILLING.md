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
pilot calls (docs/PILOT.md) against what the office pays today (keys, fobs,
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
- The thin event `v1.billing.meter.error_report_triggered` is not consumed
  yet; failed reports stay in `billing_reports` with `sent_at` empty and show
  as `unsentReports` for the owner and in the maintenance result.
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

