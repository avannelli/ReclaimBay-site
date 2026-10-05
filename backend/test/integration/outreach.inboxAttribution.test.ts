import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import type { Prisma } from "../../src/generated/prisma/client.js";
import { pollGmailInbox } from "../../src/outreach/gmailInbox.js";
import { inboxLogLines } from "../../src/outreach/inboxLog.js";
import { outreachMetrics } from "../../src/outreach/metrics.js";
import { createOutreachDraft } from "../../src/outreach/service.js";
import { addEvidence, createProspect } from "../../src/prospects.js";
import { aliasGoogle, fakeGmail, inbound, type FakeGoogle } from "../fixtures/fakeGmail.js";
import { freshDb, readyForm, skipReason, TEST_DATABASE_URL, truncate } from "./helpers.js";
import { OPTS } from "./outreachHelpers.js";

const AT = new Date("2026-10-16T12:00:00Z");
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }

describe("non-unsubscribe Inbox attribution (PostgreSQL/fake Gmail)", { skip: skipReason }, () => {
  let db: Db; let seq = 0;
  const boxes: FakeGoogle[] = [];
  const realFetch = globalThis.fetch;
  before(async () => { db = await freshDb(); });
  beforeEach(async () => { await truncate(db); boxes.length = 0; globalThis.fetch = (async () => { throw new Error("Real network forbidden."); }) as typeof fetch; });
  afterEach(async () => { globalThis.fetch = realFetch; assert.ok(boxes.every((g) => g.sendCalls.length === 0)); assert.equal(await db.outreachControlChange.count(), 0); });
  after(async () => { await db?.$disconnect(); });
  async function sent() {
    const n = ++seq; const site = `https://inbox${n}.example.com`;
    const p = await createProspect(db, readyForm({ businessName: `Inbox ${n} Auto`, website: site, email: `owner@inbox${n}.example.com`, emailSourceUrl: `${site}/contact`, phoneSourceUrl: `${site}/contact` }));
    await addEvidence(db, p.id, { signalKey: "independent_shop", sourceUrl: `${site}/about`, excerpt: "Family owned." });
    const draft = (await createOutreachDraft(db, p.id, OPTS)).outreach;
    const o = await db.outreach.update({ where: { id: draft.id }, data: { status: "sent", provider: "gmail", providerMessageId: `out-${draft.id}`, sentAt: new Date(AT.getTime() - 120_000 + n * 10), openForProspectId: null } });
    await db.prospect.update({ where: { id: p.id }, data: { status: "contacted" } });
    return { p, o };
  }
  function box(rows: Awaited<ReturnType<typeof sent>>[]) {
    const f = fakeGmail(aliasGoogle()); boxes.push(f.google);
    for (const { o } of rows) f.google.sent.push({ id: o.providerMessageId!, threadId: "shared", raw: "", marker: o.id });
    return f;
  }
  const poll = (f: ReturnType<typeof box>, apply = true) => pollGmailInbox(db, f.client, { apply, now: () => AT });
  const row = (id: string) => db.outreach.findUniqueOrThrow({ where: { id } });
  function reply(f: ReturnType<typeof box>, from: string, headers: Record<string, string> = {}, text = "Reply", id = "reply") {
    f.google.inbox.push(inbound(id, "shared", { From: from, Subject: "Re: Hello", ...headers }, text ? [{ mimeType: "text/plain", text }] : [], text, AT));
  }
  function bounce(f: ReturnType<typeof box>, recipient: string | null, text = "", id = "bounce") {
    f.google.inbox.push(inbound(id, "shared", { From: "mailer-daemon@example.com", Subject: "Delivery failure" }, [{ mimeType: "message/delivery-status", text: `Action: failed\nStatus: 5.1.1\n${recipient ? `Final-Recipient: rfc822; ${recipient}\n` : ""}${text}` }], "", AT));
  }
  async function untouched(ids: string[]) {
    assert.equal(await db.emailSuppression.count(), 0); assert.equal(await db.outreachReply.count(), 0);
    assert.equal(await db.outreachEvent.count({ where: { type: { in: ["bounced", "replied", "unsubscribed"] } } }), 0);
    for (const id of ids) assert.equal((await row(id)).status, "sent");
  }

  for (const kind of ["reply", "bounce"] as const) {
    test(`audit regression: A ${kind}, newer B in same thread, records only A`, async () => {
      const a = await sent(); const b = await sent(); const f = box([a, b]);
      assert.ok(b.o.sentAt! > a.o.sentAt!);
      if (kind === "reply") reply(f, a.p.email!);
      else bounce(f, a.p.email!, `X-ReclaimBay-Outreach: ${a.o.id}`);
      const first = (await poll(f)).items[0]!; assert.equal(first.outreachId, a.o.id); assert.equal(first.result, "recorded");
      assert.equal((await row(b.o.id)).status, "sent");
      assert.equal(await db.outreachReply.count({ where: { outreachId: b.o.id } }), 0);
      assert.equal(await db.emailSuppression.findUnique({ where: { email: b.p.email! } }), null);
      if (kind === "reply") assert.equal(await db.outreachReply.count({ where: { outreachId: a.o.id } }), 1);
      else assert.ok(await db.emailSuppression.findUnique({ where: { email: a.p.email! } }));
      assert.equal((await poll(f)).items[0]!.result, "duplicate");
    });
    test(`concurrent ${kind} ingestion records one identity/event`, async () => {
      const a = await sent(); const f = box([a]);
      if (kind === "reply") reply(f, a.p.email!); else bounce(f, a.p.email!);
      const results = await Promise.all([poll(f), poll(f)]);
      assert.deepEqual(results.map((r) => r.items[0]!.result).sort(), ["duplicate", "recorded"]);
      assert.equal(await db.outreachEvent.count({ where: { outreachId: a.o.id, type: kind === "reply" ? "replied" : "bounced" } }), 1);
      assert.equal(await db.emailSuppression.count(), kind === "bounce" ? 1 : 0);
    });
    test(`single-prospect ${kind} retains its normal behavior`, async () => {
      const a = await sent(); const f = box([a]);
      if (kind === "reply") reply(f, a.p.email!); else bounce(f, a.p.email!);
      assert.equal((await poll(f)).items[0]!.result, "recorded");
      assert.equal((await row(a.o.id)).status, kind === "reply" ? "replied" : "bounced");
    });
  }
  test("delegated reply with a verified SMTP parent identifies A among two prospects", async () => {
    const a = await sent(); const b = await sent(); const f = box([a, b]);
    reply(f, "delegate@shop.example", { "In-Reply-To": `<${a.o.providerMessageId}@fake.gmail.example>` });
    assert.equal((await poll(f)).items[0]!.outreachId, a.o.id);
    assert.equal(await db.outreachReply.count({ where: { outreachId: a.o.id } }), 1);
    assert.equal(await db.outreachReply.count({ where: { outreachId: b.o.id } }), 0);
  });
  test("delegated reply with a unique quoted marker retains supported behavior", async () => {
    const a = await sent(); const f = box([a]); reply(f, "delegate@shop.example", {}, `X-ReclaimBay-Outreach: ${a.o.id}`);
    assert.equal((await poll(f)).items[0]!.result, "recorded");
  });
  test("a verified manual Gmail parent in a unique prospect conversation supports a delegate", async () => {
    const a = await sent(); const f = box([a]);
    f.google.sent.push({ id: "manual-parent", threadId: "shared", marker: null, raw: "" });
    reply(f, "delegate@shop.example", { "In-Reply-To": "<manual-parent@fake.gmail.example>" });
    assert.equal((await poll(f)).items[0]!.result, "recorded");
    assert.equal(await db.outreachReply.count({ where: { outreachId: a.o.id } }), 1);
  });
  test("references can establish ancestry when the immediate parent has no Outreach record", async () => {
    const a = await sent(); const f = box([a]);
    f.google.sent.push({ id: "manual-parent", threadId: "shared", marker: null, raw: "" });
    reply(f, "delegate@shop.example", { "In-Reply-To": "<manual-parent@fake.gmail.example>", References: `<${a.o.providerMessageId}@fake.gmail.example>` });
    assert.equal((await poll(f)).items[0]!.result, "recorded");
  });
  for (const kind of ["reply", "bounce"] as const) {
    test(`bare shared-thread ${kind} has no attribution, repeatedly and concurrently`, async () => {
      const a = await sent(); const b = await sent(); const f = box([a, b]);
      if (kind === "reply") reply(f, "unknown@shop.example"); else bounce(f, null);
      const before = await outreachMetrics(db);
      const results = await Promise.all([poll(f), poll(f)]); await poll(f);
      assert.ok(results.every((r) => ["unresolved", "ambiguous"].includes(r.items[0]!.result)));
      assert.ok(results.every((r) => r.items[0]!.outreachId === null));
      assert.equal(results[0]!.items[0]!.gmailId, kind);
      await untouched([a.o.id, b.o.id]); assert.deepEqual(await outreachMetrics(db), before);
      assert.equal(await db.emailedUnsubscribeReview.count(), 0);
      const lines = inboxLogLines(results[0]!, { apply: true, mailbox: f.client.account }).join("\n");
      assert.match(lines, /Inbox needs operator review/); assert.ok(lines.includes(a.o.id)); assert.ok(lines.includes(b.o.id));
      assert.ok(!lines.includes("unknown@shop.example")); assert.ok(!lines.includes("Reply"));
    });
    test(`bare single-prospect thread alone is insufficient for ${kind}`, async () => {
      const a = await sent(); const f = box([a]);
      if (kind === "reply") reply(f, "unknown@shop.example"); else bounce(f, null);
      assert.equal((await poll(f)).items[0]!.result, "unresolved"); await untouched([a.o.id]);
    });
  }
  for (const fault of ["sender_vs_marker", "recipient_vs_marker", "parent_vs_marker", "two_markers", "two_dsn_recipients", "two_parent_targets"] as const) {
    test(`contradictory/plural evidence (${fault}) fails closed`, async () => {
      const a = await sent(); const b = await sent(); const f = box([a, b]);
      if (fault === "sender_vs_marker") reply(f, b.p.email!, {}, `X-ReclaimBay-Outreach: ${a.o.id}`);
      if (fault === "recipient_vs_marker") bounce(f, b.p.email!, `X-ReclaimBay-Outreach: ${a.o.id}`);
      if (fault === "parent_vs_marker") reply(f, "delegate@shop.example", { "In-Reply-To": `<${b.o.providerMessageId}@fake.gmail.example>` }, `X-ReclaimBay-Outreach: ${a.o.id}`);
      if (fault === "two_markers") reply(f, a.p.email!, {}, `X-ReclaimBay-Outreach: ${a.o.id}\nX-ReclaimBay-Outreach: ${b.o.id}`);
      if (fault === "two_dsn_recipients") bounce(f, a.p.email!, `Original-Recipient: rfc822; ${b.p.email}`);
      if (fault === "two_parent_targets") reply(f, "delegate@shop.example", { "In-Reply-To": `<${a.o.providerMessageId}@fake.gmail.example> <${b.o.providerMessageId}@fake.gmail.example>` });
      const r = (await poll(f)).items[0]!;
      assert.ok(["unresolved", "ambiguous"].includes(r.result)); assert.equal(r.outreachId, null); await untouched([a.o.id, b.o.id]);
    });
  }
  for (const source of ["marker", "sender", "parent"] as const) {
    test(`${source} A conflicts with a thread containing only B; no blind override`, async () => {
      const a = await sent(); const b = await sent(); const f = box([a, b]); f.google.sent[0]!.threadId = "another-thread";
      reply(f, source === "sender" ? a.p.email! : "delegate@shop.example", source === "parent" ? { "In-Reply-To": `<${a.o.providerMessageId}@fake.gmail.example>` } : {}, source === "marker" ? `X-ReclaimBay-Outreach: ${a.o.id}` : "Reply");
      assert.equal((await poll(f)).items[0]!.result, "unresolved"); await untouched([a.o.id, b.o.id]);
    });
  }
  test("new-thread sender identity plus received time still records the unique candidate", async () => {
    const a = await sent(); const f = box([a]); reply(f, a.p.email!); f.google.inbox[0]!.threadId = "new-thread";
    assert.equal((await poll(f)).items[0]!.result, "recorded");
  });
  test("DSN returned RFC identity and recipient corroborate A, not newest B", async () => {
    const a = await sent(); const b = await sent(); const f = box([a, b]);
    bounce(f, a.p.email!, `Message-ID: <${a.o.providerMessageId}@fake.gmail.example>`);
    assert.equal((await poll(f)).items[0]!.outreachId, a.o.id);
    assert.equal(await db.emailSuppression.findUnique({ where: { email: b.p.email! } }), null);
  });
  test("duplicate References cannot hide another prospect's parent", async () => {
    const a = await sent(); const b = await sent(); const f = box([a, b]);
    reply(f, "delegate@shop.example", { References: `<${a.o.providerMessageId}@fake.gmail.example>` });
    f.google.inbox[0]!.payload!.headers!.push({ name: "References", value: `<${b.o.providerMessageId}@fake.gmail.example>` });
    assert.equal((await poll(f)).items[0]!.result, "unresolved"); await untouched([a.o.id, b.o.id]);
  });
  for (const field of ["Final-Recipient: x400; unknown", "Original-Recipient:", "Final-Recipient: rfc822; not an address"] as const) {
    test(`invalid DSN recipient cannot be discarded in favor of a marker: ${field}`, async () => {
      const a = await sent(); const b = await sent(); const f = box([a, b]);
      bounce(f, null, `X-ReclaimBay-Outreach: ${a.o.id}\n${field}`);
      assert.equal((await poll(f)).items[0]!.result, "unresolved"); await untouched([a.o.id, b.o.id]);
    });
  }
  test("malformed parent cannot hide a conflicting message identity", async () => {
    const a = await sent(); const b = await sent(); const f = box([a, b]);
    reply(f, a.p.email!, { "In-Reply-To": `<${a.o.providerMessageId}@fake.gmail.example> <${b.o.providerMessageId}@fake.gmail.example` });
    assert.equal((await poll(f)).items[0]!.result, "unresolved"); await untouched([a.o.id, b.o.id]);
  });
  test("bounce suppression uses the locked identity, never an intermediate recipient snapshot", async () => {
    const a = await sent(); const b = await sent(); const f = box([a, b]);
    bounce(f, a.p.email!, `X-ReclaimBay-Outreach: ${a.o.id}`);
    let changed = false;
    const wrapped = new Proxy(db, { get(target, key) {
      if (key === "outreach") return new Proxy(target.outreach, { get(delegate, method) {
        if (method !== "findUnique") return Reflect.get(delegate, method);
        return async (args: Parameters<typeof delegate.findUnique>[0]) => {
          if (args.where.providerMessageId === a.o.providerMessageId && !changed) {
            changed = true;
            await db.outreach.update({ where: { id: a.o.id }, data: { recipientEmail: b.p.email! } });
          }
          return delegate.findUnique(args);
        };
      } });
      if (key === "$transaction") return async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
        await db.outreach.update({ where: { id: a.o.id }, data: { recipientEmail: a.p.email! } });
        return target.$transaction(work);
      };
      return Reflect.get(target, key);
    } });
    assert.equal((await pollGmailInbox(wrapped, f.client, { apply: true })).items[0]!.result, "recorded");
    assert.ok(changed); assert.ok(await db.emailSuppression.findUnique({ where: { email: a.p.email! } }));
    assert.equal(await db.emailSuppression.findUnique({ where: { email: b.p.email! } }), null);
    assert.equal((await row(b.o.id)).status, "sent");
  });
  test("a delivery report sent by another known prospect is conflicting evidence, not suppression authorization", async () => {
    const a = await sent(); const b = await sent(); const f = box([a, b]);
    bounce(f, a.p.email!, `X-ReclaimBay-Outreach: ${a.o.id}`);
    f.google.inbox[0]!.payload!.headers!.find((h) => h.name === "From")!.value = b.p.email!;
    f.google.inbox[0]!.payload!.headers!.push({ name: "Content-Type", value: 'multipart/report; report-type="delivery-status"' });
    assert.equal((await poll(f)).items[0]!.result, "unresolved"); await untouched([a.o.id, b.o.id]);
  });
  test("multiple messages for one recipient require a direct parent, never newest", async () => {
    const a = await sent();
    const draft = (await createOutreachDraft(db, a.p.id, { ...OPTS, followUpOfId: a.o.id })).outreach;
    const o = await db.outreach.update({ where: { id: draft.id }, data: { status: "sent", sentAt: new Date(AT.getTime() - 1), openForProspectId: null, provider: "gmail", providerMessageId: `out-${draft.id}` } });
    const f = box([a, { p: a.p, o }]); reply(f, a.p.email!);
    assert.equal((await poll(f)).items[0]!.result, "ambiguous");
    f.google.inbox[0]!.payload!.headers!.push({ name: "In-Reply-To", value: `<${a.o.providerMessageId}@fake.gmail.example>` });
    assert.equal((await poll(f)).items[0]!.outreachId, a.o.id);
  });
  test("distinct replies keep chronological records and one message-level funnel count", async () => {
    const a = await sent(); const f = box([a]); reply(f, a.p.email!); reply(f, a.p.email!, {}, "Second reply", "reply-2");
    f.google.inbox[1]!.internalDate = String(AT.getTime() + 1);
    assert.ok((await poll(f)).items.every((r) => r.result === "recorded"));
    assert.deepEqual((await db.outreachReply.findMany({ orderBy: { receivedAt: "asc" } })).map((r) => r.gmailMessageId), ["reply", "reply-2"]);
    assert.equal((await outreachMetrics(db)).at(-1)!.replied, 1); assert.equal(await db.emailSuppression.count(), 0);
  });
  for (const fault of ["missing_time", "historical", "duplicate_from", "malformed_dsn", "reference_bound", "lookup_failure", "incomplete_lookup"] as const) {
    test(`${fault} cannot authorize attribution`, async () => {
      const a = await sent(); const f = box([a]);
      if (fault === "malformed_dsn") bounce(f, "not an address");
      else reply(f, fault === "lookup_failure" || fault === "incomplete_lookup" ? "delegate@shop.example" : a.p.email!, { "In-Reply-To": `<${a.o.providerMessageId}@fake.gmail.example>` });
      if (fault === "missing_time") delete f.google.inbox[0]!.internalDate;
      if (fault === "historical") f.google.inbox[0]!.internalDate = String(a.o.sentAt!.getTime() - 1);
      if (fault === "duplicate_from") f.google.inbox[0]!.payload!.headers!.push({ name: "From", value: "other@shop.example" });
      if (fault === "reference_bound") f.google.inbox[0]!.payload!.headers!.find((h) => h.name === "In-Reply-To")!.value = Array.from({ length: 21 }, (_, n) => `<id-${n}@example.com>`).join(" ");
      if (fault === "lookup_failure") { const get = f.client.getMessage.bind(f.client); f.client.getMessage = async (id, format, headers) => { if (format === "metadata") throw new Error(`private provider content ${a.o.body}`); return get(id, format, headers); }; }
      if (fault === "incomplete_lookup") { const list = f.client.listMessages.bind(f.client); f.client.listMessages = async (q) => q.q?.startsWith("rfc822msgid:") ? { messages: [{ id: a.o.providerMessageId!, threadId: "shared" }], nextPageToken: "more" } : list(q); }
      assert.ok(["unresolved", "unmatched"].includes((await poll(f)).items[0]!.result)); await untouched([a.o.id]);
    });
  }
  function pauseRecording() {
    const reached = deferred(); const release = deferred();
    const paused = new Proxy(db, { get(target, key) {
      if (key !== "$transaction") return Reflect.get(target, key);
      return async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => { reached.resolve(); await release.promise; return target.$transaction(work); };
    } });
    return { reached, release, paused };
  }
  for (const kind of ["reply", "bounce"] as const) {
    for (const field of ["recipient", "prospect", "time", "status"] as const) {
      test(`${kind} rechecks changed ${field} before recording`, async () => {
        const a = await sent(); const b = await sent(); const f = box([a]);
        if (kind === "reply") reply(f, a.p.email!, { "In-Reply-To": `<${a.o.providerMessageId}@fake.gmail.example>` });
        else bounce(f, a.p.email!, `X-ReclaimBay-Outreach: ${a.o.id}`);
        const p = pauseRecording(); const run = pollGmailInbox(p.paused, f.client, { apply: true }); await p.reached.promise;
        const data = field === "recipient" ? { recipientEmail: "changed@shop.example" } : field === "prospect" ? { prospectId: b.p.id } : field === "time" ? { sentAt: new Date(AT.getTime() + 1) } : { status: "cancelled" as const };
        await db.outreach.update({ where: { id: a.o.id }, data }); p.release.resolve();
        const r = (await run).items[0]!; assert.equal(r.result, "unresolved"); assert.equal(r.outreachId, null);
        assert.equal(await db.outreachReply.count(), 0); assert.equal(await db.emailSuppression.count(), 0);
        assert.equal((await row(b.o.id)).status, "sent");
      });
    }
  }
  test("a candidate becoming known during recording is included in the locked recheck", async () => {
    const a = await sent(); const b = await sent(); const f = box([a, b]);
    await db.outreach.update({ where: { id: b.o.id }, data: { providerMessageId: null, sentAt: null, recipientEmail: a.p.email! } });
    reply(f, a.p.email!); const p = pauseRecording(); const run = pollGmailInbox(p.paused, f.client, { apply: true }); await p.reached.promise;
    await db.outreach.update({ where: { id: b.o.id }, data: { providerMessageId: b.o.providerMessageId, sentAt: b.o.sentAt } }); p.release.resolve();
    assert.equal((await run).items[0]!.result, "ambiguous"); await untouched([a.o.id, b.o.id]);
  });
  test("Gmail reads occur outside the send gate, and recording waits for it", async () => {
    const a = await sent(); const f = box([a]); reply(f, a.p.email!);
    const held = deferred(); const release = deferred(); const atGate = deferred();
    const hold = db.$transaction(async (tx) => { await tx.$executeRaw`SELECT pg_advisory_xact_lock(73160201)`; held.resolve(); await release.promise; }, { timeout: 30_000 }); await held.promise;
    const wrapped = new Proxy(db, { get(target, key) {
      if (key !== "$transaction") return Reflect.get(target, key);
      return (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => target.$transaction((tx) => work(new Proxy(tx, { get(t, k) {
        if (k !== "$executeRaw") return Reflect.get(t, k);
        return (...args: unknown[]) => { atGate.resolve(); return Reflect.apply(t.$executeRaw, t, args); };
      } })));
    } });
    const run = pollGmailInbox(wrapped, f.client, { apply: true });
    try { await atGate.promise; assert.ok(f.google.calls.some((c) => c.url.includes("/threads/"))); assert.equal(await db.outreachReply.count(), 0); }
    finally { release.resolve(); await hold; }
    assert.equal((await run).items[0]!.result, "recorded");
  });
  test("recording rollback leaves no reply, event, suppression or prospect transition", async () => {
    const a = await sent(); const f = box([a]); bounce(f, a.p.email!);
    const failing = new Proxy(db, { get(target, key) {
      if (key !== "$transaction") return Reflect.get(target, key);
      return (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => target.$transaction(async (tx) => { await work(tx); throw new Error("Force rollback."); });
    } });
    await assert.rejects(pollGmailInbox(failing, f.client, { apply: true }), /Force rollback/); await untouched([a.o.id]);
  });
  test("actual destination omits private inbound content, provider IDs and token URLs", async () => {
    const a = await sent(); const b = await sent(); const f = box([a, b]);
    const token = /\/invite#([A-Za-z0-9_-]+)/.exec(a.o.body)![1]!;
    const secret = `private inbound text https://reclaimbay.com/invite#${token} https://api.example/u/${a.o.unsubscribeToken}`;
    reply(f, "private-sender@shop.example", {}, secret, "private-gmail-id");
    const report = await poll(f); const logs: string[] = [];
    const app = await buildApp(loadConfig({ DATABASE_URL: TEST_DATABASE_URL, ALLOWED_ORIGIN: OPTS.siteUrl }), db, true, { logStream: { write: (line) => { logs.push(line); } } });
    try {
      for (const line of inboxLogLines(report, { apply: true, mailbox: f.client.account })) app.log.info(line);
      const output = logs.join(""); assert.match(output, /operator review/); assert.ok(output.includes(a.o.id));
      for (const value of ["private inbound text", "private-sender@shop.example", "private-gmail-id", token, a.o.unsubscribeToken!, "https://api.example/u/"]) assert.ok(!output.includes(value));
    } finally { await app.close(); }
    await untouched([a.o.id, b.o.id]);
  });
});
