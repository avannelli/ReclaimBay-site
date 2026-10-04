import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import { revokeInvitationForOutreach } from "../../src/invitations/service.js";
import { confirmStuckSent, dailyCapacity, dispatchQueued, stuckMessages } from "../../src/outreach/dispatch.js";
import { gmailSender } from "../../src/outreach/gmail.js";
import { gmailOAuthConfig, openSealedToken, type GmailOAuthConfig } from "../../src/outreach/gmailAuth.js";
import { senderFromConfig } from "../../src/outreach/sender.js";
import { pollGmailInbox } from "../../src/outreach/gmailInbox.js";
import { inboxLogLines } from "../../src/outreach/inboxLog.js";
import { createOutreachDraft, queueOutreach } from "../../src/outreach/service.js";
import { addEvidence, createProspect } from "../../src/prospects.js";
import { ACCOUNT, CLIENT_ID, FakeGoogle, MAILBOX, aliasGoogle, fakeGmail, inbound } from "../fixtures/fakeGmail.js";
import { TEST_DATABASE_URL, freshDb, readyForm, skipReason, truncate } from "./helpers.js";
import { CFG, OPTS, mockSender, switchOn } from "./outreachHelpers.js";

/*
 * The real dispatcher and inbox reader with the Gmail adapter, against a
 * fake Google and a disposable database. No real mailbox, no network.
 */

