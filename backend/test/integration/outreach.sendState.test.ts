import { addFixtureCollisionEvidence } from "./helpers.js";
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { Db } from "../../src/db.js";
import { confirmStuckSent, dailyCapacity, dispatchQueued } from "../../src/outreach/dispatch.js";
import { revokeInvitationForOutreach } from "../../src/invitations/service.js";
import { STUCK_AFTER_MS } from "../../src/outreach/records.js";
import type { SendResult } from "../../src/outreach/sender.js";
import { applyProviderEvent, createOutreachDraft, discardOutreach, queueOutreach, recordReply } from "../../src/outreach/service.js";
import { ProspectError, addEvidence, changeStatus, createProspect } from "../../src/prospects.js";
import { freshDb, readyForm, skipReason, truncate } from "./helpers.js";
import { CFG, OPTS, mockSender, queueAndSend, switchOn } from "./outreachHelpers.js";

/*
 * Stage 5D Phase C: a send that has started is decided by its outcome, never
 * by a stop that lands while the provider is being called. The provider here
 * is a mock that waits until the test lets it answer, so each stop runs in
 * exactly that window: after the dispatcher's claim committed, before its
 * result. Real PostgreSQL (the send gate orders everything); any network call
 * fails the test.
 */

describe("send state while a send is in flight", { skip: skipReason }, () => {
  let db: Db;
  let realFetch: typeof fetch;
  before(async () => {
    db = await freshDb();
  });
  beforeEach(async () => {
    await truncate(db);
    realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network call during a send-state test");
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  after(async () => db?.$disconnect());

  let seq = 0;
  const prospect = async () => {
    const n = ++seq;
    const site = `https://inflight${n}.example.com`;
    const p = await createProspect(
      db,
      readyForm({ businessName: `In Flight ${n} Auto`, website: site, phoneSourceUrl: `${site}/contact`, email: `service@inflight${n}.example.com`, emailSourceUrl: `${site}/contact` }),
    );
    await addFixtureCollisionEvidence(db, p);
    await addEvidence(db, p.id, { signalKey: "independent_shop", sourceUrl: `${site}/about`, excerpt: "Family owned." });
    return p;
  };
  const draft = async (prospectId: string, followUpOfId?: string) => (await createOutreachDraft(db, prospectId, followUpOfId ? { ...OPTS, followUpOfId } : OPTS)).outreach;
  const message = (id: string) => db.outreach.findUniqueOrThrow({ where: { id } });
  const eventsOf = async (id: string) => (await db.outreachEvent.findMany({ where: { outreachId: id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })).map((e) => e.type);
  const prospectStatus = async (id: string) => (await db.prospect.findUniqueOrThrow({ where: { id } })).status;

  /**
   * Starts the dispatcher on the queued message and returns once the provider
   * has it: the claim is committed and the send is "in flight" until answer().
   */
  const sendInFlight = async (now?: () => Date) => {
    let answer!: (r: SendResult) => void;
    const answered = new Promise<SendResult>((r) => (answer = r));
    let reached!: () => void;
    const atProvider = new Promise<void>((r) => (reached = r));
    const sender = mockSender(async () => {
      reached();
      return answered;
    });
    await switchOn(db, sender);
    const run = dispatchQueued(db, { config: CFG, sender, now });
    await atProvider;
    return { answer, run, sender };
  };
  const accepted = (id: string): SendResult => ({ status: "accepted", providerMessageId: `msg-${id}` });

  /** The message was sent, and says so: status, time, the provider's id, and no cancellation anywhere. */
  const assertSent = async (id: string) => {
    const o = await message(id);
    assert.equal(o.status, "sent");
    assert.ok(o.sentAt);
    assert.equal(o.providerMessageId, `msg-${id}`);
    assert.equal(o.cancelledAt, null);
    assert.ok(!(await eventsOf(id)).includes("cancelled"), "never recorded as cancelled");
  };

  const pendingConfirmation = (id: string) => assert.rejects(
    confirmStuckSent(db, id, "manual"),
    (err: unknown) => err instanceof ProspectError && err.kind === "conflict" && /result has not been recorded/.test(err.messages.join(" ")),
  );

  for (const aged of [false, true]) {
    for (const outcome of ["accepted", "rejected", "unavailable", "uncertain"] as const) {
      test(`manual confirmation during ${aged ? "an old" : "a fresh"} active claim cannot overwrite provider ${outcome}`, async () => {
        const p = await prospect();
        const started = new Date(Date.now() - (aged ? STUCK_AFTER_MS + 60_000 : 0));
        const o = (await createOutreachDraft(db, p.id, { ...OPTS, now: new Date(started.getTime() - 2_000) })).outreach;
        await queueOutreach(db, o.id, CFG, new Date(started.getTime() - 1_000));
        let clockCalls = 0;
        const inFlight = await sendInFlight(() => ++clockCalls === 1 ? started : new Date());
        const claimed = await message(o.id);
        try {
          await pendingConfirmation(o.id);
          assert.deepEqual(await message(o.id), claimed, "a refused confirmation writes nothing");
          assert.deepEqual(await eventsOf(o.id), ["drafted", "queued"]);
          assert.deepEqual(await dailyCapacity(db, { outreachDailyLimit: 1 }, new Date()), { used: 1, limit: 1, remaining: 0 });
          const competing = await dispatchQueued(db, { config: CFG, sender: inFlight.sender });
          assert.deepEqual(competing.sent, []);
          assert.equal(inFlight.sender.calls.length, 1, "another dispatcher cannot send a claimed message");
        } finally {
          inFlight.answer(outcome === "accepted" ? accepted(o.id) : { status: outcome, reason: `Provider ${outcome}.` });
          await inFlight.run;
        }
        const resolved = await message(o.id);
        if (outcome === "accepted") {
          await assertSent(o.id);
          assert.equal((await confirmStuckSent(db, o.id, "manual")).changed, false);
          assert.deepEqual(await message(o.id), resolved, "manual confirmation preserves provider identity, timestamps and state");
          assert.deepEqual(await eventsOf(o.id), ["drafted", "queued", "sent"]);
          assert.equal(await prospectStatus(p.id), "contacted");
        } else if (outcome === "rejected") {
          await assert.rejects(confirmStuckSent(db, o.id, "manual"), /Only a message/);
          assert.deepEqual(await message(o.id), resolved);
          assert.equal(resolved.status, "failed");
          assert.equal(resolved.sentAt, null);
          assert.equal(resolved.failureReason, "Provider rejected.");
          assert.deepEqual(await eventsOf(o.id), ["drafted", "queued", "failed"]);
          assert.equal(await prospectStatus(p.id), "ready_to_contact");
        } else if (outcome === "unavailable") {
          await assert.rejects(confirmStuckSent(db, o.id, "manual"), /Only a message/);
          assert.deepEqual(await message(o.id), resolved);
          assert.equal(resolved.status, "queued");
          assert.equal(resolved.sendStartedAt, null);
          assert.equal(resolved.sendAttempts, 0);
          assert.deepEqual(await dailyCapacity(db, { outreachDailyLimit: 1 }, new Date()), { used: 0, limit: 1, remaining: 1 });
          assert.deepEqual(await eventsOf(o.id), ["drafted", "queued"]);
        } else {
          assert.equal(resolved.status, "queued");
          assert.equal(resolved.lastSendError, "Provider uncertain.");
          assert.equal((await confirmStuckSent(db, o.id, "manual")).changed, true);
          assert.equal((await confirmStuckSent(db, o.id, "manual")).changed, false);
          assert.deepEqual(await eventsOf(o.id), ["drafted", "queued", "sent"]);
          assert.equal((await message(o.id)).sendAttempts, 1);
          assert.deepEqual(await dailyCapacity(db, { outreachDailyLimit: 1 }, new Date()), { used: 1, limit: 1, remaining: 0 });
        }
        assert.equal(inFlight.sender.calls.length, 1);
      });
    }
  }

  test("manual confirmation and competing dispatchers on a completed uncertain send produce one sent event and no additional provider calls", async () => {
    const o = await draft((await prospect()).id);
    const sender = mockSender(() => ({ status: "uncertain", reason: "Timed out." }));
    await queueAndSend(db, o.id, sender);
    const results = await Promise.all([
      confirmStuckSent(db, o.id, "manual"),
      dispatchQueued(db, { config: CFG, sender }),
      confirmStuckSent(db, o.id, "manual"),
      dispatchQueued(db, { config: CFG, sender }),
    ]);
    assert.equal(results[0].changed || results[2].changed, true);
    assert.notEqual(results[0].changed, results[2].changed);
    assert.deepEqual(await eventsOf(o.id), ["drafted", "queued", "sent"]);
    assert.equal(sender.calls.length, 1);
    assert.equal((await message(o.id)).sendAttempts, 1);
  });

  test("drafts, unclaimed queues and cancelled messages cannot be manually marked sent, including revoked invitations", async () => {
    const o = await draft((await prospect()).id);
    await assert.rejects(confirmStuckSent(db, o.id, "manual"), /Only a message/);
    await queueOutreach(db, o.id, CFG);
    await assert.rejects(confirmStuckSent(db, o.id, "manual"), /Only a message/);
    await revokeInvitationForOutreach(db, o.id, "Wrong shop.");
    const sender = mockSender();
    await switchOn(db, sender);
    const report = await dispatchQueued(db, { config: CFG, sender });
    assert.equal(report.cancelled.length, 1);
    const cancelled = await message(o.id);
    await assert.rejects(confirmStuckSent(db, o.id, "manual"), /Only a message/);
    assert.deepEqual(await message(o.id), cancelled);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.sentAt, null);
    assert.equal(sender.calls.length, 0);
    assert.deepEqual(await eventsOf(o.id), ["drafted", "queued", "cancelled"]);
  });

  test("an uncertain send discarded by a person cannot be manually resurrected", async () => {
    const o = await draft((await prospect()).id);
    await queueAndSend(db, o.id, mockSender(() => ({ status: "uncertain", reason: "Timed out." })));
    await discardOutreach(db, o.id, "Checked the provider.");
    const cancelled = await message(o.id);
    await assert.rejects(confirmStuckSent(db, o.id, "manual"), /Only a message/);
    assert.deepEqual(await message(o.id), cancelled);
    assert.deepEqual(await eventsOf(o.id), ["drafted", "queued", "cancelled"]);
  });

  test("manual confirmation preserves delivered, bounced and replied outcomes and cannot hide a later provider failure", async () => {
    for (const outcome of ["delivered", "bounced", "replied", "failed"] as const) {
      const o = await draft((await prospect()).id);
      await queueAndSend(db, o.id);
      if (outcome === "replied") await recordReply(db, o.id, { summary: "Thanks." });
      else await applyProviderEvent(db, { type: outcome, provider: "mock", outreachId: o.id, providerMessageId: `msg-${o.id}`, reason: "Provider outcome." });
      const resolved = await message(o.id);
      const events = await eventsOf(o.id);
      if (outcome === "failed") await assert.rejects(confirmStuckSent(db, o.id, "manual"), /Only a message/);
      else assert.equal((await confirmStuckSent(db, o.id, "manual")).changed, false);
      assert.equal(resolved.status, outcome);
      assert.deepEqual(await message(o.id), resolved);
      assert.deepEqual(await eventsOf(o.id), events);
    }
  });

  test("Do not contact during a first message's send: the send is recorded, the business stays Do not contact, the address is suppressed", async () => {
    const p = await prospect();
    const o = await draft(p.id);
    await queueOutreach(db, o.id, CFG);
    const inFlight = await sendInFlight();

    await changeStatus(db, p.id, "do_not_contact", "Asked by phone.");
    const meanwhile = await message(o.id);
    assert.equal(meanwhile.status, "queued", "a send in flight is left to its outcome");
    assert.ok(meanwhile.sendStartedAt);

    inFlight.answer(accepted(o.id));
    const report = await inFlight.run;
    assert.deepEqual(report.sent.map((s) => s.outreachId), [o.id]);
    await assertSent(o.id);
    assert.deepEqual(await eventsOf(o.id), ["drafted", "queued", "sent"]);
    assert.equal(await prospectStatus(p.id), "do_not_contact", "the send doesn't move it back to Contacted");
    assert.ok(await db.emailSuppression.findUnique({ where: { email: p.email! } }));
    assert.equal(inFlight.sender.calls.length, 1);
  });

  test("a bounce of the first message during its follow-up's send: the follow-up is recorded as sent, and the address is suppressed", async () => {
    const p = await prospect();
    const first = await draft(p.id);
    await queueAndSend(db, first.id);
    const followUp = await draft(p.id, first.id);
    await queueOutreach(db, followUp.id, CFG);
    const inFlight = await sendInFlight();

    assert.equal((await applyProviderEvent(db, { provider: "mock", type: "bounced", providerMessageId: `msg-${first.id}` })).result, "recorded");
    assert.equal((await message(followUp.id)).status, "queued");

    inFlight.answer(accepted(followUp.id));
    await inFlight.run;
    await assertSent(followUp.id);
    assert.equal((await message(first.id)).status, "bounced");
    assert.ok(await db.emailSuppression.findUnique({ where: { email: first.recipientEmail } }));
  });

  test("a 'not interested' reply during the follow-up's send: the business is Lost, and the follow-up is recorded as sent", async () => {
    const p = await prospect();
    const first = await draft(p.id);
    await queueAndSend(db, first.id);
    const followUp = await draft(p.id, first.id);
    await queueOutreach(db, followUp.id, CFG);
    const inFlight = await sendInFlight();

    await recordReply(db, first.id, { outcome: "not_interested" });
    assert.equal(await prospectStatus(p.id), "lost");
    assert.equal((await message(followUp.id)).status, "queued");

    inFlight.answer(accepted(followUp.id));
    await inFlight.run;
    await assertSent(followUp.id);
    assert.equal(await prospectStatus(p.id), "lost");
  });

  test("a person can't discard a message while it is being sent; the send is recorded", async () => {
    const p = await prospect();
    const o = await draft(p.id);
    await queueOutreach(db, o.id, CFG);
    const inFlight = await sendInFlight();

    await assert.rejects(discardOutreach(db, o.id, "Wrong shop."), (err: unknown) => err instanceof ProspectError && err.kind === "conflict" && /being sent right now/.test(err.messages.join(" ")));
    inFlight.answer(accepted(o.id));
    await inFlight.run;
    await assertSent(o.id);
    assert.equal(await prospectStatus(p.id), "contacted");
  });

  test("an interrupted send can be discarded by a person; if the provider then confirms it, the record says sent", async () => {
    const p = await prospect();
    const o = await draft(p.id);
    await queueOutreach(db, o.id, CFG);
    const inFlight = await sendInFlight();

    // Claimed long enough ago to count as interrupted: a person, having checked the provider, discards it.
    await db.outreach.update({ where: { id: o.id }, data: { sendStartedAt: new Date(Date.now() - STUCK_AFTER_MS - 60_000) } });
    assert.equal((await discardOutreach(db, o.id, "Checked: not in Sent.")).changed, true);
    assert.equal((await message(o.id)).status, "cancelled");

    // The provider was only slow: it accepted the message after all.
    inFlight.answer(accepted(o.id));
    await inFlight.run;
    const corrected = await message(o.id);
    assert.equal(corrected.status, "sent");
    assert.ok(corrected.sentAt);
    assert.equal(corrected.providerMessageId, `msg-${o.id}`);
    assert.equal(corrected.cancelledAt, null);
    assert.equal(corrected.cancelReason, null);
    assert.deepEqual(await eventsOf(o.id), ["drafted", "queued", "cancelled", "sent"], "the discard stays in the history");
    const sentEvent = await db.outreachEvent.findFirstOrThrow({ where: { outreachId: o.id, type: "sent" } });
    assert.match(sentEvent.detail ?? "", /after it was discarded as unsent/);
    assert.equal(await prospectStatus(p.id), "contacted");
  });

  test("an unknown outcome can still be discarded by a person, and automatic stops leave it for them", async () => {
    const p = await prospect();
    const o = await draft(p.id);
    await queueAndSend(db, o.id, mockSender(() => ({ status: "uncertain", reason: "Timed out." })));
    // An automatic stop doesn't decide a send that may have gone out.
    await changeStatus(db, p.id, "do_not_contact", "Asked by phone.");
    const held = await message(o.id);
    assert.equal(held.status, "queued");
    assert.ok(held.sendStartedAt && held.lastSendError);
    // A person, having checked the provider, does.
    assert.equal((await discardOutreach(db, o.id, "Checked: not in Sent.")).changed, true);
    assert.equal((await message(o.id)).status, "cancelled");
  });

  test("the send's outcome and Do not contact at once (real PostgreSQL): the message ends sent, never cancelled, every time", async () => {
    for (let round = 0; round < 10; round++) {
      const p = await prospect();
      const o = await draft(p.id);
      await queueOutreach(db, o.id, CFG);
      const inFlight = await sendInFlight();
      const [, dnc] = await Promise.allSettled([
        (async () => {
          inFlight.answer(accepted(o.id));
          return inFlight.run;
        })(),
        changeStatus(db, p.id, "do_not_contact", "Asked by phone."),
      ]);
      assert.equal(dnc.status, "fulfilled", `round ${round}: Do not contact always applies`);
      await assertSent(o.id);
      assert.equal(await prospectStatus(p.id), "do_not_contact", `round ${round}`);
    }
  });
});
