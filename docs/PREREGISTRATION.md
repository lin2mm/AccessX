# Design: visitor pre-registration link

Status: **implemented** (migration 0018, `test/invites.test.js`). The feature
adds the first public endpoint that ends with a door code, so the security
design was settled here before any code was written. Where the build differs
from the first draft, the text below says so.

## Goal

A host (or reception) invites a visitor ahead of time. The visitor opens a
link, confirms their details (and optionally picks an arrival time inside
the window the host allowed), and receives their door code — without anyone
at reception typing it in.

## Threats

| # | Threat | Why it matters |
|---|---|---|
| T1 | The link is forwarded, leaked or phished | whoever holds it may obtain a working door code |
| T2 | Visitor chooses where the code is sent | a leaked link sends the code to the attacker's phone |
| T3 | SMS pumping (toll fraud): bots submit premium-rate numbers | direct cost, account suspension by Twilio |
| T4 | Guessing or enumerating tokens | unauthorised invites |
| T5 | Visitor widens their own access (more doors, longer window, sensitive doors) | privilege escalation through a public form |
| T6 | Replay / double submission | two sets of codes; codes nobody tracks |
| T7 | Vendor abuse: many submissions create many TTLock passcodes | TTLock rate limits (30006) hit every tenant on the app |
| T8 | Personal data collected without notice | GDPR transparency |
| T9 | Stored injection via name/company in emails and the admin UI | XSS / email spoofing |

## Decisions

1. **The invite is the approval (T5).** An operator with `visitor.manage`
   creates the invite with host, site, doors (≤ 5, never sensitive), and a
   window envelope — the same checks as `POST /api/visits`, run at invite
   time *and again* at submission (the host may have been suspended, a door
   made sensitive). The visitor can only narrow: pick an arrival time inside
   the envelope. Audited: `invite.create` (no personal data).
2. **Delivery channel fixed by the host (T1, T2, T3).** The host enters the
   visitor's email or mobile number when inviting; the link is sent there
   and the code is delivered **to the same address only**, never shown on
   the page. A leaked link is then worth no more than access to the visitor's
   inbox or phone. The public form never accepts a phone number, so it
   cannot be used for SMS pumping.
3. **Token (T4, T6).** 144-bit random, only `sha256` stored, in the URL
   fragment (never in logs or Referer) — as the self check-out link. Single
   use; expires at the **end of the envelope** (at most 30 days out, the
   visit rules still cap the visit itself) — the draft said "start + 1 h",
   but a visitor registering during a day-long window is the normal case and
   the code is still only sent to the fixed address. Revocable. Wrong, used,
   expired, revoked and exhausted tokens all return the same 404.
4. **Rate limits (T7).** Per token: 5 attempts (then the link is dead). Per
   tenant: at most 200 open invites (a clear 429 to the operator). Together
   these bound what one tenant's links can cost: ≤ 1 000 submissions, and
   codes/texts only ever go to addresses an operator typed in. The draft's
   "60 submissions per hour" counter was dropped in favour of per-IP limits
   at the edge (Cloudflare rate limiting on `/api/visit-invite`, see
   `docs/SECURITY-TESTING.md`). Code creation goes through the tenant's write
   queue like every other write.
5. **Reception approval for sensitive sites.** `requireApproval` defaults
   to **on** when the site has any sensitive door group (only an owner may
   switch it off per invite). Submission stores the name/company/arrival
   (`status = 'submitted'`), raises an `approval_requested` alert (no
   personal data in it) and kills the link; reception approves (the visit is
   created with *their* rights, the code goes to the fixed address, nobody
   sees it) or rejects. The draft's "pending visit" became a pending invite,
   so no codes exist until approval.
6. **Privacy (T8).** The form shows who collects the data, why, and the
   retention (`retentionDays`). Invite rows hold the contact address; erased
   with the visit, or after expiry + retention if never used.
7. **Input (T9).** Name ≤ 100, company ≤ 100 chars, control characters
   stripped; emails are plain text; the UI escapes as today.

## Data

```
visit_invites (
  tenant_id, id, token_hash, host_user_id, site_id, lock_ids,
  start_local, end_local, start_at, end_at, channel ('email' | 'sms'),
  contact, require_approval,
  status ('open' | 'submitted' | 'used' | 'revoked' | 'expired' | 'rejected'),
  attempts, submitted_name, submitted_company, submitted_start, submitted_at,
  created_by, created_at, expires_at, decided_by, visit_id, erased_at,
  PRIMARY KEY (tenant_id, id)
)  + index on token_hash
```

## API

| Route | Who | Does |
|---|---|---|
| `POST /api/visit-invites` | `visitor.manage` | create + send the link |
| `GET /api/visit-invites` | `visitor.manage` (site-scoped) | list |
| `POST /api/visit-invites/:id/revoke` | `visitor.manage` | revoke (open or submitted) |
| `POST /api/visit-invites/:id/approve` \| `reject` | `visitor.manage` (site-scoped) | decide a submitted registration |
| `POST /api/visit-invite` `{token, action: 'status' \| 'submit', name, company, startLocal}` | public | show envelope / create the visit and deliver the code to the fixed channel |

Worker: the public route resolves the tenant read-only, then runs the
submission as a Durable Object job (`/__tenant/job`, type `invite_submit`).

**Acting as the inviter.** Without approval, the submission replays
`POST /api/visits` as the operator who created the invite, with their
*current* role and site scope (a revoked operator or one who lost
`visitor.manage` makes the link fail), actor `invite:<id>`. If the code
cannot be delivered, the new visit is cancelled at once (codes removed)
and the invite stays open, so there is never a live code nobody received.
Failures are audited as `invite.failed` with the reason; the visitor only
sees "no longer valid / contact your host".

## Tests (all in `test/invites.test.js`)

Forwarded link to a new device (code still goes to the original address);
submission after the host is suspended; door made sensitive after the invite;
arrival outside the envelope; second submission; expired / revoked token;
rate limits; the public response never contains a code; isolation gate
includes the new routes; erasure removes the contact.

## Open product questions

- Terms / NDA acceptance on the form? Decided: **not in v1**.
- Photo or ID check? (Out of scope for keypad locks; would need a kiosk.)
- Repeat contractors: better handled as people with a schedule than as
  weekly visitor invites.
