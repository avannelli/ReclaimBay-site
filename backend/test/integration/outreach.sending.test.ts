import { addFixtureCollisionEvidence } from "./helpers.js";
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import { confirmStuckSent, dailyCapacity, dispatchQueued, sendingSwitch, setSendingSwitch, stuckMessages } from "../../src/outreach/dispatch.js";
import { outreachMetrics } from "../../src/outreach/metrics.js";
import { prepareEligibleOutreach } from "../../src/outreach/prepare.js";
import { disabledSender } from "../../src/outreach/sender.js";
import {
  applyProviderEvent,
  classifyReply,
  createOutreachDraft,
  previewOutreachDraft,
  queueOutreach,
  recordInboundReply,
  recordReply,
  unsubscribeOutreach,
} from "../../src/outreach/service.js";
import { addEvidence, changeStatus, createProspect, updateProspect, formValuesOf } from "../../src/prospects.js";
import { TEST_DATABASE_URL, WEBSITE, freshDb, readyForm, skipReason, truncate } from "./helpers.js";
import { CFG, OPTS, mockSender, queueAndSend, switchOn } from "./outreachHelpers.js";

/*
 * Sending, provider events, suppression, and the global switch, through the
 * real service and dispatcher with a mock provider. No real email can be
 * sent: the codebase has no provider, and any network call fails the test.
 */

let seq = 0;
function forbidNetwork() {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    calls.push(String(url));
    throw new Error("network call during outreach");
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}

