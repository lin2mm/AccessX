# Pilot runbook (real locks, real phones)

Everything below has automated tests against simulated TTLock, Twilio and
email services. A pilot proves the parts that simulations cannot: TTLock's real
callback timing, real SMS delivery, and how long codes linger on locks
without a gateway. Plan for **2–4 weeks per site** and **3 sites** of different
shapes (one office with gateways, one site with at least one door without a gateway,
one busy front desk).

## 0. Before the first site

| Item | How to check |
|---|---|
| Migrations applied remotely **before** deploying | automatic: every build runs `npm run deploy` (migrate → deploy → health check), [13-CLOUDFLARE-GIT-DEPLOY.md](13-CLOUDFLARE-GIT-DEPLOY.md) |
| `SECRETS_KEY`, `PUBLIC_URL` set | Visitors → Settings says "Visitors get a self check-out link" |
| TTLock callback | `TTLOCK_NOTIFY_SECRET` set; TTLock developer console → your app → Callback URL `https://<host>/api/ttlock/notify/<secret>`. Unlock any managed door with the app: Visitors → Settings shows **Last message from TTLock** within a minute |
| SMS | Twilio env set; Visitors → Settings → **Send test text** to your own phone. Cap: `SMS_MONTHLY_CAP` |
| Email | Alerts → **Send test** with an email recipient |
| Alerts channel | Slack/Teams webhook; keep `lock_alarm` on |

## 1. Test cases per site

Record each result in the table in section 2. Times come from the audit log
(Log → filter by action) and your phone's clock.

| # | Do | Expect | Measure |
|---|---|---|---|
| 1 | Register a visitor, text the code, arrive and type it | `visit.arrived` in the log; host email | seconds from the keypad to `visit.arrived` (callback), and to the host's inbox |
| 2 | Same without the callback (temporarily blank the URL in TTLock) | arrival found at the next scheduled run | minutes to `visit.arrived` |
| 3 | Visitor taps the self check-out link | "You are checked out"; `visit.checkout … by visitor` | seconds until the code **fails at the keypad** (gateway door) |
| 4 | Check out a visitor on a door **without** a gateway | code `pending_removal`; overdue alert after the SLA | hours until someone removes it on site (`credential.removed_on_site`) |
| 5 | Type a wrong code 5+ times (keypad lock-out) | `lock_alarm` "keypad locked" in the channel | seconds to the alert |
| 6 | Tamper alarm (if the model has one) | `lock_alarm` "tamper alarm" | seconds; does the model report it at all? |
| 7 | Suspend a person with codes on 3 doors | revocation report shows each door's state | minutes until every code fails at the keypad |
| 8 | Text to a foreign number (if visitors come from abroad) | delivered, or a clear failure on screen | delivery rate per country |
| 9 | Visit across a whole day (start 09:00 next day) | code works from 09:00, not before | first-use rule: code used > 24 h after start is refused by the lock (expected, warned in UI) |

## 2. Results sheet (copy per site)

| Metric | Target | Site A | Site B | Site C |
|---|---|---|---|---|
| Callback latency (keypad → `visit.arrived`), median / worst | < 10 s / < 60 s | | | |
| Polling latency without callback | < 20 min | | | |
| Check-out → code dead at keypad (gateway) | < 60 s | | | |
| Pending removal (no gateway) → removed on site | < SLA (48 h default) | | | |
| SMS delivered / sent (Twilio console) | ≥ 98 % | | | |
| Keypad-lock alarm → channel | < 60 s | | | |
| Reception time to register a visitor | < 60 s | | | |
| Visitors who used self check-out | > 30 % | | | |
| Support questions from reception staff | fewer each week | | | |

## 3. What to send back

- The evidence pack for the pilot period (Reports → Evidence pack) and the
  revocation report: they carry the audit entries behind every number above.
- `GET /api/platform/usage?period=YYYY-MM` (platform token) for the SMS cost.
- Lock models and firmware of any door where alarms or records were missing.

## 4. Exit criteria

Go to paid rollout when, on all three sites: callback latency meets the
target, no code outlived a check-out on a gateway door, every no-gateway
removal was either confirmed on site or escalated, and reception staff
register visitors without help.
