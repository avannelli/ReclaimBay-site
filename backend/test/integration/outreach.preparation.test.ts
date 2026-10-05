import { addFixtureCollisionEvidence } from "./helpers.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import { PREPARE_LIMIT, prepareSelectedOutreach } from "../../src/outreach/prepare.js";
import { createOutreachDraft } from "../../src/outreach/service.js";
import { ProspectError, addEvidence, createProspect } from "../../src/prospects.js";
import { TEST_DATABASE_URL, freshDb, readyForm, skipReason, truncate } from "./helpers.js";
import { CFG, OPTS, draftedInvitation, mockSender, queueAndSend } from "./outreachHelpers.js";

/*
 * Stage 5B: preparing, reviewing, queueing, and discarding drafts from the
 * admin, one at a time and in a chosen batch. Through the real admin routes,
 * against the test database. The app's email provider is a spy: nothing here
 * may ever reach it, and no admin action sends.
 */

const SECRET = "integration-test-secret-0123456789";
const FORM = { "content-type": "application/x-www-form-urlencoded" };
/** The sender identity the drafts are signed for; sending itself stays unarmed. */
const ENV = {
  DATABASE_URL: TEST_DATABASE_URL,
  ALLOWED_ORIGIN: "https://reclaimbay.com",
  ADMIN_SECRET: SECRET,
  TRUST_PROXY_HOPS: "0",
  OUTREACH_SENDER_NAME: CFG.outreachSender.name!,
  OUTREACH_SENDER_EMAIL: CFG.outreachSender.email!,
  OUTREACH_POSTAL_ADDRESS: CFG.outreachSender.postalAddress!,
  PUBLIC_API_URL: CFG.publicApiUrl!,
};
const RAW_LINK = /\/invite#[A-Za-z0-9_-]{43}/;