describe("outreach sending (service)", { skip: skipReason }, () => {
  let db: Db;
  let net: ReturnType<typeof forbidNetwork>;
  before(async () => {
    db = await freshDb();
  });
  beforeEach(async () => {
    await truncate(db);
    net = forbidNetwork();
  });
  afterEach(() => {
    net.restore();
    assert.deepEqual(net.calls, [], "no network call was made");
  });
  after(async () => db?.$disconnect());

  /** A qualified prospect with its own published email and evidence. */
  const prospect = async (over: Record<string, string> = {}) => {
    const n = ++seq;
    const site = `https://shop${n}.example.com`;
    const p = await createProspect(
      db,
      readyForm({ businessName: `Shop ${n} Auto`, website: site, phoneSourceUrl: `${site}/contact`, email: `service@shop${n}.example.com`, emailSourceUrl: `${site}/contact`, ...over }),
    );
    await addFixtureCollisionEvidence(db, p);
    await addEvidence(db, p.id, { signalKey: "independent_shop", sourceUrl: `${site}/about`, excerpt: "Family owned." });
    return p;
  };
  const draft = async (prospectId: string) => (await createOutreachDraft(db, prospectId, OPTS)).outreach;
  const status = async (id: string) => (await db.outreach.findUniqueOrThrow({ where: { id } })).status;
  const prospectStatus = async (id: string) => (await db.prospect.findUniqueOrThrow({ where: { id } })).status;
  const events = async (id: string) => (await db.outreachEvent.findMany({ where: { outreachId: id }, orderBy: { createdAt: "asc" } })).map((e) => e.type);

  test("a successful send hands the provider the reviewed message, persists its id, and moves the prospect", async () => {
    const p = await prospect();
    const o = await draft(p.id);
    const sender = mockSender();
    const report = await queueAndSend(db, o.id, sender);

    assert.equal(sender.calls.length, 1);
    const m = sender.calls[0]!;
    assert.equal(m.to, p.email);
    assert.deepEqual(m.from, { name: "Alex Rivera", email: "hello@reclaimbay.example" });
    assert.equal(m.replyTo, "hello@reclaimbay.example");
    assert.equal(m.subject, o.subject);
    assert.equal(m.text, o.body, "exactly the stored, reviewed text");
    assert.match(m.text, /1 Main St, Ventura, CA 93001/);
    assert.equal(m.idempotencyKey, `outreach-${o.id}`);
    assert.equal(m.headers["List-Unsubscribe"], `<https://api.reclaimbay.example/u/${o.unsubscribeToken}>, <mailto:hello@reclaimbay.example?subject=unsubscribe>`);
    assert.equal(m.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");

    assert.deepEqual(report.sent, [{ outreachId: o.id, providerMessageId: `msg-${o.id}` }]);
    const stored = await db.outreach.findUniqueOrThrow({ where: { id: o.id } });
    assert.equal(stored.status, "sent");
    assert.equal(stored.providerMessageId, `msg-${o.id}`);
    assert.equal(stored.provider, "mock");
    assert.equal(stored.sendAttempts, 1);
    assert.ok(stored.sentAt && stored.sendStartedAt);
    assert.deepEqual(await events(o.id), ["drafted", "queued", "sent"]);
    assert.equal(await prospectStatus(p.id), "contacted");
  });

  test("a provider rejection becomes a failed message; an invalid recipient is suppressed", async () => {
    const p = await prospect();
    const o = await draft(p.id);
    const sender = mockSender(() => ({ status: "rejected", reason: "422 invalid recipient", invalidRecipient: true }));
    const report = await queueAndSend(db, o.id, sender);
    assert.deepEqual(report.failed, [{ outreachId: o.id, reason: "422 invalid recipient" }]);
    const stored = await db.outreach.findUniqueOrThrow({ where: { id: o.id } });
    assert.equal(stored.status, "failed");
    assert.equal(stored.failureReason, "422 invalid recipient");
    assert.equal(stored.sentAt, null);
    assert.deepEqual(await events(o.id), ["drafted", "queued", "failed"]);
    assert.equal(await prospectStatus(p.id), "ready_to_contact", "nothing was sent, so the prospect wasn't contacted");
    assert.equal((await db.emailSuppression.findUniqueOrThrow({ where: { email: p.email! } })).reason, "invalid");
    await assert.rejects(createOutreachDraft(db, p.id, OPTS), /suppressed \(invalid\)/);
  });

  test("one message is never sent twice: repeated and concurrent dispatchers", async () => {
    const p = await prospect();
    const o = await draft(p.id);
    const sender = mockSender();
    await queueOutreach(db, o.id, CFG);
    await switchOn(db, sender);
    await Promise.all([1, 2, 3].map(() => dispatchQueued(db, { config: CFG, sender })));
    await dispatchQueued(db, { config: CFG, sender });
    assert.equal(sender.calls.length, 1);
    assert.equal((await db.outreachEvent.count({ where: { outreachId: o.id, type: "sent" } })), 1);
    // Queueing again is a no-op on a sent message.
    await assert.rejects(queueOutreach(db, o.id, CFG), /from Sent to Queued/);
  });

  test("an unknown outcome is never sent again automatically, whatever the provider promises: it waits for a person", async () => {
    const p = await prospect();
    const o = await draft(p.id);
    // A provider that honours idempotency keys, and would accept a second attempt.
    const sender = mockSender((m, call) => (call === 1 ? { status: "uncertain", reason: "timeout" } : { status: "accepted", providerMessageId: `msg-${m.outreachId}` }));
    assert.equal(sender.supportsIdempotency, true);
    const first = await queueAndSend(db, o.id, sender);
    assert.equal(first.uncertain.length, 1);
    // Later runs, one after another and several at once, never send it again.
    await dispatchQueued(db, { config: CFG, sender });
    await Promise.all([1, 2, 3].map(() => dispatchQueued(db, { config: CFG, sender })));
    assert.equal(sender.calls.length, 1, "one provider call, ever");
    const stored = await db.outreach.findUniqueOrThrow({ where: { id: o.id } });
    assert.deepEqual([stored.status, stored.sendAttempts, stored.lastSendError], ["queued", 1, "timeout"]);
    // A person's straight away: listed with no waiting period.
    assert.deepEqual((await stuckMessages(db)).map((s) => s.id), [o.id]);
    // They check the provider and record it; nothing sends it after that either.
    await confirmStuckSent(db, o.id, sender.name);
    assert.equal(await status(o.id), "sent");
    await dispatchQueued(db, { config: CFG, sender });
    assert.equal(sender.calls.length, 1);
    assert.deepEqual(await stuckMessages(db), []);
  });

  test("the dispatcher takes only messages whose send never started", async () => {
    const make = async () => draft((await prospect()).id);
    // Sent, refused, and an unknown outcome, each through the dispatcher.
    const sent = await make();
    await queueAndSend(db, sent.id);
    const refused = await make();
    await queueAndSend(db, refused.id, mockSender(() => ({ status: "rejected", reason: "550 policy", invalidRecipient: false })));
    const unknown = await make();
    await queueAndSend(db, unknown.id, mockSender(() => ({ status: "uncertain", reason: "timeout" })));
    // Interrupted: claimed by a dispatcher that died before the provider answered.
    const interrupted = await make();
    await queueOutreach(db, interrupted.id, CFG);
    await db.outreach.update({ where: { id: interrupted.id }, data: { sendStartedAt: new Date(Date.now() - 11 * 60_000), sendAttempts: 1 } });
    // Never started.
    const fresh = await make();
    await queueOutreach(db, fresh.id, CFG);

    const sender = mockSender();
    await switchOn(db, sender);
    assert.deepEqual((await dispatchQueued(db, { config: CFG, sender, dryRun: true })).wouldSend, [fresh.id]);
    const report = await dispatchQueued(db, { config: CFG, sender });
    assert.deepEqual(sender.calls.map((c) => c.outreachId), [fresh.id]);
    assert.deepEqual(report.sent.map((s) => s.outreachId), [fresh.id]);
    assert.deepEqual(
      [await status(sent.id), await status(refused.id), await status(unknown.id), await status(interrupted.id), await status(fresh.id)],
      ["sent", "failed", "queued", "queued", "sent"],
    );
    assert.deepEqual(new Set((await stuckMessages(db)).map((s) => s.id)), new Set([unknown.id, interrupted.id]), "the two that may have gone out wait for a person");
  });

  test("with a provider that can't deduplicate, an uncertain send waits for a person", async () => {
    const p = await prospect();
    const o = await draft(p.id);
    const sender = mockSender(() => ({ status: "uncertain", reason: "connection reset" }), false);
    await queueAndSend(db, o.id, sender);
    await dispatchQueued(db, { config: CFG, sender });
    assert.equal(sender.calls.length, 1, "not retried");
    const stuck = await stuckMessages(db);
    assert.deepEqual(stuck.map((s) => s.id), [o.id]);
    // A person checks the provider and confirms it went out.
    await confirmStuckSent(db, o.id, sender.name);
    assert.equal(await status(o.id), "sent");
    assert.equal(await prospectStatus(p.id), "contacted");
  });

  test("a provider throwing is treated as uncertain, never as a failure that could be redrafted", async () => {
    const p = await prospect();
    const o = await draft(p.id);
    const sender = mockSender(() => {
      throw new Error("socket hang up");
    });
    const report = await queueAndSend(db, o.id, sender);
    assert.match(report.uncertain[0]!.reason, /socket hang up/);
    assert.equal(await status(o.id), "queued");
    const again = await createOutreachDraft(db, p.id, OPTS);
    assert.equal(again.created, false, "the possibly-sent message stays the open one; no second message");
    assert.equal(again.outreach.id, o.id);
  });

  test("provider events are idempotent, tolerate order, and ignore what doesn't fit", async () => {
    const p = await prospect();
    const o = await draft(p.id);
    await queueOutreach(db, o.id, CFG);
    // The provider's "sent" webhook beats the dispatcher's own record.
    const early = await applyProviderEvent(db, { provider: "mock", type: "sent", outreachId: o.id, providerMessageId: "pm-1", providerEventId: "evt-1" });
    assert.equal(early.result, "recorded");
    assert.equal((await db.outreach.findUniqueOrThrow({ where: { id: o.id } })).providerMessageId, "pm-1");
    assert.equal(await prospectStatus(p.id), "contacted");

    const twice = await Promise.all([1, 2].map(() => applyProviderEvent(db, { provider: "mock", type: "delivered", providerMessageId: "pm-1", providerEventId: "evt-2" })));
    assert.deepEqual(twice.map((r) => r.result).sort(), ["duplicate", "recorded"]);
    assert.equal((await applyProviderEvent(db, { provider: "mock", type: "delivered", providerMessageId: "pm-1", providerEventId: "evt-2" })).result, "duplicate");
    assert.equal((await applyProviderEvent(db, { provider: "mock", type: "delivered", providerMessageId: "pm-1" })).result, "duplicate");
    assert.equal((await applyProviderEvent(db, { provider: "mock", type: "bounced", providerMessageId: "pm-1", permanent: false })).result, "ignored", "a soft bounce changes nothing");
    assert.equal((await applyProviderEvent(db, { provider: "mock", type: "delivered", providerMessageId: "nope" })).result, "unknown_message");
    assert.equal((await applyProviderEvent(db, { provider: "mock", type: "delivered", outreachId: "not-a-uuid" })).result, "unknown_message");

    await recordReply(db, o.id, { outcome: "interested" });
    assert.equal((await applyProviderEvent(db, { provider: "mock", type: "bounced", providerMessageId: "pm-1" })).result, "ignored", "a late bounce can't undo a reply");
    assert.deepEqual(await events(o.id), ["drafted", "queued", "sent", "delivered", "replied"]);
    assert.equal(await db.outreachEvent.count({ where: { providerEventId: { not: null } } }), 2);
  });

  test("concurrent reports about one message are applied one at a time, and none of them throws", async () => {
    const p = await prospect();
    const o = await draft(p.id);
    await queueAndSend(db, o.id);
    const pm = `msg-${o.id}`;
    const reports = [
      { provider: "mock", type: "delivered" as const, providerMessageId: pm, providerEventId: "d-1" },
      { provider: "mock", type: "delivered" as const, providerMessageId: pm, providerEventId: "d-1" },
      { provider: "mock", type: "bounced" as const, providerMessageId: pm, providerEventId: "b-1", reason: "550 no such user" },
      { provider: "mock", type: "complained" as const, providerMessageId: pm, providerEventId: "c-1" },
      { provider: "mock", type: "complained" as const, providerMessageId: pm, providerEventId: "c-2" },
    ];
    const results = await Promise.all(reports.map((r) => applyProviderEvent(db, r)));
    assert.ok(results.every((r) => r.outreachId === o.id));
    // Delivered then bounced, or bounced first and the late delivery ignored: bounced either way.
    assert.equal(await status(o.id), "bounced");
    assert.equal(await db.outreachEvent.count({ where: { providerEventId: "d-1" } }), 1);
    assert.equal(await db.outreachEvent.count({ where: { outreachId: o.id, type: "complained" } }), 1, "two complaint notifications, one complaint");
    assert.equal(await db.outreachEvent.count({ where: { outreachId: o.id, type: "bounced" } }), 1);
    assert.ok(await db.emailSuppression.findUnique({ where: { email: p.email! } }));
    assert.equal(await prospectStatus(p.id), "do_not_contact");
    await assert.rejects(createOutreachDraft(db, p.id, OPTS), /never be contacted/, "nothing in those reports makes the business eligible again");
  });

  test("the dispatcher's own record and the provider's sent report racing: the send is recorded once", async () => {
    const p = await prospect();
    const o = await draft(p.id);
    let webhook: Promise<unknown> = Promise.resolve();
    const sender = mockSender((m) => {
      // The provider's notification arrives while the dispatcher records the same send.
      webhook = applyProviderEvent(db, { provider: "mock", type: "sent", outreachId: m.outreachId, providerMessageId: `msg-${m.outreachId}`, providerEventId: "s-1" });
      return { status: "accepted", providerMessageId: `msg-${m.outreachId}` };
    });
    const report = await queueAndSend(db, o.id, sender);
    const fromWebhook = (await webhook) as { result: string };
    assert.equal(report.sent.length, 1);
    assert.ok(["recorded", "duplicate"].includes(fromWebhook.result));
    assert.equal(sender.calls.length, 1);
    assert.equal(await db.outreachEvent.count({ where: { outreachId: o.id, type: "sent" } }), 1);
    const stored = await db.outreach.findUniqueOrThrow({ where: { id: o.id } });
    assert.equal(stored.status, "sent");
    assert.equal(stored.providerMessageId, `msg-${o.id}`);
    assert.equal(await prospectStatus(p.id), "contacted");
  });

  test("copies of one reply arriving together are recorded once; a reply and a bounce together, one wins", async () => {
    const p = await prospect();
    const o = await draft(p.id);
    await queueAndSend(db, o.id);
    const copies = await Promise.all([1, 2, 3].map(() => recordInboundReply(db, { fromEmail: p.email!, inReplyToProviderMessageId: `msg-${o.id}`, summary: "Interested" })));
    assert.deepEqual(copies.map((r) => r.result).sort(), ["duplicate", "duplicate", "recorded"]);
    assert.equal(await db.outreachEvent.count({ where: { outreachId: o.id, type: "replied" } }), 1);
    assert.equal(await prospectStatus(p.id), "engaged");

    const q = await prospect();
    const m = await draft(q.id);
    await queueAndSend(db, m.id);
    const [reply, bounce] = await Promise.all([
      recordInboundReply(db, { fromEmail: q.email!, inReplyToProviderMessageId: `msg-${m.id}` }),
      applyProviderEvent(db, { provider: "mock", type: "bounced", providerMessageId: `msg-${m.id}`, providerEventId: "b-race" }),
    ]);
    assert.deepEqual([reply.result, bounce.result].sort(), ["ignored", "recorded"]);
    assert.ok(["replied", "bounced"].includes(await status(m.id)));
  });

  test("an opt-out arriving twice at once is logged once, and the address stays suppressed", async () => {
    const p = await prospect();
    const o = await draft(p.id);
    await queueAndSend(db, o.id);
    const r = await Promise.all([1, 2].map(() => unsubscribeOutreach(db, o.id, "with the link in an outreach email")));
    assert.deepEqual(r.map((x) => x.result).sort(), ["duplicate", "recorded"]);
    assert.equal(await db.outreachEvent.count({ where: { outreachId: o.id, type: "unsubscribed" } }), 1);
    assert.equal((await db.emailSuppression.findUniqueOrThrow({ where: { email: p.email! } })).reason, "unsubscribed");
    assert.equal(await prospectStatus(p.id), "do_not_contact");
  });

  test("a claimed send survives a restart: a new dispatcher never sends it again", async () => {
    const p = await prospect();
    const o = await draft(p.id);
    await queueOutreach(db, o.id, CFG);
    // A dispatcher claimed it and the process died before the provider answered.
    const claimedAt = new Date(Date.now() - 11 * 60 * 1000);
    await db.outreach.update({ where: { id: o.id }, data: { sendStartedAt: claimedAt, sendAttempts: 1 } });
    const fresh = mockSender();
    await switchOn(db, fresh);
    const report = await dispatchQueued(db, { config: CFG, sender: fresh });
    assert.equal(fresh.calls.length, 0, "the claim is in the database, not in a process");
    assert.deepEqual(report.sent, []);
    assert.equal(await status(o.id), "queued");
    assert.deepEqual((await stuckMessages(db)).map((s) => s.id), [o.id], "listed for a person instead");
    const cap = await dailyCapacity(db, CFG, new Date());
    assert.equal(cap.used, 1, "it counts against the daily limit once");
  });

  test("preparing, queueing, and sending give the same reason for the same problem", async () => {
    // The problem: a required criterion is no longer confirmed. Qualified and Ready to
    // contact require "Meets criteria", so (as a person would) the prospect is first moved
    // back to New, the one status that allows an unconfirmed criterion, and then edited.
    const unconfirm = async (id: string) => {
      const current = await db.prospect.findUniqueOrThrow({ where: { id }, include: { signals: true } });
      for (const s of current.status === "ready_to_contact" ? ["qualified", "new"] : current.status === "qualified" ? ["new"] : []) await changeStatus(db, id, s, null);
      await updateProspect(db, id, { ...formValuesOf(current), signal_collision_repair_services: "unknown" });
      assert.equal((await db.prospect.findUniqueOrThrow({ where: { id } })).status, "new");
    };
    const reason = /Outreach requires Qualification "Meets criteria"; this prospect is Unverified/;

    // Sending: queued while qualified, unconfirmed afterwards.
    const p = await prospect();
    const o = await draft(p.id);
    await queueOutreach(db, o.id, CFG);
    await unconfirm(p.id);
    assert.equal(await status(o.id), "queued", "moving back to New doesn't close outreach, so the send step must catch it");
    const sender = mockSender();
    await switchOn(db, sender);
    const report = await dispatchQueued(db, { config: CFG, sender });
    assert.equal(sender.calls.length, 0);
    assert.match(report.cancelled[0]!.reasons.join(" "), reason);
    assert.equal(await status(o.id), "cancelled");

    // Preparing: the same prospect can't get a new draft, for the same reason.
    assert.match((await previewOutreachDraft(db, p.id, OPTS)).errors.join(" "), reason);
    await assert.rejects(createOutreachDraft(db, p.id, OPTS), reason);

    // Queueing: a draft made while qualified can't be queued once unconfirmed, for the same reason.
    const q = await prospect();
    const m = await draft(q.id);
    await unconfirm(q.id);
    await assert.rejects(queueOutreach(db, m.id, CFG), reason);
    assert.equal(await status(m.id), "draft");
  });

  test("a bounce suppresses the address and cancels any queued message to it, on any prospect", async () => {
    const shared = "front@sharedinbox.example.com";
    const a = await prospect({ email: shared });
    const b = await prospect({ email: shared });
    const oa = await draft(a.id);
    const ob = await draft(b.id);
    await queueOutreach(db, ob.id, CFG);
    const sender = mockSender();
    await queueOutreach(db, oa.id, CFG);
    await switchOn(db, sender);
    await dispatchQueued(db, { config: CFG, sender, limit: 1 });
    const firstSent = sender.calls[0]!.outreachId;
    const other = firstSent === oa.id ? ob.id : oa.id;
    await applyProviderEvent(db, { provider: "mock", type: "bounced", providerMessageId: `msg-${firstSent}`, reason: "550 no such user" });
    assert.equal(await status(firstSent), "bounced");
    assert.equal((await db.emailSuppression.findUniqueOrThrow({ where: { email: shared } })).reason, "bounced");
    assert.equal(await status(other), "cancelled", "cancelled the moment the address was suppressed");
    await dispatchQueued(db, { config: CFG, sender });
    assert.equal(sender.calls.length, 1);
  });

  test("Do not contact, a complaint, or an opt-out reply stops everything for that business", async () => {
    // Do not contact after queueing: cancelled at once, never sent.
    const p = await prospect();
    const o = await draft(p.id);
    await queueOutreach(db, o.id, CFG);
    await changeStatus(db, p.id, "do_not_contact", "Asked by phone.");
    assert.equal(await status(o.id), "cancelled");
    const sender = mockSender();
    await switchOn(db, sender);
    await dispatchQueued(db, { config: CFG, sender });
    assert.equal(sender.calls.length, 0);

    // A spam complaint.
    const q = await prospect();
    const m = await draft(q.id);
    await queueAndSend(db, m.id, sender);
    assert.equal((await applyProviderEvent(db, { provider: "mock", type: "complained", providerMessageId: `msg-${m.id}`, providerEventId: "c-1" })).result, "recorded");
    assert.equal(await prospectStatus(q.id), "do_not_contact");
    assert.equal((await db.emailSuppression.findUniqueOrThrow({ where: { email: q.email! } })).reason, "complained");
    assert.ok((await events(m.id)).includes("complained"));
    assert.equal((await applyProviderEvent(db, { provider: "mock", type: "complained", providerMessageId: `msg-${m.id}` })).result, "duplicate");

    // An opt-out reply.
    const r = await prospect();
    const n = await draft(r.id);
    await queueAndSend(db, n.id, sender);
    await recordReply(db, n.id, { outcome: "do_not_contact" });
    assert.equal(await prospectStatus(r.id), "do_not_contact");
    assert.equal((await db.emailSuppression.findUniqueOrThrow({ where: { email: r.email! } })).reason, "unsubscribed");
  });

  test("a change after queueing is caught right before sending: the message is cancelled, not sent", async () => {
    const p = await prospect();
    const o = await draft(p.id);
    await queueOutreach(db, o.id, CFG);
    const current = await db.prospect.findUniqueOrThrow({ where: { id: p.id }, include: { signals: true } });
    // Move it back so the email can be edited, as a person would, then change the address.
    await changeStatus(db, p.id, "qualified", null);
    await updateProspect(db, p.id, { ...formValuesOf(current), email: "new@shopnew.example.com" });
    const sender = mockSender();
    await switchOn(db, sender);
    const report = await dispatchQueued(db, { config: CFG, sender });
    assert.equal(sender.calls.length, 0);
    assert.equal(report.cancelled.length, 1);
    assert.match(report.cancelled[0]!.reasons.join(" "), /email changed/);
    assert.equal(await status(o.id), "cancelled");
  });

  test("the global switch: off by default, needs everything ready to switch on, and stops a batch immediately", async () => {
    const p1 = await prospect();
    const p2 = await prospect();
    const o1 = await draft(p1.id);
    const o2 = await draft(p2.id);
    await queueOutreach(db, o1.id, CFG);
    await queueOutreach(db, o2.id, CFG);

    let sender = mockSender();
    assert.equal((await sendingSwitch(db)).enabled, false);
    const off = await dispatchQueued(db, { config: CFG, sender });
    assert.ok(off.blockers.includes("The global sending switch is off."));
    assert.equal(sender.calls.length, 0);

    await assert.rejects(setSendingSwitch(db, true, "go", CFG, disabledSender), /No email provider is configured/);
    await assert.rejects(setSendingSwitch(db, true, "go", { ...CFG, outreachSendingArmed: false }, sender), /OUTREACH_SENDING_ENABLED/);
    await assert.rejects(setSendingSwitch(db, true, "go", { ...CFG, outreachSender: { ...CFG.outreachSender, postalAddress: null } }, sender), /postal address/);
    await assert.rejects(setSendingSwitch(db, true, "", CFG, sender), /needs a reason/);

    // Switched off by someone while the first message is being sent: the second is not sent.
    sender = mockSender(async (m) => {
      await setSendingSwitch(db, false, "Stop!", CFG, sender);
      return { status: "accepted", providerMessageId: `msg-${m.outreachId}` };
    });
    await switchOn(db, sender);
    const report = await dispatchQueued(db, { config: CFG, sender });
    assert.equal(sender.calls.length, 1);
    assert.equal(report.sent.length, 1);
    assert.match(report.stoppedBecause!, /switch is off/);

    // Disarmed by the deployment: nothing goes even with the switch on.
    await switchOn(db, sender);
    const disarmed = await dispatchQueued(db, { config: { ...CFG, outreachSendingArmed: false }, sender });
    assert.ok(disarmed.blockers.some((b) => /OUTREACH_SENDING_ENABLED/.test(b)));
    assert.equal(sender.calls.length, 1);
    // And with the real (disabled) sender, nothing can be sent at all.
    const real = await dispatchQueued(db, { config: CFG, sender: disabledSender });
    assert.ok(real.blockers.includes("No email provider is configured."));
    const history = await db.outreachControlChange.findMany({ orderBy: { createdAt: "asc" } });
    assert.deepEqual(history.map((h) => h.sendingEnabled), [true, false, true]);
  });

  test("a message drafted without a postal address or for another sender can't be queued", async () => {
    const p = await prospect();
    const { outreach } = await createOutreachDraft(db, p.id, { siteUrl: OPTS.siteUrl, sender: { name: null, email: null, postalAddress: null } });
    await assert.rejects(queueOutreach(db, outreach.id, CFG), /postal address/);
    await assert.rejects(queueOutreach(db, outreach.id, CFG), /different sender/);
    assert.equal(await status(outreach.id), "draft");
    assert.equal(await prospectStatus(p.id), "new", "a refused queue changes nothing");
  });

  test("replies: inbound mail is matched and recorded unclassified, then classified once", async () => {
    const p = await prospect();
    const o = await draft(p.id);
    await queueAndSend(db, o.id);
    assert.equal((await recordInboundReply(db, { fromEmail: "stranger@example.com" })).result, "unmatched");
    assert.equal((await recordInboundReply(db, { fromEmail: p.email!.toUpperCase(), summary: "Tell me more" })).result, "recorded");
    assert.equal((await recordInboundReply(db, { fromEmail: p.email! })).result, "duplicate");
    const replied = await db.outreach.findUniqueOrThrow({ where: { id: o.id } });
    assert.equal(replied.status, "replied");
    assert.equal(replied.replyOutcome, null);
    assert.equal(await prospectStatus(p.id), "engaged");
    await classifyReply(db, o.id, "not_interested");
    assert.equal(await prospectStatus(p.id), "lost");
    await assert.rejects(classifyReply(db, o.id, "interested"), /already classified/);
  });

  test("automatic preparation drafts every eligible prospect once, and skips the rest with reasons", async () => {
    const good1 = await prospect();
    const good2 = await prospect();
    const unverified = await prospect({ signal_collision_repair_services: "unknown" });
    const noEmail = await createProspect(db, readyForm({ businessName: "Phone Only Auto" }));
    const dnc = await prospect();
    await changeStatus(db, dnc.id, "do_not_contact", "Asked.");
    const already = await prospect();
    await draft(already.id);

    const dry = await prepareEligibleOutreach(db, { draft: OPTS, compliance: CFG, apply: false });
    assert.equal(dry.drafted.length, 2);
    assert.equal(await db.outreach.count(), 1, "a dry run stores nothing");

    const r = await prepareEligibleOutreach(db, { draft: OPTS, compliance: CFG, apply: true, queue: true });
    assert.deepEqual(new Set(r.drafted.map((d) => d.prospectId)), new Set([good1.id, good2.id]));
    assert.equal(r.queued.length, 2);
    assert.ok(r.skipped.some((s) => s.prospectId === unverified.id && /Unverified/.test(s.reasons.join(" "))));
    assert.ok(!r.skipped.some((s) => s.prospectId === noEmail.id || s.prospectId === dnc.id || s.prospectId === already.id), "never even considered");
    assert.equal(await prospectStatus(good1.id), "ready_to_contact");

    const again = await prepareEligibleOutreach(db, { draft: OPTS, compliance: CFG, apply: true, queue: true });
    assert.equal(again.drafted.length, 0);
    assert.equal(await db.outreach.count(), 3);
  });

  test("the funnel is computed from the raw records, by campaign", async () => {
    const sender = mockSender();
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const p = await prospect();
      const o = await draft(p.id);
      await queueAndSend(db, o.id, sender);
      ids.push({ p, o });
    }
    const [a, b, c, d] = ids;
    await applyProviderEvent(db, { provider: "mock", type: "delivered", providerMessageId: `msg-${a!.o.id}` });
    await applyProviderEvent(db, { provider: "mock", type: "bounced", providerMessageId: `msg-${b!.o.id}` });
    await recordReply(db, a!.o.id, { outcome: "interested" });
    await recordReply(db, c!.o.id, { outcome: "not_interested" });
    for (const s of ["meeting", "proposal", "customer"]) await changeStatus(db, a!.p.id, s, null);
    void d;
    // Prepared but never queued: drafted, not queued.
    await draft((await prospect()).id);
    const rows = await outreachMetrics(db);
    const t = rows.find((r) => r.campaign === "outreach-intro-t4")!;
    // Stage 5C definitions (outreach.measurement.test.ts covers each one): b bounced, so it was emailed but not reached.
    assert.deepEqual(
      { everDrafted: t.everDrafted, everQueued: t.everQueued, emailed: t.prospectsEmailed, reached: t.prospectsReached, sent: t.sent, bounced: t.bounced, replied: t.replied, positive: t.positive, negative: t.negative, meetings: t.meetings, proposals: t.proposals, customers: t.customers, lost: t.lost },
      { everDrafted: 5, everQueued: 4, emailed: 4, reached: 3, sent: 4, bounced: 1, replied: 2, positive: 1, negative: 1, meetings: 1, proposals: 1, customers: 1, lost: 1 },
    );
    assert.equal(rows.find((r) => r.campaign === "all")!.sent, 4);
  });
});

