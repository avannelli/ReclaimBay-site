import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { Db } from "../../src/db.js";
import { pollGmailInbox } from "../../src/outreach/gmailInbox.js";
import { createOutreachDraft } from "../../src/outreach/service.js";
import { addEvidence, createProspect } from "../../src/prospects.js";
import { aliasGoogle, fakeGmail, inbound, type FakeGoogle } from "../fixtures/fakeGmail.js";
import { addFixtureCollisionEvidence, freshDb, readyForm, skipReason, truncate } from "./helpers.js";
import { OPTS } from "./outreachHelpers.js";

/*
 * The production incident, end to end: in one run, the message whose thread
 * Gmail refuses ("400 failedPrecondition") records nothing, and a healthy
 * message of the same kind is still recorded. When Gmail serves the thread
 * again, the next run processes it normally: nothing about the failure sticks.
 */

const AT = new Date("2026-10-16T12:00:00Z");
const FAILED_PRECONDITION = { status: 400, body: { error: { code: 400, message: "Precondition check failed.", errors: [{ reason: "failedPrecondition" }] } } };

describe("an unreadable Gmail thread (PostgreSQL/fake Gmail)", { skip: skipReason }, () => {
  let db: Db; let seq = 0;
  const boxes: FakeGoogle[] = [];
  const realFetch = globalThis.fetch;
  before(async () => { db = await freshDb(); });
  beforeEach(async () => { await truncate(db); boxes.length = 0; globalThis.fetch = (async () => { throw new Error("Real network forbidden."); }) as typeof fetch; });
  afterEach(async () => { globalThis.fetch = realFetch; assert.ok(boxes.every((g) => g.sendCalls.length === 0)); assert.equal(await db.outreachControlChange.count(), 0); });
  after(async () => { await db?.$disconnect(); });

  async function sent() {
    const n = ++seq; const site = `https://thread${n}.example.com`;
    const p = await createProspect(db, readyForm({ businessName: `Thread ${n} Auto`, website: site, email: `owner@thread${n}.example.com`, emailSourceUrl: `${site}/contact`, phoneSourceUrl: `${site}/contact` }));
    await addFixtureCollisionEvidence(db, p);
    await addEvidence(db, p.id, { signalKey: "independent_shop", sourceUrl: `${site}/about`, excerpt: "Family owned." });
    const draft = (await createOutreachDraft(db, p.id, OPTS)).outreach;
    const o = await db.outreach.update({ where: { id: draft.id }, data: { status: "sent", provider: "gmail", providerMessageId: `out-${draft.id}`, sentAt: new Date(AT.getTime() - 120_000 + n * 10), openForProspectId: null } });
    await db.prospect.update({ where: { id: p.id }, data: { status: "contacted" } });
    return { p, o };
  }

  type Kind = "reply" | "bounce" | "unsubscribe";
  /** Outreach A and B, each in its own Gmail thread, and one inbound message of `kind` answering each. A's thread can't be read. */
  async function scenario(kind: Kind) {
    const a = await sent(); const b = await sent();
    const f = fakeGmail(aliasGoogle()); boxes.push(f.google);
    for (const [x, thread] of [[a, "thread-a"], [b, "thread-b"]] as const) {
      f.google.sent.push({ id: x.o.providerMessageId!, threadId: thread, raw: "", marker: x.o.id });
      const email = x.p.email!;
      f.google.inbox.push(
        kind === "reply" ? inbound(`in-${thread}`, thread, { From: email, Subject: "Re: Hello" }, [{ mimeType: "text/plain", text: "Yes, call me" }], "Yes, call me", AT)
        : kind === "bounce" ? inbound(`in-${thread}`, thread, { From: "mailer-daemon@example.com", Subject: "Delivery failure" }, [{ mimeType: "message/delivery-status", text: `Action: failed\nStatus: 5.1.1\nFinal-Recipient: rfc822; ${email}` }], "", AT)
        : inbound(`in-${thread}`, thread, { From: email, Subject: "Re: unsubscribe" }, [], "Private inbound text", AT),
      );
    }
    f.google.threadAnswers.set("thread-a", FAILED_PRECONDITION);
    return { a, b, f };
  }
  const poll = (f: ReturnType<typeof fakeGmail>) => pollGmailInbox(db, f.client, { apply: true, now: () => AT });
  /** What the inbox recorded for one outreach: replies, bounce suppressions, opt-outs, and its status. */
  async function recorded(o: { id: string; recipientEmail: string }) {
    return {
      replies: await db.outreachReply.count({ where: { outreachId: o.id } }),
      events: (await db.outreachEvent.findMany({ where: { outreachId: o.id, type: { in: ["bounced", "replied", "unsubscribed"] } } })).map((e) => e.type).sort(),
      suppressed: await db.emailSuppression.count({ where: { email: { equals: o.recipientEmail, mode: "insensitive" } } }),
      status: (await db.outreach.findUniqueOrThrow({ where: { id: o.id } })).status,
    };
  }

  for (const kind of ["reply", "bounce", "unsubscribe"] as const) {
    test(`${kind}: the unreadable one records nothing, the healthy one in the same run is recorded, and a later readable run catches up`, async () => {
      const { a, b, f } = await scenario(kind);
      const r = await poll(f);
      assert.equal(r.checked, 2);
      assert.equal(r.unreadableThreads, 1);
      const items = Object.fromEntries(r.items.map((i) => [i.gmailId, i]));
      assert.equal(items["in-thread-a"]!.result, "unresolved");
      assert.equal(items["in-thread-a"]!.outreachId, null);
      assert.notEqual(items["in-thread-b"]!.result, "unresolved");
      assert.equal(items["in-thread-b"]!.outreachId, b.o.id);

      // A: nothing at all, though its sender alone would have pointed at it.
      assert.deepEqual(await recorded(a.o), { replies: 0, events: [], suppressed: 0, status: "sent" });
      assert.equal(await db.emailedUnsubscribeReview.count(), 0, "no review row built from partial evidence");
      // B: recorded as it would be without A's failure.
      const healthy = await recorded(b.o);
      if (kind === "reply") assert.equal(healthy.replies, 1);
      if (kind === "bounce") assert.equal(healthy.suppressed, 1);
      if (kind === "unsubscribe") assert.deepEqual(healthy.events, ["unsubscribed"]);

      // Gmail serves A's thread again: the next run processes it like any other.
      f.google.threadAnswers.clear();
      const again = await poll(f);
      assert.equal(again.unreadableThreads, 0);
      const after = await recorded(a.o);
      if (kind === "reply") assert.equal(after.replies, 1);
      if (kind === "bounce") assert.equal(after.suppressed, 1);
      if (kind === "unsubscribe") assert.deepEqual(after.events, ["unsubscribed"]);
    });
  }
});
