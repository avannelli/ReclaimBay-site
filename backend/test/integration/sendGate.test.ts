import { addFixtureCollisionEvidence } from "./helpers.js";
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Db } from "../../src/db.js";
import { revokeInvitation, revokeInvitationForOutreach } from "../../src/invitations/service.js";
import { confirmStuckSent, dispatchQueued, setSendingSwitch } from "../../src/outreach/dispatch.js";
import { SEND_GATE } from "../../src/outreach/records.js";
import type { SendResult } from "../../src/outreach/sender.js";
import {
  applyProviderEvent,
  classifyReply,
  createOutreachDraft,
  discardOutreach,
  queueOutreach,
  recordInboundReply,
  recordReply,
  unsubscribeOutreach,
} from "../../src/outreach/service.js";
import { ProspectError, addEvidence, changeStatus, createProspect, formValuesOf, updateProspect } from "../../src/prospects.js";
import { freshDb, readyForm, skipReason, truncate } from "./helpers.js";
import { CFG, OPTS, mockSender, queueAndSend, switchOn } from "./outreachHelpers.js";

/*
 * Stage 5D Phase A: the send gate (outreach/records.ts lockSendGate), against
 * real PostgreSQL. Every top-level operation that can make or stop a send
 * waits for the gate; the provider is never called while anyone holds it;
 * and operations that used to take row locks in opposite orders (queueing vs
 * Do not contact, an opt-out vs a status change) now run one after the
 * other: no deadlock, one consistent outcome, nothing applied by halves.
 * The provider is a mock; any network call fails the test. The emulator
 * can't prove any of this: run it on real PostgreSQL.
 */

const ROUNDS = 12;