describe("outreach sending (HTTP)", { skip: skipReason }, () => {
  const SECRET = "integration-test-secret-0123456789";
  const FORM = { "content-type": "application/x-www-form-urlencoded" };
  let db: Db;
  let app: FastifyInstance;
  let cookie = "";
  before(async () => {
    db = await freshDb();
    // The app as deployed today: the real (disabled) sender.
    app = await buildApp(loadConfig({ DATABASE_URL: TEST_DATABASE_URL, ALLOWED_ORIGIN: "https://reclaimbay.com", ADMIN_SECRET: SECRET, TRUST_PROXY_HOPS: "0" }), db, false);
    const login = await app.inject({ method: "POST", url: "/admin/login", headers: FORM, payload: new URLSearchParams({ secret: SECRET }).toString() });
    cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  });
  beforeEach(async () => truncate(db));
  after(async () => {
    await app?.close();
    await db?.$disconnect();
  });
  const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });
  const post = (url: string, body: Record<string, string> = {}, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url, headers: { ...FORM, cookie, ...headers }, payload: new URLSearchParams(body).toString() });

  const sentMessage = async () => {
    const p = await createProspect(db, readyForm({ email: "service@smithauto.example.com", emailSourceUrl: `${WEBSITE}/contact` }));
    await addFixtureCollisionEvidence(db, p);
    const { outreach } = await createOutreachDraft(db, p.id, OPTS);
    await queueAndSend(db, outreach.id);
    return { p, o: (await db.outreach.findUniqueOrThrow({ where: { id: outreach.id } }))! };
  };

  test("one-click unsubscribe: GET only asks, POST unsubscribes, repeating is harmless, tokens can't be probed", async () => {
    const { p, o } = await sentMessage();
    const page = await app.inject({ method: "GET", url: `/u/${o.unsubscribeToken}` });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /<form method="post">/);
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: p.id } })).status, "contacted", "a GET (or a mail scanner) changes nothing");

    const oneClick = await app.inject({ method: "POST", url: `/u/${o.unsubscribeToken}`, headers: FORM, payload: "List-Unsubscribe=One-Click" });
    assert.equal(oneClick.statusCode, 200);
    assert.match(oneClick.body, /You're unsubscribed/);
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: p.id } })).status, "do_not_contact");
    assert.equal((await db.emailSuppression.findUniqueOrThrow({ where: { email: p.email! } })).reason, "unsubscribed");

    const again = await app.inject({ method: "POST", url: `/u/${o.unsubscribeToken}`, headers: FORM, payload: "List-Unsubscribe=One-Click" });
    assert.equal(again.body, oneClick.body);
    assert.equal(await db.outreachEvent.count({ where: { outreachId: o.id, type: "unsubscribed" } }), 1);
    const unknown = await app.inject({ method: "POST", url: "/u/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", headers: FORM, payload: "List-Unsubscribe=One-Click" });
    assert.equal(unknown.body, oneClick.body, "same answer for an unknown token");
    assert.equal(unknown.headers["cache-control"], "no-store");
  });

  test("the admin control page shows the switch blocked by the missing provider and can't switch it on", async () => {
    const page = (await get("/admin/outreach")).body;
    assert.match(page, /Sending is OFF/);
    assert.match(page, /No email provider is configured/);
    assert.match(page, /OUTREACH_SENDING_ENABLED/);
    assert.doesNotMatch(page, /Switch sending on<\/button>/);
    const on = await post("/admin/outreach/switch", { enabled: "1", reason: "try" });
    assert.equal(on.statusCode, 400);
    assert.equal(await db.outreachControlChange.count(), 0);
    const off = await post("/admin/outreach/switch", { enabled: "0" });
    assert.equal(off.statusCode, 303);
    assert.equal((await db.outreachControlChange.findFirstOrThrow()).sendingEnabled, false);
  });

  test("the control page answers at a glance: on or off, what's waiting, today's limit, and what needs a person", async () => {
    // A reply nobody has classified, and a message the provider refused for a business whose name needs escaping.
    const { o } = await sentMessage();
    await recordInboundReply(db, { fromEmail: o.recipientEmail, inReplyToProviderMessageId: o.providerMessageId });
    const site = "https://sons.example.com";
    const p2 = await createProspect(db, readyForm({ businessName: "Smith & <Sons> Auto", website: site, phoneSourceUrl: `${site}/contact`, email: "shop@sons.example.com", emailSourceUrl: `${site}/contact` }));
    await addFixtureCollisionEvidence(db, p2);
    const { outreach: refused } = await createOutreachDraft(db, p2.id, OPTS);
    await queueAndSend(db, refused.id, mockSender(() => ({ status: "rejected", reason: "552 <message> too large" })));
    await db.outreachControlChange.create({ data: { sendingEnabled: false, reason: "Switched off.", createdAt: new Date(Date.now() + 1_000) } });

    const page = (await get("/admin/outreach")).body;
    assert.match(page, /<section class="o-status t-quiet" aria-labelledby="sending-h">/);
    assert.match(page, /<h2 id="sending-h" class="o-status-l"><span aria-hidden="true">○<\/span> Sending is OFF<\/h2>/);
    assert.match(page, /Sending can't be switched on until:[\s\S]*No email provider is configured\./);
    assert.match(page, /<section class="q-tiles" aria-label="Outreach at a glance">/);
    // The refused business can get a new message (nothing reached it); two sends started count against the limit.
    assert.match(page, /<span class="q-tile-n">1<\/span><span class="q-tile-l"><span aria-hidden="true">✓<\/span> Eligible now<\/span>/);
    assert.match(page, /<span class="q-tile-n">2 \/ 20<\/span><span class="q-tile-l"><span aria-hidden="true">✉<\/span> Send attempts, last 24 hours<\/span><span class="q-tile-h">started, whether or not the provider sent them · 18 left under the daily limit<\/span>/);
    assert.match(page, /Last message sent: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);

    assert.match(page, /<h2 id="attention-h">Needs attention<\/h2>/);
    assert.match(page, new RegExp(`Replies to classify <span class="q-count">1</span>[\\s\\S]*?href="/admin/outreach/${o.id}"`));
    assert.match(page, new RegExp(`Refused by the provider, last 7 days <span class="q-count">1</span>[\\s\\S]*?href="/admin/outreach/${refused.id}">A quick question about Smith &#38; &#60;Sons&#62; Auto</a>`));
    assert.match(page, /552 &#60;message&#62; too large/);
    assert.doesNotMatch(page, /<Sons>|<message>/, "provider text and business names are escaped");
    assert.match(page, /<details class="disc" id="funnel"><summary><h2>Funnel by campaign<\/h2>/, "measurement stays one click away");
    assert.match(page, /<th scope="col" class="num">Ever queued<\/th>/);

    // Switched on earlier, and the provider is gone since: the page says nothing can be sent, and offers only Stop.
    await db.outreachControlChange.create({ data: { sendingEnabled: true, reason: "Launch.", createdAt: new Date(Date.now() + 2_000) } });
    const blocked = (await get("/admin/outreach")).body;
    assert.match(blocked, /<section class="o-status t-neg"/);
    assert.match(blocked, /<span aria-hidden="true">✕<\/span> Sending is ON, but blocked<\/h2>\s*<p class="o-status-d">Nothing can be sent: /);
    assert.match(blocked, />Stop all sending now<\/button>/);
    assert.doesNotMatch(blocked, /Switch sending on<\/button>/);
  });

  test("the admin prepares drafts for the eligible prospects chosen, and repeating drafts nothing new", async () => {
    const p = await createProspect(db, readyForm({ email: "service@smithauto.example.com", emailSourceUrl: `${WEBSITE}/contact` }));
    await addFixtureCollisionEvidence(db, p);
    assert.match((await get("/admin/outreach")).body, /<b>1 prospect is eligible<\/b> for a first message now/);
    const res = await post("/admin/outreach/prepare", { [`p:${p.id}`]: "1" });
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, "/admin/outreach/messages?view=eligible&done=prepared&prepared=1&existing=0&ineligible=0&refused=0&failed=0");
    assert.equal(await db.outreach.count(), 1);
    await post("/admin/outreach/prepare", { [`p:${p.id}`]: "1" });
    assert.equal(await db.outreach.count(), 1, "repeating drafts nothing new");
  });

  test("a stuck send can be confirmed from the admin, and no admin route sends", async () => {
    const p = await createProspect(db, readyForm({ email: "service@smithauto.example.com", emailSourceUrl: `${WEBSITE}/contact` }));
    await addFixtureCollisionEvidence(db, p);
    const { outreach } = await createOutreachDraft(db, p.id, OPTS);
    await queueAndSend(db, outreach.id, mockSender(() => ({ status: "uncertain", reason: "timeout" }), false));
    const view = (await get(`/admin/outreach/${outreach.id}`)).body;
    assert.match(view, /outcome unknown/);
    assert.match(view, new RegExp(`/admin/outreach/${outreach.id}/confirm-sent`));
    assert.equal((await post(`/admin/outreach/${outreach.id}/confirm-sent`)).statusCode, 303);
    assert.equal((await db.outreach.findUniqueOrThrow({ where: { id: outreach.id } })).status, "sent");
    const repeat = await post(`/admin/outreach/${outreach.id}/confirm-sent`);
    assert.equal(repeat.statusCode, 303);
    assert.equal(repeat.headers.location, `/admin/outreach/${outreach.id}?done=already_sent`);
    assert.match((await get(String(repeat.headers.location))).body, /already has a recorded send outcome\. Nothing changed/);
    assert.equal(await db.outreachEvent.count({ where: { outreachId: outreach.id, type: "sent" } }), 1);
    assert.equal((await post(`/admin/outreach/${outreach.id}/send`)).statusCode, 404);
    assert.equal((await post("/admin/outreach/dispatch")).statusCode, 404);
  });

  test("the admin hides confirmation for a pending claim and refuses a direct POST, even after ten minutes", async () => {
    const p = await createProspect(db, readyForm({ email: "service@smithauto.example.com", emailSourceUrl: `${WEBSITE}/contact` }));
    await addFixtureCollisionEvidence(db, p);
    const { outreach } = await createOutreachDraft(db, p.id, OPTS);
    await queueOutreach(db, outreach.id, CFG);
    let answer!: () => void;
    let reached!: () => void;
    const atProvider = new Promise<void>((r) => { reached = r; });
    const release = new Promise<void>((r) => { answer = r; });
    const sender = mockSender(async (m) => {
      reached();
      await release;
      return { status: "accepted", providerMessageId: `msg-${m.outreachId}` };
    });
    await switchOn(db, sender);
    let clockCalls = 0;
    const run = dispatchQueued(db, { config: CFG, sender, now: () => new Date(Date.now() - (++clockCalls === 1 ? 11 * 60_000 : 0)) });
    await atProvider;
    const claimed = await db.outreach.findUniqueOrThrow({ where: { id: outreach.id } });
    try {
      const page = (await get(`/admin/outreach/${outreach.id}`)).body;
      assert.match(page, /PROVIDER OUTCOME PENDING/);
      assert.doesNotMatch(page, /action="[^\"]*\/confirm-sent"/);
      const refused = await post(`/admin/outreach/${outreach.id}/confirm-sent`);
      assert.equal(refused.statusCode, 409);
      assert.match(refused.body, /result has not been recorded yet/);
      assert.deepEqual(await db.outreach.findUniqueOrThrow({ where: { id: outreach.id } }), claimed);
      assert.equal(await db.outreachEvent.count({ where: { outreachId: outreach.id, type: "sent" } }), 0);
    } finally {
      answer();
      await run;
    }
    const sent = await db.outreach.findUniqueOrThrow({ where: { id: outreach.id } });
    const repeat = await post(`/admin/outreach/${outreach.id}/confirm-sent`);
    assert.equal(repeat.statusCode, 303);
    assert.equal(repeat.headers.location, `/admin/outreach/${outreach.id}?done=already_sent`);
    assert.deepEqual(await db.outreach.findUniqueOrThrow({ where: { id: outreach.id } }), sent);
    assert.equal(sender.calls.length, 1);
  });

  test("a provider rejection remains failed when an admin attempts confirmation", async () => {
    const p = await createProspect(db, readyForm({ email: "service@smithauto.example.com", emailSourceUrl: `${WEBSITE}/contact` }));
    await addFixtureCollisionEvidence(db, p);
    const { outreach } = await createOutreachDraft(db, p.id, OPTS);
    await queueAndSend(db, outreach.id, mockSender(() => ({ status: "rejected", reason: "Provider refused." })));
    const failed = await db.outreach.findUniqueOrThrow({ where: { id: outreach.id } });
    const refused = await post(`/admin/outreach/${outreach.id}/confirm-sent`);
    assert.equal(refused.statusCode, 400);
    assert.doesNotMatch(refused.body, /action="[^\"]*\/confirm-sent"/);
    assert.deepEqual(await db.outreach.findUniqueOrThrow({ where: { id: outreach.id } }), failed);
    assert.equal(await db.outreachEvent.count({ where: { outreachId: outreach.id, type: "sent" } }), 0);
  });
});
