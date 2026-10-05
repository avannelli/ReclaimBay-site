import { addFixtureCollisionEvidence } from "./helpers.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Db } from "../../src/db.js";
import { invitationForOutreach, openInvitation, revokeInvitation } from "../../src/invitations/service.js";
import { hashInvitationToken } from "../../src/invitations/tokens.js";
import { prepareEligibleOutreach } from "../../src/outreach/prepare.js";
import { createOutreachDraft, previewOutreachDraft, queueOutreach } from "../../src/outreach/service.js";
import { addEvidence, changeStatus, createProspect, formValuesOf, updateProspect } from "../../src/prospects.js";
import { freshDb, readyForm, skipReason, truncate } from "./helpers.js";
import { CFG, OPTS, mockSender, queueAndSend } from "./outreachHelpers.js";

/*
 * Stage 4D: outreach carries invitations. A first message gets exactly one,
 * made in its drafting transaction, and links it; a follow-up reuses that
 * same link; messages made before invitations keep working as they did.
 */

const LINK_RE = /https:\/\/reclaimbay\.com\/invite#([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/;

describe("invitations in outreach", { skip: skipReason }, () => {
  let db: Db;
  before(async () => {
    db = await freshDb();
  });
  beforeEach(async () => truncate(db));
  after(async () => db?.$disconnect());

  let seq = 0;
  const prospect = async (over: Record<string, string> = {}) => {
    const n = ++seq;
    const site = `https://wire${n}.example.com`;
    const p = await createProspect(
      db,
      readyForm({ businessName: `Wire ${n} Auto`, website: site, phoneSourceUrl: `${site}/contact`, email: `service@wire${n}.example.com`, emailSourceUrl: `${site}/contact`, ...over }),
    );
    await addFixtureCollisionEvidence(db, p);
    await addEvidence(db, p.id, { signalKey: "independent_shop", sourceUrl: `${site}/about`, excerpt: "Family owned." });
    return p;
  };
  const draft = async (prospectId: string) => (await createOutreachDraft(db, prospectId, OPTS)).outreach;
  const tokenIn = (body: string) => LINK_RE.exec(body)?.[1] ?? null;

  test("a first message gets exactly one invitation, in its drafting transaction, and its email opens it", async () => {
    const p = await prospect();
    const o = await draft(p.id);
    const token = tokenIn(o.body);
    assert.ok(token, "the email links /invite#<token>");
    assert.match(o.body, /Get your free report: https:\/\/reclaimbay\.com\/invite#[A-Za-z0-9_-]{43}\n/);
    assert.ok(!o.body.includes("?ref="), "no referral link");

    const inv = await db.invitation.findUniqueOrThrow({ where: { outreachId: o.id } });
    assert.equal(inv.tokenHash, hashInvitationToken(token), "the database keeps only the hash of the token in the email");
    assert.equal(inv.prospectId, p.id);
    assert.equal(inv.campaign, o.campaign, "the campaign, frozen from the message");
    assert.equal(inv.campaign, "outreach-intro-t2");
    for (const secret of [inv.tokenHash, inv.id]) assert.ok(!o.body.includes(secret) && !o.subject.includes(secret), "the email carries the token only, never its hash or id");
    assert.ok(!JSON.stringify(inv).includes(token), "the token itself is stored nowhere but the message");

    // The token in the email is the one that opens it, for this prospect.
    const sessionId = randomUUID();
    assert.deepEqual(await openInvitation(db, { token, sessionId }), { active: true, businessName: p.businessName });
    assert.equal((await db.analyticsSession.findUniqueOrThrow({ where: { anonymousSessionId: sessionId } })).prospectId, p.id);

    // Drafting again returns the same draft: still one invitation.
    const again = await createOutreachDraft(db, p.id, OPTS);
    assert.deepEqual([again.created, again.outreach.id], [false, o.id]);
    assert.equal(await db.invitation.count(), 1);
  });

  test("drafting raced from several places still makes one draft and one invitation", async () => {
    const p = await prospect();
    const results = await Promise.all([1, 2, 3, 4].map(() => createOutreachDraft(db, p.id, OPTS)));
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.equal(await db.outreach.count(), 1);
    assert.equal(await db.invitation.count(), 1);
    const o = results[0]!.outreach;
    assert.equal((await db.invitation.findUniqueOrThrow({ where: { outreachId: o.id } })).tokenHash, hashInvitationToken(tokenIn(o.body)!));
  });

  test("automatic preparation gives every draft its invitation; a preview makes none", async () => {
    const a = await prospect();
    const b = await prospect();
    const preview = await previewOutreachDraft(db, a.id, OPTS);
    assert.ok(preview.message && !tokenIn(preview.message.body), "a preview shows a placeholder, not a token");
    assert.equal(await db.invitation.count(), 0);
    const r = await prepareEligibleOutreach(db, { draft: OPTS, compliance: CFG, apply: true });
    assert.equal(r.drafted.length, 2);
    for (const p of [a, b]) {
      const o = await db.outreach.findFirstOrThrow({ where: { prospectId: p.id } });
      assert.equal((await db.invitation.findUniqueOrThrow({ where: { outreachId: o.id } })).tokenHash, hashInvitationToken(tokenIn(o.body)!));
    }
  });

  test("a follow-up reuses the first message's link exactly, and makes no invitation of its own", async () => {
    const p = await prospect();
    const first = await draft(p.id);
    const sender = mockSender();
    await queueAndSend(db, first.id, sender);
    assert.ok(sender.calls[0]!.text.includes(LINK_RE.exec(first.body)![0]), "the sent email carries the invitation link, unchanged");

    const followUp = (await createOutreachDraft(db, p.id, { ...OPTS, followUpOfId: first.id })).outreach;
    assert.equal(followUp.template, "follow-up@t2");
    assert.equal(LINK_RE.exec(followUp.body)![0], LINK_RE.exec(first.body)![0], "the same link, same token");
    assert.equal(await db.invitation.count(), 1, "no second invitation");
    assert.equal(await invitationForOutreach(db, followUp.id), null);

    // Opening it from the follow-up still attributes to the original prospect and invitation.
    const sessionId = randomUUID();
    await openInvitation(db, { token: tokenIn(followUp.body), sessionId });
    const session = await db.analyticsSession.findUniqueOrThrow({ where: { anonymousSessionId: sessionId } });
    const inv = await db.invitation.findUniqueOrThrow({ where: { outreachId: first.id } });
    assert.deepEqual([session.prospectId, session.invitationId], [p.id, inv.id]);
  });

  test("a follow-up to a message whose invitation was revoked is refused: it would link to a page that no longer works", async () => {
    const p = await prospect();
    const first = await draft(p.id);
    await queueAndSend(db, first.id);
    const inv = await db.invitation.findUniqueOrThrow({ where: { outreachId: first.id } });
    await revokeInvitation(db, inv.id, "Wrong address.");
    await assert.rejects(createOutreachDraft(db, p.id, { ...OPTS, followUpOfId: first.id }), /invitation was revoked, so a follow-up would link to a page that no longer works/);
    assert.equal(await db.outreach.count(), 1, "nothing drafted");
  });

  test("messages made before invitations keep working as they did, and no token is ever made up for them", async () => {
    const p = await prospect();
    // A pre-4D first message: drafted with the referral link, no invitation.
    const o = await draft(p.id);
    await db.invitation.delete({ where: { outreachId: o.id } });
    const legacyBody = o.body.replace(LINK_RE, `https://reclaimbay.com/?ref=${p.referralCode}&campaign=outreach-intro-t1`);
    await db.outreach.update({ where: { id: o.id }, data: { body: legacyBody, template: "intro@t1", campaign: "outreach-intro-t1" } });

    // It still queues and sends exactly as before; nothing is added to it.
    const sender = mockSender();
    const report = await queueAndSend(db, o.id, sender);
    assert.equal(report.sent.length, 1);
    assert.equal(sender.calls[0]!.text, legacyBody, "sent exactly as stored");
    assert.equal(await db.invitation.count(), 0);
    assert.equal(await invitationForOutreach(db, o.id), null);

    // Its follow-up keeps the referral link, under the old follow-up template.
    const followUp = (await createOutreachDraft(db, p.id, { ...OPTS, followUpOfId: o.id })).outreach;
    assert.equal(followUp.template, "follow-up@t1");
    assert.ok(followUp.body.includes(`https://reclaimbay.com/?ref=${p.referralCode}&campaign=outreach-follow-up-t1`));
    assert.ok(!followUp.body.includes("/invite#"));
    assert.equal(await db.invitation.count(), 0, "no invitation invented");
  });

  test("an invitation whose link isn't in its message (made after the fact) isn't guessed at: the follow-up keeps the referral link", async () => {
    const p = await prospect();
    const o = await draft(p.id);
    // The message text no longer carries the invitation's link (as for an invitation made later for an older draft).
    await db.outreach.update({ where: { id: o.id }, data: { body: o.body.replace(LINK_RE, "https://reclaimbay.com/") } });
    await queueAndSend(db, o.id);
    const followUp = (await createOutreachDraft(db, p.id, { ...OPTS, followUpOfId: o.id })).outreach;
    assert.equal(followUp.template, "follow-up@t1");
    assert.ok(!followUp.body.includes("/invite#"));
  });

  test("an invitation is never made where outreach isn't allowed, and drafting with one changes no rule", async () => {
    const unverified = await prospect({ signal_collision_repair_services: "unknown" });
    await assert.rejects(createOutreachDraft(db, unverified.id, OPTS), /Unverified/);
    const dnc = await prospect();
    await changeStatus(db, dnc.id, "do_not_contact", "Asked.");
    await assert.rejects(createOutreachDraft(db, dnc.id, OPTS), /never be contacted/);
    const suppressed = await prospect();
    await db.emailSuppression.create({ data: { email: suppressed.email!, reason: "bounced" } });
    await assert.rejects(createOutreachDraft(db, suppressed.id, OPTS), /suppressed \(bounced\)/);
    assert.equal(await db.invitation.count(), 0);
    assert.equal(await db.outreach.count(), 0);

    // With an invitation, queueing still enforces everything it did: a lost qualification is still refused.
    const p = await prospect();
    const o = await draft(p.id);
    const current = await db.prospect.findUniqueOrThrow({ where: { id: p.id }, include: { signals: true } });
    await updateProspect(db, p.id, { ...formValuesOf(current), signal_collision_repair_services: "unknown" });
    await assert.rejects(queueOutreach(db, o.id, CFG), /Outreach requires Qualification "Meets criteria"; this prospect is Unverified/);
    assert.equal((await db.outreach.findUniqueOrThrow({ where: { id: o.id } })).status, "draft");
  });

  test("a business name with markup stays text in the email; the link is the invitation, whatever the name says", async () => {
    const p = await prospect({ businessName: `<a href="https://evil.example/?r=1">Evil</a> & Sons` });
    const o = await draft(p.id);
    assert.equal(o.subject, `Quick question about <a href="https://evil.example/?r=1">Evil</a> & Sons`);
    const cta = /Get your free report: (\S+)\n/.exec(o.body)![1]!;
    assert.match(cta, /^https:\/\/reclaimbay\.com\/invite#[A-Za-z0-9_-]{43}$/, "the call to action is always the invitation, never anything from the name");
    const sender = mockSender();
    await queueAndSend(db, o.id, sender);
    assert.equal(sender.calls[0]!.text, o.body, "sent as the plain text that was reviewed");
  });
});
