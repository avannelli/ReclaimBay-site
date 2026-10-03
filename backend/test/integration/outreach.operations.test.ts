import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import { invitationActivations, openInvitation } from "../../src/invitations/service.js";
import { HIDDEN_TOKEN } from "../../src/invitations/tokens.js";
import { REPLY_OUTCOME_LABELS } from "../../src/outreach/lifecycle.js";
import { STALE_QUEUE_MS } from "../../src/outreach/operations.js";
import { classifyReply, createOutreachDraft, discardOutreach, queueOutreach, recordInboundReply } from "../../src/outreach/service.js";
import { addEvidence, createProspect } from "../../src/prospects.js";
import { TEST_DATABASE_URL, freshDb, readyForm, skipReason, truncate } from "./helpers.js";
import { CFG, OPTS, draftedInvitation, mockSender, queueAndSend } from "./outreachHelpers.js";

/*
 * Stage 5A: the Outreach operations views (/admin/outreach/messages) and the
 * Outreach page's attention list and navigation. Read-only views over the
 * stored records, through the real admin routes, against the test database.
 */

const SECRET = "integration-test-secret-0123456789";
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const BASE_ENV = { DATABASE_URL: TEST_DATABASE_URL, ALLOWED_ORIGIN: "https://reclaimbay.com", ADMIN_SECRET: SECRET, TRUST_PROXY_HOPS: "0" };
/** A deployment that may send: armed, with the sender identity the test messages are prepared for. */
const ARMED_ENV = {
  ...BASE_ENV,
  OUTREACH_SENDING_ENABLED: "1",
  OUTREACH_SENDER_NAME: CFG.outreachSender.name!,
  OUTREACH_SENDER_EMAIL: CFG.outreachSender.email!,
  OUTREACH_POSTAL_ADDRESS: CFG.outreachSender.postalAddress!,
  PUBLIC_API_URL: CFG.publicApiUrl!,
};
const HOUR = 60 * 60 * 1000;
const RAW_LINK = /\/invite#[A-Za-z0-9_-]{43}/;

