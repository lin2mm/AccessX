# Office setup (about 45 minutes)

For a small or mid-sized office (5–200 doors) moving from the TTLock app to
AccessX. At the end: every door is in a group, staff and cleaners have rules,
server/comms rooms need two people to change, people arrive from your
directory, and alarms reach your chat. Trying it with real locks first? See
[PILOT.md](PILOT.md).

## Before you start

- The **TTLock account that owns the locks** (top administrator, not an
  e-key holder) and its region.
- In TTLock, give doors **clear names** ("Front Door", "Comms Room",
  "Cleaner's Cupboard") and put each building's locks in a **TTLock group**
  named after it: AccessX turns groups into sites and names into door groups.
- An admin of your identity provider (Entra ID, Google Workspace or Okta).
- A Slack or Teams channel (or an email list) for alerts.

## 1. Connect TTLock

People → Operators & sign-in → *TTLock account*: region, username, password. The password is used
once and never stored; AccessX keeps an encrypted token. The **Get started**
card on the Doors page ticks "Connect your TTLock account".

## 2. Office setup (door groups and rules)

Doors page → Get started → *Office setup*. Enter the offices' time zone and
hours, **Preview**, check the tables, **Apply**. Per site it creates:

| Door group | From door names like | Who, when |
|---|---|---|
| Entrances | entrance, front, lobby, reception, gate | Staff in office hours; Cleaners in cleaning hours |
| Offices | anything else (meeting rooms, kitchen…) | Staff in office hours; Cleaners in cleaning hours |
| Facilities | cleaner, cupboard, store, plant, loading | Cleaners in cleaning hours |
| Secure rooms (**sensitive**) | server, comms, IT, electrical, safe, records, lab | nobody yet |

Defaults: office hours Mon–Fri 07:00–19:00, cleaning Mon–Fri 18:00–22:00,
both closed on holidays (add them with `POST /api/holidays {date, name}`;
there is no holidays screen yet). Every item is
audited; doors already in a group are never touched, so running it again is
safe. Afterwards:

- **Secure rooms**: create a small people group (e.g. "IT"), add the
  people, and assign it to Secure rooms:
  `POST /api/assignments {userGroupId, doorGroupId, scheduleId}`. That change
  waits for a second owner or manager to approve (four-eyes, shown under
  Activity → Waiting for a second person).
- Anything misfiled (a "Store" that staff use): the rules screen is
  read-only today; change door groups through the API (`/api/doorGroups`)
  or re-run the setup on a fresh tenant during the pilot.

## 3. Operators and single sign-on

People → Operators & sign-in → *Single sign-on*:

- **Entra ID**: App registrations → New → Web, redirect URI
  `https://<your AccessX host>/api/auth/sso/callback`; create a client
  secret. Issuer `https://login.microsoftonline.com/<tenant-id>/v2.0`.
- **Google Workspace**: Google Cloud console → OAuth client (Web), same
  redirect URI. Issuer `https://accounts.google.com`.
- **Okta**: Applications → OIDC Web App, same redirect URI. Issuer
  `https://<org>.okta.com`.

Add your email domain and publish the TXT record AccessX shows
(`_accessx.<domain>`); invite operators by email (reception gets *Front
Desk*: visitors only). Once everyone has signed in, **Require single
sign-on**:
shared tokens stop working, and break-glass use raises an alert.

## 4. People from your directory (SCIM)

People → Operators & sign-in → create a token with the *Directory sync* role. In
Entra ID: Enterprise application → Provisioning → Automatic, Tenant URL
`https://<host>/scim/v2`, Secret token = that token; assign the groups to
sync. Then map directory groups to people groups (e.g. "All Staff" →
*Staff*) in the same card; SCIM groups grant nothing until mapped.
A person disabled in the directory loses their door codes in the same
request. Cleaners are usually contractors: add them by hand to *Cleaners*,
one person each (no shared codes: you want to know who opened what).

## 5. Alerts

People → Operators & sign-in → *Alerts*: a Slack/Teams webhook or email
recipients. On by
default: approval requests, failed revocations, codes stuck on offline
locks, break-glass sign-ins, TTLock disconnected, **lock alarms** (tamper,
forced, keypad locked), **batteries** (low, or running out within 3 weeks)
and a **silent TTLock callback**. Non-urgent ones can wait for the daily
summary.

## 6. TTLock callback (instant alarms and arrivals)

Set `TTLOCK_NOTIFY_SECRET` on the server, then in the TTLock developer
console set the callback URL to `https://<host>/api/ttlock/notify/<secret>`.
TTLock allows **one callback URL per app**: if another integration (a hotel
system, Home Assistant) uses the same app, one of them loses. AccessX warns
you when records exist that the callback never delivered.

## 7. Visitors

Reception registers visitors (codes by email/SMS, lock-enforced window) or
sends an **invitation**: the visitor enters their own name, the code goes
only to the address reception typed. Sites with sensitive doors wait for
reception's approval. Needs `EMAIL_PROVIDER` or `SMS_PROVIDER` and
`PUBLIC_URL`.

## Good to know

- Doors **without a gateway** take code changes only when someone syncs them
  with the TTLock app nearby; AccessX flags those removals and chases them.
- TTLock voids a timed code not used within 24 h of its start: issue codes
  for the day people first come in.
- Everything above is visible in Activity (audit log, hash-chained).