describe("outreach preparation and queueing", { skip: skipReason }, () => {
  let db: Db;
  let app: FastifyInstance;
  let cookie = "";
  const provider = mockSender();
  before(async () => {
    db = await freshDb();
    app = await buildApp(loadConfig(ENV), db, false, { outreachSender: provider });
    const login = await app.inject({ method: "POST", url: "/admin/login", headers: FORM, payload: new URLSearchParams({ secret: SECRET }).toString() });
    cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  });
  beforeEach(async () => {
    await truncate(db);
    provider.calls.length = 0;
  });
  after(async () => {
    // Whatever happened above, no admin action handed a message to the provider.
    assert.equal(provider.calls.length, 0, "the email provider was never called");
    await app?.close();
    await db?.$disconnect();
  });

  const get = (url: string, headers: Record<string, string> = { cookie }) => app.inject({ method: "GET", url, headers });
  const post = (url: string, body: Record<string, string> = {}, headers: Record<string, string> = { cookie }) =>
    app.inject({ method: "POST", url, headers: { ...FORM, ...headers }, payload: new URLSearchParams(body).toString() });
  const noSend = () => assert.equal(provider.calls.length, 0, "nothing was handed to the email provider");

  let seq = 0;
  const prospect = async (name: string, withEmail = true) => {
    const n = ++seq;
    const site = `https://prep${n}.example.com`;
    const p = await createProspect(
      db,
      readyForm({ businessName: name, website: site, phoneSourceUrl: `${site}/contact`, ...(withEmail ? { email: `service@prep${n}.example.com`, emailSourceUrl: `${site}/contact` } : {}) }),
    );
    await addFixtureCollisionEvidence(db, p);
    await addEvidence(db, p.id, { signalKey: "independent_shop", sourceUrl: `${site}/about`, excerpt: "Family owned since 1998." });
    return p;
  };
  /** Prepares a first draft through the admin, as the Eligible view's row button does. */
  const prepare = async (prospectId: string) => {
    const res = await post(`/admin/prospects/${prospectId}/outreach`);
    assert.equal(res.statusCode, 303, res.body.slice(0, 300));
    const id = /^\/admin\/outreach\/([0-9a-f-]{36})\?done=(drafted|existing)$/.exec(String(res.headers.location));
    assert.ok(id, String(res.headers.location));
    return { id: id[1]!, done: id[2]! };
  };
  const status = async (id: string) => (await db.outreach.findUniqueOrThrow({ where: { id } })).status;
  const discard = (id: string, body: Record<string, string> = { reason: "Not this one.", confirm: "1" }) => post(`/admin/outreach/${id}/discard`, body);

  // ---------- one draft ----------

  test("a draft is prepared from the Eligible view, written from the evidence, with its invitation, and nothing is sent", async () => {
    const p = await prospect("Harbor Lane Auto");
    const eligible = (await get("/admin/outreach/messages?view=eligible")).body;
    assert.ok(eligible.includes(`formaction="/admin/prospects/${p.id}/outreach"`), "each row has its own Prepare draft");
    assert.ok(eligible.includes(`name="p:${p.id}"`), "and a checkbox for preparing several");

    const first = await prepare(p.id);
    assert.equal(first.done, "drafted");
    const o = await db.outreach.findUniqueOrThrow({ where: { id: first.id } });
    assert.equal(o.status, "draft");
    assert.equal(o.kind, "initial");
    assert.match(o.body, /I came across Harbor Lane Auto while researching independent shops/, "the evidenced fact, in the existing template");
    assert.ok(JSON.stringify(o.evidence).includes("independent_shop"), "the evidence it relies on is stored with it");
    await draftedInvitation(db, o); // the invitation exists, and the link carries its token
    noSend();

    const again = await prepare(p.id);
    assert.deepEqual(again, { id: first.id, done: "existing" }, "preparing again returns the open draft");
    assert.equal(await db.outreach.count(), 1);
    assert.equal(await db.invitation.count(), 1);
  });

  test("the draft's page is the review: its state, business, qualification, message, evidence, and invitation, without the token", async () => {
    const p = await prospect("Review Auto");
    const { id } = await prepare(p.id);
    const { token, invitation } = await draftedInvitation(db, await db.outreach.findUniqueOrThrow({ where: { id } }));
    const html = (await get(`/admin/outreach/${id}`)).body;
    assert.match(html, /DRAFT — NOT SENT<\/h2>/);
    assert.match(html, /<dt>Business<\/dt><dd><a href="\/admin\/prospects\/[0-9a-f-]{36}">Review Auto<\/a>/);
    assert.match(html, /<dt>Qualification<\/dt><dd>[\s\S]*?Meets criteria/);
    assert.match(html, /<dt>Template<\/dt><dd><code>intro@t2<\/code>/);
    assert.match(html, /<dt>Campaign<\/dt><dd><code>outreach-intro-t2<\/code>/);
    assert.match(html, /Quick question about Review Auto/);
    assert.match(html, /Evidence used[\s\S]*?Family owned since 1998\./);
    assert.match(html, /<h2 id="invitation-h">Invitation<\/h2>[\s\S]*?Not opened/);
    assert.match(html, /<a href="\/admin\/outreach\/messages\?status=draft">Messages<\/a>/, "back to the drafts in the Operations Center");
    assert.match(html, /<form method="post" action="\/admin\/outreach\/[0-9a-f-]{36}\/queue"/);
    for (const secret of [token, invitation.tokenHash, invitation.id]) assert.ok(!html.includes(secret));
    assert.doesNotMatch(html, RAW_LINK);
  });

  // ---------- queue ----------

  test("queueing a reviewed draft queues it and sends nothing; repeating it is harmless", async () => {
    const p = await prospect("Queue Auto");
    const { id } = await prepare(p.id);
    const res = await post(`/admin/outreach/${id}/queue`);
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, `/admin/outreach/${id}?done=queued`);
    assert.equal(await status(id), "queued");
    const page = (await get(`/admin/outreach/${id}?done=queued`)).body;
    assert.match(page, /Queued\. Nothing was sent by this action/);
    assert.match(page, /QUEUED — NOT SENT BY THIS ACTION<\/h2>/);
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: p.id } })).status, "ready_to_contact");

    assert.equal((await post(`/admin/outreach/${id}/queue`)).statusCode, 303, "a second click changes nothing");
    assert.equal(await db.outreachEvent.count({ where: { outreachId: id, type: "queued" } }), 1);
    noSend();
  });

  test("queueing is refused for a cancelled draft, a prospect no longer eligible, and a revoked invitation", async () => {
    const cancelled = (await prepare((await prospect("Cancelled Auto")).id)).id;
    assert.equal((await discard(cancelled)).statusCode, 303);
    assert.equal((await post(`/admin/outreach/${cancelled}/queue`)).statusCode, 400);
    assert.equal(await status(cancelled), "cancelled");

    // Changed after the page was shown: the published email the draft was prepared for is gone.
    const p = await prospect("Changed Auto");
    const stale = (await prepare(p.id)).id;
    await db.prospect.update({ where: { id: p.id }, data: { email: "owner@elsewhere.example.com" } });
    assert.match((await get(`/admin/outreach/${stale}`)).body, /Not ready to queue/);
    const refused = await post(`/admin/outreach/${stale}/queue`);
    assert.equal(refused.statusCode, 400);
    assert.match(refused.body, /email/i);
    assert.equal(await status(stale), "draft");

    // A revoked invitation: this message's link no longer works, so it isn't queued.
    const r = await prospect("Revoked Auto");
    const revoked = (await prepare(r.id)).id;
    assert.equal((await post(`/admin/outreach/${revoked}/invitation/revoke`, { reason: "Wrong contact.", confirm: "1" })).statusCode, 303);
    assert.match((await get(`/admin/outreach/${revoked}`)).body, /Not ready to queue[\s\S]*?invitation was revoked/);
    const blocked = await post(`/admin/outreach/${revoked}/queue`);
    assert.equal(blocked.statusCode, 400);
    assert.match(blocked.body, /invitation was revoked/);
    assert.equal(await status(revoked), "draft");
    // Revoking changed nothing about the prospect: discard the draft and it can be prepared again, with a new invitation.
    const before = (await db.prospect.findUniqueOrThrow({ where: { id: r.id } })).status;
    assert.equal((await discard(revoked)).statusCode, 303);
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: r.id } })).status, before);
    const fresh = await prepare(r.id);
    assert.equal(fresh.done, "drafted");
    assert.equal(await db.invitation.count({ where: { prospectId: r.id } }), 2);
    noSend();
  });

  // ---------- discard ----------

  test("discarding needs a reason and a confirmation, keeps the invitation as it was, and never undoes a send", async () => {
    const p = await prospect("Discard Auto");
    const { id } = await prepare(p.id);

    const noReason = await discard(id, { confirm: "1" });
    assert.equal(noReason.statusCode, 400);
    assert.match(noReason.body, /Give a reason for discarding this message\./);
    const noConfirm = await discard(id, { reason: "Duplicate." });
    assert.equal(noConfirm.statusCode, 400);
    assert.match(noConfirm.body, /Confirm that this message should never be sent\./);
    assert.match(noConfirm.body, /<details class="rv-disregard" open>[\s\S]*?value="Duplicate\."/, "the form stays open with what was typed");
    assert.equal(await status(id), "draft");

    assert.equal((await discard(id, { reason: "Duplicate.", confirm: "1" })).statusCode, 303);
    const o = await db.outreach.findUniqueOrThrow({ where: { id } });
    assert.equal(o.status, "cancelled");
    assert.equal(o.cancelReason, "Duplicate.");
    assert.equal((await db.invitation.findUniqueOrThrow({ where: { outreachId: id } })).revokedAt, null, "discarding isn't revoking");

    // A queued message can still be stopped before it is sent.
    const q = (await prepare((await prospect("Stop Auto")).id)).id;
    await post(`/admin/outreach/${q}/queue`);
    assert.equal((await discard(q)).statusCode, 303);
    assert.equal(await status(q), "cancelled");

    // A sent message can't be discarded.
    const s = (await prepare((await prospect("Sent Auto")).id)).id;
    await queueAndSend(db, s, mockSender());
    assert.equal(await status(s), "sent");
    assert.equal((await discard(s)).statusCode, 400);
    assert.equal(await status(s), "sent");
    noSend();
  });

  // ---------- several at once ----------

  test("preparing chosen prospects drafts each eligible one once, skips the rest safely, and reports exactly what happened", async () => {
    const a = await prospect("Alpha Auto");
    const b = await prospect("Bravo Auto");
    const drafted = await prospect("Drafted Auto");
    await prepare(drafted.id);
    const noEmail = await prospect("No Email Auto", false);
    const unknown = randomUUID();

    const res = await post("/admin/outreach/prepare", Object.fromEntries([a, b, drafted, noEmail, { id: unknown }].map((x) => [`p:${x.id}`, "1"])));
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, "/admin/outreach/messages?view=eligible&done=prepared&prepared=2&existing=1&ineligible=2&refused=0&failed=0");
    for (const x of [a, b, drafted]) assert.equal(await db.outreach.count({ where: { prospectId: x.id } }), 1, "one draft each");
    assert.equal(await db.outreach.count({ where: { prospectId: noEmail.id } }), 0);
    assert.equal(await db.invitation.count({ where: { prospectId: noEmail.id } }), 0, "no invitation for a prospect that wasn't drafted");
    assert.equal(await db.outreach.count({ where: { status: { not: "draft" } } }), 0, "nothing was queued");

    const page = (await get(String(res.headers.location))).body;
    assert.match(page, /2 drafts prepared; 1 already had an open message; 2 aren&#39;t eligible now\. Nothing was queued or sent/);

    const again = await post("/admin/outreach/prepare", { [`p:${a.id}`]: "1", [`p:${b.id}`]: "1" });
    assert.match(String(again.headers.location), /prepared=0&existing=2/, "repeating drafts nothing new");
    assert.equal(await db.outreach.count(), 3);
    noSend();
  });

  test("a batch needs a choice, and is never larger than the limit", async () => {
    assert.equal((await post("/admin/outreach/prepare")).headers.location, "/admin/outreach/messages?view=eligible&done=prepare_none");
    const tooMany = Object.fromEntries(Array.from({ length: PREPARE_LIMIT + 1 }, () => [`p:${randomUUID()}`, "1"]));
    assert.equal((await post("/admin/outreach/prepare", tooMany)).headers.location, "/admin/outreach/messages?view=eligible&done=prepare_too_many");
    assert.match((await get("/admin/outreach/messages?view=eligible&done=prepare_too_many")).body, new RegExp(`Choose at most ${PREPARE_LIMIT} prospects at a time\\.`));
    assert.equal(await db.outreach.count(), 0);
    await assert.rejects(prepareSelectedOutreach(db, Array.from({ length: PREPARE_LIMIT + 1 }, () => randomUUID()), { draft: OPTS }), ProspectError);
  });

  test("one prospect's failure leaves the rest of the batch, and the database, intact", async () => {
    const [first, broken, changing, last] = [await prospect("First Auto"), await prospect("Broken Auto"), await prospect("Changing Auto"), await prospect("Last Auto")];
    const logged: string[] = [];
    const results = await prepareSelectedOutreach(db, [first.id, broken.id, changing.id, last.id, first.id], {
      draft: OPTS,
      onError: (prospectId) => logged.push(prospectId),
      createDraft: async (d, prospectId, opts) => {
        if (prospectId === broken.id) throw new Error("connection reset");
        if (prospectId === changing.id) throw new ProspectError(["The prospect changed meanwhile."]);
        return createOutreachDraft(d, prospectId, opts);
      },
    });
    assert.deepEqual(
      results.map((r) => [r.prospectId, r.outcome]),
      [
        [first.id, "prepared"],
        [broken.id, "failed"],
        [changing.id, "refused"],
        [last.id, "prepared"],
      ],
      "each prospect once, in order, each with its own outcome",
    );
    assert.deepEqual(logged, [broken.id], "the unexpected failure is reported, not swallowed");
    for (const [p, n] of [[first, 1], [broken, 0], [changing, 0], [last, 1]] as const) {
      assert.equal(await db.outreach.count({ where: { prospectId: p.id } }), n, p.businessName!);
      assert.equal(await db.invitation.count({ where: { prospectId: p.id } }), n, `${p.businessName}: an invitation only with a draft`);
    }
  });

  // ---------- at the same time ----------

  test("two preparations of the same prospect at once make one draft and one invitation", async () => {
    const p = await prospect("Race Auto");
    const [x, y] = await Promise.all([post(`/admin/prospects/${p.id}/outreach`), post(`/admin/prospects/${p.id}/outreach`)]);
    assert.deepEqual([x.statusCode, y.statusCode], [303, 303]);
    assert.deepEqual([String(x.headers.location).split("?done=")[1], String(y.headers.location).split("?done=")[1]].sort(), ["drafted", "existing"]);
    assert.equal(await db.outreach.count(), 1);
    assert.equal(await db.invitation.count(), 1);

    const q = await prospect("Batch Race Auto");
    await Promise.all([post("/admin/outreach/prepare", { [`p:${q.id}`]: "1" }), post("/admin/outreach/prepare", { [`p:${q.id}`]: "1" })]);
    assert.equal(await db.outreach.count({ where: { prospectId: q.id } }), 1, "two batches at once: still one draft");
    assert.equal(await db.invitation.count({ where: { prospectId: q.id } }), 1);
  });

  test("two queue clicks at once queue the draft once, and move the prospect once", async () => {
    const p = await prospect("Double Click Auto");
    const { id } = await prepare(p.id);
    const results = await Promise.all([post(`/admin/outreach/${id}/queue`), post(`/admin/outreach/${id}/queue`)]);
    for (const r of results) assert.ok([303, 409].includes(r.statusCode), `queued, or told it changed meanwhile: ${r.statusCode}`);
    assert.equal(await status(id), "queued");
    assert.equal(await db.outreachEvent.count({ where: { outreachId: id, type: "queued" } }), 1);
    assert.equal(await db.prospectStatusChange.count({ where: { prospectId: p.id, toStatus: "ready_to_contact" } }), 1);
    noSend();
  });

  test("a discard and a queue at once leave one consistent outcome, never a send", async () => {
    const p = await prospect("Both Auto");
    const { id } = await prepare(p.id);
    const [d, q] = await Promise.all([discard(id), post(`/admin/outreach/${id}/queue`)]);
    for (const r of [d, q]) assert.ok([303, 400, 409].includes(r.statusCode), String(r.statusCode));
    const final = await status(id);
    assert.ok(final === "cancelled" || final === "queued", final);
    const events = (await db.outreachEvent.findMany({ where: { outreachId: id } })).map((e) => e.type);
    assert.equal(events.filter((t) => t === "queued").length <= 1 && events.filter((t) => t === "cancelled").length <= 1, true, events.join(","));
    if (final === "queued") assert.ok(!events.includes("cancelled"), "a queued message was never cancelled");
    noSend();
  });

  // ---------- access ----------

  test("every action needs a session and a same-site POST; a GET changes nothing", async () => {
    const p = await prospect("Guarded Auto");
    const { id } = await prepare(p.id);
    const before = { outreach: await db.outreach.count(), events: await db.outreachEvent.count() };

    for (const [url, body] of [
      ["/admin/outreach/prepare", { [`p:${p.id}`]: "1" }],
      [`/admin/outreach/${id}/queue`, {}],
      [`/admin/outreach/${id}/discard`, { reason: "x", confirm: "1" }],
      [`/admin/prospects/${p.id}/outreach`, {}],
    ] as const) {
      const anon = await post(url, body, {});
      assert.equal(anon.statusCode, 303, url);
      assert.equal(anon.headers.location, "/admin/login", url);
      const foreign = await post(url, body, { cookie, origin: "https://evil.example.com" });
      assert.equal(foreign.statusCode, 403, `${url}: another site's form`);
    }
    for (const url of ["/admin/outreach/prepare", `/admin/outreach/${id}/queue`, `/admin/outreach/${id}/discard`]) {
      assert.equal((await get(url)).statusCode, 404, `${url}: no GET`);
    }
    await get("/admin/outreach/messages?view=eligible");
    assert.deepEqual({ outreach: await db.outreach.count(), events: await db.outreachEvent.count() }, before, "nothing changed");
    assert.equal(await status(id), "draft");
  });

  // ---------- the Operations Center ----------

  test("the Messages view tells drafts to review from queued, sent, and cancelled messages", async () => {
    const draft = (await prepare((await prospect("Draft One Auto")).id)).id;
    const queued = (await prepare((await prospect("Queued One Auto")).id)).id;
    await post(`/admin/outreach/${queued}/queue`);
    const cancelled = (await prepare((await prospect("Cancelled One Auto")).id)).id;
    await discard(cancelled);

    const html = (await get("/admin/outreach/messages")).body;
    assert.match(html, /<nav class="chips" aria-label="Messages by status">/);
    assert.match(html, /<a class="chip attn" href="\/admin\/outreach\/messages\?status=draft">Drafts to review <span class="n">1<\/span><\/a>/);
    assert.match(html, /href="\/admin\/outreach\/messages\?status=queued">Queued <span class="n">1<\/span>/);
    assert.match(html, /href="\/admin\/outreach\/messages\?status=cancelled">Cancelled <span class="n">1<\/span>/);
    const drafts = (await get("/admin/outreach/messages?status=draft")).body;
    assert.ok(drafts.includes(`href="/admin/outreach/${draft}"`) && !drafts.includes(`href="/admin/outreach/${queued}"`));
    assert.match(drafts, /aria-current="true">Drafts to review/);
    const outreach = (await get("/admin/outreach")).body;
    assert.match(outreach, /href="\/admin\/outreach\/messages\?view=eligible">Choose prospects to prepare<\/a>/);
    assert.doesNotMatch(outreach, /Prepare and queue/, "no admin action prepares and queues in one step");
  });
});
