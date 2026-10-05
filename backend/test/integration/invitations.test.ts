import { addFixtureCollisionEvidence } from "./helpers.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import { createInvitationForOutreach, invitationActivations, openInvitation, revokeInvitation } from "../../src/invitations/service.js";
import { hashInvitationToken, newInvitationToken } from "../../src/invitations/tokens.js";
import { createOutreachDraft } from "../../src/outreach/service.js";
import { addEvidence, changeStatus, createProspect, formValuesOf, updateProspect } from "../../src/prospects.js";
import { TEST_DATABASE_URL, freshDb, readyForm, skipReason, truncate } from "./helpers.js";
import { OPTS, draftedInvitation, queueAndSend, withoutInvitation } from "./outreachHelpers.js";

/*
 * Invitations (Stage 4A): one per outreach contact attempt, made only where
 * outreach is allowed, opened by anonymous visitors, revocable, and the
 * source of activation. Through the real services, against the test database.
 */

const SITE = "https://reclaimbay.com";
const at = (iso: string) => new Date(iso);

describe("invitations", { skip: skipReason }, () => {
  let db: Db;
  before(async () => {
    db = await freshDb();
  });
  beforeEach(async () => truncate(db));
  after(async () => db?.$disconnect());

  let seq = 0;
  /** A qualified prospect with a published email and evidence, as outreach needs. */
  const prospect = async (over: Record<string, string> = {}) => {
    const n = ++seq;
    const site = `https://inv${n}.example.com`;
    const p = await createProspect(
      db,
      readyForm({ businessName: `Invite ${n} Auto`, website: site, phoneSourceUrl: `${site}/contact`, email: `service@inv${n}.example.com`, emailSourceUrl: `${site}/contact`, ...over }),
    );
    await addFixtureCollisionEvidence(db, p);
    await addEvidence(db, p.id, { signalKey: "independent_shop", sourceUrl: `${site}/about`, excerpt: "Family owned." });
    return p;
  };
  const draft = async (prospectId: string) => (await createOutreachDraft(db, prospectId, OPTS)).outreach;
  const invite = (outreachId: string) => createInvitationForOutreach(db, outreachId, { siteUrl: SITE });
  /** A first message without an invitation (as before Stage 4D), to exercise createInvitationForOutreach itself. */
  const bare = async (prospectId: string) => {
    const o = await draft(prospectId);
    return withoutInvitation(db, o.id);
  };
  /** A first message's own invitation, made by drafting it: its token and record. */
  const own = async (prospectId: string) => draftedInvitation(db, await draft(prospectId));
  const invitation = (id: string) => db.invitation.findUniqueOrThrow({ where: { id } });

  test("an eligible first message gets exactly one invitation, and making it sends nothing", async () => {
    const p = await prospect();
    const o = await bare(p.id);
    const r = await invite(o.id);
    assert.equal(r.created, true);
    assert.ok(r.created);
    assert.match(r.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(r.url, `${SITE}/invite#${r.token}`);
    assert.equal(r.invitation.tokenHash, hashInvitationToken(r.token));
    assert.equal(r.invitation.prospectId, p.id);
    assert.equal(r.invitation.outreachId, o.id);
    assert.equal(r.invitation.campaign, o.campaign, "the message's campaign, frozen");
    assert.equal(r.invitation.openCount, 0);
    assert.equal(r.invitation.firstOpenedAt, null);
    assert.ok(!JSON.stringify(await invitation(r.invitation.id)).includes(r.token), "the token itself is never stored");

    const again = await invite(o.id);
    assert.deepEqual([again.created, again.token, again.url, again.invitation.id], [false, null, null, r.invitation.id], "idempotent, and the token can't be recovered");

    // Nothing was sent, queued, or switched on.
    assert.equal((await db.outreach.findUniqueOrThrow({ where: { id: o.id } })).status, "draft");
    assert.equal(await db.outreachEvent.count({ where: { outreachId: o.id, type: { not: "drafted" } } }), 0);
    assert.equal(await db.outreachControlChange.count(), 0);
  });

  test("concurrent requests for the same message still make one invitation", async () => {
    const o = await bare((await prospect()).id);
    const results = await Promise.all([1, 2, 3, 4].map(() => invite(o.id)));
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.equal(new Set(results.map((r) => r.invitation.id)).size, 1);
    assert.equal(await db.invitation.count(), 1);
  });

  test("an invitation is refused wherever outreach itself would be", async () => {
    // A message that has been sent, and its follow-up.
    const sentTo = await prospect();
    const sent = await bare(sentTo.id);
    await queueAndSend(db, sent.id);
    await assert.rejects(invite(sent.id), /made before its message is sent; this message is Sent/);
    const followUp = (await createOutreachDraft(db, sentTo.id, { ...OPTS, followUpOfId: sent.id })).outreach;
    await assert.rejects(invite(followUp.id), /Only a first message gets an invitation/);

    // No longer qualified (moved back to New, a required criterion unconfirmed): the same reason drafting gives.
    const unq = await prospect();
    const m = await bare(unq.id);
    const current = await db.prospect.findUniqueOrThrow({ where: { id: unq.id }, include: { signals: true } });
    await updateProspect(db, unq.id, { ...formValuesOf(current), signal_collision_repair_services: "unknown" });
    await assert.rejects(invite(m.id), /Outreach requires Qualification "Meets criteria"; this prospect is Unverified/);

    // A suppressed address, recorded while the draft was open.
    const sup = await prospect();
    const s = await bare(sup.id);
    await db.emailSuppression.create({ data: { email: sup.email!, reason: "bounced" } });
    await assert.rejects(invite(s.id), /is suppressed \(bounced\); it must not be emailed again/);

    // Do not contact: the message is cancelled with it, and the prospect is refused outright.
    const dnc = await prospect();
    const d = await bare(dnc.id);
    await changeStatus(db, dnc.id, "do_not_contact", "Asked by phone.");
    await assert.rejects(invite(d.id), /must never be contacted/);

    await assert.rejects(invite(randomUUID()), /Outreach not found/);
    assert.equal(await db.invitation.count(), 0, "no refused request left a record");
  });

  test("opening counts every open, keeps the first, and links each visitor's session, first touch only", async () => {
    const p = await prospect();
    const r = await own(p.id);
    const s1 = randomUUID();
    const first = await openInvitation(db, { token: r.token, sessionId: s1 }, at("2026-10-10T10:00:00Z"));
    assert.deepEqual(first, { active: true, businessName: p.businessName }, "only whether it's active and the business's own public name");

    await openInvitation(db, { token: r.token, sessionId: s1 }, at("2026-10-10T11:00:00Z"));
    const s2 = randomUUID();
    await openInvitation(db, { token: r.token, sessionId: s2 }, at("2026-10-10T12:00:00Z"));
    await openInvitation(db, { token: r.token }, at("2026-10-10T13:00:00Z"));
    const inv = await invitation(r.invitation.id);
    assert.equal(inv.openCount, 4);
    assert.deepEqual([inv.firstOpenedAt, inv.lastOpenedAt], [at("2026-10-10T10:00:00Z"), at("2026-10-10T13:00:00Z")]);
    assert.equal(await db.invitation.count(), 1, "opens never make another invitation");
    for (const s of [s1, s2]) {
      const session = await db.analyticsSession.findUniqueOrThrow({ where: { anonymousSessionId: s } });
      assert.deepEqual([session.prospectId, session.invitationId], [p.id, inv.id], "both devices attributed");
    }
    assert.equal(await db.analyticsSession.count(), 2, "an open without a session id links nothing");

    // A browser that first arrived through another business's link keeps that attribution.
    const other = await prospect();
    const elsewhere = randomUUID();
    await db.analyticsSession.create({ data: { anonymousSessionId: elsewhere, prospectId: other.id } });
    await openInvitation(db, { token: r.token, sessionId: elsewhere });
    const kept = await db.analyticsSession.findUniqueOrThrow({ where: { anonymousSessionId: elsewhere } });
    assert.deepEqual([kept.prospectId, kept.invitationId], [other.id, null]);

    // A session id in the wrong shape is ignored, not trusted.
    await openInvitation(db, { token: r.token, sessionId: "not-a-uuid'); DROP TABLE x;--" });
    assert.equal(await db.analyticsSession.count(), 3);
  });

  test("concurrent opens are all counted, and the first open is recorded once", async () => {
    const r = await own((await prospect()).id);
    await Promise.all(Array.from({ length: 6 }, () => openInvitation(db, { token: r.token, sessionId: randomUUID() })));
    const inv = await invitation(r.invitation.id);
    assert.equal(inv.openCount, 6);
    assert.ok(inv.firstOpenedAt && inv.lastOpenedAt && inv.firstOpenedAt <= inv.lastOpenedAt);
    assert.equal(await db.analyticsSession.count({ where: { invitationId: inv.id } }), 6);
  });

  test("a bad, unknown, or revoked link, or an opted-out business, gets the same answer and changes nothing", async () => {
    const p = await prospect();
    const r = await own(p.id);
    const inactive = { active: false };
    for (const token of [undefined, "", "short", newInvitationToken(), `<img src=x onerror=alert(1)>`.padEnd(43, "a"), r.token.slice(0, 42), `${r.token} `]) {
      assert.deepEqual(await openInvitation(db, { token, sessionId: randomUUID() }), inactive, String(token));
    }
    assert.equal((await invitation(r.invitation.id)).openCount, 0);
    assert.equal(await db.analyticsSession.count(), 0, "nothing recorded for a link that isn't active");

    // Revoked: repeatable, the first reason kept, the record intact, the link dead.
    assert.deepEqual(await revokeInvitation(db, r.invitation.id, "  Sent  to the wrong address. "), { changed: true });
    assert.deepEqual(await revokeInvitation(db, r.invitation.id, "Another reason."), { changed: false });
    const revoked = await invitation(r.invitation.id);
    assert.equal(revoked.revokeReason, "Sent to the wrong address.");
    assert.ok(revoked.revokedAt);
    assert.deepEqual(await openInvitation(db, { token: r.token, sessionId: randomUUID() }), inactive);
    assert.equal((await invitation(r.invitation.id)).openCount, 0);
    await assert.rejects(revokeInvitation(db, randomUUID()), /Invitation not found/);

    // A business that later asked not to be contacted: its link goes quiet, and nothing is recorded.
    const q = await prospect();
    const live = await own(q.id);
    await changeStatus(db, q.id, "do_not_contact", "Asked by phone.");
    assert.deepEqual(await openInvitation(db, { token: live.token, sessionId: randomUUID() }), inactive);
    // And one whose address was suppressed.
    const t = await prospect();
    const sup = await own(t.id);
    await db.emailSuppression.create({ data: { email: t.email!, reason: "unsubscribed" } });
    assert.deepEqual(await openInvitation(db, { token: sup.token, sessionId: randomUUID() }), inactive);
    assert.equal(await db.invitation.count({ where: { openCount: { gt: 0 } } }), 0);
  });

  test("activation is the first real scan by a visitor who arrived through the invitation", async () => {
    const p = await prospect();
    const r = await own(p.id);
    const never = await own((await prospect()).id);

    // This browser scanned once before it ever opened the invitation: that scan wasn't caused by it.
    const s1 = randomUUID();
    const session = await db.analyticsSession.create({ data: { anonymousSessionId: s1 } });
    const event = (sessionId: string, iso: string, isSample = false) =>
      db.productEvent.create({ data: { sessionId, eventType: "scan_completed", isSample, createdAt: at(iso) } });
    await event(session.id, "2026-10-10T09:00:00Z");
    await openInvitation(db, { token: r.token, sessionId: s1 }, at("2026-10-10T10:00:00Z"));
    await event(session.id, "2026-10-10T10:05:00Z", true); // the sample report: not activation
    await event(session.id, "2026-10-10T10:20:00Z"); // the first real scan
    await event(session.id, "2026-10-10T11:00:00Z");
    // A browser that never opened it.
    const stranger = await db.analyticsSession.create({ data: { anonymousSessionId: randomUUID(), prospectId: p.id } });
    await event(stranger.id, "2026-10-10T10:10:00Z");

    const activations = await invitationActivations(db, [r.invitation.id, never.invitation.id]);
    assert.deepEqual([...activations.entries()], [[r.invitation.id, at("2026-10-10T10:20:00Z")]]);
    assert.equal((await invitationActivations(db, [])).size, 0);
  });
});

describe("invitation open endpoint (HTTP)", { skip: skipReason }, () => {
  const ORIGIN = "https://reclaimbay.com";
  const env = { DATABASE_URL: TEST_DATABASE_URL, ALLOWED_ORIGIN: ORIGIN, ADMIN_SECRET: "integration-test-secret-0123456789", TRUST_PROXY_HOPS: "0" };
  let db: Db;
  let app: FastifyInstance;
  before(async () => {
    db = await freshDb();
    app = await buildApp(loadConfig(env), db, false);
  });
  beforeEach(async () => truncate(db));
  after(async () => {
    await app?.close();
    await db?.$disconnect();
  });

  let seq = 0;
  const prospect = async () => {
    const n = ++seq;
    const site = `https://http${n}.example.com`;
    const p = await createProspect(db, readyForm({ businessName: `Http ${n} Auto`, website: site, phoneSourceUrl: `${site}/contact`, email: `service@http${n}.example.com`, emailSourceUrl: `${site}/contact` }));
    await addFixtureCollisionEvidence(db, p);
    await addEvidence(db, p.id, { signalKey: "independent_shop", sourceUrl: `${site}/about`, excerpt: "Family owned." });
    return p;
  };
  const invited = async () => {
    const p = await prospect();
    const r = await draftedInvitation(db, (await createOutreachDraft(db, p.id, OPTS)).outreach);
    return { p, r };
  };
  const open = (body: unknown, origin = ORIGIN, on: FastifyInstance = app) =>
    on.inject({ method: "POST", url: "/api/invitations/open", headers: { "content-type": "application/json", origin }, payload: JSON.stringify(body) });
  const event = (body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/events", headers: { "content-type": "application/json", origin: ORIGIN }, payload: JSON.stringify(body) });

  test("an active link answers with only the business's public name, and records the open", async () => {
    const { p, r } = await invited();
    const sessionId = randomUUID();
    const res = await open({ token: r.token, sessionId });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { active: true, businessName: p.businessName });
    assert.equal(res.headers["access-control-allow-origin"], ORIGIN);
    assert.equal(res.headers["cache-control"], "no-store");
    const full = await db.prospect.findUniqueOrThrow({ where: { id: p.id } });
    for (const secret of [p.id, r.invitation.id, r.invitation.outreachId, full.email!, full.referralCode, r.invitation.campaign!, r.token, "status", "score"]) {
      assert.ok(!res.body.includes(secret), `the answer never contains ${secret}`);
    }
    assert.equal((await db.invitation.findUniqueOrThrow({ where: { id: r.invitation.id } })).openCount, 1);
    const session = await db.analyticsSession.findUniqueOrThrow({ where: { anonymousSessionId: sessionId } });
    assert.deepEqual([session.prospectId, session.invitationId], [p.id, r.invitation.id]);
  });

  test("unknown, malformed, revoked, and opted-out links all get the byte-identical answer", async () => {
    const { r: revoked } = await invited();
    await revokeInvitation(db, revoked.invitation.id, "Wrong address.");
    const { p: dnc, r: quiet } = await invited();
    await changeStatus(db, dnc.id, "do_not_contact", "Asked by phone.");
    const answers = await Promise.all(
      [newInvitationToken(), "short", "<script>alert(1)</script>", revoked.token, quiet.token].map((token) => open({ token, sessionId: randomUUID() })),
    );
    for (const a of answers) {
      assert.equal(a.statusCode, 200);
      assert.equal(a.body, '{"active":false}');
    }
    assert.equal(await db.analyticsSession.count(), 0, "nothing recorded for any of them");
    // Not an invitation request at all: refused by shape, still saying nothing about any invitation.
    assert.equal((await open({ sessionId: randomUUID() })).statusCode, 400);
    assert.equal((await open({ token: quiet.token, extra: "x" })).statusCode, 400);
    assert.equal((await open({ token: quiet.token, sessionId: "not-a-session" })).statusCode, 400);
  });

  test("only the site may call it: another origin gets no CORS permission", async () => {
    const { r } = await invited();
    const res = await open({ token: r.token, sessionId: randomUUID() }, "https://evil.example");
    assert.equal(res.headers["access-control-allow-origin"], undefined);
    const preflight = await app.inject({ method: "OPTIONS", url: "/api/invitations/open", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    assert.equal(preflight.headers["access-control-allow-origin"], undefined);
  });

  test("entering the product keeps the attribution, and a real scan activates the invitation", async () => {
    const { p, r } = await invited();
    const sessionId = randomUUID();
    await open({ token: r.token, sessionId });
    // The scanner's own events: the same browser id, no ?ref= anywhere.
    assert.equal((await event({ sessionId, event: "landing_view", isSample: false })).statusCode, 204);
    assert.equal((await event({ sessionId, event: "scan_completed", isSample: true })).statusCode, 204);
    assert.equal((await invitationActivations(db, [r.invitation.id])).size, 0, "the sample report isn't activation");
    assert.equal((await event({ sessionId, event: "scan_completed", isSample: false })).statusCode, 204);
    const events = await db.productEvent.findMany({ where: { session: { anonymousSessionId: sessionId } } });
    assert.ok(events.length === 3 && events.every((e) => e.prospectId === p.id), "every event carries the invitation's prospect");
    assert.equal((await invitationActivations(db, [r.invitation.id])).size, 1);
  });

  test("a contact click after opening an invitation belongs to the invited prospect", async () => {
    const { p, r } = await invited();
    const other = await invited();
    const sessionId = randomUUID();
    await open({ token: r.token, sessionId });
    assert.equal((await event({ sessionId, event: "contact_clicked", isSample: false })).statusCode, 204);
    const clicks = await db.productEvent.findMany({ where: { eventType: "contact_clicked" } });
    assert.deepEqual(clicks.map((e) => e.prospectId), [p.id]);
    assert.notEqual(p.id, other.p.id);
  });

  test("first touch is kept: a browser that arrived through another business's ?ref= link stays with it", async () => {
    const earlier = await prospect();
    const sessionId = randomUUID();
    await event({ sessionId, event: "landing_view", isSample: false, ref: earlier.referralCode });
    const { r } = await invited();
    assert.deepEqual((await open({ token: r.token, sessionId })).json().active, true);
    const session = await db.analyticsSession.findUniqueOrThrow({ where: { anonymousSessionId: sessionId } });
    assert.deepEqual([session.prospectId, session.invitationId], [earlier.id, null]);
  });

  test("it is rate limited, generously enough for a person opening their own link", async () => {
    // A separate app, so this test's count starts at zero.
    const limited = await buildApp(loadConfig(env), db, false);
    try {
      const { r } = await invited();
      for (let i = 0; i < 5; i++) assert.equal((await open({ token: r.token, sessionId: randomUUID() }, ORIGIN, limited)).statusCode, 200, "a few opens are fine");
      let status = 200;
      for (let i = 5; i < 40 && status === 200; i++) status = (await open({ token: newInvitationToken() }, ORIGIN, limited)).statusCode;
      assert.equal(status, 429, "a flood of guesses is cut off");
      assert.equal((await db.invitation.findUniqueOrThrow({ where: { id: r.invitation.id } })).openCount, 5);
    } finally {
      await limited.close();
    }
  });
});
