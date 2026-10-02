# Outreach: lifecycle, sending, events, and measurement

Outreach is the step after a prospect is approved: a message to the business,
what happened to it, and what came of it.

**What ReclaimBay sells in outreach:** recovering revenue from declined and
deferred repair work at independent repair shops. The first message
(`intro@t1`) says only what the product does today: it reads the shop's
declined or deferred work report and shows its total value, the
highest-value jobs, and where that value is concentrated, privately in the
browser. It never mentions websites, invents figures, or promises results.

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
| `template`, `campaign` | `intro@t1` / `follow-up@t1`; the referral-link campaign (`outreach-intro-t1`) |
| `subject`, `body`, `evidence`, `generatedAt` | The message as generated and reviewed, and the stored facts it relies on |
| `recipientEmail`, `recipientSourceUrl` | The published business email and where it was found |
| `senderName`, `senderEmail` | Who it was prepared for |
| `status`, `statusChangedAt`, `openForProspectId` | As above; the prospect id while open (unique: one open message per prospect) |
| `queuedAt`, `sentAt`, `deliveredAt`, `failedAt` + `failureReason`, `repliedAt` + `replyOutcome` + `replySummary`, `cancelledAt` + `cancelReason` | When each step happened, and why |
| `provider`, `providerMessageId` | Who sent it and the provider's id (unique) |
| `sendStartedAt`, `sendAttempts`, `lastSendError` | The dispatcher's claim and attempts |
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
message names services only from research's own vocabulary, never quotes
excerpts, and uses fixed text from the public site for ReclaimBay itself. It
ends with the sender's name, an opt-out instruction ("reply 'no thanks'"),
and the sender's postal address.

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

The admin **Outreach** page has the same two buttons.

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

A provider with delivery webhooks would add an endpoint that verifies the
webhook signature, then calls this. Gmail has no such webhooks. Its bounces
are read from the mailbox instead (see below).

## Google Workspace (Gmail)

[`src/outreach/gmail.ts`](src/outreach/gmail.ts) is the sender, and
[`src/outreach/gmailInbox.ts`](src/outreach/gmailInbox.ts) the mailbox
reader. They have no dependencies beyond Node.

**Authentication.** A Google Cloud service account with domain-wide
delegation impersonates the outreach mailbox. It signs a short JWT and gets a
one-hour access token. There is no password, no SMTP, and no refresh token
to store. Scopes: `gmail.send` and `gmail.readonly`. Nothing modifies or
deletes mail.

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
| `GMAIL_SERVICE_ACCOUNT_JSON` | The service account's JSON key, raw or base64. A secret: set it in the host's secret store |
| `OUTREACH_SENDER_EMAIL` | The Workspace mailbox to send from and read; the account the service account impersonates |
| `OUTREACH_SENDER_NAME`, `OUTREACH_POSTAL_ADDRESS`, `PUBLIC_API_URL` | As above |
| `OUTREACH_DAILY_LIMIT` | New sends per rolling 24 hours (default 20) |
| `OUTREACH_SENDING_ENABLED` | `1` to arm the deployment |

**Setup:**
1. Use a dedicated outreach mailbox. A separate sending domain or subdomain
   protects the main domain's reputation, at the cost of warming it up. Set
   up SPF, DKIM (Admin console > Gmail > Authenticate email), and DMARC for it.
2. In a Google Cloud project owned by the Workspace organization:
   - enable the Gmail API;
   - create a service account and a JSON key;
   - mark the OAuth consent screen **Internal**, so the Gmail scopes need no
     Google review.
3. In the Admin console (Security > API controls > Domain-wide delegation),
   authorize the service account's client ID for
   `https://www.googleapis.com/auth/gmail.send` and
   `https://www.googleapis.com/auth/gmail.readonly`.
4. Set the variables above. The admin **Outreach** page lists anything still
   missing.

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

## Measurement

`outreachMetrics` ([`src/outreach/metrics.ts`](src/outreach/metrics.ts))
computes the funnel by campaign from the raw records only. It counts:
drafted, prospects reached, sent, delivered, bounced, failed, replied, positive
(interested), negative (not interested, asked not to be contacted),
unsubscribed, and complaints. It also counts meetings, proposals, customers,
and lost, as prospects that ever reached that status, attributed to the
campaign of their first sent message. The admin **Outreach** page shows it.
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
   DMARC, service account, delegation).
2. **Configure the sender:** `OUTREACH_PROVIDER`,
   `GMAIL_SERVICE_ACCOUNT_JSON`, `OUTREACH_SENDER_NAME`,
   `OUTREACH_SENDER_EMAIL`, `OUTREACH_POSTAL_ADDRESS`, and `PUBLIC_API_URL`.
   The backend must be reachable there, so unsubscribe links work.
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
