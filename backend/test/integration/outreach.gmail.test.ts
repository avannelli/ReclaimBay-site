import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { Db } from "../../src/db.js";
import { dispatchQueued } from "../../src/outreach/dispatch.js";
import { gmailSender } from "../../src/outreach/gmail.js";
import { pollGmailInbox } from "../../src/outreach/gmailInbox.js";
import { createOutreachDraft, queueOutreach } from "../../src/outreach/service.js";
import { addEvidence, createProspect } from "../../src/prospects.js";
import { MAILBOX, fakeGmail, inbound } from "../fixtures/fakeGmail.js";
import { freshDb, readyForm, skipReason, truncate } from "./helpers.js";
import { CFG, OPTS, switchOn } from "./outreachHelpers.js";

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

  test("a lost response is retried safely: Sent is checked first, so one email only", async () => {
    const { google, client } = fakeGmail();
    const sender = gmailSender(client);
    const { o } = await queued();
    await switchOn(db, sender);
    google.sendAnswers = ["network"];
    const first = await dispatchQueued(db, { config: CFG, sender });
    assert.equal(first.uncertain.length, 1);
    assert.equal(google.sent.length, 1, "it actually went out");
    const second = await dispatchQueued(db, { config: CFG, sender });
    assert.equal(second.sent.length, 1);
    assert.equal(google.sent.length, 1, "found in Sent, not sent again");
    const stored = await row(o.id);
    assert.equal(stored.providerMessageId, google.sent[0]!.id);
    assert.equal(stored.sendAttempts, 2);
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
});
