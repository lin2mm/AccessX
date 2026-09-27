# 25 — Nuki as a second lock vendor (R19)

AccessX started on TTLock only. From R19 a tenant can connect a **Nuki** account
instead (one vendor account per tenant: TTLock *or* Nuki). Everything above the
vendor layer (rules, schedules, visitors, approvals, the reconciler, access
reviews, the passcode sweep, the audit trail) works the same way. This document
says what maps to what, what Nuki cannot do, and what still needs checking on a
real Nuki account.

> **Status: tested against a fake Nuki Web API only** (`support/fake-nuki.js`,
> written from Nuki's public API documentation). No real Nuki account or lock
> has been used yet. Do the checks in [§6](#6-before-the-first-real-nuki-site)
> before the first Nuki site goes live.

## 1. Connecting

1. In **Nuki Web** (web.nuki.io), open **API** and generate an **API token**
   with these scopes: `smartlock`, `smartlock.auth`, `smartlock.action`,
   `smartlock.log`. Use a dedicated admin account, not someone's personal one.
2. In AccessX: **Settings → Lock vendor account → Vendor: Nuki**, then paste the token.

At connect time AccessX:

- reads the account and its locks. A rejected token gives 400. A network failure gives 502;
- **lists the codes on the first lock**, so that a token without `smartlock.auth`
  is refused right away with a message naming the scopes (not at the first visitor);
- refuses an account that is already connected to another AccessX tenant (409);
- stores the token **encrypted** with `SECRETS_KEY`. It is never returned by the API
  and never written to the audit trail. The audit trail has `vendor.connect nuki uid=… locks=N`.

API tokens do not expire, so there is no refresh. **Changing the Nuki Web password
destroys the token.** When that happens, the next call that reaches Nuki marks
the account **reconnect required**, and the owner is alerted as with TTLock.
Until someone reconnects, door pages return 503 `needs_reconnect`, never an empty fleet.

OAuth2 (Nuki "Advanced API") is not implemented. It would add refresh tokens and
webhooks, but it needs a Nuki partner application.

## 2. How Nuki maps onto AccessX

| AccessX | Nuki Web API | Notes |
|---|---|---|
| Door (`lockId`) | smartlock (`smartlockId`) | Name, battery (`batteryCharge`; if Nuki only reports `batteryCritical`, AccessX shows 10 %) |
| "Has gateway" | `serverState === 0` (online) | Offline Nuki = a TTLock door without a gateway: nothing can reach it remotely |
| Passcode | keypad code: an authorization with `type 13` | 6 digits 1–9, not starting with "12", unique on the keypad. AccessX generates the code itself |
| Validity window | `allowedFromDate` / `allowedUntilDate` (UTC) **+ `allowedWeekDays: 127`** | Nuki ignores the dates unless weekdays are set; the test fails if this is dropped |
| Code name | `name`, max 20 characters | Truncated |
| Revoke | `DELETE /smartlock/{id}/auth/{authId}` | Idempotent: "already gone" counts as done |
| Remote open | `POST /smartlock/{id}/action/unlock` | Accepted asynchronously |
| Passcode sweep (R18) | `GET /smartlock/{id}/auth` (type 13 only) | Digits never leave the adapter; app users and fobs are not listed |
| Records | `GET /smartlock/{id}/log` (last 50) | Shown as `nuki:unlock (keypad)` etc. |

Code: `nuki.js` (HTTP client), `vendor-nuki-core.js` (adapter),
`vendor-accounts.js` (`connectNuki`, `vendorFor`). No database migration: the
existing `vendor_accounts` row takes `kind='nuki'`, and the expiry is a far-future value.

### Writes are asynchronous

Nuki answers 204 as soon as a request is *valid*. The change reaches the lock
later. So after creating a code, AccessX **re-reads the lock's code list until
the new code shows up**. It checks every 1.5 s, up to 8 times (`NUKI_POLL_MS`
changes the interval). Only then does anyone see the digits.
If the code never shows up, the request fails with 503 `unconfirmed`:
nothing is registered and nobody has seen the digits. If the code does
appear later, the passcode sweep lists it as "not from AccessX" and it can be
removed there.

Before creating a code, AccessX reads the lock's codes to avoid duplicates. It
refuses (409, with the reason shown to the operator) when:

- the lock has **no keypad paired**;
- the lock is **offline**. A TTLock code works offline by design; a Nuki code has to
  reach the lock, so an offline lock would give someone a code that does not open the door;
- the lock already has 200 authorizations. Older devices hold 100; Nuki refuses above that and the error is shown.

## 3. What Nuki cannot do here (shown on the vendor card)

The vendor card lists each vendor's limits in words, taken from `GET /api/vendor`
→ `limits`. For Nuki:

| Limit | Why | Effect |
|---|---|---|
| **A Nuki Keypad is required** for codes | Codes are typed on the Keypad | Doors without one: remote open only |
| **No arrival detection** | Nuki logs say "keypad" and the auth name, not the code typed | Visits are not marked "arrived" automatically; the host is not emailed on first entry |
| **No lock alarms** | Not in Nuki's log in a form we can rely on | Tamper / wrong-code alerts (R10) are TTLock-only |
| **Last 50 events** per lock | API maximum | Longer history: export regularly or use TTLock |
| **Asynchronous writes** | Nuki design | A few seconds per code; see above |
| **Offline lock** | Bridge or Wi-Fi down | No new codes. A revoked code is marked "pending removal", and the **reconciler deletes it automatically when the lock is back online** (tested). To remove it sooner, use the Nuki app over Bluetooth at the door |
| **No webhooks** | Advanced API only | No push events; nothing depends on them yet |
| **Weekly (cyclic) codes** not verified | Mapped to `allowedWeekDays` + times, but only one-window codes are used | Reported as `cyclicVerified: false`, same as TTLock |

TTLock limits are listed on the card as well: validity in whole hours, the
24-hour first-use rule for period codes, and a gateway needed for remote opening and removal.

## 4. Errors

| Nuki | AccessX |
|---|---|
| 401 / 403 | Account → **reconnect required**, owner alerted, 503 `needs_reconnect` |
| 429 (about 20 requests/min reported), 5xx, network | 503 `unavailable`, retry later; the reconciler retries by itself |
| 404 on delete | "Already gone" (done) |
| Other delete errors | AccessX re-lists the codes. If the code is gone, the delete counts as done |
| Offline lock | 409 `no_gateway` (as with TTLock without a gateway) |

## 5. Configuration

| Variable | Purpose |
|---|---|
| `SECRETS_KEY` | Required to store the token (already needed for TTLock accounts and SSO) |
| `NUKI_API_BASE` | Overrides `https://api.nuki.io`. **Tests only**: `npm run doctor` warns in production |
| `NUKI_POLL_MS` | Confirmation interval (default 1500, minimum 50) |

Tests: `test/nuki.test.js` (keypad rules, adapter against the fake, the whole API
on a Nuki tenant). The Worker smoke test also runs Nuki on workerd when
`NUKI_PORT=4002` is set and `.dev.vars` has `NUKI_API_BASE=http://127.0.0.1:4002`.
The fake runs standalone with `node support/fake-nuki.js 4002`.

## 6. Before the first real Nuki site

The fake follows the documentation. These points can only be confirmed on a real
account (about 20 minutes with one Smart Lock, a Keypad and a Bridge or Wi-Fi model):

1. Create a code from AccessX, then check in the Nuki app that it has the
   right time window. It should **not** open the door before the start or after the end.
2. The `code` field in `GET /smartlock/{id}/auth`: Nuki changed it from a number
   to an array in late 2024. The adapter accepts number, string and array (tested), but check what comes back.
3. How long confirmation takes (it should be under 12 s). If it is longer, raise `NUKI_POLL_MS`.
4. Delete a code while the lock is offline: see what Nuki answers, and whether
   the code is removed when the lock comes back.
5. Run a passcode sweep with a code added in the Nuki app: it should appear as "not from AccessX".
6. Rate limits: connect a site with 10+ locks and run a sweep. The sweep reads each lock once.
