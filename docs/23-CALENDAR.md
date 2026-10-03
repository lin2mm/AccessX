# Calendar invitations → visitor pre-registration

Status: **implemented in R17** (migration 0024, `calendar-core.js`,
`test/calendar.test.js`, and a Worker smoke check through the real `email()`
handler on D1). It is off until the server has `CALENDAR_INBOUND_DOMAIN` and an
administrator saves the calendar settings.

The idea: a host books a meeting in Google Calendar or Outlook as usual and adds
one extra guest, the office's calendar address. AccessX reads the invitation and
emails **the organiser** a link. The organiser picks which outside guests get a
visitor invitation. Nothing goes to a guest until the organiser confirms.

```
host's calendar ──invite──▶ cal-xxxxxxxxxxxxxxxx@in.doors.example.com
                                  │  (Cloudflare Email Routing → Worker email())
                                  ▼
                       draft (status: pending) ──email──▶ organiser
                                                          │ opens /calendar#t=…
                                                          ▼ picks office + guests
                         visitor invitation(s), the same as Visitors → Invite
                                  │  (a site with a sensitive door group: reception approves first)
                                  ▼
                 guest registers ──▶ door code for the meeting's time only
```

## One-time set-up (operator of the deployment, about 10 minutes)

1. Pick a mail subdomain that only receives mail, e.g. `in.doors.example.com`.
   The domain must be on Cloudflare.
2. **Cloudflare dashboard → your zone → Email → Email Routing**: enable it for
   that subdomain. Cloudflare adds the MX/TXT records. Then go to **Routing
   rules → Catch-all address → Action "Send to a Worker"** and pick the AccessX
   Worker. Every `cal-…@in.doors.example.com` address reaches the Worker's
   `email()` handler. No extra binding is needed.
3. Set `CALENDAR_INBOUND_DOMAIN=in.doors.example.com` (Worker variable). The
   feature also needs `PUBLIC_URL` (for the link) and an `EMAIL_PROVIDER` (to
   email the organiser). `npm run doctor` reports an **error** if either is
   missing, or if the domain is not a bare domain.
4. **Node server instead of the Worker:** send inbound mail from your mail
   provider's inbound webhook to `POST /api/inbound/calendar`:
   - send the raw RFC 5322 message as the body (up to 600 KB);
   - set the header `Authorization: Bearer $CALENDAR_INBOUND_SECRET`
     (`openssl rand -hex 24`; doctor flags secrets shorter than 24 characters);
   - put the envelope recipient in the header `x-envelope-to` (or `?to=`).

   A wrong secret gets `404` and counts against the per-IP rate limit. Accepted
   mail gets `202`, whatever happens to it. A server error gets `500`, so that
   the provider retries.

Local test: under `wrangler dev`, `POST /cdn-cgi/local/email?from=…&to=…` with a
raw message runs the real `email()` handler. `support/worker-smoke.js` does
exactly this.

## What the office administrator does (Visitors → Calendar invitations)

Only the **owner** can change this card; anyone with visitor rights sees the
recent invitations.

- For each office (up to 10), pick the doors a calendar guest may open. Only
  doors of that office that are in your scope and **not in a sensitive door
  group** are offered.
- Tick **Accept calendar invitations** and **Save**. The card shows the address
  with a copy button. Share it with staff: "add this as a guest to meetings
  with visitors".
- **New address** replaces the address at once, for example if it leaked to
  spam lists. The old address stops working immediately.
- The table lists recent invitations: *waiting for the host*, *invitations
  sent*, *host said not needed*, *meeting cancelled*, *replaced by a newer
  version*, *not confirmed in time*, *not used* (with the reason).

**Who is responsible:** saving the settings is a standing approval by the
person who saved them. Invitations created from calendars are recorded as
created by that person, with the actor `calendar:<draft id>` in the audit log.
If that person later loses visitor rights, confirming stops with *"Calendar
invitations are paused: an administrator needs to save the calendar settings
again"*. The audit log gets `calendar.failed`.

## What the host sees

1. An email: *Visitor access for "Quarterly review": please confirm*, with the
   times in the office time zone, the list of outside guests, and a link that
   works **once, until the meeting ends**.
2. The page `/calendar` shows the meeting, the guests (all ticked), and the
   office (guessed from the meeting's location, otherwise the first office).
   Buttons: **Send invitations** or **Not needed**.
3. Each ticked guest gets the normal visitor invitation email. They register,
   and at a site with a sensitive door group reception approves. The door code
   covers the meeting's start and end time only, on the doors set for that
   office.

## Which guests count as "outside"

The organiser must be an **active person in AccessX with the same email
address**; otherwise the invitation is stored as *not used*. These are skipped:

- the organiser;
- the calendar address itself;
- anyone whose email belongs to a person in AccessX;
- anyone on a verified SSO domain of the tenant (colleagues who are not in
  AccessX yet).

At most 20 guests per meeting are read.

## Changes, cancellations, limits

- **Updated invitation** (new time or guests; a higher `SEQUENCE`): a pending
  draft is replaced by the new version and the organiser gets a new link. A
  resend with no change and an older `SEQUENCE` are both ignored.
- **Cancelled meeting** (`METHOD:CANCEL` from the same organiser): pending
  drafts become *meeting cancelled*. Invitations already sent but not yet used
  are **revoked**.
- **Recurring meetings:** only the **first** occurrence is used (the host page
  says so). If the series started in the past, it is *not used* ("the meeting is
  already over"). For a recurring visitor, use Visitors → Invite.
- **All-day events** are not used: door access needs a start and end time.
- **Meetings more than 30 days away** are not used.
- **Time zones:** IANA zones (Google), Windows zone names and `VTIMEZONE`
  blocks (Outlook) are understood. If none can be read, the office time zone is
  assumed, and the email and page say so.
- **Size limits:** messages over 512 KB (the Worker drops anything over 600 KB
  before reading it), 50 MIME parts, nesting over 5 levels. At most **50
  invitations per tenant per 24 hours**.

## Security model

- **The sender never gets an answer.** Unknown or disabled addresses,
  non-invitations and errors are all dropped silently. There is no bounce, so
  the address space cannot be probed. Addresses have 80 random bits
  (`cal-` + 16 base32 characters).
- **The `ORGANIZER` line is not trusted as proof.** Anyone who knows the
  address could forge an invitation "from" a colleague. That only sends the
  colleague an email with a link ("If you did not send this invitation, ignore
  this email: nothing happens without you"). **Clicking the link in their own
  mailbox is the proof**, the same trust as a password-reset email.
- The link token is 18 random bytes. Only its SHA-256 is stored. It works once,
  only while the draft is pending and the meeting has not ended. Any bad,
  expired or used token gets the same generic `404`.
- **What a calendar guest can get:** only the doors the owner set for that
  office, never a sensitive door, and only for the meeting's time. At sites with
  a sensitive door group, reception still approves each registration.
- Audit trail: `calendar.configure`, `calendar.rotate`, `calendar.draft`,
  `calendar.confirmed`, `calendar.declined`, `calendar.cancelled`,
  `calendar.failed`.
- Demo reset clears `calendar_drafts`.

## Not in this round

- There is no OAuth calendar connection (reading staff calendars directly).
  This is deliberate: an email address needs no admin consent in Google
  Workspace or Entra, and it sees only the meetings it is invited to.
- Some organisations strip `.ics` attachments from external mail, or block
  external guests on calendar invitations. Then nothing arrives, so check this
  during the pilot.
