# Access review, passcode sweep, retention, bulk invitations

Status: **implemented in R18**. Code: migration 0025, `review-core.js`, the R18
block in `api-core.js`, `public/review.js`. Tests: `test/access-review.test.js`,
plus the site-scope gate (`test/scope.fuzz.test.js`) and a Worker smoke check
on D1.

Auditors ask two questions that the audit trail alone does not answer. Does
anyone regularly confirm who still has access (ISO 27001 A.5.18, SOC 2 CC6.2 and
CC6.3)? And do the locks hold only the codes you think they hold? The access
review answers the first. The passcode sweep answers the second.

## 1. Access review

**What a line is.** When a review starts, AccessX writes one line:
- for each person with doors at a site, through a people group or a live code;
- for each administrator (operator).

Suspended people and people past their end date are left out: they already
have no access. A line stores ids and counts only. Names, doors and groups are
shown from the live directory, so a person who is erased disappears from old
reviews too.

**Who decides.**

| Line | Decided by | Never by |
|---|---|---|
| Person at a site | anyone with `user.manage` for that site (the site manager) | themselves (matched by email) |
| Administrator | an owner with all-site scope | themselves |

A site manager does not see other sites' lines. Asking for one by id returns
404, not 403. Starting, closing and scheduling a review need an all-site owner.

**Keep / Remove.** *Keep* records the decision. It can later be changed to
remove. *Remove* acts at once:

- **Person at a site:** they leave that site's people groups, and their codes
  on that site's doors are revoked. With a gateway, codes are deleted from the
  lock; without one they become *pending removal*.
  - Groups at other sites are untouched.
  - If a group without a site, or another site's group, still opens a door
    here, the outcome says so ("STILL opens …").
  - If the membership came from the directory (SCIM), the outcome says to
    remove it there too. Otherwise the next sync adds it back.
- **Administrator:** the operator is revoked and their sessions end. This uses
  the same code as *Operators → Revoke*.

Remove is final within the review. To give access back, do it under People as
usual; that is audited separately.

**Timeline.**

| When | What happens |
|---|---|
| Start (by an owner, or automatically every 30/90/180/365 days if set) | Reviewers with an email address are told how many lines wait for them |
| 3 days before the due date | One reminder, only to reviewers who still have lines waiting |
| Due date passed | One notice to the owners |
| After the due date | An owner can close with **Remove door access nobody confirmed**. Each such line is removed as above and noted "not confirmed by the due date". Administrator lines are never removed in bulk |
| Close | The review is recorded with kept / removed / not confirmed counts. It goes into the evidence pack with "closed on time" or not |

The due period is 3–60 days (default 14). Only one review is open at a time.
The scheduled maintenance handles automatic starts and notices.

**Concurrency.** Two reviewers clicking the same line at the same time: the
first claim wins (a unique `decided_at` value, then a re-read), and the second
gets 409. If a removal fails halfway (for example the vendor API is down), the
decision is rolled back so the line can be tried again. A code that could not
be deleted is flagged, and the next reconcile removes it.

## 2. Passcode sweep

**Activity → Passcode sweep → Check the codes on the locks.** For each door
you can see (up to 50 per sweep; sweep one site at a time beyond that), AccessX
lists the codes the lock vendor has for that lock and compares them with its
registry:

| Result | Meaning | Action offered |
|---|---|---|
| issued by AccessX | a live registered code | none |
| not from AccessX | set in the TTLock app, by an installer, or by an old system | **Remove from lock** (gateway needed) |
| not from AccessX (expired) | as above, already past its end | remove (unticked by default) |
| revoked in AccessX, still on the lock | the revoke never reached the lock | **Remove from lock**. The registry entry becomes *revoked* |
| missing from the lock | registered and live, but not on the lock (deleted in the app, lock reset, restored backup) | **Record as gone**. AccessX lists the lock again first. The person keeps their rule, so the next reconcile issues a new code |

Rules:
- Code digits are never returned or shown, only names, types and validity.
- A live registered code can never be removed from the sweep. Revoke it under
  Codes instead.
- Removal needs a gateway (409 otherwise: remove it at the lock over Bluetooth).
- Site managers can sweep and remove only on their own sites' doors. They do
  not see all-site sweeps in the history.
- Each sweep stores counts only (`passcode_sweeps`). The audit trail records
  `passcodes.sweep`, and `passcodes.sweep_remove` with the lock and vendor
  refs, never code names.

