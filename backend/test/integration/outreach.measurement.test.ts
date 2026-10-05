import { addFixtureCollisionEvidence } from "./helpers.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import { openInvitation } from "../../src/invitations/service.js";
import { dispatchQueued } from "../../src/outreach/dispatch.js";
import { outreachMetrics, type FunnelRow } from "../../src/outreach/metrics.js";
import { applyProviderEvent, classifyReply, createOutreachDraft, discardOutreach, queueOutreach, recordReply, unsubscribeOutreach } from "../../src/outreach/service.js";
import type { Status } from "../../src/prospectStatus.js";
import { addEvidence, changeStatusInTx, createProspect, formValuesOf, rescoreProspects, scoringInputFromRecord, updateProspect } from "../../src/prospects.js";
import { SCORING_VERSION, scoreProspect } from "../../src/scoring.js";
import { TEST_DATABASE_URL, freshDb, readyForm, skipReason, truncate } from "./helpers.js";
import { CFG, OPTS, draftedInvitation, mockSender, queueAndSend, switchOn } from "./outreachHelpers.js";

/*
 * Stage 5C, measurement integrity: what each funnel figure counts
 * (outreachMetrics and the Outreach page), and the score each message is
 * queued with. Through the real services and the real dispatcher with the mock
 * provider, against the test database. Nothing reaches the network.
 */

const SECRET = "integration-test-secret-0123456789";
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const INTRO = "outreach-intro-t4";
const FOLLOW_UP = "outreach-follow-up-t2";
const MINUTE = 60_000;
const later = (minutes: number) => new Date(Date.now() + minutes * MINUTE);
const earlier = (minutes: number) => new Date(Date.now() - minutes * MINUTE);