describe("outreach through Gmail", { skip: skipReason }, () => {
  let db: Db;
  let realCalls: string[] = [];
  const realFetch = globalThis.fetch;
  before(async () => {
    db = await freshDb();
  });
  beforeEach(async () => {
    await truncate(db);
    realCalls = [];
    globalThis.fetch = (async (url: unknown) => {
      realCalls.push(String(url));
      throw new Error("real network call");
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    assert.deepEqual(realCalls, [], "no real network call");
  });
  after(async () => db?.$disconnect());

  let n = 0;
  /** A queued first message to a fresh, qualified prospect. */
  const queued = async () => {
    const i = ++n;
    const site = `https://g${i}.example.com`;
    const p = await createProspect(db, readyForm({ businessName: `G${i} Auto`, website: site, phoneSourceUrl: `${site}/c`, email: `owner@g${i}.example.com`, emailSourceUrl: `${site}/c` }));
    await addEvidence(db, p.id, { signalKey: "independent_shop", sourceUrl: `${site}/about`, excerpt: "Family owned." });
    const { outreach } = await createOutreachDraft(db, p.id, OPTS);
    await queueOutreach(db, outreach.id, CFG);
    return { p, o: outreach };
  };
  const row = (id: string) => db.outreach.findUniqueOrThrow({ where: { id } });

  test("an invitation revoked after queueing cancels before any Gmail call or daily-capacity claim", async () => {
    const { google, client } = fakeGmail();
    const sender = gmailSender(client);
    const { p, o } = await queued();
    const config = { ...CFG, outreachDailyLimit: 1 };
    await switchOn(db, sender);
    await revokeInvitationForOutreach(db, o.id, "Wrong shop.");
    assert.equal((await row(o.id)).status, "queued", "revocation itself leaves the message alone");

    const preview = await dispatchQueued(db, { config, sender, dryRun: true });
    assert.equal(preview.cancelled[0]?.outreachId, o.id);
    assert.deepEqual(preview.wouldSend, []);
    assert.equal((await row(o.id)).status, "queued", "dry run writes nothing");

    const report = await dispatchQueued(db, { config, sender });
    assert.equal(report.cancelled[0]?.outreachId, o.id);
    assert.match(report.cancelled[0]!.reasons.join(" "), /invitation.*revoked/);
    assert.deepEqual([report.sent, report.failed, report.uncertain, report.unavailable], [[], [], [], []]);
    assert.equal(google.calls.length, 0, "not even a Gmail authorization or readiness call");
    const stored = await row(o.id);
    assert.equal(stored.status, "cancelled");
    assert.ok(stored.cancelledAt);
    assert.match(stored.cancelReason!, /^No longer eligible: .*invitation.*revoked/);
    assert.deepEqual([stored.sendStartedAt, stored.sentAt, stored.sendAttempts, stored.lastSendError, stored.failedAt, stored.failureReason, stored.providerMessageId, stored.openForProspectId], [null, null, 0, null, null, null, null, null]);
    const events = await db.outreachEvent.findMany({ where: { outreachId: o.id }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(events.map((e) => e.type), ["drafted", "queued", "cancelled"]);
    assert.match(events[2]!.detail!, /invitation.*revoked/);
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: p.id } })).status, "ready_to_contact");
    assert.deepEqual(await dailyCapacity(db, config, new Date()), { used: 0, limit: 1, remaining: 1 });
    assert.deepEqual((await dispatchQueued(db, { config, sender })).cancelled, [], "a repeat adds no cancellation event");
    assert.equal(await db.outreachEvent.count({ where: { outreachId: o.id, type: "cancelled" } }), 1);
  });

  test("a revoked invitation does not use the last daily slot or stop an unrelated active invitation", async () => {
    const { google, client } = fakeGmail();
    const sender = gmailSender(client);
    const blocked = await queued();
    const valid = await queued();
    // Fix candidate order independently of clock resolution.
    await db.outreach.update({ where: { id: blocked.o.id }, data: { queuedAt: new Date(Date.now() - 1_000) } });
    await revokeInvitationForOutreach(db, blocked.o.id, "Wrong shop.");
    await switchOn(db, sender);
    const config = { ...CFG, outreachDailyLimit: 1 };
    const report = await dispatchQueued(db, { config, sender });
    assert.deepEqual(report.cancelled.map((c) => c.outreachId), [blocked.o.id]);
    assert.deepEqual(report.sent.map((s) => s.outreachId), [valid.o.id]);
    assert.equal(report.stoppedBecause, null);
    assert.deepEqual(google.sent.map((s) => s.marker), [valid.o.id]);
    assert.equal(google.sendCalls.length, 1);
    assert.deepEqual([(await row(blocked.o.id)).status, (await row(valid.o.id)).status], ["cancelled", "sent"]);
    assert.deepEqual(await dailyCapacity(db, config, new Date()), { used: 1, limit: 1, remaining: 0 });
  });

  for (const missing of [false, true]) {
    test(`a queued follow-up cannot send after its original invitation is ${missing ? "missing" : "revoked"}`, async () => {
      const first = await queued();
      const initial = mockSender();
      await switchOn(db, initial);
      await dispatchQueued(db, { config: CFG, sender: initial });
      const followUp = (await createOutreachDraft(db, first.p.id, { ...OPTS, followUpOfId: first.o.id })).outreach;
      await queueOutreach(db, followUp.id, CFG);
      if (missing) await db.invitation.delete({ where: { outreachId: first.o.id } });
      else await revokeInvitationForOutreach(db, first.o.id, "Wrong shop.");
      const { google, client } = fakeGmail();
      const config = { ...CFG, outreachDailyLimit: 2 };
      const report = await dispatchQueued(db, { config, sender: gmailSender(client) });
      assert.deepEqual(report.cancelled.map((c) => c.outreachId), [followUp.id]);
      assert.match(report.cancelled[0]!.reasons.join(" "), missing ? /invitation.*missing/ : /invitation.*revoked/);
      assert.equal(google.calls.length, 0);
      const stored = await row(followUp.id);
      assert.deepEqual([stored.status, stored.sendStartedAt, stored.sentAt, stored.sendAttempts, stored.lastSendError], ["cancelled", null, null, 0, null]);
      assert.equal((await row(first.o.id)).status, "sent", "the original send's history stays intact");
      assert.deepEqual(await dailyCapacity(db, config, new Date()), { used: 1, limit: 2, remaining: 1 });
    });
  }

  test("a queued first message whose invitation is missing is cancelled without contacting Gmail", async () => {
    const { o } = await queued();
    await db.invitation.delete({ where: { outreachId: o.id } });
    const { google, client } = fakeGmail();
    const sender = gmailSender(client);
    await switchOn(db, sender);
    const report = await dispatchQueued(db, { config: CFG, sender });
    assert.deepEqual(report.cancelled.map((c) => c.outreachId), [o.id]);
    assert.match(report.cancelled[0]!.reasons.join(" "), /invitation.*missing/);
    assert.equal(google.calls.length, 0);
    assert.deepEqual([(await row(o.id)).status, (await row(o.id)).sendStartedAt], ["cancelled", null]);
  });

  test("a send through Gmail stores Gmail's id and moves the prospect; the kill switch still rules", async () => {
    const { google, client } = fakeGmail();
    const sender = gmailSender(client);
    const { p, o } = await queued();
    const off = await dispatchQueued(db, { config: CFG, sender });
    assert.ok(off.blockers.includes("The global sending switch is off."));
    assert.equal(google.calls.length, 0, "switch off: Google isn't even contacted");

    await switchOn(db, sender);
    assert.equal((await dispatchQueued(db, { config: { ...CFG, outreachSendingArmed: false }, sender })).blockers.length, 1);
    assert.equal(google.calls.length, 0, "disarmed: Google isn't contacted");

    const report = await dispatchQueued(db, { config: CFG, sender });
    assert.equal(report.sent.length, 1);
    const stored = await row(o.id);
    assert.equal(stored.status, "sent");
    assert.equal(stored.provider, "gmail");
    assert.equal(stored.providerMessageId, google.sent[0]!.id);
    assert.equal(google.sent[0]!.marker, o.id);
    assert.match(Buffer.from(google.sent[0]!.raw, "base64url").toString(), /List-Unsubscribe: <https:\/\/api\.reclaimbay\.example\/u\//);
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: p.id } })).status, "contacted");
  });

  test("authorized as another account, a send goes out as its verified Send As address; without that alias nothing is attempted", async () => {
    const { google, client } = fakeGmail(aliasGoogle("accepted"));
    const sender = gmailSender(client);
    const { o } = await queued();
    await switchOn(db, sender);
    const report = await dispatchQueued(db, { config: CFG, sender });
    assert.equal(report.sent.length, 1);
    const head = Buffer.from(google.sent[0]!.raw, "base64url").toString().split("\r\n\r\n")[0]!;
    assert.match(head, /^From: "Alex Rivera" <hello@reclaimbay\.example>$/m);
    assert.match(head, /^Reply-To: hello@reclaimbay\.example$/m);
    assert.equal((await row(o.id)).providerMessageId, google.sent[0]!.id);

    const pending = fakeGmail(aliasGoogle("pending"));
    const s2 = gmailSender(pending.client);
    const b = await queued();
    await switchOn(db, s2);
    const blocked = await dispatchQueued(db, { config: CFG, sender: s2 });
    assert.equal(blocked.unavailable.length, 1);
    assert.match(blocked.stoppedBecause!, /isn't ready to use \(Gmail says pending\)/);
    assert.equal(pending.google.sendCalls.length, 0);
    const r = await row(b.o.id);
    assert.deepEqual([r.status, r.sendAttempts, r.sendStartedAt], ["queued", 0, null], "untouched, ready once the alias is verified");
  });

  test("Google unavailable (auth or quota): nothing sent, the message untouched, the batch stops", async () => {
    const { google, client } = fakeGmail();
    const sender = gmailSender(client);
    const a = await queued();
    const b = await queued();
    await switchOn(db, sender);
    google.tokenAnswer = { status: 401, body: { error: "unauthorized_client" } };
    const report = await dispatchQueued(db, { config: CFG, sender });
    assert.equal(report.unavailable.length, 1);
    assert.match(report.stoppedBecause!, /can't send right now.*unauthorized_client/);
    assert.equal(google.sendCalls.length, 0);
    for (const { o } of [a, b]) {
      const r = await row(o.id);
      assert.deepEqual([r.status, r.sendAttempts, r.sendStartedAt, r.lastSendError], ["queued", 0, null, null], "as if never attempted");
    }
    google.tokenAnswer = null;
    google.sendAnswers = [{ status: 429, body: { error: { message: "User-rate limit exceeded" } } }];
    const quota = await dispatchQueued(db, { config: CFG, sender });
    assert.equal(quota.unavailable.length, 1);
    assert.equal(google.sent.length, 0);
    assert.equal((await dispatchQueued(db, { config: CFG, sender })).sent.length, 2, "sends once Google is back");
  });

  test("a lost response is never retried: it waits for a person, who records it as sent", async () => {
    const { google, client } = fakeGmail();
    const sender = gmailSender(client);
    const { o } = await queued();
    await switchOn(db, sender);
    google.sendAnswers = ["network"];
    const first = await dispatchQueued(db, { config: CFG, sender });
    assert.equal(first.uncertain.length, 1);
    assert.equal(google.sent.length, 1, "it actually went out");
    const second = await dispatchQueued(db, { config: CFG, sender });
    assert.deepEqual(second.sent, []);
    assert.equal(google.sendCalls.length, 1, "Gmail is never asked to send it again");
    assert.equal(google.sent.length, 1, "one email");
    assert.deepEqual((await stuckMessages(db)).map((s) => s.id), [o.id]);
    // A person finds it in Sent, and records it.
    await confirmStuckSent(db, o.id, sender.name);
    const stored = await row(o.id);
    assert.equal(stored.status, "sent");
    assert.equal(stored.sendAttempts, 1);
  });

  test("an invalid recipient fails the message and suppresses the address", async () => {
    const { google, client } = fakeGmail();
    const sender = gmailSender(client);
    const { p, o } = await queued();
    await switchOn(db, sender);
    google.sendAnswers = [{ status: 400, body: { error: { message: "Invalid To header", errors: [{ reason: "invalidArgument" }] } } }];
    const r = await dispatchQueued(db, { config: CFG, sender });
    assert.equal(r.failed.length, 1);
    assert.equal((await row(o.id)).status, "failed");
    assert.equal((await db.emailSuppression.findUniqueOrThrow({ where: { email: p.email! } })).reason, "invalid");
  });

  test("the daily limit: counted over a rolling 24 hours, and concurrent dispatchers can't overshoot it", async () => {
    const { google, client } = fakeGmail();
    const sender = gmailSender(client);
    for (let i = 0; i < 3; i++) await queued();
    await switchOn(db, sender);
    const cfg = { ...CFG, outreachDailyLimit: 2 };
    const r = await dispatchQueued(db, { config: cfg, sender });
    assert.equal(r.sent.length, 2);
    assert.match(r.stoppedBecause!, /daily sending limit is reached \(2 of 2/);
    assert.equal((await dispatchQueued(db, { config: cfg, sender })).sent.length, 0);
    const tomorrow = () => new Date(Date.now() + 25 * 60 * 60 * 1000);
    assert.equal((await dispatchQueued(db, { config: cfg, sender, now: tomorrow })).sent.length, 1, "a day later, the last one goes");
    assert.equal(google.sent.length, 3);

    await truncate(db);
    const g2 = fakeGmail();
    const s2 = gmailSender(g2.client);
    for (let i = 0; i < 4; i++) await queued();
    await switchOn(db, s2);
    await Promise.all([1, 2, 3, 4].map(() => dispatchQueued(db, { config: { ...CFG, outreachDailyLimit: 1 }, sender: s2 })));
    assert.equal(g2.google.sent.length, 1, "exactly the limit, even with four dispatchers at once");
  });

  test("the mailbox: replies, bounces, auto-replies, and emailed unsubscribes are recorded once; the rest is only reported", async () => {
    const { google, client } = fakeGmail();
    const sender = gmailSender(client);
    const a = await queued();
    const b = await queued();
    const c = await queued();
    const d = await queued();
    await switchOn(db, sender);
    await dispatchQueued(db, { config: CFG, sender });
    const thread = (o: { id: string }) => google.sent.find((s) => s.marker === o.id)!.threadId;

    google.inbox.push(
      inbound("in-reply", thread(a.o), { From: `Owner <${a.p.email}>`, Subject: "Re: Declined work at G Auto" }, [{ mimeType: "text/plain", text: "Sounds interesting, call me." }], "Sounds interesting, call me."),
      inbound("in-ooo", thread(b.o), { From: `Front <${b.p.email}>`, Subject: "Automatic reply: Declined work", "Auto-Submitted": "auto-replied" }),
      inbound("in-dsn", thread(c.o), { From: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", Subject: "Delivery Status Notification (Failure)" }, [
        { mimeType: "message/delivery-status", text: "Action: failed\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550 5.1.1 does not exist" },
      ]),
      inbound("in-unsub", "th-new", { From: `${d.p.email}`, Subject: "unsubscribe" }),
      inbound("in-stranger", "th-other", { From: "someone@else.example.com", Subject: "Hello" }),
      inbound("in-delay", thread(b.o), { From: "mailer-daemon@googlemail.com", Subject: "Delivery Status Notification (Delay)" }, [{ mimeType: "message/delivery-status", text: "Action: delayed\nStatus: 4.4.7" }]),
    );

    const dry = await pollGmailInbox(db, client, { apply: false });
    assert.ok(dry.items.some((i) => i.result === "would record"));
    assert.equal(await db.outreachEvent.count({ where: { type: { in: ["replied", "bounced", "unsubscribed"] } } }), 0, "a dry run records nothing");

    const r = await pollGmailInbox(db, client, { apply: true });
    const by = (id: string) => r.items.find((i) => i.gmailId === id)!;
    assert.deepEqual([by("in-reply").kind, by("in-reply").result], ["reply", "recorded"]);
    assert.deepEqual([by("in-ooo").kind, by("in-ooo").result], ["auto_reply", "ignored"]);
    assert.deepEqual([by("in-dsn").kind, by("in-dsn").result], ["bounce", "recorded"]);
    assert.deepEqual([by("in-unsub").kind, by("in-unsub").result], ["unsubscribe", "recorded"]);
    assert.deepEqual([by("in-stranger").kind, by("in-stranger").result], ["reply", "unmatched"]);
    assert.deepEqual([by("in-delay").kind, by("in-delay").result], ["delay", "ignored"]);

    // What the job prints for this run: counts, and for matched mail only its kind, result, and our id.
    const printed = inboxLogLines(r, { apply: true, mailbox: ACCOUNT }).join("\n");
    for (const i of r.items) {
      if (i.subject !== "unsubscribe") assert.ok(!printed.includes(i.subject), `subject never printed: ${i.subject}`);
      if (i.from !== ACCOUNT) assert.ok(!printed.includes(i.from), `sender never printed: ${i.from}`);
    }
    assert.match(printed, /auto-replies 1, delays 1, unmatched 1, matched 3/);
    assert.match(printed, /matched: .*reply recorded 1/);
    assert.match(printed, /bounce recorded 1/);
    assert.match(printed, /unsubscribe recorded 1/);
    assert.ok(printed.includes(`reply recorded -> ${a.o.id}`), "matched mail keeps our message id");

    const ra = await row(a.o.id);
    assert.deepEqual([ra.status, ra.replyOutcome, ra.replySummary], ["replied", null, "Sounds interesting, call me."], "recorded unclassified, for a person");
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: a.p.id } })).status, "engaged");
    assert.equal((await row(b.o.id)).status, "sent", "an auto-reply and a delay change nothing");
    assert.equal((await row(c.o.id)).status, "bounced");
    assert.equal((await db.emailSuppression.findUniqueOrThrow({ where: { email: c.p.email! } })).reason, "bounced");
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: d.p.id } })).status, "do_not_contact");
    assert.equal((await db.emailSuppression.findUniqueOrThrow({ where: { email: d.p.email! } })).reason, "unsubscribed");

    const before = await db.outreachEvent.count();
    const again = await pollGmailInbox(db, client, { apply: true });
    assert.equal(await db.outreachEvent.count(), before, "reading the same mail again records nothing");
    assert.ok(again.items.every((i) => ["duplicate", "ignored", "unmatched"].includes(i.result)), JSON.stringify(again.items.map((i) => i.result)));
    assert.equal(google.sendCalls.length, 4, "reading the mailbox never sends");
    void MAILBOX;
  });

  test("mail by address is matched only if it arrived at or after our message was sent; earlier mail stays unmatched and records nothing", async () => {
    const { google, client } = fakeGmail();
    const sender = gmailSender(client);
    const history = await queued(); // earlier mail, then a real answer, from the same address
    const boundary = await queued(); // a reply received in the very millisecond we sent
    const contact = await queued(); // a contact-path email to hello@, and an emailed "unsubscribe", both before outreach
    const threaded = await queued(); // a reply in our own thread
    await switchOn(db, sender);
    await dispatchQueued(db, { config: CFG, sender });
    const sentAt = async (o: { id: string }) => (await row(o.id)).sentAt!;
    const thread = (o: { id: string }) => google.sent.find((s) => s.marker === o.id)!.threadId;
    const DAY = 24 * 60 * 60 * 1000;
    const replyEvents = () => db.outreachEvent.count({ where: { type: "replied" } });

    google.inbox.push(
      // 1. Historical: received three days before we wrote to them, from the same address, a new thread.
      inbound("old-mail", "th-old", { From: `Owner <${history.p.email}>`, Subject: "Question about my car" }, [{ mimeType: "text/plain", text: "Earlier, unrelated." }], "Earlier, unrelated.", new Date((await sentAt(history.o)).getTime() - 3 * DAY)),
      // 3. Boundary: received at exactly our send time. Inclusive by design (>=): sentAt is recorded only
      // once Gmail has accepted our message, so mail stamped at that instant can't be from before it.
      inbound("same-ms", "th-same", { From: `Owner <${boundary.p.email}>`, Subject: "Re: Declined work" }, [{ mimeType: "text/plain", text: "Yes." }], "Yes.", await sentAt(boundary.o)),
      // 7. Contact path: a "Talk to ReclaimBay" email to hello@ a week before outreach, and an emailed unsubscribe two days before.
      inbound("contact-mail", "th-contact", { From: `Owner <${contact.p.email}>`, To: MAILBOX, Subject: "Talk to ReclaimBay" }, [{ mimeType: "text/plain", text: "Shop name: ..." }], "Shop name: ...", new Date((await sentAt(contact.o)).getTime() - 7 * DAY)),
      inbound("early-unsub", "th-unsub", { From: contact.p.email!, Subject: "unsubscribe" }, [], "", new Date((await sentAt(contact.o)).getTime() - 2 * DAY)),
      // 4. Same thread: unchanged; matched by the thread whatever the address rule says.
      inbound("in-thread", thread(threaded.o), { From: `Owner <${threaded.p.email}>`, Subject: "Re: Declined work" }, [{ mimeType: "text/plain", text: "Call me." }], "Call me."),
      // 5. Unrelated mail: unmatched, as before.
      inbound("stranger", "th-stranger", { From: "someone@else.example.com", Subject: "Hello" }),
    );
    // No received time at all: not trusted for an address match.
    google.inbox.push({ ...inbound("no-date", "th-nodate", { From: `Owner <${history.p.email}>`, Subject: "Re: Declined work" }), internalDate: undefined });

    const first = await pollGmailInbox(db, client, { apply: true });
    const by = (r: typeof first, id: string) => r.items.find((i) => i.gmailId === id)!;
    assert.deepEqual([by(first, "old-mail").result, by(first, "old-mail").outreachId], ["unmatched", null], "historical mail is not a reply");
    assert.deepEqual([by(first, "same-ms").result, by(first, "same-ms").outreachId], ["recorded", boundary.o.id], "received at our send time: matched");
    assert.deepEqual([by(first, "contact-mail").result, by(first, "early-unsub").result], ["unmatched", "unmatched"], "contact-path mail and an earlier unsubscribe aren't answers to the outreach");
    assert.deepEqual([by(first, "in-thread").result, by(first, "in-thread").outreachId], ["recorded", threaded.o.id]);
    assert.equal(by(first, "stranger").result, "unmatched");
    assert.equal(by(first, "no-date").result, "unmatched", "no received time: no address match");

    // Nothing recorded for the earlier mail: no reply, no summary, no Engaged, no suppression, no opt-out.
    for (const q of [history, contact]) {
      const o = await row(q.o.id);
      assert.deepEqual([o.status, o.repliedAt, o.replySummary], ["sent", null, null]);
      assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: q.p.id } })).status, "contacted");
      assert.equal(await db.outreachEvent.count({ where: { outreachId: q.o.id, type: { in: ["replied", "unsubscribed"] } } }), 0);
      assert.equal(await db.emailSuppression.count({ where: { email: q.p.email! } }), 0);
      assert.equal(await db.prospectStatusChange.count({ where: { prospectId: q.p.id, toStatus: { in: ["engaged", "do_not_contact"] } } }), 0);
    }
    assert.equal(await replyEvents(), 2, "only the boundary reply and the thread reply");

    // 2. A real answer from the same address, after we wrote: matched and recorded, despite the earlier mail.
    google.inbox.push(inbound("real-answer", "th-answer", { From: `Owner <${history.p.email}>`, Subject: "Re: Quick question" }, [{ mimeType: "text/plain", text: "Interested." }], "Interested.", new Date((await sentAt(history.o)).getTime() + 60 * 60 * 1000)));
    const second = await pollGmailInbox(db, client, { apply: true });
    assert.deepEqual([by(second, "real-answer").result, by(second, "real-answer").outreachId], ["recorded", history.o.id]);
    assert.equal(by(second, "old-mail").result, "unmatched", "the earlier mail still never matches");
    const answered = await row(history.o.id);
    assert.deepEqual([answered.status, answered.replySummary], ["replied", "Interested."], "the summary is the answer's, not the earlier mail's");
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: history.p.id } })).status, "engaged");

    // 6. Idempotent: reading it all again records nothing new.
    const events = await db.outreachEvent.count();
    const third = await pollGmailInbox(db, client, { apply: true });
    assert.equal(await db.outreachEvent.count(), events);
    assert.ok(third.items.every((i) => ["duplicate", "unmatched", "ignored"].includes(i.result)), JSON.stringify(third.items.map((i) => [i.gmailId, i.result])));
    assert.equal(google.sendCalls.length, 4, "reading the mailbox never sends");
  });
});