describe("the send gate (real PostgreSQL)", { skip: skipReason }, () => {
  let db: Db;
  let realFetch: typeof fetch;
  before(async () => {
    db = await freshDb();
  });
  beforeEach(async () => {
    await truncate(db);
    realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network call during a send-gate test");
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  after(async () => db?.$disconnect());

  let seq = 0;
  const prospect = async () => {
    const n = ++seq;
    const site = `https://gate${n}.example.com`;
    const p = await createProspect(
      db,
      readyForm({ businessName: `Gate ${n} Auto`, website: site, phoneSourceUrl: `${site}/contact`, email: `service@gate${n}.example.com`, emailSourceUrl: `${site}/contact` }),
    );
    await addFixtureCollisionEvidence(db, p);
    await addEvidence(db, p.id, { signalKey: "independent_shop", sourceUrl: `${site}/about`, excerpt: "Family owned." });
    return p;
  };
  const draft = async (prospectId: string, followUpOfId?: string) => (await createOutreachDraft(db, prospectId, followUpOfId ? { ...OPTS, followUpOfId } : OPTS)).outreach;
  /** A prospect with a first message that was sent (through the dispatcher and the mock provider). */
  const sentMessage = async () => {
    const p = await prospect();
    const o = await draft(p.id);
    await queueAndSend(db, o.id);
    return { p, o: await db.outreach.findUniqueOrThrow({ where: { id: o.id } }) };
  };

  // ---------- watching the gate ----------

  const THIS_DB = "database = (SELECT oid FROM pg_database WHERE datname = current_database())";
  /** Sessions holding the gate (granted), or waiting for it. */
  const gateLocks = async (granted: boolean) =>
    (await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = ${SEND_GATE} AND ${THIS_DB} AND granted = ${granted}`))[0]!.n;
  /** Waits (polling the database, never a fixed sleep) until `n` sessions are queued behind the gate. */
  const untilWaiting = async (n = 1) => {
    const deadline = Date.now() + 10_000;
    while ((await gateLocks(false)) < n) {
      if (Date.now() > deadline) throw new Error(`expected ${n} session(s) waiting for the send gate`);
      await delay(5);
    }
  };
  /** Takes the gate in another transaction and holds it until released. */
  const holdGate = async () => {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let acquired!: () => void;
    const holding = new Promise<void>((r) => (acquired = r));
    const done = db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${SEND_GATE})`);
        acquired();
        await released;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    await holding;
    return { release, done };
  };
  /**
   * Starts `operation` while another transaction holds the gate: it must wait
   * (queued behind the gate, not finished), then complete once the gate is free.
   */
  const waitsForGate = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
    const gate = await holdGate();
    let settled = false;
    const running = operation().finally(() => (settled = true));
    try {
      await untilWaiting(1);
      assert.equal(settled, false, `${name} waited for the gate`);
    } finally {
      gate.release();
      await gate.done;
    }
    return running;
  };

  test("every top-level operation that can make or stop a send waits for the gate", async () => {
    // Queueing, discarding, and revoking, on drafts.
    let o = await draft((await prospect()).id);
    assert.equal((await waitsForGate("queueOutreach", () => queueOutreach(db, o.id, CFG))).changed, true);
    o = await draft((await prospect()).id);
    assert.equal((await waitsForGate("discardOutreach", () => discardOutreach(db, o.id, "Not now."))).changed, true);
    o = await draft((await prospect()).id);
    const inv = await db.invitation.findUniqueOrThrow({ where: { outreachId: o.id } });
    assert.deepEqual(await waitsForGate("revokeInvitation", () => revokeInvitation(db, inv.id, "Wrong shop.")), { changed: true });
    o = await draft((await prospect()).id);
    assert.deepEqual(await waitsForGate("revokeInvitationForOutreach", () => revokeInvitationForOutreach(db, o.id, "Wrong shop.")), { changed: true });

    // The prospect: a status change, and an edit.
    let p = await prospect();
    assert.equal((await waitsForGate("changeStatus", () => changeStatus(db, p.id, "do_not_contact", "Asked."))).to, "do_not_contact");
    p = await prospect();
    const current = await db.prospect.findUniqueOrThrow({ where: { id: p.id }, include: { signals: true } });
    await waitsForGate("updateProspect", () => updateProspect(db, p.id, { ...formValuesOf(current), signal_multiple_bays_or_staff: "yes" }));

    // What happens to a sent message: a reply (recorded, classified, or from the inbox), a provider event, an opt-out.
    let s = await sentMessage();
    assert.equal((await waitsForGate("recordReply", () => recordReply(db, s.o.id, { outcome: "interested" }))).changed, true);
    s = await sentMessage();
    await recordReply(db, s.o.id, {});
    await waitsForGate("classifyReply", () => classifyReply(db, s.o.id, "interested"));
    s = await sentMessage();
    assert.equal((await waitsForGate("recordInboundReply", () => recordInboundReply(db, { fromEmail: s.o.recipientEmail, inReplyToProviderMessageId: s.o.providerMessageId }))).result, "recorded");
    s = await sentMessage();
    assert.equal((await waitsForGate("applyProviderEvent", () => applyProviderEvent(db, { provider: "mock", type: "bounced", providerMessageId: s.o.providerMessageId }))).result, "recorded");
    s = await sentMessage();
    assert.equal((await waitsForGate("unsubscribeOutreach", () => unsubscribeOutreach(db, s.o.id, "by a test"))).result, "recorded");

    // The switch, a stuck send confirmed, and the dispatcher's claim.
    await waitsForGate("setSendingSwitch", () => setSendingSwitch(db, false, "Test.", CFG, mockSender()));
    o = await draft((await prospect()).id);
    await queueAndSend(db, o.id, mockSender(() => ({ status: "uncertain", reason: "Timed out." })));
    assert.equal((await waitsForGate("confirmStuckSent", () => confirmStuckSent(db, o.id, "mock"))).changed, true);

    o = await draft((await prospect()).id);
    await queueOutreach(db, o.id, CFG);
    const sender = mockSender();
    await switchOn(db, sender);
    const report = await waitsForGate("dispatchQueued", async () => {
      const r = dispatchQueued(db, { config: CFG, sender });
      return r;
    });
    assert.deepEqual(report.sent.map((x) => x.outreachId), [o.id]);
    assert.equal(sender.calls.length, 1);
  });

  test("the provider is only ever called while nobody holds the gate", async () => {
    const seen: number[] = [];
    const sender = mockSender(async (m) => {
      seen.push(await gateLocks(true));
      return { status: "accepted", providerMessageId: `msg-${m.outreachId}` };
    });
    for (let i = 0; i < 3; i++) await queueOutreach(db, (await draft((await prospect()).id)).id, CFG);
    await switchOn(db, sender);
    const report = await dispatchQueued(db, { config: CFG, sender });
    assert.equal(report.sent.length, 3);
    assert.deepEqual(seen, [0, 0, 0], "the claim's transaction had committed before each send");
  });

  test("confirmation queued before the dispatch claim is refused; dispatch alone records the send", async () => {
    const o = await draft((await prospect()).id);
    await queueOutreach(db, o.id, CFG);
    const sender = mockSender();
    await switchOn(db, sender);
    const gate = await holdGate();
    // Attach the rejection handler before releasing the gate. Observe the
    // actual PostgreSQL waiters to order both operations without a sleep.
    const confirmation = confirmStuckSent(db, o.id, "manual").then(
      () => { throw new Error("an unclaimed message was confirmed"); },
      (err: unknown) => {
        assert.ok(err instanceof ProspectError);
        assert.match(err.messages.join(" "), /Only a message/);
      },
    );
    let dispatch: ReturnType<typeof dispatchQueued> | undefined;
    try {
      await untilWaiting(1);
      dispatch = dispatchQueued(db, { config: CFG, sender });
      await untilWaiting(2);
    } finally {
      gate.release();
      await gate.done;
    }
    await confirmation;
    assert.ok(dispatch);
    const report = await dispatch;
    assert.deepEqual(report.sent.map((s) => s.outreachId), [o.id]);
    const stored = await db.outreach.findUniqueOrThrow({ where: { id: o.id } });
    assert.equal(stored.status, "sent");
    assert.equal(stored.provider, "mock");
    assert.equal(stored.providerMessageId, `msg-${o.id}`);
    assert.equal(stored.sendAttempts, 1);
    assert.deepEqual(await eventsOf(o.id), ["drafted", "queued", "sent"].sort());
    assert.equal(sender.calls.length, 1);
  });

  for (const confirmationFirst of [true, false]) {
    for (const outcome of ["accepted", "rejected", "uncertain"] as const) {
      test(`${confirmationFirst ? "confirmation" : "provider result"} takes the gate first with provider ${outcome}: one authoritative outcome`, async () => {
        const o = await draft((await prospect()).id);
        await queueOutreach(db, o.id, CFG);
        let answer!: (result: SendResult) => void;
        const answered = new Promise<SendResult>((r) => { answer = r; });
        let reached!: () => void;
        const atProvider = new Promise<void>((r) => { reached = r; });
        const sender = mockSender(async () => { reached(); return answered; });
        await switchOn(db, sender);
        const dispatch = dispatchQueued(db, { config: CFG, sender });
        await atProvider;
        const gate = await holdGate();
        const result: SendResult = outcome === "accepted"
          ? { status: "accepted", providerMessageId: `msg-${o.id}` }
          : { status: outcome, reason: `Provider ${outcome}.` };
        const confirm = () => confirmStuckSent(db, o.id, "manual").then(
          (value) => ({ value, error: null }),
          (error: unknown) => ({ value: null, error }),
        );
        let confirmation: ReturnType<typeof confirm> | undefined;
        try {
          if (confirmationFirst) {
            confirmation = confirm();
            await untilWaiting(1);
            answer(result);
          } else {
            answer(result);
            await untilWaiting(1);
            confirmation = confirm();
          }
          await untilWaiting(2);
        } finally {
          answer(result);
          gate.release();
          await gate.done;
        }
        await dispatch;
        assert.ok(confirmation);
        const manual = await confirmation;
        if (confirmationFirst) {
          assert.ok(manual.error instanceof ProspectError);
          assert.equal(manual.error.kind, "conflict");
        } else if (outcome === "rejected") {
          assert.ok(manual.error instanceof ProspectError);
          assert.equal(manual.error.kind, "invalid");
        } else {
          assert.equal(manual.error, null);
          assert.equal(manual.value?.changed, outcome === "uncertain");
        }
        const stored = await db.outreach.findUniqueOrThrow({ where: { id: o.id } });
        const expected = outcome === "rejected" ? "failed" : outcome === "uncertain" && confirmationFirst ? "queued" : "sent";
        assert.equal(stored.status, expected);
        assert.equal(stored.sendAttempts, 1);
        assert.equal(stored.providerMessageId, outcome === "accepted" ? `msg-${o.id}` : null);
        assert.equal(stored.provider, outcome === "uncertain" ? confirmationFirst ? null : "manual" : "mock");
        assert.equal(await db.outreachEvent.count({ where: { outreachId: o.id, type: "sent" } }), expected === "sent" ? 1 : 0);
        assert.equal(await db.outreachEvent.count({ where: { outreachId: o.id, type: "failed" } }), outcome === "rejected" ? 1 : 0);
        assert.equal(sender.calls.length, 1);
      });
    }
  }

  // ---------- operations that used to lock rows in opposite orders ----------

  const historyOf = async (prospectId: string) =>
    (await db.prospectStatusChange.findMany({ where: { prospectId } })).map((h) => `${h.fromStatus}->${h.toStatus}`).sort();
  const eventsOf = async (outreachId: string) => (await db.outreachEvent.findMany({ where: { outreachId } })).map((e) => e.type).sort();
  /** A loser gets the service's own answer (a ProspectError), never a database failure such as a deadlock. */
  const onlyRefusals = (results: PromiseSettledResult<unknown>[]) => {
    for (const r of results) if (r.status === "rejected") assert.ok(r.reason instanceof ProspectError, `refused, not failed: ${(r.reason as Error).message}`);
  };

  test("queueing and Do not contact at once: no deadlock, and one of the two orders, applied whole", async () => {
    const seenOrders = new Set<string>();
    for (let round = 0; round < ROUNDS; round++) {
      const p = await prospect();
      const o = await draft(p.id);
      const [queued, dnc] = await Promise.allSettled([queueOutreach(db, o.id, CFG), changeStatus(db, p.id, "do_not_contact", "Asked.")]);
      onlyRefusals([queued, dnc]);
      assert.equal(dnc.status, "fulfilled", "Do not contact always applies");

      const message = await db.outreach.findUniqueOrThrow({ where: { id: o.id } });
      assert.equal(message.status, "cancelled", "the message can never be sent");
      assert.equal(message.sendStartedAt, null);
      assert.equal(message.sentAt, null);
      assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: p.id } })).status, "do_not_contact");
      if (queued.status === "fulfilled") {
        // Queued first, then Do not contact cancelled it.
        seenOrders.add("queue first");
        assert.deepEqual(await historyOf(p.id), ["new->qualified", "null->new", "qualified->ready_to_contact", "ready_to_contact->do_not_contact"]);
        assert.deepEqual(await eventsOf(o.id), ["cancelled", "drafted", "queued"]);
      } else {
        // Do not contact first: the draft was cancelled, and queueing it was refused, changing nothing.
        seenOrders.add("Do not contact first");
        assert.match((queued.reason as ProspectError).messages.join(" "), /from Cancelled to Queued/);
        assert.deepEqual(await historyOf(p.id), ["new->do_not_contact", "null->new"]);
        assert.deepEqual(await eventsOf(o.id), ["cancelled", "drafted"]);
      }
    }
    assert.ok(seenOrders.size >= 1);
    assert.equal(await db.outreach.count({ where: { sendStartedAt: { not: null } } }), 0, "nothing was sent");
  });

  test("queueing and revoking the invitation at once: no deadlock, and one of the two orders, applied whole", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const p = await prospect();
      const o = await draft(p.id);
      const [queued, revoked] = await Promise.allSettled([queueOutreach(db, o.id, CFG), revokeInvitationForOutreach(db, o.id, "Wrong shop.")]);
      onlyRefusals([queued, revoked]);
      assert.equal(revoked.status, "fulfilled");
      assert.deepEqual((revoked as PromiseFulfilledResult<unknown>).value, { changed: true });
      assert.ok((await db.invitation.findUniqueOrThrow({ where: { outreachId: o.id } })).revokedAt);

      const message = await db.outreach.findUniqueOrThrow({ where: { id: o.id } });
      assert.equal(message.sendStartedAt, null);
      if (queued.status === "fulfilled") {
        // Queued first, then revoked: dispatch must refuse it before claiming.
        assert.equal(message.status, "queued");
        assert.deepEqual(await historyOf(p.id), ["new->qualified", "null->new", "qualified->ready_to_contact"]);
        assert.deepEqual(await eventsOf(o.id), ["drafted", "queued"]);
        const sender = mockSender();
        await switchOn(db, sender);
        const report = await dispatchQueued(db, { config: CFG, sender });
        assert.ok(report.cancelled.some((c) => c.outreachId === o.id && c.reasons.some((r) => /invitation.*revoked/.test(r))));
        assert.deepEqual(sender.calls, []);
        const cancelled = await db.outreach.findUniqueOrThrow({ where: { id: o.id } });
        assert.deepEqual([cancelled.status, cancelled.sendStartedAt, cancelled.sendAttempts], ["cancelled", null, 0]);
        assert.deepEqual(await eventsOf(o.id), ["cancelled", "drafted", "queued"]);
      } else {
        // Revoked first: queueing was refused, and nothing about the prospect changed.
        assert.match((queued.reason as ProspectError).messages.join(" "), /invitation was revoked/);
        assert.equal(message.status, "draft");
        assert.deepEqual(await historyOf(p.id), ["null->new"]);
        assert.deepEqual(await eventsOf(o.id), ["drafted"]);
      }
    }
    assert.equal(await db.outreach.count({ where: { sendStartedAt: { not: null } } }), 0, "nothing was sent");
  });

  test("an opt-out and a status change at once, with a follow-up queued: no deadlock, it is cancelled once, and the business ends Do not contact", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { p, o: first } = await sentMessage();
      const followUp = await draft(p.id, first.id);
      await queueOutreach(db, followUp.id, CFG);
      const before = await historyOf(p.id);

      const [optOut, lost] = await Promise.allSettled([unsubscribeOutreach(db, first.id, "by a test"), changeStatus(db, p.id, "lost", "Said no.")]);
      onlyRefusals([optOut, lost]);
      assert.equal(optOut.status, "fulfilled");
      assert.equal((optOut as PromiseFulfilledResult<{ result: string }>).value.result, "recorded");

      assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: p.id } })).status, "do_not_contact");
      assert.ok(await db.emailSuppression.findUnique({ where: { email: first.recipientEmail } }), "the address is suppressed");
      const f = await db.outreach.findUniqueOrThrow({ where: { id: followUp.id } });
      assert.equal(f.status, "cancelled");
      assert.equal(f.sendStartedAt, null);
      assert.deepEqual(await eventsOf(followUp.id), ["cancelled", "drafted", "queued"], "cancelled exactly once");
      assert.deepEqual((await eventsOf(first.id)).filter((e) => e === "unsubscribed"), ["unsubscribed"], "the opt-out is logged once");

      const added = (await historyOf(p.id)).filter((h) => !before.includes(h));
      if (lost.status === "fulfilled") assert.deepEqual(added, ["contacted->lost", "lost->do_not_contact"], "Lost first, then the opt-out");
      else assert.deepEqual(added, ["contacted->do_not_contact"], "the opt-out first; Lost was then refused, changing nothing");
    }
    assert.equal(await db.outreach.count({ where: { sentAt: { not: null } } }), ROUNDS, "only the first messages were ever sent");
  });
});