**Limitation: the sweep sees only the vendor's cloud list.** A code typed in
at the keypad in admin mode, or one deleted over Bluetooth without syncing,
does not show up. For certainty after a restore or a staff incident, also
check the lock in the TTLock app. On a vendor without a code list, the sweep
returns 501.

**When to run it:**
- before go-live;
- after restoring a backup (`12-GO-LIVE.md` §4, "After any restore");
- after an installer or facilities company had the TTLock app;
- quarterly with the access review.

## 3. Data retention

**Activity → Data retention** lists what AccessX keeps, for how long, and where
to change it. Use it for your privacy notice and customer security
questionnaires.

| Record | Kept | Change it |
|---|---|---|
| Audit trail | everything, or 365–3650 days | here (owner). Purged only up to an anchor delivered outside AccessX |
| Visitor details | 30 days after the visit (default) | Visitors → Visitor settings |
| Battery history | fixed | — |
| Signup requests | 7 days | — |
| Access reviews and sweeps | kept as evidence (ids and counts) | — |
| People, groups and codes | until removed | People, or the directory |

`GET /api/retention` needs `audit.read`. Reception (front desk) gets 403.

## 4. Bulk visitor invitations

In **Visitors → Register a visitor**, tick *Send an invitation instead*. Then
paste up to 100 email addresses, one per line. Each address gets its own link,
with the same host, doors and window for all.

- A shared setting that is wrong (a door outside your sites, a sensitive door,
  a bad time) fails the whole request, and **nothing is sent**.
- Per-address problems (an invalid address, the same address twice) are listed.
  The others are sent, and the failed addresses stay in the box to fix and resend.
- Hitting the rate limit stops the rest of the list, each marked with the reason.
- Invite links are never returned in the bulk response. They go only to the
  addresses.

API: `POST /api/visit-invites/bulk {rows:[{email}], hostUserId, lockIds, startLocal, endLocal}`.

## 5. API summary

| Route | Permission | Notes |
|---|---|---|
| `GET /api/access-reviews` | `audit.read` | open review (your visible lines), settings, last 8 closed |
| `POST /api/access-reviews` | `role.manage`, all sites | `{dueDays}` |
| `PUT /api/access-reviews/settings` | `role.manage`, all sites | `{everyDays, dueDays}` |
| `POST /api/access-reviews/:id/items/:item` | `user.manage` (+ rules above) | `{decision: keep\|remove, note}` |
| `POST /api/access-reviews/:id/close` | `role.manage`, all sites | `{removeUndecided, note}`. Call again while `closed: false` |
| `POST /api/passcode-sweep` | `credential.issue` | `{siteId?}` |
| `POST /api/passcode-sweep/remove` | `credential.issue` | `{lockId, refs}` |
| `POST /api/passcode-sweep/forget` | `credential.issue` | `{credentialIds}` |
| `GET /api/passcode-sweep` | `credential.issue` | last 10 |
| `GET /api/retention` | `audit.read` | |
| `POST /api/visit-invites/bulk` | `visitor.manage` | |

The evidence pack (`GET /api/reports/evidence`) gains `accessReview`
(schedule, last completed, each review's counts and whether it closed on time)
and `passcodeSweep`. The A.5.18 / CC6 control lists `accessReview` as its source.

## 6. How it was tested

- `test/access-review.test.js` (7 tests):
  - scoped reviewers, never your own line;
  - removal leaves only the site's groups and revokes only that site's codes;
  - reminder, overdue and auto-start, each sent once;
  - removal of unconfirmed lines only after the due date;
  - sweeps on the demo vendor and on a fake TTLock cloud;
  - bulk invites;
  - retention.
- **Mutation checks:** each of these breaks, made on purpose, fails a test:
  - no site check when deciding;
  - allowing your own administrator line;
  - bulk removal before the due date;
  - "forget" without re-listing the lock;
  - removing a live registered code;
  - no site check on sweep removal.
- **The site-scope gate was strengthened in this round.** It used to compare
  database state only. A gym manager deleting a code from an office lock
  through the vendor API changes no row. So when the sweep-removal scope check
  was deleted on purpose, the old gate still passed. Now the gate also:
  - records every lock operation sent to the (demo) vendor, and fails on any
    lock outside the operator's site;
  - fails on any audit line of theirs that names another site's door.

  With that, the same deliberate break is caught twice. The first version of
  the sweep-removal route really had this bug; the new test found it before
  commit.