describe("authorizing the Gmail mailbox (HTTP)", { skip: skipReason }, () => {
  const SECRET = "integration-test-secret-0123456789";
  const FORM = { "content-type": "application/x-www-form-urlencoded" };
  const KEY = randomBytes(32).toString("base64");
  let db: Db;
  let realCalls: string[] = [];
  const realFetch = globalThis.fetch;
  const apps: FastifyInstance[] = [];
  const env = (over: Record<string, string> = {}) => ({
    DATABASE_URL: TEST_DATABASE_URL,
    ALLOWED_ORIGIN: "https://reclaimbay.com",
    ADMIN_SECRET: SECRET,
    TRUST_PROXY_HOPS: "0",
    OUTREACH_PROVIDER: "gmail",
    GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: "test-client-secret",
    GMAIL_TOKEN_ENCRYPTION_KEY: KEY,
    PUBLIC_API_URL: "https://api.reclaimbay.example",
    OUTREACH_SENDER_EMAIL: MAILBOX,
    OUTREACH_SENDER_NAME: "Alex Rivera",
    OUTREACH_POSTAL_ADDRESS: "1 Main St, Ventura, CA 93001",
    ...over,
  });
  /** The app as it would be deployed with this environment, every Google call going to the fake. */
  const start = async (google: FakeGoogle, over: Record<string, string> = {}) => {
    const app = await buildApp(loadConfig(env(over)), db, false, { googleFetch: google.fetch });
    apps.push(app);
    const login = await app.inject({ method: "POST", url: "/admin/login", headers: FORM, payload: new URLSearchParams({ secret: SECRET }).toString() });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    return { app, get: (url: string) => app.inject({ method: "GET", url, headers: { cookie } }) };
  };
  /** Starts authorization as the admin; returns Google's URL and the state cookie. */
  const begin = async (get: (url: string) => Promise<{ statusCode: number; headers: Record<string, unknown> }>) => {
    const res = await get("/admin/outreach/gmail/authorize");
    assert.equal(res.statusCode, 302);
    const setCookie = String(res.headers["set-cookie"]);
    assert.match(setCookie, /^rb_gmail_oauth=[^;]+; Path=\/oauth\/gmail; HttpOnly; SameSite=Lax; Max-Age=600/);
    return { google: new URL(String(res.headers.location)), stateCookie: setCookie.split(";")[0]! };
  };
  const sealedFrom = (html: string) => /<textarea[^>]*>([^<]+)<\/textarea>/.exec(html)?.[1] ?? null;

  before(async () => {
    db = await freshDb();
  });
  beforeEach(async () => {
    await truncate(db);
    realCalls = [];
    globalThis.fetch = (async (url: unknown) => {
      realCalls.push(String(url));
      throw new Error("real network call");
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    assert.deepEqual(realCalls, [], "no real network call");
  });
  after(async () => {
    for (const a of apps) await a.close();
    await db?.$disconnect();
  });

  test("an admin authorizes the mailbox once; the refresh token is only ever shown sealed", async () => {
    const google = new FakeGoogle();
    const { app, get } = await start(google);
    const page = (await get("/admin/outreach")).body;
    assert.match(page, /authorized yet/);
    assert.match(page, /Authorize hello@reclaimbay\.example with Google/);

    const { google: url, stateCookie } = await begin(get);
    assert.equal(url.origin, "https://accounts.google.com");
    assert.equal(url.searchParams.get("access_type"), "offline");
    const state = url.searchParams.get("state")!;

    // Google sends the admin back. The admin session cookie isn't sent on this redirect (SameSite=Strict).
    const callback = (q: string, cookie?: string) => app.inject({ method: "GET", url: `/oauth/gmail/callback?${q}`, headers: cookie ? { cookie } : {} });
    assert.equal((await callback(`state=${state}&code=good-code`)).statusCode, 400, "no state cookie: refused");
    assert.equal((await callback("state=wrong&code=good-code", stateCookie)).statusCode, 400, "wrong state: refused");
    assert.equal(google.tokenCalls.length, 0, "nothing exchanged for a refused callback");

    const ok = await callback(`state=${state}&code=good-code`, stateCookie);
    assert.equal(ok.statusCode, 200);
    assert.match(ok.body, /hello@reclaimbay\.example<\/b> is authorized/);
    assert.match(String(ok.headers["set-cookie"]), /rb_gmail_oauth=; Path=\/oauth\/gmail; .*Max-Age=0/, "the state is single-use");
    assert.equal(ok.headers["cache-control"], "no-store");
    const sealed = sealedFrom(ok.body)!;
    const { refreshToken: refresh } = openSealedToken(sealed, gmailOAuthConfig(loadConfig(env())) as GmailOAuthConfig)!;
    assert.ok(google.validRefreshTokens.has(refresh));
    assert.ok(!ok.body.includes(refresh), "the plain refresh token is never shown");

    // Once stored as GMAIL_REFRESH_TOKEN_SEALED (and the service restarted), the admin sees it verified live.
    const authorized = await start(google, { GMAIL_REFRESH_TOKEN_SEALED: sealed });
    const live = (await authorized.get("/admin/outreach")).body;
    assert.match(live, /Authorized as hello@reclaimbay\.example/);
    assert.match(live, /Reauthorize hello@reclaimbay\.example with Google/);
    assert.equal(google.sendCalls.length, 0, "authorizing never sends");
  });

  test("the wrong Google account is refused, its access revoked, and nothing is issued", async () => {
    const google = new FakeGoogle();
    google.account = "personal@gmail.com";
    const { app, get } = await start(google);
    const { google: url, stateCookie } = await begin(get);
    const res = await app.inject({ method: "GET", url: `/oauth/gmail/callback?state=${url.searchParams.get("state")}&code=good-code`, headers: { cookie: stateCookie } });
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /That was personal@gmail\.com, which can&#39;t send as hello@reclaimbay\.example/);
    assert.equal(sealedFrom(res.body), null);
    assert.equal(google.revoked.length, 1);
    assert.equal(google.validRefreshTokens.size, 0);
  });

  test("the account that has the sender as a verified Send As address is authorized; a pending alias is refused", async () => {
    const google = aliasGoogle("accepted");
    const { app, get } = await start(google);
    const { google: url, stateCookie } = await begin(get);
    assert.equal(url.searchParams.get("login_hint"), null, "no hint to sign in as the alias");
    const ok = await app.inject({ method: "GET", url: `/oauth/gmail/callback?state=${url.searchParams.get("state")}&code=good-code`, headers: { cookie: stateCookie } });
    assert.equal(ok.statusCode, 200);
    assert.match(ok.body, /alex@reclaimbay\.example<\/b> is authorized for sending as hello@reclaimbay\.example/);
    const sealed = sealedFrom(ok.body)!;
    assert.equal(openSealedToken(sealed, gmailOAuthConfig(loadConfig(env())) as GmailOAuthConfig)!.account, ACCOUNT);
    assert.deepEqual(google.revoked, []);

    const live = (await (await start(google, { GMAIL_REFRESH_TOKEN_SEALED: sealed })).get("/admin/outreach")).body;
    assert.match(live, /Authorized as alex@reclaimbay\.example, sending as hello@reclaimbay\.example\./);

    // The alias is still awaiting verification: refused, revoked, nothing issued.
    const pending = aliasGoogle("pending");
    const p = await start(pending);
    const second = await begin(p.get);
    const res = await p.app.inject({ method: "GET", url: `/oauth/gmail/callback?state=${second.google.searchParams.get("state")}&code=good-code`, headers: { cookie: second.stateCookie } });
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /isn&#39;t ready to use \(Gmail says pending\)/);
    assert.equal(sealedFrom(res.body), null);
    assert.equal(pending.revoked.length, 1);
    assert.equal(google.sendCalls.length + pending.sendCalls.length, 0, "authorizing never sends");
  });

  test("a cancelled consent changes nothing", async () => {
    const google = new FakeGoogle();
    const { app, get } = await start(google);
    const { google: url, stateCookie } = await begin(get);
    const res = await app.inject({ method: "GET", url: `/oauth/gmail/callback?state=${url.searchParams.get("state")}&error=access_denied`, headers: { cookie: stateCookie } });
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /Authorization cancelled/);
    assert.equal(google.tokenCalls.length, 0);
  });

  test("a revoked authorization fails closed: the admin says reauthorize, and nothing is sent", async () => {
    const google = new FakeGoogle();
    const { app, get } = await start(google);
    const { google: url, stateCookie } = await begin(get);
    const ok = await app.inject({ method: "GET", url: `/oauth/gmail/callback?state=${url.searchParams.get("state")}&code=good-code`, headers: { cookie: stateCookie } });
    const sealed = sealedFrom(ok.body)!;
    const config = loadConfig(env({ GMAIL_REFRESH_TOKEN_SEALED: sealed, OUTREACH_SENDING_ENABLED: "1" }));

    // A queued message, with sending switched on.
    const site = "https://revoked.example.com";
    const p = await createProspect(db, readyForm({ businessName: "Revoked Auto", website: site, phoneSourceUrl: `${site}/c`, email: "owner@revoked.example.com", emailSourceUrl: `${site}/c` }));
    await addEvidence(db, p.id, { signalKey: "independent_shop", sourceUrl: `${site}/about`, excerpt: "Family owned." });
    const { outreach } = await createOutreachDraft(db, p.id, { siteUrl: "https://reclaimbay.com", sender: config.outreachSender });
    await queueOutreach(db, outreach.id, config);
    const sender = senderFromConfig(config, google.fetch);
    await switchOn(db, sender);

    // The mailbox owner revokes access in their Google account.
    google.validRefreshTokens.clear();
    const report = await dispatchQueued(db, { config, sender });
    assert.equal(report.unavailable.length, 1);
    assert.match(report.stoppedBecause!, /revoked or has expired: reauthorize/);
    assert.equal(google.sendCalls.length, 0);
    const stored = await db.outreach.findUniqueOrThrow({ where: { id: outreach.id } });
    assert.deepEqual([stored.status, stored.sendAttempts, stored.sendStartedAt], ["queued", 0, null], "untouched, ready once reauthorized");

    const page = (await (await start(google, { GMAIL_REFRESH_TOKEN_SEALED: sealed })).get("/admin/outreach")).body;
    assert.match(page, /Reauthorization required\./);
  });

  test("without OUTREACH_PROVIDER, or with Gmail half-configured, nothing can send and the admin says why", async () => {
    const google = new FakeGoogle();
    const none = await start(google, { OUTREACH_PROVIDER: "" });
    const page = (await none.get("/admin/outreach")).body;
    assert.match(page, /No email provider is configured/);
    assert.doesNotMatch(page, /Authorize hello/);
    const half = await start(google, { GOOGLE_OAUTH_CLIENT_SECRET: "" });
    assert.match((await half.get("/admin/outreach")).body, /GOOGLE_OAUTH_CLIENT_SECRET is missing/);
    assert.equal((await half.get("/admin/outreach/gmail/authorize")).statusCode, 400);
    assert.equal(google.calls.length, 0);
  });
});