describe("outreach measurement", { skip: skipReason }, () => {
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

  let seq = 0;
  /** A qualified prospect with its own published email and evidence. */
  const prospect = async (over: Record<string, string> = {}) => {
    const n = ++seq;
    const site = `https://measure${n}.example.com`;
    const p = await createProspect(
      db,
      readyForm({ businessName: `Measure ${n} Auto`, website: site, phoneSourceUrl: `${site}/contact`, email: `service@measure${n}.example.com`, emailSourceUrl: `${site}/contact`, ...over }),
    );
    await addFixtureCollisionEvidence(db, p);
    await addEvidence(db, p.id, { signalKey: "independent_shop", sourceUrl: `${site}/about`, excerpt: "Family owned." });
    return p;
  };
  const draft = async (prospectId: string, followUpOfId?: string) => (await createOutreachDraft(db, prospectId, followUpOfId ? { ...OPTS, followUpOfId } : OPTS)).outreach;
  /** A first message, queued and sent: its prospect, the message, and its invitation's token. */
  const sent = async () => {
    const p = await prospect();
    const o = await draft(p.id);
    const { token } = await draftedInvitation(db, o);
    await queueAndSend(db, o.id);
    return { p, o, token };
  };
  /** A follow-up to a sent first message, queued and sent. */
  const followUp = async (prospectId: string, firstId: string) => {
    const f = await draft(prospectId, firstId);
    await queueAndSend(db, f.id);
    return f;
  };
  /** A status change at a chosen time, through the same validated path as a person. */
  const move = (prospectId: string, to: Status, at: Date, reason: string | null = null) => db.$transaction((tx) => changeStatusInTx(tx, prospectId, to, reason, at));
  const row = (rows: FunnelRow[], campaign: string) => {
    const r = rows.find((x) => x.campaign === campaign);
    assert.ok(r, `a row for ${campaign}`);
    return r;
  };
  const pick = <K extends keyof FunnelRow>(r: FunnelRow, keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, r[k]])) as Pick<FunnelRow, K>;
  const get = async (url: string) => (await app.inject({ method: "GET", url, headers: { cookie } })).body;

  // ---------- the funnel ----------

  test("Invitations sent counts only invitations whose message was sent; Opened and Activated are of those", async () => {
    const a = await sent();
    const session = randomUUID();
    const opened = new Date();
    assert.equal((await openInvitation(db, { token: a.token, sessionId: session }, opened)).active, true);
    const s = await db.analyticsSession.findUniqueOrThrow({ where: { anonymousSessionId: session } });
    await db.productEvent.create({ data: { sessionId: s.id, eventType: "scan_completed", createdAt: new Date(opened.getTime() + MINUTE) } });
    await sent(); // sent, never opened

    // Made, but never sent: a draft (even if someone opens its link), a discarded draft, and one the provider refused.
    const drafted = await draft((await prospect()).id);
    assert.equal((await openInvitation(db, { token: (await draftedInvitation(db, drafted)).token })).active, true);
    await discardOutreach(db, (await draft((await prospect()).id)).id, "Not now.");
    await queueAndSend(db, (await draft((await prospect()).id)).id, mockSender(() => ({ status: "rejected", reason: "550 refused" })));
    assert.equal(await db.invitation.count(), 5, "all five have an invitation");

    const rows = await outreachMetrics(db);
    assert.deepEqual(pick(row(rows, INTRO), ["invitationsSent", "opened", "activated"]), { invitationsSent: 2, opened: 1, activated: 1 });
    assert.deepEqual(pick(row(rows, "all"), ["invitationsSent", "opened", "activated"]), { invitationsSent: 2, opened: 1, activated: 1 });
  });

  test("prospects emailed and reached; refused before sending is apart from sent, and failed after sending is part of it", async () => {
    const ok = await sent();
    await unsubscribeOutreach(db, ok.o.id, "by a test"); // reached, then opted out: still reached
    const complainer = await sent();
    await applyProviderEvent(db, { provider: "mock", type: "complained", providerMessageId: `msg-${complainer.o.id}` });
    const bounced = await sent();
    await applyProviderEvent(db, { provider: "mock", type: "bounced", providerMessageId: `msg-${bounced.o.id}` });
    const failed = await sent();
    await applyProviderEvent(db, { provider: "mock", type: "failed", providerMessageId: `msg-${failed.o.id}`, reason: "Quota." });
    const refused = await draft((await prospect()).id);
    await queueAndSend(db, refused.id, mockSender(() => ({ status: "rejected", reason: "550 refused" })));
    // Queued last, so no dispatch run above sent it.
    await queueOutreach(db, (await draft((await prospect()).id)).id, CFG);

    const r = row(await outreachMetrics(db), INTRO);
    assert.deepEqual(
      pick(r, ["everDrafted", "everQueued", "refusedBeforeSending", "sent", "bounced", "failedAfterSending", "unsubscribed", "complained", "prospectsEmailed", "prospectsReached"]),
      { everDrafted: 6, everQueued: 6, refusedBeforeSending: 1, sent: 4, bounced: 1, failedAfterSending: 1, unsubscribed: 1, complained: 1, prospectsEmailed: 4, prospectsReached: 2 },
    );
    assert.equal((await db.outreach.findUniqueOrThrow({ where: { id: refused.id } })).sentAt, null, "the refusal never reached the provider");
  });

  test("outcomes count only statuses reached after the first email; a reopened prospect's earlier round is never credited", async () => {
    // A prospect that went as far as a meeting, then Lost, then was set aside and reopened, all before any email.
    const reopened = await prospect();
    const before: [Status, string | null][] = [
      ["qualified", null],
      ["ready_to_contact", null],
      ["contacted", null],
      ["engaged", null],
      ["meeting", null],
      ["lost", "Not then."],
      ["archived", null],
      ["new", null],
    ];
    for (const [i, [to, reason]] of before.entries()) await move(reopened.id, to, earlier(60 - i), reason);
    const first = await draft(reopened.id);
    await queueAndSend(db, first.id);

    const none = row(await outreachMetrics(db), INTRO);
    assert.deepEqual(pick(none, ["prospectsEmailed", "meetings", "proposals", "customers", "lost"]), { prospectsEmailed: 1, meetings: 0, proposals: 0, customers: 0, lost: 0 }, "nothing from before the email");

    // After the email: a meeting for the reopened prospect; another prospect is Lost, then becomes a customer.
    await move(reopened.id, "engaged", later(1));
    await move(reopened.id, "meeting", later(2));
    const turned = await sent();
    await move(turned.p.id, "lost", later(1), "Said no.");
    await move(turned.p.id, "engaged", later(2));
    await move(turned.p.id, "customer", later(3));

    const r = row(await outreachMetrics(db), INTRO);
    assert.deepEqual(pick(r, ["prospectsEmailed", "meetings", "proposals", "customers", "lost"]), { prospectsEmailed: 2, meetings: 1, proposals: 0, customers: 1, lost: 1 });
  });

  test("every reply is exactly one of positive, negative, other, or unclassified; a prospect who replied twice is one replying prospect", async () => {
    const outcomes = ["interested", "not_interested", "do_not_contact", "other", undefined] as const;
    for (const outcome of outcomes) await recordReply(db, (await sent()).o.id, { outcome });
    // Replied to the follow-up, then to the first message too.
    const twice = await sent();
    const f = await followUp(twice.p.id, twice.o.id);
    await recordReply(db, f.id, { outcome: "interested" });
    await recordReply(db, twice.o.id, { outcome: "other" });

    const rows = await outreachMetrics(db);
    const keys = ["replied", "positive", "negative", "other", "unclassified", "replyingProspects"] as const;
    assert.deepEqual(pick(row(rows, INTRO), keys), { replied: 6, positive: 1, negative: 2, other: 2, unclassified: 1, replyingProspects: 6 });
    assert.deepEqual(pick(row(rows, FOLLOW_UP), keys), { replied: 1, positive: 1, negative: 0, other: 0, unclassified: 0, replyingProspects: 0 });
    assert.deepEqual(pick(row(rows, "all"), keys), { replied: 7, positive: 2, negative: 2, other: 2, unclassified: 1, replyingProspects: 6 });
    for (const r of rows) assert.equal(r.replied, r.positive + r.negative + r.other + r.unclassified, r.campaign);
  });

  test("a follow-up's own row counts its messages; its invitation and its prospect are credited to the first message's campaign", async () => {
    const s = await sent();
    await followUp(s.p.id, s.o.id);
    assert.equal((await openInvitation(db, { token: s.token }, later(1))).active, true, "opened after the follow-up, through the link both carry");

    const rows = await outreachMetrics(db);
    const keys = ["firstMessages", "followUps", "everDrafted", "sent", "invitationsSent", "opened", "prospectsEmailed", "prospectsReached"] as const;
    assert.deepEqual(pick(row(rows, INTRO), keys), { firstMessages: 1, followUps: 0, everDrafted: 1, sent: 1, invitationsSent: 1, opened: 1, prospectsEmailed: 1, prospectsReached: 1 });
    assert.deepEqual(pick(row(rows, FOLLOW_UP), keys), { firstMessages: 0, followUps: 1, everDrafted: 1, sent: 1, invitationsSent: 0, opened: 0, prospectsEmailed: 0, prospectsReached: 0 });
  });

  // ---------- the Outreach page ----------

  test("the page says what each figure counts: no Delivered column, ever-counts apart from the tiles, send attempts, and — where a campaign can't be credited", async () => {
    const s = await sent();
    await followUp(s.p.id, s.o.id);
    await queueAndSend(db, (await draft((await prospect()).id)).id, mockSender(() => ({ status: "rejected", reason: "550 refused" })));
    await draft((await prospect()).id); // a draft now

    const html = await get("/admin/outreach");
    const funnel = html.slice(html.indexOf('id="funnel"'));
    for (const group of ["Messages", "Invitations", "Prospects", "Reached since their first email"]) {
      assert.match(funnel, new RegExp(`<th scope="colgroup" colspan="\\d+">${group}</th>`), group);
    }
    for (const label of ["Ever drafted", "Ever queued", "Refused before sending", "Sent", "Failed after sending", "Replies", "Other", "Unclassified", "Invitations sent", "Prospects emailed", "Prospects reached", "Replying prospects", "Customer"]) {
      assert.ok(funnel.includes(`<th scope="col" class="num">${label}</th>`), label);
    }
    for (const gone of ["Delivered", "Drafted", "Queued", "Invited", "Failed", "Replied"]) assert.ok(!funnel.includes(`<th scope="col" class="num">${gone}</th>`), `no ${gone} column`);
    assert.match(funnel, /<dt>Delivery<\/dt><dd>Not measured: Gmail reports no deliveries/);
    assert.match(funnel, /<dt>All time<\/dt><dd>There is no date window\./);
    assert.match(html, /<h2>Messages by current status<\/h2>/);

    // The tiles count what is in a state now; the funnel what ever was.
    assert.match(html, /<span class="q-tile-n">1<\/span><span class="q-tile-l"><span aria-hidden="true">✎<\/span> Drafts<\/span><span class="q-tile-h">now: prepared, not yet queued<\/span>/);
    assert.match(html, /<span class="q-tile-n">0<\/span><span class="q-tile-l"><span aria-hidden="true">→<\/span> Queued<\/span><span class="q-tile-h">now: waiting to be sent<\/span>/);
    // Three sends started (the refusal included): the daily limit's count, though only two were sent.
    assert.match(html, /<span class="q-tile-n">3 \/ 20<\/span><span class="q-tile-l"><span aria-hidden="true">✉<\/span> Send attempts, last 24 hours<\/span><span class="q-tile-h">started, whether or not the provider sent them · 17 left under the daily limit<\/span>/);
    assert.equal((await db.outreach.count({ where: { sendStartedAt: { not: null } } })), 3);
    assert.equal((await db.outreach.count({ where: { sentAt: { not: null } } })), 2);

    const cells = (campaign: string) => new RegExp(`<tr><td><code>${campaign}</code></td>(.*?)</tr>`).exec(funnel)?.[1] ?? "";
    const dashes = (campaign: string) => cells(campaign).split("not attributable to this campaign").length - 1;
    assert.equal(dashes(FOLLOW_UP), 10, "invitations, prospects, and outcomes: 3 + 3 + 4");
    assert.equal(dashes(INTRO), 0);
    assert.equal(dashes("all"), 0, "the total row is never a dash");
    // Invitations sent has no link: no list holds exactly those.
    assert.ok(!html.includes("kind=initial&#38;campaign="), "no Invited link");
  });

  test("Opened and Activated link to exactly the invitations they count; by default the activity view also shows an open on an uncertain send", async () => {
    const s = await sent();
    assert.equal((await openInvitation(db, { token: s.token }, later(1))).active, true);
    // The provider may or may not have sent this one: not sent as far as the records know, but its open is worth seeing.
    const p = await prospect();
    const unsure = await draft(p.id);
    const { token } = await draftedInvitation(db, unsure);
    await queueAndSend(db, unsure.id, mockSender(() => ({ status: "uncertain", reason: "Timed out." })));
    const stored = await db.outreach.findUniqueOrThrow({ where: { id: unsure.id } });
    assert.ok(stored.sendStartedAt && !stored.sentAt, "outcome unknown");
    assert.equal((await openInvitation(db, { token }, later(2))).active, true);

    assert.deepEqual(pick(row(await outreachMetrics(db), INTRO), ["invitationsSent", "opened"]), { invitationsSent: 1, opened: 1 });
    const control = await get("/admin/outreach");
    assert.ok(control.includes('href="/admin/outreach/messages?view=activity&#38;campaign=outreach-intro-t4&#38;sent=1">1</a>'), "Opened links to sent invitations only");

    const linked = await get("/admin/outreach/messages?view=activity&campaign=outreach-intro-t4&sent=1");
    assert.match(linked, /Showing 1–1 of 1/, "the list behind Opened holds exactly what it counts");
    assert.ok(linked.includes(s.p.businessName!) && !linked.includes(p.businessName!));
    assert.match(linked, /<select id="f-sent" name="sent"><option value="">Sent or not<\/option><option value="1" selected>Sent only<\/option><\/select>/, "the filter is shown, and kept by Apply");

    const everything = await get("/admin/outreach/messages?view=activity&campaign=outreach-intro-t4");
    assert.match(everything, /Showing 1–2 of 2/);
    assert.ok(everything.includes(p.businessName!), "the uncertain send's open is still visible by default");
  });

  // ---------- the score snapshot ----------

  /** The score the current model gives the prospect now, from its stored signals. */
  const scoreNow = async (prospectId: string) => scoreProspect(scoringInputFromRecord(await db.prospect.findUniqueOrThrow({ where: { id: prospectId }, include: { signals: true } }))).score;
  const snapshot = async (id: string) => {
    const o = await db.outreach.findUniqueOrThrow({ where: { id }, select: { queuedScore: true, queuedScoreVersion: true } });
    return { score: o.queuedScore, version: o.queuedScoreVersion };
  };

  test("queueing records the prospect's score and the scoring version, once; a draft has none", async () => {
    const p = await prospect();
    const o = await draft(p.id);
    assert.deepEqual(await snapshot(o.id), { score: null, version: null }, "not queued yet");
    await queueOutreach(db, o.id, CFG);
    const expected = { score: await scoreNow(p.id), version: SCORING_VERSION };
    assert.ok(expected.score > 0);
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: p.id } })).score, expected.score, "the same score the prospect's cache holds");
    assert.deepEqual(await snapshot(o.id), expected);
    assert.equal((await queueOutreach(db, o.id, CFG)).changed, false);
    assert.deepEqual(await snapshot(o.id), expected, "queueing again changes nothing");

    // A follow-up is queued with its own snapshot.
    await switchOn(db, mockSender());
    await dispatchQueued(db, { config: CFG, sender: mockSender() });
    const f = await draft(p.id, o.id);
    await queueOutreach(db, f.id, CFG);
    assert.deepEqual(await snapshot(f.id), expected);
  });

  test("rescoring the prospect later never changes a queued message's snapshot", async () => {
    const p = await prospect();
    const o = await draft(p.id);
    await queueOutreach(db, o.id, CFG);
    const queued = await snapshot(o.id);

    // New evidence raises the prospect's score, and a rescore runs.
    const current = await db.prospect.findUniqueOrThrow({ where: { id: p.id }, include: { signals: true } });
    await updateProspect(db, p.id, { ...formValuesOf(current), signal_multiple_bays_or_staff: "yes" });
    await rescoreProspects(db, { all: true });
    const rescored = await db.prospect.findUniqueOrThrow({ where: { id: p.id } });
    assert.equal(rescored.score, queued.score! + 15, "the prospect's score moved");
    // As a later scoring model would leave it.
    await db.prospect.update({ where: { id: p.id }, data: { score: 3, scoreVersion: "v2" } });

    assert.deepEqual(await snapshot(o.id), queued);
    assert.equal(queued.version, SCORING_VERSION);
  });

  test("the snapshot survives sending, a reply, its classification, and a discard", async () => {
    const a = await prospect();
    const sentMessage = await draft(a.id);
    await queueAndSend(db, sentMessage.id);
    const expected = { score: await scoreNow(a.id), version: SCORING_VERSION };
    await recordReply(db, sentMessage.id, {});
    await classifyReply(db, sentMessage.id, "interested");
    const after = await db.outreach.findUniqueOrThrow({ where: { id: sentMessage.id } });
    assert.equal(after.status, "replied");
    assert.deepEqual(await snapshot(sentMessage.id), expected);

    const b = await prospect();
    const discarded = await draft(b.id);
    await queueOutreach(db, discarded.id, CFG);
    const queued = await snapshot(discarded.id);
    await discardOutreach(db, discarded.id, "Changed our mind.");
    assert.equal((await db.outreach.findUniqueOrThrow({ where: { id: discarded.id } })).status, "cancelled");
    assert.deepEqual(await snapshot(discarded.id), queued, "it was queued with that score, and that stays true");
  });

  test("the snapshot is what the current model computes at queue time, even when the prospect's cached score is stale", async () => {
    const p = await prospect();
    await db.prospect.update({ where: { id: p.id }, data: { score: 1, scoreVersion: "v0" } });
    const o = await draft(p.id);
    await queueOutreach(db, o.id, CFG);
    const s = await snapshot(o.id);
    assert.equal(s.version, SCORING_VERSION);
    assert.equal(s.score, await scoreNow(p.id));
    assert.notEqual(s.score, 1);
  });

  test("a message queued before snapshots were recorded keeps null: nothing invents one, and it still sends and counts", async () => {
    const p = await prospect();
    const o = await draft(p.id);
    await queueOutreach(db, o.id, CFG);
    // As the migration leaves a message queued before it.
    await db.outreach.update({ where: { id: o.id }, data: { queuedScore: null, queuedScoreVersion: null } });
    const sender = mockSender();
    await switchOn(db, sender);
    await dispatchQueued(db, { config: CFG, sender });
    const after = await db.outreach.findUniqueOrThrow({ where: { id: o.id } });
    assert.ok(after.sentAt, "sent");
    assert.deepEqual(await snapshot(o.id), { score: null, version: null });
    assert.equal(row(await outreachMetrics(db), INTRO).sent, 1);
  });
});
