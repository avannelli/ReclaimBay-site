import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import { openInvitation } from "../../src/invitations/service.js";
import { HIDDEN_TOKEN } from "../../src/invitations/tokens.js";
import { outreachMetrics } from "../../src/outreach/metrics.js";
import { createOutreachDraft, discardOutreach, recordInboundReply } from "../../src/outreach/service.js";
import { addEvidence, createProspect } from "../../src/prospects.js";
import { TEST_DATABASE_URL, freshDb, readyForm, skipReason, truncate } from "./helpers.js";
import { OPTS, draftedInvitation, mockSender, queueAndSend, withoutInvitation } from "./outreachHelpers.js";

/*
 * Stage 4C: the invitation on an outreach message's admin page, its
 * revocation, and the campaign funnel's Invited / Opened / Activated. Through
 * the real admin routes and services, against the test database.
 */

const SECRET = "integration-test-secret-0123456789";
const ADMIN = "http://localhost";
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const at = (iso: string) => new Date(iso);

describe("invitations in the admin", { skip: skipReason }, () => {
  let db: Db;
  let app: FastifyInstance;
  let cookie = "";
  before(async () => {
    db = await freshDb();
    app = await buildApp(loadConfig({ DATABASE_URL: TEST_DATABASE_URL, ALLOWED_ORIGIN: "https://reclaimbay.com", ADMIN_SECRET: SECRET, TRUST_PROXY_HOPS: "0" }), db, false);
    const login = await app.inject({ method: "POST", url: "/admin/login", headers: FORM, payload: new URLSearchParams({ secret: SECRET }).toString() });
    cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  });
  beforeEach(async () => truncate(db));
  after(async () => {
    await app?.close();
    await db?.$disconnect();
  });

  const page = async (outreachId: string) => (await app.inject({ method: "GET", url: `/admin/outreach/${outreachId}`, headers: { cookie } })).body;
  const revoke = (outreachId: string, body: Record<string, string>, headers: Record<string, string> = { cookie }) =>
    app.inject({ method: "POST", url: `/admin/outreach/${outreachId}/invitation/revoke`, headers: { ...FORM, ...headers }, payload: new URLSearchParams(body).toString() });

  let seq = 0;
  const prospect = async (name?: string) => {
    const n = ++seq;
    const site = `https://adm${n}.example.com`;
    const p = await createProspect(db, readyForm({ businessName: name ?? `Admin ${n} Auto`, website: site, phoneSourceUrl: `${site}/contact`, email: `service@adm${n}.example.com`, emailSourceUrl: `${site}/contact` }));
    await addEvidence(db, p.id, { signalKey: "independent_shop", sourceUrl: `${site}/about`, excerpt: "Family owned." });
    return p;
  };
  /** A first message with its invitation. */
  const invited = async (name?: string) => {
    const p = await prospect(name);
    const o = (await createOutreachDraft(db, p.id, OPTS)).outreach;
    const { token, invitation } = await draftedInvitation(db, o);
    return { p, o, token, invitation };
  };
  /** Opens the invitation from a browser, and returns that browser's analytics session row id. */
  const openFrom = async (token: string, iso: string) => {
    const sessionId = randomUUID();
    assert.equal((await openInvitation(db, { token, sessionId }, at(iso))).active, true);
    return (await db.analyticsSession.findUniqueOrThrow({ where: { anonymousSessionId: sessionId } })).id;
  };
  const scan = (sessionRowId: string, iso: string, isSample = false) =>
    db.productEvent.create({ data: { sessionId: sessionRowId, eventType: "scan_completed", isSample, createdAt: at(iso) } });
  const badge = (html: string) => /<span class="vd [^"]+"><span aria-hidden="true">[^<]+<\/span> ([^<]+)<\/span>/.exec(html.slice(html.indexOf('id="invitation-h"')))?.[1] ?? null;

  test("a first message without an invitation says so; a follow-up points to its first message", async () => {
    const p = await prospect();
    const o = (await createOutreachDraft(db, p.id, OPTS)).outreach;
    await withoutInvitation(db, o.id); // as drafted before invitations
    const html = await page(o.id);
    assert.match(html, /<h2 id="invitation-h">Invitation<\/h2>[\s\S]*?No invitation for this message\./);
    assert.doesNotMatch(html, /Revoke invitation/);

    await queueAndSend(db, o.id);
    const followUp = (await createOutreachDraft(db, p.id, { ...OPTS, followUpOfId: o.id })).outreach;
    assert.match(await page(followUp.id), new RegExp(`A follow-up uses the invitation of <a href="/admin/outreach/${o.id}">the first message</a>`));
  });

  test("each status shows with what it recorded, and the token and its hash never appear", async () => {
    const { o, token, invitation } = await invited();
    let html = await page(o.id);
    assert.equal(badge(html), "Not opened");
    assert.match(html, /<dt>Opens<\/dt><dd>0<\/dd>/);
    assert.match(html, /<dt>First opened<\/dt><dd>—<\/dd>/);

    const s1 = await openFrom(token, "2026-10-10T10:00:00Z");
    await openFrom(token, "2026-10-10T12:30:00Z");
    html = await page(o.id);
    assert.equal(badge(html), "Opened");
    assert.match(html, /<dt>First opened<\/dt><dd>2026-10-10 10:00 UTC<\/dd><dt>Last opened<\/dt><dd>2026-10-10 12:30 UTC<\/dd><dt>Opens<\/dt><dd>2<\/dd><dt>Activated<\/dt><dd>—<\/dd>/);

    await scan(s1, "2026-10-10T10:05:00Z", true); // the sample report
    assert.equal(badge(await page(o.id)), "Opened", "a sample scan doesn't activate");
    await scan(s1, "2026-10-10T10:20:00Z");
    html = await page(o.id);
    assert.equal(badge(html), "Activated");
    assert.match(html, /<dt>Activated<\/dt><dd>2026-10-10 10:20 UTC<\/dd>/);

    // The message is shown as reviewed, with its invitation link in place but its token hidden.
    assert.match(html, /<pre class="msg">[\s\S]*?Get your free report: https:\/\/reclaimbay\.com\/invite#\[invitation link hidden\][\s\S]*?<\/pre>/);
    assert.match(html, /The invitation link is hidden here, so opening it from the admin can&#39;t count as the business&#39;s visit\./);
    for (const secret of [token, invitation.tokenHash, invitation.id]) assert.ok(!html.includes(secret), "never the token, its hash, or the invitation's id");
  });

  test("a reply that quotes the email shows its invitation link hidden too", async () => {
    const { p, o, token, invitation } = await invited();
    await queueAndSend(db, o.id);
    const quoted = `Sounds good, I'll take a look. > Get your free report: https://reclaimbay.com/invite#${token}`;
    assert.equal((await recordInboundReply(db, { fromEmail: p.email!, inReplyToProviderMessageId: `msg-${o.id}`, summary: quoted })).result, "recorded");
    const html = await page(o.id);
    assert.match(html, /Sounds good, I&#39;ll take a look\. &#62; Get your free report: https:\/\/reclaimbay\.com\/invite#\[invitation link hidden\]/);
    for (const secret of [token, invitation.tokenHash, invitation.id]) assert.ok(!html.includes(secret), "never the token, its hash, or the invitation's id");
  });

  test("revoking needs the admin session, the admin's own origin, a reason, and a confirmation", async () => {
    const { p, o, token } = await invited();
    const revoked = async () => (await db.invitation.findUniqueOrThrow({ where: { outreachId: o.id } })).revokedAt;
    const valid = { intent: "revoke", reason: "Sent to the wrong address.", confirm: "1" };

    const signedOut = await revoke(o.id, valid, {});
    assert.equal(signedOut.statusCode, 303);
    assert.match(String(signedOut.headers.location), /\/admin\/login/);
    assert.equal((await revoke(o.id, valid, { cookie, origin: "https://evil.example" })).statusCode, 403);
    assert.equal(await revoked(), null, "neither did anything");

    const noReason = await revoke(o.id, { intent: "revoke", reason: "  ", confirm: "1" });
    assert.equal(noReason.statusCode, 400);
    assert.match(noReason.body, /Give a reason for revoking the invitation\./);
    assert.match(noReason.body, /<details class="rv-disregard"[^>]* open>/, "the form stays open with the problem shown");
    const unconfirmed = await revoke(o.id, { intent: "revoke", reason: "Wrong address." });
    assert.equal(unconfirmed.statusCode, 400);
    assert.match(unconfirmed.body, /Confirm that the invitation link should stop working\./);
    assert.equal(await revoked(), null);

    const before = { outreach: await db.outreach.findUniqueOrThrow({ where: { id: o.id } }), events: await db.outreachEvent.count(), prospect: await db.prospect.findUniqueOrThrow({ where: { id: p.id } }) };
    const ok = await revoke(o.id, valid, { cookie, origin: ADMIN, host: "localhost" });
    assert.equal(ok.statusCode, 303);
    assert.equal(ok.headers.location, `/admin/outreach/${o.id}?done=invitation_revoked`);
    const html = (await app.inject({ method: "GET", url: String(ok.headers.location), headers: { cookie } })).body;
    assert.match(html, /Invitation revoked\. Its link no longer works; everything it recorded is kept\./);
    assert.equal(badge(html), "Revoked");
    assert.match(html, /<dt>Reason<\/dt><dd>Sent to the wrong address\.<\/dd>/);
    assert.doesNotMatch(html, /Revoke invitation/, "nothing left to revoke");
    assert.deepEqual((await openInvitation(db, { token, sessionId: randomUUID() })).active, false, "the link no longer works");

    // Nothing else moved: the message, its events, the prospect. The record stays.
    const outreach = await db.outreach.findUniqueOrThrow({ where: { id: o.id } });
    assert.deepEqual([outreach.status, outreach.updatedAt.getTime()], [before.outreach.status, before.outreach.updatedAt.getTime()]);
    assert.equal(await db.outreachEvent.count(), before.events);
    const prospectAfter = await db.prospect.findUniqueOrThrow({ where: { id: p.id } });
    assert.deepEqual([prospectAfter.status, prospectAfter.score], [before.prospect.status, before.prospect.score]);
    assert.equal(await db.invitation.count(), 1);

    // A stale form posted again: nothing changes, the first reason stays.
    const again = await revoke(o.id, { ...valid, reason: "Another reason." });
    assert.equal(again.headers.location, `/admin/outreach/${o.id}?done=invitation_already_revoked`);
    assert.equal((await db.invitation.findUniqueOrThrow({ where: { outreachId: o.id } })).revokeReason, "Sent to the wrong address.");

    // A message with no invitation, and one that doesn't exist.
    const bare = (await createOutreachDraft(db, (await prospect()).id, OPTS)).outreach;
    await withoutInvitation(db, bare.id);
    const none = await revoke(bare.id, valid);
    assert.equal(none.statusCode, 400);
    assert.match(none.body, /This message has no invitation\./);
    assert.equal((await revoke(randomUUID(), valid)).statusCode, 404);
  });

  test("a reason or business name with markup is shown as text", async () => {
    const { o } = await invited(`Smith & <b onmouseover=alert(1)>Sons</b> Auto`);
    await revoke(o.id, { intent: "revoke", reason: `<script>alert("x")</script> & "quotes"`, confirm: "1" });
    const html = await page(o.id);
    assert.match(html, /<dt>Reason<\/dt><dd>&#60;script&#62;alert\(&#34;x&#34;\)&#60;\/script&#62; &#38; &#34;quotes&#34;<\/dd>/);
    assert.doesNotMatch(html, /<script>alert|<b onmouseover/);
    assert.match(html, /Smith &#38; &#60;b onmouseover=alert\(1\)&#62;Sons&#60;\/b&#62; Auto/);
  });

  test("the campaign funnel counts invitations made, opened (once each), and activated by a real scan after opening", async () => {
    // Opened twice, then a real scan: activated.
    const a = await invited();
    const sa = await openFrom(a.token, "2026-10-10T10:00:00Z");
    await openFrom(a.token, "2026-10-10T11:00:00Z");
    await scan(sa, "2026-10-10T10:30:00Z");
    // Opened, but only a sample scan, and a real scan from before it was opened: not activated.
    const b = await invited();
    const early = await db.analyticsSession.create({ data: { anonymousSessionId: randomUUID() } });
    await scan(early.id, "2026-10-10T08:00:00Z");
    await openInvitation(db, { token: b.token, sessionId: (await db.analyticsSession.findUniqueOrThrow({ where: { id: early.id } })).anonymousSessionId }, at("2026-10-10T09:00:00Z"));
    await scan(early.id, "2026-10-10T09:10:00Z", true);
    // Never opened.
    await invited();
    // Another campaign.
    const d = await invited();
    await db.invitation.update({ where: { id: d.invitation.id }, data: { campaign: "spring-test" } });

    const rows = await outreachMetrics(db);
    const pick = (campaign: string) => {
      const r = rows.find((x) => x.campaign === campaign)!;
      return { invited: r.invited, opened: r.opened, activated: r.activated };
    };
    assert.deepEqual(pick("outreach-intro-t2"), { invited: 3, opened: 2, activated: 1 });
    assert.deepEqual(pick("spring-test"), { invited: 1, opened: 0, activated: 0 });
    assert.deepEqual(pick("all"), { invited: 4, opened: 2, activated: 1 });

    const control = (await app.inject({ method: "GET", url: "/admin/outreach", headers: { cookie } })).body;
    assert.match(control, /<th scope="col" class="num">Invited<\/th><th scope="col" class="num">Opened<\/th><th scope="col" class="num">Activated<\/th>/);
  });

  test("a message's page hides a token quoted in its cancel reason, refusal, or send error, and still escapes the rest", async () => {
    const hidden = `https://reclaimbay.com/invite#${HIDDEN_TOKEN}`;
    const raw = /\/invite#[A-Za-z0-9_-]{43}/;

    // A person's discard reason that pastes the link: shown under Cancelled and in the event log.
    const cancelled = await invited();
    await discardOutreach(db, cancelled.o.id, `Wrong <shop> & stale: https://reclaimbay.com/invite#${cancelled.token}`);
    // The provider's refusal quoting the link.
    const refused = await invited();
    await queueAndSend(db, refused.o.id, mockSender(() => ({ status: "rejected", reason: `550 <blocked> https://reclaimbay.com/invite#${refused.token}`, invalidRecipient: false })));
    // An uncertain send whose error quotes the link: the "outcome unknown" card.
    const unsure = await invited();
    await queueAndSend(db, unsure.o.id, mockSender(() => ({ status: "uncertain", reason: `timeout & retry https://reclaimbay.com/invite#${unsure.token}` })));

    const cases = [
      { x: cancelled, text: `Wrong &#60;shop&#62; &#38; stale: ${hidden}`, where: [/<dt>Cancelled<\/dt><dd>[^<]*· Wrong &#60;shop&#62;/, /<b>cancelled<\/b> · Wrong &#60;shop&#62;/] },
      { x: refused, text: `550 &#60;blocked&#62; ${hidden}`, where: [/<dt>Bounced \/ failed<\/dt><dd>[^<]*· 550 &#60;blocked&#62;/] },
      { x: unsure, text: `timeout &#38; retry ${hidden}`, where: [/outcome unknown<\/div>[\s\S]*?Last error: timeout &#38; retry/] },
    ];
    for (const { x, text, where } of cases) {
      const html = await page(x.o.id);
      assert.ok(!html.includes(x.token), "the raw token never appears");
      assert.doesNotMatch(html, raw, "no working invitation link");
      assert.ok(html.includes(text), `the reason stays readable, escaped, with the link in its hidden form: ${text}`);
      for (const re of where) assert.match(html, re);
      assert.doesNotMatch(html, /<shop>|<blocked>/, "HTML in a reason is escaped, never rendered");
    }
  });
});
