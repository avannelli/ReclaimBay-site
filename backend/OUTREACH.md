# Outreach: lifecycle, sending, events, and measurement

Outreach is the step after a prospect is approved: a message to the business,
what happened to it, and what came of it.

**What ReclaimBay sells in outreach:** recovering revenue from declined and
deferred repair work at independent repair shops. The first message
(`intro@t2`) is short and low-pressure: it invites the shop to run its own
declined-work data through ReclaimBay, with one link, its invitation. It
never mentions websites, invents figures, claims an analysis of the business,
or promises results.

**Sending is off by default.** The one provider is Google Workspace through
the Gmail API (see [Google Workspace (Gmail)](#google-workspace-gmail)). It
sends only when `OUTREACH_PROVIDER=gmail` is configured, the deployment is
armed, and the admin switch is on. Transactional providers checked (Resend,
SendGrid, Amazon SES) forbid cold outreach in their acceptable-use policies.

## Three questions, three places

| Question | Answered by |
| -------- | ----------- |
| Was outreach attempted? | An `Outreach` row with `sentAt` |
| What happened to the message? | `Outreach.status`, with its append-only `OutreachEvent` log |
| What came of it commercially? | The prospect's status (see [PROSPECTS.md](PROSPECTS.md)), with its `ProspectStatusChange` history |

## Message lifecycle

```
draft -> queued -> sent -> delivered -> replied
  |        |        |  \        \
  |        |        |   failed    bounced
  |        |        bounced
  |        failed (rejected by the provider)
  cancelled (draft or queued)
```

| Status | Meaning |
| ------ | ------- |
| `draft` | Generated and stored for review. Not sent. |
| `queued` | Approved for sending; the dispatcher sends it while sending is on. |
| `sent` | The provider accepted it. |
| `delivered` | The provider reported delivery. |
| `bounced` | The receiving server rejected it permanently. |
| `failed` | The provider couldn't send it (a definite rejection). |
| `replied` | The business replied (classified, or waiting to be). |
| `cancelled` | Discarded, or stopped because the prospect or address became ineligible. |

`bounced`, `failed`, `replied`, and `cancelled` are final. A retry or a
follow-up is always a **new row**; no message is ever overwritten. Rules live
in [`src/outreach/lifecycle.ts`](src/outreach/lifecycle.ts).

### What a message does to the prospect

Always through the same validated status change a person uses, and only
where that move is allowed from the prospect's current status:

| Event | Prospect |
| ----- | -------- |
| Queued (first message) | New → Qualified → Ready to contact |
| Sent | Ready to contact → Contacted |
| Reply, not yet classified | Contacted → Engaged |
| Reply: interested, or other | → Engaged |
| Reply: not interested | → Lost |
| Reply: asked not to be contacted | → Do not contact (permanent); the address is suppressed |
| Unsubscribe link, or spam complaint | → Do not contact; the address is suppressed |

Meeting, Proposal, Customer, and Lost after a conversation are set by a
person on the prospect's page. Entering Do not contact, Not a fit, Lost,
Archived, or Customer **cancels any open message**.

## Records

`Outreach` (one row per message):

| Field | Holds |
| ----- | ----- |
| `prospectId`, `kind`, `followUpOfId` | The prospect; `initial` or `follow_up`; the message a follow-up answers |
| `template`, `campaign` | `intro@t2` / `follow-up@t2` (`intro@t1` / `follow-up@t1` before invitations); the campaign (`outreach-intro-t2`) |
| `subject`, `body`, `evidence`, `generatedAt` | The message as generated and reviewed, and the stored facts it relies on |
| `recipientEmail`, `recipientSourceUrl` | The published business email and where it was found |
| `senderName`, `senderEmail` | Who it was prepared for |
| `status`, `statusChangedAt`, `openForProspectId` | As above; the prospect id while open (unique: one open message per prospect) |
| `queuedAt`, `sentAt`, `deliveredAt`, `failedAt` + `failureReason`, `repliedAt` + `replyOutcome` + `replySummary`, `cancelledAt` + `cancelReason` | When each step happened, and why |
| `provider`, `providerMessageId` | Who sent it and the provider's id (unique) |
| `sendStartedAt`, `sendAttempts`, `lastSendError` | The dispatcher's claim and attempts |
| `queuedScore`, `queuedScoreVersion` | The prospect's opportunity score when the message was queued, as the scoring model then (`SCORING_VERSION`) computed it from the stored signals; written once, never updated. Null if never queued, or queued before Stage 5C |
| `unsubscribeToken` | Opaque token for the one-click unsubscribe link (unique) |

`OutreachEvent` is append-only. It has one row per status change (`drafted`, `queued`,
`sent`, `delivered`, `bounced`, `failed`, `replied`, `cancelled`), plus
`complained` and `unsubscribed`. Each row carries a short detail and, when a
provider notification caused it, that notification's id
(`providerEventId`, unique).

`EmailSuppression` lists addresses that must never be emailed again
(`bounced`, `complained`, `unsubscribed`, `invalid`). It is only ever added to.
Adding an address cancels every open message to it, on any prospect.

`OutreachControlChange` is the global sending switch: an append-only history,
where the newest row is the current state. With no rows, sending is off.

## Eligibility: one decision

Whether a business may get a message is decided in one place,
[`src/outreach/eligibility.ts`](src/outreach/eligibility.ts), at three steps:
**prepare** (may a draft be made?), **queue** (may this draft be approved?),
and **send** (may it leave now?, re-checked right before each send). The rule
itself, `eligibilityErrors`, is pure; `outreachEligibility` reads the facts it
needs. Drafting, automatic preparation, queueing, the admin, and the
dispatcher all call it, so they can't disagree, and a person sees the same
reason at every step.

## Drafts

### Who gets one

A first message can be drafted for a prospect that:
- is **New, Qualified, or Ready to contact**;
- meets everything Ready to contact requires (business name, Qualification
  **Meets criteria**);
- has a **valid published business email** with the URL where it was found;
- has no open message and no first message already sent; and
- whose address isn't suppressed.

A follow-up can be drafted for a sent or delivered message without a reply
(one per message), while the prospect is Contacted.

### How a draft is written

[`src/outreach/compose.ts`](src/outreach/compose.ts) is deterministic: no
model and no network. Every personal detail comes from a fact the record
supports: a stored field, or a signal recorded **yes** with evidence. The
first message (`intro@t2`) uses only the business's name, its city when
known, and that it is independent when that is evidenced; it never quotes
excerpts. Its one link is its invitation (see [Invitations](#invitations)).
Every message ends with the sender's name, an opt-out instruction ("reply 'no
thanks'"), and the sender's postal address.

### Automatic preparation

`prepareEligibleOutreach` ([`src/outreach/prepare.ts`](src/outreach/prepare.ts))
finds every eligible prospect and drafts it, optionally queueing it too. No one
has to open a prospect. It skips prospects with an open or sent message, so
repeating it is safe. It never sends.

```bash
npm run outreach:prepare                      # dry run: who would get a draft, who wouldn't and why
npm run outreach:prepare -- --apply           # store drafts
npm run outreach:prepare -- --apply --queue   # store and queue them
```

The admin doesn't prepare and queue in one step: there, a person chooses who
gets a draft and reviews each one before queueing it (below).

### Preparing, reviewing, and queueing in the admin

```
Eligible now ──Prepare──> Draft ──review, Queue──> Queued ──dispatcher, while sending is on──> Sent
                            └──────── Discard ────────┴──> Cancelled (never sent)
```

- **Prepare.** **Outreach › Eligible now** lists who a first message can be
  prepared for. Each row's **Prepare draft** drafts that prospect
  (`POST /admin/prospects/:id/outreach`, the same route as the prospect's
  page). Or tick several and **Prepare drafts for the chosen prospects**
  (`POST /admin/outreach/prepare`, `prepareSelectedOutreach`): at most 50 at a
  time, each checked again first and drafted in its own transaction, so one
  prospect's problem never stops the rest. The page then says how many were
  prepared, already had an open message, aren't eligible now, changed while
  being drafted, or failed (logged on the server). Drafting makes the
  invitation with the message, as always. **Nothing is queued or sent.**
- **Review.** A draft's page opens with **DRAFT — NOT SENT**, then the
  business and its qualification, the recipient and where the address was
  found, the sender, template, campaign, the full message (its invitation link
  hidden), the evidence it uses, and its invitation.
- **Queue.** **Queue** on the draft's page checks everything again: the
  prospect's eligibility, the recipient, suppression, the sender identity and
  compliance, and that the message's own invitation hasn't been revoked (its
  link would no longer work; the prospect stays exactly as eligible as
  before). A second click changes nothing; two at once queue it once.
  **Queueing sends nothing**: the page says **QUEUED — NOT SENT BY THIS
  ACTION**, and the dispatcher sends it only while sending is on.
- **Discard.** **Discard** stops a draft or a queued message for good; it
  needs a reason and an explicit confirmation, and stays in the history as
  Cancelled. Its invitation is left as it is: revoking is a separate action.
  A sent message can't be discarded.

## Sending

[`src/outreach/dispatch.ts`](src/outreach/dispatch.ts) is the only code that
calls a sender; a test enforces this. Run it on a schedule:

```bash
npm run outreach:send              # dry run: what would be sent, and what blocks sending
npm run outreach:send -- --apply
```

### Three keys, re-checked before every message

1. `OUTREACH_SENDING_ENABLED=1` in the environment arms the deployment.
2. The global switch is on (admin, **Outreach**). It is off by default, and
   switching it on needs a reason and everything else ready. **Switching it
   off takes effect before the next message**, mid-batch included.
3. An enabled provider: `OUTREACH_PROVIDER=gmail` with a complete Gmail
   configuration. Unset, or incomplete, it is disabled and the admin shows why.

Sending also needs a complete sender identity: `OUTREACH_SENDER_NAME`,
`OUTREACH_SENDER_EMAIL`, `OUTREACH_POSTAL_ADDRESS`, and `PUBLIC_API_URL` (for
the unsubscribe link).

### Daily limit

At most `OUTREACH_DAILY_LIMIT` new messages (default 20, at most 500) start
sending in any rolling 24 hours. It is counted under a database lock, so
concurrent dispatchers can't overshoot it. Each message counts once, however
many attempts it takes. Workspace allows 2,000 messages a day per mailbox and
blocks sending for up to 24 hours beyond that; a low limit also warms up a new
mailbox gradually.

### Before each send

The dispatcher re-checks every condition. If any fails, the message is
cancelled with the reason instead of sent:
- the prospect is still eligible (Ready to contact for a first message,
  Contacted for a follow-up; Meets criteria; not Do not contact);
- the prospect's email is unchanged since the message was prepared;
- the address isn't suppressed;
- no other first message was sent;
- the message carries the opt-out and the postal address, and was prepared
  for the configured sender.

### Never two emails for one message

- **Claimed once.** A message is claimed compare-and-set before its send, so
  only one dispatcher sends it, even when several run at once.
- **Same key on every attempt.** Each attempt carries the idempotency key
  `outreach-<id>`.
- **Uncertain outcomes** (a timeout, a 5xx, a provider that throws):
  - the message stays queued;
  - it is retried only by a provider that can rule out a second send (an
    idempotency key, or for Gmail a check of Sent first), and only within
    23 hours;
  - otherwise it is listed under **Send outcome unknown** for a person. They check
    the provider, then record **It was sent** or discard the message.
- **Rejections.** A definite rejection marks the message `failed`. An invalid
  recipient is also suppressed.
- **Provider unavailable** (authentication, configuration, quota): certainly
  not sent. The claim is undone exactly, the message stays queued as if never
  attempted, and the batch stops.

What a message carries: From (the sender), Reply-To (the sender), the
recipient, the subject and text exactly as reviewed, and the
`List-Unsubscribe` / `List-Unsubscribe-Post` one-click headers (RFC 8058).

## Provider events

`applyProviderEvent` takes a normalised event: `sent`, `delivered`,
`bounced` (with `permanent`), `failed`, or `complained`. Each event carries
the provider's message id or our outreach id, and the notification's id.
- **Idempotent.** A repeated notification id, or the same status again,
  changes nothing.
- **Tolerant of order.** A `delivered` that arrives before `sent` records
  the send first.
- **Never thrown.** Events that don't fit the message's state (a late bounce
  after a reply, a soft bounce) are ignored, so an endpoint can always
  answer 2xx.
- **One at a time per message.** Every report about a sent message (provider
  events, replies, opt-outs, and the dispatcher's own record of the send)
  first locks that message's row (`lockOutreach`). Two copies of a
  notification arriving together are applied one after the other: the second
  finds the first recorded and is a duplicate, instead of failing the first's
  compare-and-set. The guarantee is in the database, so it holds across
  processes and restarts.
- **Never reopens outreach.** A bounce, complaint, or opt-out suppresses the
  address; nothing an event does makes a business eligible again.

A provider with delivery webhooks would add an endpoint that verifies the
webhook signature, then calls this. Gmail has no such webhooks. Its bounces
are read from the mailbox instead (see below).

## Google Workspace (Gmail)

[`src/outreach/gmail.ts`](src/outreach/gmail.ts) is the sender, and
[`src/outreach/gmailInbox.ts`](src/outreach/gmailInbox.ts) the mailbox
reader. Both get their credentials from
[`src/outreach/gmailAuth.ts`](src/outreach/gmailAuth.ts), so neither depends
on how the mailbox was authorized.

**Authentication: Google OAuth 2.0 user authorization.** A Workspace account
is authorized once, by a person signed in as that account, through Google's
standard authorization-code flow with offline access. This uses Google's
official `google-auth-library`. There is no password, no SMTP, and no
service-account key: the Workspace organization policy
`iam.disableServiceAccountKeyCreation` blocks keys, and it should stay on.
- **Two identities.** The *account* is the Google user who signs in
  (`alex@reclaimbay.com`). The *sender* is `OUTREACH_SENDER_EMAIL`, the From
  address (`hello@reclaimbay.com`). They can be the same address. They can
  differ only when the sender is one of the account's Gmail **Send As**
  addresses that Gmail reports as ready to use: verification status
  `accepted`, or none reported, as for a Workspace alias. A `pending` address,
  an address missing from the account's Send As list, or another account
  entirely fails closed. Matching the domain is never enough.
- **Scopes:** exactly `gmail.send` and `gmail.readonly`. `gmail.readonly` also
  allows reading the Send As settings (`users.settings.sendAs.get`), so no
  settings scope is requested. Nothing modifies or deletes mail.
- **Checked before anything is sent.** Before its first call, and on every
  admin check, the client confirms the account with Gmail's own profile and
  the sender with the account's Send As settings. Without this, Gmail would
  quietly put the account's own address in From. Each message's From must
  also be exactly the sender: not the account's own address, and not
  another of its aliases.
- **Fail closed.** Access tokens are refreshed automatically. If the
  authorization is revoked or expires, or the alias stops being usable,
  nothing is sent: the message stays queued, the batch stops, and the admin
  **Outreach** page says why.

**Authorizing (once, and again after a revocation):**
1. In the admin's **Outreach** page, choose **Authorize
   hello@reclaimbay.com with Google**.
2. The server sets a random state (32 bytes) in an HMAC-signed,
   ten-minute, HttpOnly cookie, and sends you to Google. Google is asked for
   offline access, only the two Gmail scopes, `prompt=consent`, and a hint for
   the sender's domain. There's no login hint, because the sender may be an
   alias that nobody signs in as.
3. Sign in as `alex@reclaimbay.com`, the account that has
   `hello@reclaimbay.com` as a Send As address, and allow both permissions.
4. Google returns to `PUBLIC_API_URL/oauth/gmail/callback`. The server:
   - checks the state against the cookie (single use);
   - exchanges the code;
   - checks that both scopes were granted;
   - reads the account from Gmail's profile, and confirms the sender is that
     account or one of its ready Send As addresses. Any other grant is
     revoked at once, and nothing is issued.
5. The page shows the refresh token **sealed** once, together with the
   account it belongs to: encrypted with AES-256-GCM under
   `GMAIL_TOKEN_ENCRYPTION_KEY`, and bound to this OAuth client and sender.
   Store it as `GMAIL_REFRESH_TOKEN_SEALED` in the host's secret store and
   restart. The plain refresh token is never shown, logged, or stored anywhere
   else.

The sealed value is kept in the host's secret store, not the database: the
app can't write to that store, so this one copy step is the price of
needing no schema change.

**What Gmail tells us, and how certain it is:**

| Question | From Gmail | Recorded as |
| -------- | ---------- | ----------- |
| Was it sent? | Yes: the API returns Gmail's message id when Gmail accepts it | `sent`, with that id |
| Was it delivered? | **No.** Gmail sends no delivery receipts | Nothing. `delivered` stays unset; "sent, not bounced" is the closest measure |
| Did it bounce? | A bounce notice (DSN) arrives in the mailbox, threaded with the message | `bounced` and suppressed, only for a permanent status (5.x.x). A delay (4.x.x) changes nothing, and an unclear notice is listed for a person |
| Did they reply? | The reply arrives in the mailbox, threaded with the message | `replied`, unclassified, for a person to classify. Auto-replies and out-of-office notices are ignored |
| Did they complain (spam)? | **No.** No per-message complaint reports | Nothing. Google Postmaster Tools shows only an aggregate spam rate |
| Did they unsubscribe? | The one-click link reaches our own endpoint. An "unsubscribe" email (the List-Unsubscribe mailto) arrives in the mailbox | `unsubscribed`, the address suppressed, and the prospect Do not contact |

**No idempotency key.** Gmail also replaces any Message-ID we set. So every
message carries `X-ReclaimBay-Outreach: <outreach id>`, a custom header that
Gmail keeps. A retry first looks in Sent, since the first attempt, for that
header. If it finds it, the earlier attempt is recorded as the send. If Sent
can't be checked, nothing is sent.

**Errors.**
- A 4xx on send means Gmail refused the message: `rejected`. An invalid
  recipient is also suppressed.
- Authentication, a 403, or a 429 (limits) means certainly not sent:
  `unavailable`. The message stays queued and the batch stops.
- A 5xx or a lost response: `uncertain`, retried only after the Sent check.

**Reading the mailbox.** Run `npm run outreach:inbox` on a schedule, for
example every 5 minutes. It is a dry run by default; `--apply` records.
- It reads the last 7 days. It needs no cursor: every write is idempotent,
  because a bounce carries Gmail's message id as its event id and a second
  reply to a replied message is a duplicate.
- It matches by Gmail thread, then by the marker quoted in a bounce, then by
  the sender's address. Unmatched mail is only reported.
- Gmail push notifications (a Pub/Sub watch, renewed every 7 days) could
  trigger a run sooner. That is extra infrastructure this volume doesn't need.

**Configuration** (environment only; never in the repository):

| Variable | Value |
| -------- | ----- |
| `OUTREACH_PROVIDER` | `gmail` |
| `OUTREACH_SENDER_EMAIL` | The From address (`hello@reclaimbay.com`). Either the authorized account itself, or a verified Send As address of it. Mail is read from the authorized account's mailbox |
| `GOOGLE_OAUTH_CLIENT_ID` | The OAuth client's ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | The OAuth client's secret. A secret: host secret store only |
| `GMAIL_TOKEN_ENCRYPTION_KEY` | 32 random bytes, base64, for sealing the refresh token: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. A secret |
| `GMAIL_REFRESH_TOKEN_SEALED` | The sealed value from the authorization page. A secret |
| `OUTREACH_SENDER_NAME`, `OUTREACH_POSTAL_ADDRESS`, `PUBLIC_API_URL` | As above. `PUBLIC_API_URL` is also where Google returns |
| `OUTREACH_DAILY_LIMIT` | New sends per rolling 24 hours (default 20) |
| `OUTREACH_SENDING_ENABLED` | `1` to arm the deployment |

**Setup:**
1. Use a dedicated outreach mailbox. A separate sending domain or subdomain
   protects the main domain's reputation, at the cost of warming it up. Set
   up SPF, DKIM (Admin console > Gmail > Authenticate email), and DMARC for it.
2. In the Google Cloud project owned by the Workspace organization:
   - enable the Gmail API;
   - set the OAuth consent screen's user type to **Internal**, so only
     accounts in the organization can authorize and the Gmail scopes need no
     Google review;
   - add the two scopes above;
   - create an **OAuth client ID** of type **Web application** with the
     authorized redirect URI `PUBLIC_API_URL/oauth/gmail/callback` (for
     example `https://api.reclaimbay.com/oauth/gmail/callback`).
3. Set the variables above, all except `GMAIL_REFRESH_TOKEN_SEALED`, and deploy.
4. Authorize the mailbox from the admin **Outreach** page, store
   `GMAIL_REFRESH_TOKEN_SEALED`, and restart. The page then shows
   "Authorized as hello@reclaimbay.com" after a live check with Gmail.

No service account, service-account key, or domain-wide delegation is used.
A service account left over from earlier setup can be deleted, and its
domain-wide delegation entry removed.

## Replies and opt-outs

- `recordInboundReply` matches an inbound email to the message it answers:
  by the provider id in In-Reply-To, otherwise the latest sent message to
  that address. It records the reply unclassified (the prospect becomes
  Engaged) and never guesses at unmatched mail.
- `classifyReply` sets the outcome once: interested, not interested, other,
  or asked not to be contacted. Classification is a person's job for now;
  there is no automatic classification.
- **One-click unsubscribe:** `GET /u/:token` shows a button (mail scanners
  follow links), and `POST /u/:token` unsubscribes, from the button or a mail
  client's one-click request. It suppresses the address, makes the prospect
  Do not contact, and logs `unsubscribed`. Repeating it is harmless, and the
  response is the same for unknown tokens.

## Invitations

An invitation is the link a contacted business follows into ReclaimBay:
`https://reclaimbay.com/invite#<token>`. The service is in
[`src/invitations/`](src/invitations/), the page is the site's `/invite`, and the
admin shows each first message's invitation and can revoke it. Accounts and
signup are a separate, later milestone, so an invitation leads into the
existing anonymous product.

```
First message:  Prospect -> Outreach -> Invitation -> /invite#<token> -> visits -> activation
Follow-up:      Outreach (follow-up) -> reuses its first message's Invitation, same link
```

- **Made with the first message.** Drafting a first message makes its
  invitation in the same transaction (`createInvitationInTx`), and writes its
  link into the message. If either fails, neither exists, so there is never a
  first message without its invitation, or a second invitation for one.
- **Follow-ups reuse it.** The token is stored nowhere but in the first
  message's text, so a follow-up takes the link from there, accepted only when
  its hash is the invitation's. No follow-up makes an invitation. A follow-up
  to a message whose invitation was revoked is refused: its link no longer
  works.
- **Messages made before invitations** (`intro@t1`) are left exactly as they
  are: no invitation is invented for them and their text isn't changed. They
  queue and send as before, with the referral link (`?ref=`), which still
  attributes visits to the prospect. Their follow-ups keep the referral link
  too (`follow-up@t1`). To give such a business an invitation instead,
  discard the unsent draft and prepare it again.
- **Local links.** Links use `PUBLIC_SITE_URL` (default
  `https://reclaimbay.com`); set `PUBLIC_SITE_URL=http://localhost:3000` in
  `backend/.env` for invitation links that open the local site.

- **One per contact attempt.** An invitation belongs to a first message,
  made while it is unsent (unique per message; a follow-up reuses it). It is
  made only where drafting is allowed: the same eligibility decision
  (`eligibility.ts`). Making one sends and queues nothing.
- **The token.** 32 random bytes as 43 base64url characters, in the URL
  fragment, which browsers never send to a server. Only its SHA-256 is stored
  (`Invitation.tokenHash`), so the token is returned once, when the
  invitation is made, and can't be recovered. The link carries nothing else:
  no ids, name, email, or campaign.
- **Opening.** Counts the open (`firstOpenedAt`, `lastOpenedAt`, `openCount`)
  and links the visitor's anonymous analytics session to the invitation and
  its prospect, first touch only, exactly as a `?ref=` link does. A malformed,
  unknown, or revoked link, or one for a business that is Do not contact or
  whose address is suppressed, gets the same "not active" answer and records
  nothing. The answer reveals only whether it's active and the business's own
  public name.
- **Revoking** stops the link and keeps the record (`revokedAt`,
  `revokeReason`). Repeating it changes nothing. It doesn't change whether the
  prospect is eligible, but an unsent first message whose invitation is
  revoked can't be queued (its link would no longer work): discard it and
  prepare a new draft, which gets a new invitation.
- **Activation** is measured, not stored: the first real (not sample)
  `scan_completed` in a session that arrived through the invitation, at or
  after its first open (`invitationActivations`).

## The Outreach page

The admin **Outreach** page answers, at a glance:
- **Is mail going out?** One headline: OFF; ON; ON but blocked (with the
  first reason, including a failed live check of the provider); or ON but
  paused by the daily limit. Its one action is **Stop all sending now** while
  on, or **Switch sending on** once nothing else blocks it.
- **Eligible now, Drafts, and Queued**, each as it stands now, and **Send
  attempts in the last 24 hours** against the daily limit: sends the
  dispatcher started (`sendStartedAt`), whether or not the provider sent them,
  the same count the limit enforces. Also when the last message went out (a
  stale time means the scheduled sender isn't running).
- **Needs attention**, shown only when something does: sends whose outcome is
  unknown, replies to classify, messages the provider refused in the last
  7 days, invitations opened or activated in the last 7 days, and queued mail
  that isn't going out, each linked. That last one appears only while sending
  is ON and unblocked with daily capacity left, the switch has been on for 2
  hours, a message has waited unclaimed for 2 hours, and nothing has been sent
  in those 2 hours: a sign the scheduled sender isn't running (expected outside
  its hours if it runs only in business hours). A queue that is draining, one
  message per run, keeps sending and never trips it.
- Preparing drafts, the email provider, and, collapsed, messages by current
  status and the funnel by campaign (see [Measurement](#measurement)), whose
  Opened and Activated numbers link to the invitations behind them.

### Operations views

`/admin/outreach/messages`, linked from the Outreach page, lists what the
records already hold. It is read-only: nothing there drafts, queues, sends, or
records anything, and nothing new is tracked.

| View | Shows |
| ---- | ----- |
| **Messages** | Every message, newest change first, filtered by status, kind, and campaign: its business and recipient, template and campaign, status with its reason (cancelled, refused, bounced, outcome unknown), queued and sent times, its invitation (first open, opens, activation), and its reply |
| **Replies** | Replied messages, unclassified first, with each one's classification and reply summary |
| **Invitation activity** | Opened invitations, newest activity first (an open, or activation), optionally activated only, and optionally only those whose message was sent (the funnel's Opened and Activated link there, so the list is exactly what they count). By default it also shows an open on a message whose send outcome is unknown, which suggests it went out |
| **Eligible now** | Who a first message could be prepared for right now: the same dry run the Outreach page counts, so the one eligibility decision; no draft or invitation is made |

Lists are filtered and paged (50 to a page) in the database, and every filter
is in the link, so a view can be bookmarked. Activation is always
`invitationActivations`: a real scan, at or after the first open. No page
shows a message body, a token, its hash, or an invitation's id, and any text
that can quote an email (a reply summary, a reason) has its invitation tokens
hidden before it is escaped.

## Measurement

`outreachMetrics` ([`src/outreach/metrics.ts`](src/outreach/metrics.ts))
computes the funnel by campaign from the raw records only: messages, their
`unsubscribed` and `complained` events, invitations, and prospect status
history. Nothing is stored, so a definition can change without a migration.
The admin **Outreach** page shows it, with these definitions under the table.

**All time.** There is no date window, so a recent campaign has had less time
to be opened, answered, or move forward than an old one.

Each figure is counted at one level, by one campaign:

| Level | Credited to | Figure | Counts |
| ----- | ----------- | ------ | ------ |
| Messages | the message's campaign | Ever drafted | every message, whatever its status now (cancelled ones included) |
| | | Ever queued | messages ever queued (`queuedAt`), even if cancelled afterwards |
| | | Refused before sending | the provider refused it, so it was never sent (`failed`, no `sentAt`) |
| | | Sent | handed to the provider (`sentAt`), whatever happened next |
| | | Bounced, Failed after sending | sent, then reported bounced, or failed |
| | | Replies | messages with a reply; each is exactly one of Positive (interested), Negative (not interested, asked not to be contacted), Other, Unclassified |
| | | Unsubscribed, Complaints | messages whose recipient unsubscribed, or marked them as spam |
| Invitations | the invitation's campaign (its first message's) | Invitations sent | invitations whose message was sent; one made for a draft never sent doesn't count |
| | | Opened | of those, opened at least once (the invitation page reporting an open, not the email being read) |
| | | Activated | of those, activated (`invitationActivations`) |
| Prospects | the campaign of the prospect's first sent message | Prospects emailed | prospects with a sent message |
| | | Prospects reached | prospects with a sent message that hasn't bounced or failed |
| | | Replying prospects | prospects who replied to any of their messages, once each |
| | | Meeting, Proposal, Customer, Lost | prospects that entered that status at or after their first email was sent |

- **One round per prospect.** A prospect gets at most one sent first
  message ([eligibility](#eligibility-one-decision)), so everything from that
  send on (follow-ups included) is its one outreach round, credited to that
  message's campaign. Statuses reached before it, including a whole earlier
  round of the prospect's lifecycle before it was reopened, are never
  credited to the email.
- **Ever reached, within the round.** Statuses can move backward, so a
  prospect can count in several (Lost, then later Customer). These aren't
  exclusive, and aren't the prospect's status now.
- **Follow-ups.** A follow-up reuses its first message's invitation, and its
  prospect is credited to the first message's campaign. A campaign of
  follow-ups only therefore shows **—** for its invitation and prospect
  figures: not attributable to it, rather than a 0 that reads as "nobody did
  this". Opens after a follow-up count under the first message's campaign.
- **Delivery isn't measured.** Gmail reports no deliveries, so there is no
  Delivered column; Prospects reached is the closest measure.
- **Drafts and Queued** in the tiles above the funnel count what is in that
  state now; the funnel's **Ever drafted** and **Ever queued** count history.
  **Send attempts, last 24 hours** is the daily limit's count
  (`sendStartedAt`), not confirmed sends.
- **Score at queue time.** Each message keeps the prospect's score when it was
  queued (`queuedScore`, `queuedScoreVersion`), so prospect quality can later
  be compared with outcomes even after rescoring. Messages queued before this
  was recorded have none; nothing back-fills them.

Revenue isn't recorded yet; billing comes later.

## Safety checklist before the first real email

Already supported:
- unsubscribe and Do not contact handling;
- sender identity and postal-address checks;
- bounce, complaint, and invalid-address suppression;
- duplicate prevention;
- cancellation when eligibility changes;
- the global kill switch.

Still required:
1. **Set up Google Workspace** as described above (mailbox, SPF, DKIM,
   DMARC, the Internal consent screen, and the OAuth client).
2. **Configure the sender:** `OUTREACH_PROVIDER`, `GOOGLE_OAUTH_CLIENT_ID`,
   `GOOGLE_OAUTH_CLIENT_SECRET`, `GMAIL_TOKEN_ENCRYPTION_KEY`,
   `OUTREACH_SENDER_NAME`, `OUTREACH_SENDER_EMAIL`, `OUTREACH_POSTAL_ADDRESS`,
   and `PUBLIC_API_URL`. The backend must be reachable there, so the OAuth
   callback and unsubscribe links work. Then authorize the mailbox and set
   `GMAIL_REFRESH_TOKEN_SEALED`.
3. **Reprepare** any draft made before the sender was configured. Queueing
   refuses it, because it lacks the postal address.
4. **Classify replies.** `outreach:inbox` records them unclassified. A
   person classifies each one; opt-outs within 10 business days under US law
   (CAN-SPAM).
5. **Schedule `outreach:send -- --apply` and `outreach:inbox -- --apply`**,
   set `OUTREACH_SENDING_ENABLED=1`, and switch sending on in the admin with
   a reason.

## Not automated yet (on purpose)

- Delivery and complaint tracking: Gmail doesn't provide them.
- Gmail push notifications: the inbox is polled instead.
- Automatic reply classification.
- Follow-up schedules.
- Revenue tracking.
