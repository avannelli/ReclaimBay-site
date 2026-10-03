import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { Db } from "../../src/db.js";
import { dispatchQueued } from "../../src/outreach/dispatch.js";
import { createOutreachDraft, discardOutreach, previewOutreachDraft, queueOutreach } from "../../src/outreach/service.js";
import { ProspectError, addEvidence, changeStatus, createProspect, formValuesOf, updateProspect } from "../../src/prospects.js";
import { freshDb, readyForm, skipReason, truncate } from "./helpers.js";
import { CFG, OPTS, mockSender, queueAndSend, switchOn } from "./outreachHelpers.js";

/*
 * Stage 5D Phase B: recipient ownership. A message's recipient is the one it
 * was drafted with (Outreach.recipientEmail), and an address is only ever
 * contacted for one business. Through the real services and the real
 * dispatcher with the mock provider; any network call fails the test. The
 * concurrent case needs real PostgreSQL (the send gate).
 */

describe("outreach recipients", { skip: skipReason }, () => {
  let db: Db;
  let realFetch: typeof fetch;
  before(async () => {
    db = await freshDb();
  });
  beforeEach(async () => {
    await truncate(db);
    realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network call during a recipient test");
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  after(async () => db?.$disconnect());

  let seq = 0;
  /** A qualified prospect with evidence; `email` lets several share one address. */
  const prospect = async (email?: string) => {
    const n = ++seq;
    const site = `https://recipient${n}.example.com`;
    const p = await createProspect(
      db,
      readyForm({ businessName: `Recipient ${n} Auto`, website: site, phoneSourceUrl: `${site}/contact`, email: email ?? `service@recipient${n}.example.com`, emailSourceUrl: `${site}/contact` }),
    );
    await addEvidence(db, p.id, { signalKey: "independent_shop", sourceUrl: `${site}/about`, excerpt: "Family owned." });
    return p;
  };
  const draft = async (prospectId: string, followUpOfId?: string) => (await createOutreachDraft(db, prospectId, followUpOfId ? { ...OPTS, followUpOfId } : OPTS)).outreach;
  const message = (id: string) => db.outreach.findUniqueOrThrow({ where: { id } });
  const refusal = (pattern: RegExp) => (err: unknown) => err instanceof ProspectError && pattern.test(err.messages.join(" "));
  const ELSEWHERE = /was already contacted for Recipient \d+ Auto\. An address is only ever emailed for one business\./;

  test("two businesses sharing an address: the first contacted keeps it, the other is cancelled, never sent, and can't be prepared again", async () => {
    const shared = "service@shared-one.example.com";
    const a = await prospect(shared);
    const b = await prospect("SERVICE@Shared-One.example.com");
    assert.equal(b.email, shared, "the address is normalized on entry");
    const first = await draft(a.id);
    const second = await draft(b.id);
    // Nobody has been contacted at it yet: both may wait in the queue.
    await queueOutreach(db, first.id, CFG);
    await queueOutreach(db, second.id, CFG);

    const sender = mockSender();
    await switchOn(db, sender);
    const report = await dispatchQueued(db, { config: CFG, sender });
    assert.deepEqual(
      sender.calls.map((c) => [c.outreachId, c.to]),
      [[first.id, shared]],
      "one email, to the recipient stored on the message",
    );
    assert.deepEqual(report.cancelled.map((c) => c.outreachId), [second.id]);
    assert.match(report.cancelled[0]!.reasons.join(" "), ELSEWHERE);
    const cancelled = await message(second.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.sendStartedAt, null);

    // A third business at that address can't even be prepared; the first one's own follow-up can.
    const c = await prospect(shared);
    assert.match((await previewOutreachDraft(db, c.id, OPTS)).errors.join(" "), ELSEWHERE);
    await assert.rejects(createOutreachDraft(db, c.id, OPTS), refusal(ELSEWHERE));
    assert.equal((await draft(a.id, first.id)).status, "draft");
  });

  test("two dispatchers at once, two businesses at one address: exactly one email (real PostgreSQL, the send gate)", async () => {
    for (let round = 0; round < 6; round++) {
      const shared = `service@race${round}.example.com`;
      const first = await draft((await prospect(shared)).id);
      const second = await draft((await prospect(shared)).id);
      await queueOutreach(db, first.id, CFG);
      await queueOutreach(db, second.id, CFG);
      const [s1, s2] = [mockSender(), mockSender()];
      await switchOn(db, s1);
      await Promise.all([dispatchQueued(db, { config: CFG, sender: s1 }), dispatchQueued(db, { config: CFG, sender: s2 })]);
      assert.equal(s1.calls.length + s2.calls.length, 1, `round ${round}: one email`);
      const statuses = [(await message(first.id)).status, (await message(second.id)).status].sort();
      assert.deepEqual(statuses, ["cancelled", "sent"], `round ${round}`);
    }
  });

  test("a refusal frees the address; an unknown outcome, or a send cancelled after it started, keeps it", async () => {
    // Refused before it went out: the address was never contacted, so another business can be.
    const refusedAt = "service@refused.example.com";
    const refused = await draft((await prospect(refusedAt)).id);
    await queueAndSend(db, refused.id, mockSender(() => ({ status: "rejected", reason: "550 policy", invalidRecipient: false })));
    assert.equal((await message(refused.id)).status, "failed");
    const next = await draft((await prospect(refusedAt)).id);
    await queueAndSend(db, next.id);
    assert.equal((await message(next.id)).status, "sent");

    // An unknown outcome: it may have gone out, so it holds the address.
    const unsureAt = "service@unsure.example.com";
    const owner = await prospect(unsureAt);
    const unsure = await draft(owner.id);
    await queueAndSend(db, unsure.id, mockSender(() => ({ status: "uncertain", reason: "Timed out." })));
    const other = await prospect(unsureAt);
    assert.match((await previewOutreachDraft(db, other.id, OPTS)).errors.join(" "), ELSEWHERE);

    // Cancelled after its send started (however that happened): it may still have gone out. It keeps the
    // address, and its own business gets no second first message.
    await db.outreach.update({ where: { id: unsure.id }, data: { status: "cancelled", cancelledAt: new Date(), openForProspectId: null } });
    assert.match((await previewOutreachDraft(db, other.id, OPTS)).errors.join(" "), ELSEWHERE);
    assert.match((await previewOutreachDraft(db, owner.id, OPTS)).errors.join(" "), /A first message was already sent/);
  });

  test("Do not contact, set by a person, suppresses the address: another business's queued message to it is cancelled, and nothing is sent", async () => {
    const shared = "office@shared-dnc.example.com";
    const asked = await prospect(shared);
    const other = await prospect(shared);
    const queued = await draft(other.id);
    await queueOutreach(db, queued.id, CFG);

    await changeStatus(db, asked.id, "do_not_contact", "Asked by phone.");
    const suppression = await db.emailSuppression.findUniqueOrThrow({ where: { email: shared } });
    assert.equal(suppression.reason, "unsubscribed");
    assert.match(suppression.detail ?? "", /Recipient \d+ Auto is Do not contact: Asked by phone\./);
    const cancelled = await message(queued.id);
    assert.equal(cancelled.status, "cancelled");
    assert.match(cancelled.cancelReason ?? "", /suppressed/);

    const sender = mockSender();
    await switchOn(db, sender);
    await dispatchQueued(db, { config: CFG, sender });
    assert.equal(sender.calls.length, 0);
  });

  test("a follow-up goes only to the address its first message went to", async () => {
    const p = await prospect();
    const first = await draft(p.id);
    await queueAndSend(db, first.id);
    const followUp = await draft(p.id, first.id);
    assert.equal(followUp.recipientEmail, first.recipientEmail);

    // The business email changes after the first message.
    const current = await db.prospect.findUniqueOrThrow({ where: { id: p.id }, include: { signals: true } });
    await updateProspect(db, p.id, { ...formValuesOf(current), email: "owner@recipient-new.example.com" });

    await assert.rejects(queueOutreach(db, followUp.id, CFG), refusal(/goes to the address the first message was sent to/));
    assert.equal((await message(followUp.id)).status, "draft", "nothing changed");
    await discardOutreach(db, followUp.id, "The email changed.");
    await assert.rejects(createOutreachDraft(db, p.id, { ...OPTS, followUpOfId: first.id }), refusal(/goes to the address the first message was sent to/));
  });
});
