# Front-desk kiosk, visitor notice, printable list, Turnstile

Status: **implemented in R16** (migration 0023, `test/kiosk.test.js`, Worker
smoke check). Nothing changes until an administrator pairs a tablet.

## What reception sets up (5 minutes)

1. **Visitors → Visitor settings → Visitor notice** (optional, up to 2,000
   characters): house rules and the privacy line, e.g. "Please wear your badge
   and stay with your host. We keep your name and company for 30 days." This is
   a notice the visitor ticks, **not an NDA** (no signature, no legal review).
2. **Visitors → Kiosks → Add kiosk**: pick the site and a name ("Front door
   iPad"). The pairing link and its QR code are shown **once**. Open the link on
   the tablet (or scan the QR with it) and press **Done: hide the link**.
3. Lock the tablet to that page: **Guided Access** (iPad) or **screen pinning**
   (Android), charger plugged in, auto-lock off.
4. To retire a tablet (lost, replaced): **Switch off**. Its key and every phone
   pass it showed stop working immediately.

## What a visitor sees on the tablet

| Button | Flow | Result |
|---|---|---|
| **I'm expected** | invitation email → tick the notice → "Welcome, Sarah knows you're here" | visit marked signed in (time + which notice), host emailed, `visitor_arrived` alert |
| **I'm not expected** | name (required), company, email, who they're seeing (optional) → tick the notice | a waiting walk-in on the reception screen; the named host is emailed |
| **Signing out** | invitation email | visit ended, door codes removed (same as the check-out link) |
| **Use your phone** | QR on the home screen | the same three flows on the visitor's own phone, for 10 minutes |

The tablet returns to the start after 60 seconds without a touch and 12 seconds
after a finished flow. It never shows a door code, a visitor list or anyone's
full name: a check-in reveals only the host's **first name**, and only when the
host email went out.

## Reception screen (Visitors page)

- **Walk-ins waiting**: name, company, who they asked for, whether the host was
  emailed, notice ticked. **Issue code** opens the normal visit form pre-filled
  (reception chooses doors and hours as for any visit); the visit is marked
  signed in and the walk-in closed, in one transaction. **Dismiss** closes it
  without access. Waiting walk-ins expire after 24 hours.
- **Visits** show "signed in 09:12 · notice accepted".
- **Print visitors on site** (`/visitors-print`, next to the range picker): for a
  fire roll call. Two lists with tick boxes, filtered by site: *on site now*
  (signed in, or has opened a door, plus waiting walk-ins) and *expected today,
  not signed in*. Visitors only, never staff. The sheet says it contains
  personal data and should be shredded after use.

## Security design

| Question | Answer |
|---|---|
| What is the tablet's credential? | A kiosk key `kx_…` (256-bit), shown once inside the pairing link, stored on the server only as a SHA-256 hash (domain-separated), kept in the tablet's local storage. |
| What can the key do? | Only `POST /api/kiosk` for **its own site**: check in, register a walk-in, sign out, show a phone pass. It is not an operator: every `/api/*` route returns 401 for it. It can never create a door code, read the visitor list or change settings. |
| Someone steals the unlocked tablet | They can do exactly what a visitor at that desk can do. **Switch off** in the dashboard ends it. `last seen` (written at most once a minute) shows whether a tablet is still in use. |
| Phone passes | `p1.<tenant>.<kiosk>.<expiry>.<HMAC>`: 10 minutes, signed with the kiosk's secret, shown only as a rotating QR on the tablet (new one every 4 minutes). There is **no printed poster QR**: a photo of the QR is useless after 10 minutes. A phone cannot mint a new pass. Switching the kiosk off invalidates all its passes. |
| Check-in window | By invitation email, at the kiosk's site, from **2 hours before** the visit starts until it ends. Other sites' and other days' visits: "no invitation found". |
| Email enumeration | Check-in answers whether an invitation exists for an email today at this site. Accepted: it needs physical presence or a live pass, is limited to 120 requests a minute per IP, and reveals nothing else (no name, no time, no door). |
| Sign-out by email | Anyone who knows a visitor's email and stands at the desk can end that visit early. Accepted: it only ever removes access, and it is audited as `kiosk:<id>`. |
| Walk-in flooding | At most 30 walk-ins per hour per kiosk (then 429), plus the per-IP rate limit. |
| Audit | `kiosk.create`, `kiosk.revoke`, `visit.checked_in` (with the first 12 hex characters of the notice's SHA-256), `walkin.create`, `walkin.issue`, `walkin.dismiss`, `walkin.erased`. Ids only: never names, emails or companies. The actor is `kiosk:<id>` or `kiosk:<id>:phone`. |
| Personal data | Walk-ins follow the visitor retention setting (`retentionDays`, default 30): after it, name, company and email are erased by the nightly maintenance. **Erase** on the reception screen does it immediately (a right-to-erasure request). Erasing a visit also erases the walk-in it came from. The demo reset deletes walk-ins and keeps paired kiosks. |
| Camera | The app's `Permissions-Policy` keeps `camera=()`: the tablet shows QR codes, it never scans them. |
| QR codes | Drawn in the browser by `public/qr.js` (no dependency, no third-party service, so links never leave the page). The encoder is bit-identical to the Python `qrcode` reference for all 8 masks and decodes with OpenCV; `test/kiosk.test.js` pins the output. |

## API

| Route | Who | Notes |
|---|---|---|
| `GET /api/kiosks` | `visitor.manage` | `{kiosks, notice, sites}` in the operator's site scope |
| `POST /api/kiosks` `{siteId, name}` | `visitor.manage` | `{kiosk, pairUrl}`; `pairUrl` is shown once |
| `POST /api/kiosks/:id/revoke` | `visitor.manage` | switch off |
| `GET /api/walkins[?status=all]` | `visitor.manage` | waiting walk-ins from the last 24 hours; `status=all`: every status, last 30 days; operator's sites only |
| `POST /api/walkins/:id/dismiss` · `/erase` | `visitor.manage` | |
| `POST /api/visits` `{…, walkinId}` | `visitor.manage` | issues the code for a walk-in: 409 unless it is waiting, 400 if the doors are at another site |
| `POST /api/kiosk` `{kiosk \| pass, action}` | the kiosk key or a phone pass | `info`, `pass` (kiosk only), `checkin {email, acceptNotice}`, `walkin {name, company?, email?, host?, acceptNotice}`, `checkout {email}`. 401 = not paired / switched off / pass expired; 404 = no invitation found |

The host of a walk-in is matched narrowly: the full name or the first name
(ignoring case, accents and extra spaces; at least 3 characters) of exactly one
active person; otherwise no host, and
the kiosk says "Please take a seat; reception will be with you shortly".

## Turnstile on signup (optional)

Cloudflare Turnstile is an invisible or one-click human check. When both keys
are set, `/signup` shows the widget and the server verifies every token with
Cloudflare's `siteverify` before sending the confirmation email.

| Variable | Meaning |
|---|---|
| `TURNSTILE_SITE_KEY` | public widget key (Cloudflare dashboard → Turnstile → add the production hostname) |
| `TURNSTILE_SECRET_KEY` | secret, set with `wrangler secret put` |

- No token or a rejected token: 400 "Please complete the human check and try again".
- `siteverify` unreachable: **503, fails closed** (retry in a minute); the
  signup limits from `21-SIGNUP.md` still apply either way.
- Only `/signup` gets the wider Content-Security-Policy
  (`https://challenges.cloudflare.com` in `script-src` and `frame-src`). The
  dashboard, the kiosk and every other page keep `script-src 'self'`.
- `npm run doctor`: one key without the other is an error, Cloudflare's test
  keys (`1x…`, `2x…`, `3x…`) in production are an error, open signup without
  Turnstile is a warning.
- Not used on the kiosk: the kiosk key or a 10-minute pass already proves the
  request came from the desk.

## Not included (on purpose)

Badge printing, visitor photos, ID scanning, NDA e-signature and host SMS.
Each adds hardware or legal work that the pilot has not asked for; the notice
tick plus audit covers the common "we tell visitors our rules" requirement.