describe("outreach operations views", { skip: skipReason }, () => {
  let db: Db;
  let app: FastifyInstance;
  let cookie = "";
  const signIn = async (a: FastifyInstance) => {
    const login = await a.inject({ method: "POST", url: "/admin/login", headers: FORM, payload: new URLSearchParams({ secret: SECRET }).toString() });
    return String(login.headers["set-cookie"]).split(";")[0]!;
  };
  before(async () => {
    db = await freshDb();
    app = await buildApp(loadConfig(BASE_ENV), db, false);
    cookie = await signIn(app);
  });
  beforeEach(async () => truncate(db));
  after(async () => {
    await app?.close();
    await db?.$disconnect();
  });

  const page = async (url: string, a = app, c = cookie) => {
    const res = await a.inject({ method: "GET", url, headers: { cookie: c } });
    assert.equal(res.statusCode, 200, `${url}: ${res.body.slice(0, 300)}`);
    return res.body;
  };
  /** The Outreach page's "Needs attention" section only. */
  const attentionOf = (html: string) => {
    const start = html.indexOf('id="attention-h"');
    return start === -1 ? "" : html.slice(start, html.indexOf("</section>", start));
  };
  /** The table row that names a business (one row per business in these tests). */
  const rowOf = (html: string, name: string) => html.split("<tr").find((r) => r.includes(`>${name}<`)) ?? "";
  /** The table row of one message. */
  const rowById = (html: string, outreachId: string) => html.split("<tr").find((r) => r.includes(`href="/admin/outreach/${outreachId}"`)) ?? "";

  let seq = 0;
  const prospect = async (name: string, withEmail = true) => {
    const n = ++seq;
    const site = `https://ops${n}.example.com`;
    const p = await createProspect(
      db,
      readyForm({ businessName: name, website: site, phoneSourceUrl: `${site}/contact`, ...(withEmail ? { email: `service@ops${n}.example.com`, emailSourceUrl: `${site}/contact` } : {}) }),
    );
    await addEvidence(db, p.id, { signalKey: "independent_shop", sourceUrl: `${site}/about`, excerpt: "Family owned." });
    return p;
  };
  /** A first message (a draft) with its invitation and the token its link carries. */
  const invited = async (name: string) => {
    const p = await prospect(name);
    const o = (await createOutreachDraft(db, p.id, OPTS)).outreach;
    const { token, invitation } = await draftedInvitation(db, o);
    return { p, o, token, invitation };
  };
  /** Opens an invitation from a new browser; returns that browser's analytics session row id. */
  const openFrom = async (token: string, at: Date) => {
    const sessionId = randomUUID();
    assert.equal((await openInvitation(db, { token, sessionId }, at)).active, true);
    return (await db.analyticsSession.findUniqueOrThrow({ where: { anonymousSessionId: sessionId } })).id;
  };
  const scan = (sessionRowId: string, at: Date, isSample = false) => db.productEvent.create({ data: { sessionId: sessionRowId, eventType: "scan_completed", isSample, createdAt: at } });
  const ago = (ms: number) => new Date(Date.now() - ms);
  const replyTo = (o: { id: string }, email: string, summary: string | null, at: Date) =>
    recordInboundReply(db, { fromEmail: email, inReplyToProviderMessageId: `msg-${o.id}`, summary, at });

  // ---------- access ----------

  test("every view needs a session, keeps the admin's script-free policy, and has no scripts", async () => {
    const views = ["/admin/outreach/messages", "/admin/outreach/messages?view=replies", "/admin/outreach/messages?view=activity", "/admin/outreach/messages?view=eligible"];
    for (const url of views) {
      const anon = await app.inject({ method: "GET", url });
      assert.equal(anon.statusCode, 303, url);
      assert.equal(anon.headers.location, "/admin/login", url);
      const res = await app.inject({ method: "GET", url, headers: { cookie } });
      assert.equal(res.statusCode, 200, url);
      assert.match(String(res.headers["content-security-policy"]), /^default-src 'none'; img-src 'self'; style-src 'unsafe-inline'/, url);
      assert.doesNotMatch(res.body, /<script|\son[a-z]+\s*=|javascript:/i, url);
    }
  });

  // ---------- the message list ----------

  test("lists every message with its state, linked to its message and its prospect; filters by status, kind, and campaign", async () => {
    const a = await invited("Alpha Auto");
    const b = await invited("Bravo Auto");
    await queueAndSend(db, b.o.id);
    const followUp = (await createOutreachDraft(db, b.p.id, { ...OPTS, followUpOfId: b.o.id })).outreach;
    await db.outreach.update({ where: { id: a.o.id }, data: { campaign: "pilot-1" } });
    await db.outreach.update({ where: { id: followUp.id }, data: { campaign: null } });

    const all = await page("/admin/outreach/messages");
    for (const id of [a.o.id, b.o.id, followUp.id]) assert.match(all, new RegExp(`href="/admin/outreach/${id}"`), "each message links to its own page");
    assert.match(all, new RegExp(`href="/admin/prospects/${a.p.id}">Alpha Auto<`), "and to its prospect");
    assert.match(all, /Showing 1–3 of 3/);
    assert.match(rowById(all, b.o.id), /Queued \d{4}-[\s\S]*?Sent \d{4}-/, "queued and sent times");
    assert.match(rowById(all, b.o.id), /Not opened/, "its invitation's state");
    assert.match(rowById(all, a.o.id), /Not queued/);
    assert.match(rowById(all, followUp.id), /Uses the first message's/, "a follow-up points to the first message's invitation");

    const only = async (query: string) => {
      const html = await page(`/admin/outreach/messages?${query}`);
      return [a.o.id, b.o.id, followUp.id].filter((id) => html.includes(`href="/admin/outreach/${id}"`));
    };
    assert.deepEqual(await only("status=draft"), [a.o.id, followUp.id], "drafts: the first message and the follow-up");
    assert.deepEqual(await only("status=sent"), [b.o.id]);
    assert.deepEqual(await only("kind=follow_up"), [followUp.id]);
    assert.deepEqual(await only("kind=initial&status=draft"), [a.o.id]);
    assert.deepEqual(await only("campaign=pilot-1"), [a.o.id]);
    assert.deepEqual(await only("campaign=%28none%29"), [followUp.id], "the funnel's (none) row");
    assert.deepEqual((await only("campaign=nonexistent")).length, 0);

    const kept = await page("/admin/outreach/messages?status=draft&campaign=pilot-1");
    assert.match(kept, /<option value="draft" selected>/, "the chosen filters stay selected");
    assert.match(kept, /<option value="pilot-1" selected>/);
  });

  test("pages 50 at a time, and the page links keep the filters", async () => {
    for (let i = 0; i < 51; i++) await createOutreachDraft(db, (await prospect(`Paged ${i} Auto`)).id, OPTS);
    const first = await page("/admin/outreach/messages?status=draft");
    assert.match(first, /Showing 1–50 of 51/);
    assert.equal(first.match(/href="\/admin\/outreach\/[0-9a-f-]{36}"/g)?.length, 50);
    assert.match(first, /href="\/admin\/outreach\/messages\?status=draft&#38;page=2">Next/);
    assert.doesNotMatch(first, /Previous/);
    const second = await page("/admin/outreach/messages?status=draft&page=2");
    assert.match(second, /Showing 51–51 of 51/);
    assert.equal(second.match(/href="\/admin\/outreach\/[0-9a-f-]{36}"/g)?.length, 1);
    assert.match(second, /href="\/admin\/outreach\/messages\?status=draft&#38;page=1">← Previous/);
  });

  // ---------- security ----------

  test("no page shows an invitation token, its hash, the invitation's id, or a working invitation link, even where a reply or a reason quotes one", async () => {
    const s = await invited("Quoted Auto");
    await queueAndSend(db, s.o.id);
    await openFrom(s.token, ago(HOUR));
    // A reply quoting the original email, link and all.
    await replyTo(s.o, s.p.email!, `Thanks. > Get your free report: https://reclaimbay.com/invite#${s.token}`, ago(30 * 60_000));
    // A person's reason that pastes the link.
    const d = await invited("Discarded Auto");
    await discardOutreach(db, d.o.id, `Sent the wrong one: https://reclaimbay.com/invite#${d.token}`);
    const fresh = await invited("Fresh Auto"); // a draft: its body carries the link

    const urls = [
      "/admin/outreach",
      "/admin/outreach/messages",
      "/admin/outreach/messages?status=cancelled",
      "/admin/outreach/messages?view=replies",
      "/admin/outreach/messages?view=activity",
      "/admin/outreach/messages?view=eligible",
    ];
    for (const url of urls) {
      const html = await page(url);
      for (const x of [s, d, fresh]) {
        assert.ok(!html.includes(x.token), `${url}: no token`);
        assert.ok(!html.includes(x.invitation.tokenHash), `${url}: no token hash`);
        assert.ok(!html.includes(x.invitation.id), `${url}: no invitation id`);
      }
      assert.doesNotMatch(html, RAW_LINK, `${url}: no working invitation link`);
      // A line only the email body has (the reply above quotes a different one).
      assert.doesNotMatch(html, /No account or commitment required/, `${url}: no message body`);
    }
    const replies = await page("/admin/outreach/messages?view=replies");
    assert.ok(replies.includes(`https://reclaimbay.com/invite#${HIDDEN_TOKEN}`), "the quoted link keeps its place, without its token");
    const cancelled = await page("/admin/outreach/messages?status=cancelled");
    assert.ok(cancelled.includes(`Sent the wrong one: https://reclaimbay.com/invite#${HIDDEN_TOKEN}`));
  });

  // ---------- replies ----------

  test("replies: unclassified first, with each one's classification and a safe summary", async () => {
    const older = await invited("Unclassified Auto");
    const newer = await invited("Interested Auto");
    const quiet = await invited("No Reply Auto");
    for (const x of [older, newer, quiet]) await queueAndSend(db, x.o.id);
    await replyTo(older.o, older.p.email!, "Can you call me Tuesday? <b>bold</b>", ago(5 * HOUR));
    await replyTo(newer.o, newer.p.email!, "Yes, interested.", ago(HOUR));
    await classifyReply(db, newer.o.id, "interested");

    const html = await page("/admin/outreach/messages?view=replies");
    assert.match(html, /Showing 1–2 of 2<\/b> · 1 not yet classified/);
    assert.ok(html.indexOf("Unclassified Auto") < html.indexOf("Interested Auto"), "the unclassified reply comes first, though it is older");
    assert.ok(!html.includes("No Reply Auto"), "only messages with a reply");
    assert.match(rowOf(html, "Unclassified Auto"), /<b>Not yet classified<\/b>/);
    assert.match(rowOf(html, "Interested Auto"), new RegExp(REPLY_OUTCOME_LABELS.interested));
    assert.match(html, /Can you call me Tuesday\? &#60;b&#62;bold&#60;\/b&#62;/, "the summary is escaped");
    assert.match(html, new RegExp(`href="/admin/outreach/${older.o.id}"`));
  });

  // ---------- invitation activity ----------

  test("activity: opened invitations, newest activity first; activation is invitationActivations(), never a sample or an earlier scan", async () => {
    const activated = await invited("Activated Auto");
    const opened = await invited("Opened Only Auto");
    const early = await invited("Scanned Early Auto");
    const sample = await invited("Sample Only Auto");
    const unopened = await invited("Unopened Auto");

    await scan(await openFrom(activated.token, ago(3 * HOUR)), ago(HOUR)); // real scan after the open
    await openFrom(opened.token, ago(2 * HOUR));
    await scan(await openFrom(early.token, ago(2.5 * HOUR)), ago(5 * HOUR)); // scan dated before the open
    await scan(await openFrom(sample.token, ago(4 * HOUR)), ago(3.5 * HOUR), true); // the built-in sample

    const html = await page("/admin/outreach/messages?view=activity");
    assert.match(html, /Showing 1–4 of 4/);
    assert.ok(!html.includes("Unopened Auto"), "only opened invitations");
    const order = ["Activated Auto", "Opened Only Auto", "Scanned Early Auto", "Sample Only Auto"].map((n) => html.indexOf(n));
    assert.deepEqual([...order].sort((x, y) => x - y), order, "newest activity first: a scan 1h ago, then opens 2h, 2.5h, 4h ago");
    assert.match(rowOf(html, "Activated Auto"), /Activated<\/span><div class="sub">\d{4}-/);
    assert.match(rowOf(html, "Activated Auto"), /Ran a real scan/);
    for (const name of ["Opened Only Auto", "Scanned Early Auto", "Sample Only Auto"]) {
      assert.match(rowOf(html, name), /<\/span> Opened<\/span>/, `${name}: opened, not activated`);
      assert.match(rowOf(html, name), /Opened the invitation/);
    }

    // The view's "activated" is exactly invitationActivations().
    const ids = [activated, opened, early, sample, unopened].map((x) => x.invitation.id);
    const byService = await invitationActivations(db, ids);
    assert.deepEqual([...byService.keys()], [activated.invitation.id]);
    const onlyActivated = await page("/admin/outreach/messages?view=activity&activated=1");
    assert.match(onlyActivated, /Showing 1–1 of 1/);
    assert.ok(onlyActivated.includes("Activated Auto") && !onlyActivated.includes("Opened Only Auto"));

    const byCampaign = await page("/admin/outreach/messages?view=activity&campaign=outreach-intro-t2");
    assert.match(byCampaign, /Showing 1–4 of 4/, "the campaign frozen on the invitation");
    assert.match(await page("/admin/outreach/messages?view=activity&campaign=pilot-9"), /No invitation has been opened yet\./);
  });

  // ---------- eligible now ----------

  test("eligible now: exactly the prospects a first draft could be made for, and looking drafts nothing", async () => {
    const eligible = await prospect("Eligible Auto");
    await invited("Already Drafted Auto"); // has an open message
    await prospect("No Email Auto", false); // no published email

    const [messagesBefore, invitationsBefore] = [await db.outreach.count(), await db.invitation.count()];
    const html = await page("/admin/outreach/messages?view=eligible");
    assert.equal(await db.outreach.count(), messagesBefore, "no draft was made");
    assert.equal(await db.invitation.count(), invitationsBefore, "no invitation was made");

    assert.match(html, /Showing 1–1 of 1/);
    assert.match(html, new RegExp(`href="/admin/prospects/${eligible.id}">Eligible Auto<`));
    assert.ok(html.includes(eligible.email!) && html.includes("found at"), "its email and where it was found");
    assert.match(rowOf(html, "Eligible Auto"), /Meets criteria/);
    assert.ok(!html.includes("Already Drafted Auto") && !html.includes("No Email Auto"));
    assert.match(html, /<nav class="chips" aria-label="Outreach views">[\s\S]*?Eligible now <span class="n">1<\/span>/);
  });

  // ---------- the Outreach page ----------

  test("the Outreach page links to every view, and its funnel's Opened and Activated lead to the invitations behind them", async () => {
    const x = await invited("Funnel Auto");
    await queueAndSend(db, x.o.id);
    await scan(await openFrom(x.token, ago(2 * HOUR)), ago(HOUR));
    const html = await page("/admin/outreach");
    for (const href of ["/admin/outreach/messages?view=eligible", "/admin/outreach/messages", "/admin/outreach/messages?view=replies", "/admin/outreach/messages?view=activity", "/admin/outreach#funnel"]) {
      assert.ok(html.includes(`href="${href.replace(/&/g, "&#38;")}"`), href);
    }
    // Invitations sent has no link: no list holds exactly the invitations whose message was sent.
    assert.ok(!html.includes("kind=initial&#38;campaign=outreach-intro-t2"), "Invitations sent");
    // Sent invitations only, like the counts (outreach.measurement.test.ts checks the lists match them).
    assert.ok(html.includes('href="/admin/outreach/messages?view=activity&#38;campaign=outreach-intro-t2&#38;sent=1">1</a>'), "Opened");
    assert.ok(html.includes('href="/admin/outreach/messages?view=activity&#38;campaign=outreach-intro-t2&#38;activated=1&#38;sent=1">1</a>'), "Activated");
    assert.ok(html.includes('href="/admin/outreach/messages?view=activity&#38;activated=1&#38;sent=1">1</a>'), "the total row has no campaign filter");
  });

  test("needs attention: recent invitation activity, replies to classify, and the provider's refusals", async () => {
    const recent = await invited("Recently Opened Auto");
    const stale = await invited("Opened Long Ago Auto");
    await openFrom(recent.token, ago(HOUR));
    await openFrom(stale.token, ago(10 * 24 * HOUR));
    const replied = await invited("Replied Auto");
    await queueAndSend(db, replied.o.id);
    await replyTo(replied.o, replied.p.email!, "Interested?", ago(HOUR));
    const refused = await invited("Refused Auto");
    await queueAndSend(db, refused.o.id, mockSender(() => ({ status: "rejected", reason: "550 mailbox unavailable", invalidRecipient: false })));

    const attention = attentionOf(await page("/admin/outreach"));
    assert.match(attention, /Invitation activity, last 7 days <span class="q-count">1<\/span>/);
    assert.ok(attention.includes("Recently Opened Auto"), "opened an hour ago");
    assert.ok(!attention.includes("Opened Long Ago Auto"), "opened ten days ago is not recent");
    assert.match(attention, /Replies to classify <span class="q-count">1<\/span>/);
    assert.match(attention, /Refused by the provider, last 7 days <span class="q-count">1<\/span>[\s\S]*?550 mailbox unavailable/);
    assert.doesNotMatch(attention, /Queued mail isn/, "sending isn't on here");
  });

  test(`the stale-queue warning appears only while sending is really on, after ${STALE_QUEUE_MS / HOUR} hours with queued mail and nothing sent`, async () => {
    const sender = mockSender();
    const armed = await buildApp(loadConfig(ARMED_ENV), db, false, { outreachSender: sender });
    try {
      const armedCookie = await signIn(armed);
      const sent = await invited("Sent Earlier Auto");
      await queueAndSend(db, sent.o.id, sender); // also switches sending on
      const waiting = await invited("Waiting Auto");
      await queueOutreach(db, waiting.o.id, CFG);
      const past = ago(STALE_QUEUE_MS + HOUR);
      await db.outreach.update({ where: { id: waiting.o.id }, data: { queuedAt: past } });
      await db.outreachControlChange.updateMany({ data: { createdAt: past } });

      const warned = (html: string) => /Queued mail isn&#39;t going out/.test(attentionOf(html));
      assert.equal(warned(await page("/admin/outreach", armed, armedCookie)), false, "something was sent just now: the job is running");

      await db.outreach.update({ where: { id: sent.o.id }, data: { sentAt: past } });
      const html = await page("/admin/outreach", armed, armedCookie);
      assert.match(html, /Sending is ON</, "on, unblocked, capacity left");
      assert.equal(warned(html), true, "queued past the threshold, nothing sent within it");
      assert.ok(attentionOf(html).includes('href="/admin/outreach/messages?status=queued"'));

      // The same records on a deployment that can't send: no warning, since nothing would send anyway.
      assert.equal(warned(await page("/admin/outreach")), false);

      // Switched on only moments ago: the job may not have had its turn yet.
      await db.outreachControlChange.updateMany({ data: { createdAt: new Date() } });
      assert.equal(warned(await page("/admin/outreach", armed, armedCookie)), false);
    } finally {
      await armed.close();
    }
  });
});
