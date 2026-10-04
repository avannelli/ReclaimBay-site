import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import { format } from "node:util";
import { createContentLogger } from "../../src/logging.js";
import { dispatchQueued } from "../../src/outreach/dispatch.js";
import type { OutgoingMessage } from "../../src/outreach/sender.js";
import { revokeInvitation } from "../../src/invitations/service.js";
import { invitationUrl } from "../../src/invitations/tokens.js";
import { unsubscribeUrl } from "../../src/outreach/compliance.js";
import { createOutreachDraft, queueOutreach } from "../../src/outreach/service.js";
import { addEvidence, createProspect } from "../../src/prospects.js";
import { freshDb, readyForm, skipReason, TEST_DATABASE_URL, truncate } from "./helpers.js";
import { CFG, draftedInvitation, mockSender, OPTS, switchOn } from "./outreachHelpers.js";

describe("invitation/unsubscribe logging with real PostgreSQL", { skip: skipReason }, () => {
  let db: Db;
  let app: FastifyInstance;
  const lines: string[] = [];
  const config = loadConfig({ DATABASE_URL: TEST_DATABASE_URL || "postgresql://unused/unused", TRUST_PROXY_HOPS: "0", ALLOWED_ORIGIN: OPTS.siteUrl });
  before(async () => {
    db = await freshDb();
    app = await buildApp(config, db, true, { logStream: { write: (line) => { lines.push(line); } } });
  });
  beforeEach(async () => { await truncate(db); lines.length = 0; });
  after(async () => { await app?.close(); await db?.$disconnect(); });

  async function fixture() {
    const site = "https://logging-shop.example";
    const prospect = await createProspect(db, readyForm({ website: site, phoneSourceUrl: `${site}/contact`, email: "service@logging-shop.example", emailSourceUrl: `${site}/contact` }));
    await addEvidence(db, prospect.id, { signalKey: "independent_shop", sourceUrl: `${site}/about`, excerpt: "Family owned." });
    const outreach = (await createOutreachDraft(db, prospect.id, OPTS)).outreach;
    const invitation = await draftedInvitation(db, outreach);
    assert.ok(outreach.unsubscribeToken);
    return { prospect, outreach, invitation, unsubscribeToken: outreach.unsubscribeToken };
  }

  function checkLogs(f: Awaited<ReturnType<typeof fixture>>, output = lines) {
    let text = output.join("");
    // Independently inspect recoverable representations, including JSON's
    // escaped backslashes, rather than checking only the raw token spelling.
    for (let i = 0; i < 16; i++) {
      const decoded = text.replace(/%([0-9a-f]{2})|\\+u([0-9a-f]{4})/gi, (_escape, percent: string | undefined, unicode: string | undefined) => String.fromCharCode(Number.parseInt((percent ?? unicode)!, 16)))
        .replace(/\\+\//g, "/");
      if (decoded === text) break;
      text = decoded;
    }
    for (const secret of [f.invitation.token, f.unsubscribeToken, invitationUrl(OPTS.siteUrl, f.invitation.token), unsubscribeUrl("https://api.reclaimbay.example", f.unsubscribeToken)]) {
      assert.ok(!text.includes(secret), "no token or complete sensitive URL reaches the log destination");
    }
    const records = output.map((line) => JSON.parse(line));
    assert.ok(records.some((line) => line.msg === "incoming request"));
    assert.ok(records.some((line) => line.msg === "request completed" && typeof line.responseTime === "number"));
    return records;
  }

  test("active and revoked invitations still behave correctly with logging enabled", async () => {
    const f = await fixture();
    const sessionId = randomUUID();
    const open = () => app.inject({ method: "POST", url: `/api/invitations/open?token=${f.invitation.token}`, payload: { token: f.invitation.token, sessionId } });
    const active = await open();
    assert.equal(active.statusCode, 200);
    assert.deepEqual(active.json(), { active: true, businessName: f.prospect.businessName });
    assert.equal((await db.invitation.findUniqueOrThrow({ where: { id: f.invitation.invitation.id } })).openCount, 1);
    assert.equal((await db.analyticsSession.findUniqueOrThrow({ where: { anonymousSessionId: sessionId } })).invitationId, f.invitation.invitation.id);
    await revokeInvitation(db, f.invitation.invitation.id);
    assert.deepEqual((await open()).json(), { active: false });
    const records = checkLogs(f);
    assert.ok(records.some((line) => line.req?.method === "POST" && line.req.url === "/api/invitations/open"));
    assert.equal((await db.outreach.findUniqueOrThrow({ where: { id: f.outreach.id } })).status, "draft");
    assert.equal(await db.outreachControlChange.count(), 0);
  });

  test("GET is read-only; one-click POST suppresses and invalidates the invitation, idempotently", async () => {
    const f = await fixture();
    const url = `/u/${f.unsubscribeToken}?token=${f.invitation.token}`;
    const page = await app.inject({ method: "GET", url });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /<form method="post">/);
    assert.equal(await db.emailSuppression.count(), 0);
    const post = () => app.inject({ method: "POST", url, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "List-Unsubscribe=One-Click" });
    const unsubscribed = await post();
    assert.equal(unsubscribed.statusCode, 200);
    assert.match(unsubscribed.body, /You're unsubscribed/);
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: f.prospect.id } })).status, "do_not_contact");
    assert.equal((await db.emailSuppression.findUniqueOrThrow({ where: { email: f.prospect.email! } })).reason, "unsubscribed");
    assert.equal((await post()).body, unsubscribed.body);
    assert.equal(await db.outreachEvent.count({ where: { outreachId: f.outreach.id, type: "unsubscribed" } }), 1);
    assert.deepEqual((await app.inject({ method: "POST", url: "/api/invitations/open", payload: { token: f.invitation.token } })).json(), { active: false });
    const records = checkLogs(f);
    assert.ok(records.some((line) => line.req?.url === "/u/:token" && line.req.method === "GET"));
    assert.ok(records.some((line) => line.msg === "outreach unsubscribe" && line.result === "recorded"));
    assert.ok(records.some((line) => line.res?.statusCode === 200));
    assert.equal(await db.outreachControlChange.count(), 0, "no sending switch was touched");
  });

  test("database failures on both real routes retain safe diagnostics without URLs/tokens", async () => {
    const f = await fixture();
    const failure = Object.assign(new Error(`database failure for ${invitationUrl(OPTS.siteUrl, f.invitation.token)} and ${unsubscribeUrl("https://api.reclaimbay.example", f.unsubscribeToken)}`), { code: "P2024" });
    // Inject only the failed queries, keeping the migrated real client and
    // routes. No schema, database configuration, or production data changes.
    const failedDb = db.$extends({ query: {
      invitation: { findUnique: async () => { throw failure; } },
      outreach: { findUnique: async () => { throw failure; } },
    } }) as unknown as Db;
    const failed = await buildApp(config, failedDb, true, { logStream: { write: (line) => { lines.push(line); } } });
    try {
      assert.equal((await failed.inject({ method: "POST", url: `/api/invitations/open?token=${f.invitation.token}`, payload: { token: f.invitation.token } })).statusCode, 500);
      assert.equal((await failed.inject({ method: "POST", url: `/u/${f.unsubscribeToken}` })).statusCode, 500);
      const records = checkLogs(f);
      assert.ok(records.some((line) => line.msg === "invitation open failed" && line.err.code === "P2024"));
      assert.ok(records.some((line) => line.res?.statusCode === 500 && line.err?.code === "P2024" && line.err.stack));
      assert.equal(await db.emailSuppression.count(), 0, "a failed unsubscribe made no partial change");
    } finally { await failed.close(); }
  });

  test("stored short, UUID-shaped and maximum-length unsubscribe tokens still work without logging them", async () => {
    const f = await fixture();
    for (const token of ["short-private_16", "12345678-1234-1234-1234-123456789abc", "X".repeat(64)]) {
      // Use actual accepted tokens in the disposable database, without
      // queuing a draft or invoking a sender.
      await db.outreach.update({ where: { id: f.outreach.id }, data: { unsubscribeToken: token } });
      f.unsubscribeToken = token;
      lines.length = 0;
      const encoded = [...token].map((char) => `%${char.charCodeAt(0).toString(16)}`).join("");
      const url = `/u/${encoded}?token=${encodeURIComponent(f.invitation.token)}`;
      assert.equal((await app.inject({ method: "GET", url })).statusCode, 200);
      assert.equal((await app.inject({ method: "POST", url })).statusCode, 200);
      checkLogs(f);
      assert.equal(await db.outreachEvent.count({ where: { outreachId: f.outreach.id, type: "unsubscribed" } }), 1);
    }
    assert.equal(await db.outreachControlChange.count(), 0);
  });

  test("real invitation/unsubscribe error destinations remove mixed encodings of stored tokens", async () => {
    const f = await fixture();
    const percent = (token: string) => [...token].map((char) => `%${char.charCodeAt(0).toString(16)}`).join("");
    const unicode = (token: string) => [...token].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    const variants = [
      (token: string) => token,
      percent,
      (token: string) => encodeURIComponent(percent(token)),
      unicode,
      (token: string) => encodeURIComponent(unicode(token)),
      (token: string) => encodeURIComponent(encodeURIComponent(unicode(token))),
      (token: string) => [...token].map((char, i) => [char, percent(char), unicode(char), encodeURIComponent(unicode(char))][i % 4]).join(""),
      (token: string) => encodeURIComponent(JSON.stringify(unicode(token)).slice(1, -1)),
    ];
    let encode = variants[0]!;
    const failedDb = db.$extends({ query: {
      invitation: { findUnique: async () => {
        throw Object.assign(new Error("invitation lookup failed"), { name: encode(f.invitation.token), code: "P2024" });
      } },
      outreach: { findUnique: async () => {
        const echo = encode(f.unsubscribeToken);
        throw Object.assign(new Error(`lookup diagnostic ${echo}suffix`, { cause: new Error(echo) }), { code: "P2024", context: [{ echo }, JSON.stringify({ echo })] });
      } },
    } }) as unknown as Db;
    const failed = await buildApp(config, failedDb, true, { logStream: { write: (line) => { lines.push(line); } } });
    try {
      for (encode of variants) {
        lines.length = 0;
        assert.equal((await failed.inject({ method: "POST", url: "/api/invitations/open", payload: { token: f.invitation.token } })).statusCode, 500);
        assert.equal((await failed.inject({ method: "POST", url: `/u/${f.unsubscribeToken}` })).statusCode, 500);
        const records = checkLogs(f);
        assert.ok(records.some((line) => line.msg === "invitation open failed" && line.err.name === "[redacted]" && line.err.code === "P2024"));
        assert.ok(records.some((line) => line.res?.statusCode === 500 && line.err?.code === "P2024" && line.err.stack.includes("lookup diagnostic [redacted]suffix")));
      }
      assert.equal(await db.emailSuppression.count(), 0);
      assert.equal((await db.outreach.findUniqueOrThrow({ where: { id: f.outreach.id } })).status, "draft");
      assert.equal(await db.outreachControlChange.count(), 0);
    } finally { await failed.close(); }
  });

  test("CLI content observation preserves the dispatcher payload/results and protects bare provider echoes", async (t) => {
    const consoleLines: string[] = [];
    t.mock.method(console, "log", (line: string) => consoleLines.push(line));
    // Existing integration fixtures enable only the disposable database's
    // mock sender. Block fetch as an additional check: no email/network.
    t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected network"); });
    for (const outcome of ["accepted", "rejected", "observer-error"] as const) {
      await truncate(db);
      const f = await fixture();
      const content = createContentLogger();
      const messageId = "provider-safe-" + "C".repeat(64);
      const sender = mockSender(() => outcome === "rejected"
        ? { status: "rejected", reason: `echoed ${f.invitation.token} ${f.unsubscribeToken}suffix` }
        : { status: "accepted", providerMessageId: messageId });
      await queueOutreach(db, f.outreach.id, CFG);
      await switchOn(db, sender);
      let observed: Readonly<OutgoingMessage> | undefined;
      const report = await dispatchQueued(db, { config: CFG, sender, observeMessage(message) {
        observed = message;
        content.remember(message);
        if (outcome === "observer-error") throw new Error("diagnostic failure");
      } });
      assert.equal(sender.calls.length, 1);
      assert.equal(observed, sender.calls[0], "same payload object reaches the original provider");
      assert.equal(sender.calls[0]!.text, f.outreach.body);
      if (outcome === "rejected") {
        assert.deepEqual(report.failed, [{ outreachId: f.outreach.id, reason: `echoed ${f.invitation.token} ${f.unsubscribeToken}suffix` }]);
        content.console.log(report.failed);
      } else {
        assert.deepEqual(report.sent, [{ outreachId: f.outreach.id, providerMessageId: messageId }]);
        content.console.log(report.sent);
        assert.ok(consoleLines.at(-1)!.includes(messageId));
      }
      assert.ok(!consoleLines.join("").includes(f.invitation.token));
      assert.ok(!consoleLines.join("").includes(f.unsubscribeToken));
      assert.ok(!format(content.error(new Error(f.invitation.token))).includes(f.invitation.token));
    }
  });
});
