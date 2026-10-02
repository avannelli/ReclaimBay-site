import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import { dispatchQueued } from "../../src/outreach/dispatch.js";
import { gmailSender } from "../../src/outreach/gmail.js";
import { gmailOAuthConfig, openSealedToken, type GmailOAuthConfig } from "../../src/outreach/gmailAuth.js";
import { senderFromConfig } from "../../src/outreach/sender.js";
import { pollGmailInbox } from "../../src/outreach/gmailInbox.js";
import { createOutreachDraft, queueOutreach } from "../../src/outreach/service.js";
import { addEvidence, createProspect } from "../../src/prospects.js";
import { ACCOUNT, CLIENT_ID, FakeGoogle, MAILBOX, aliasGoogle, fakeGmail, inbound } from "../fixtures/fakeGmail.js";
import { TEST_DATABASE_URL, freshDb, readyForm, skipReason, truncate } from "./helpers.js";
import { CFG, OPTS, switchOn } from "./outreachHelpers.js";

/*
 * The real dispatcher and inbox reader with the Gmail adapter, against a
 * fake Google and a disposable database. No real mailbox, no network.
 */

describe("outreach through Gmail", { skip: skipReason }, () => {
  let db: Db;
  let realCalls: string[] = [];
  const realFetch = globalThis.fetch;
  before(async () => {
    db = await freshDb();
  });
  beforeEach(async () => {
    await truncate(db);
    realCalls = [];
    globalThis.fetch = (async (url: unknown) => {
      realCalls.push(String(url));
      throw new Error("real network call");
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    assert.deepEqual(realCalls, [], "no real network call");
  });
  after(async () => db?.$disconnect());

  let n = 0;
  /** A queued first message to a fresh, qualified prospect. */
  const queued = async () => {
    const i = ++n;
    const site = `https://g${i}.example.com`;
    const p = await createProspect(db, readyForm({ businessName: `G${i} Auto`, website: site, phoneSourceUrl: `${site}/c`, email: `owner@g${i}.example.com`, emailSourceUrl: `${site}/c` }));
    await addEvidence(db, p.id, { signalKey: "independent_shop", sourceUrl: `${site}/about`, excerpt: "Family owned." });
    const { outreach } = await createOutreachDraft(db, p.id, OPTS);
    await queueOutreach(db, outreach.id, CFG);
    return { p, o: outreach };
  };
  const row = (id: string) => db.outreach.findUniqueOrThrow({ where: { id } });

  test("a send through Gmail stores Gmail's id and moves the prospect; the kill switch still rules", async () => {
    const { google, client } = fakeGmail();
    const sender = gmailSender(client);
    const { p, o } = await queued();
    const off = await dispatchQueued(db, { config: CFG, sender });
    assert.ok(off.blockers.includes("The global sending switch is off."));
    assert.equal(google.calls.length, 0, "switch off: Google isn't even contacted");

    await switchOn(db, sender);
    assert.equal((await dispatchQueued(db, { config: { ...CFG, outreachSendingArmed: false }, sender })).blockers.length, 1);
    assert.equal(google.calls.length, 0, "disarmed: Google isn't contacted");

    const report = await dispatchQueued(db, { config: CFG, sender });
    assert.equal(report.sent.length, 1);
    const stored = await row(o.id);
    assert.equal(stored.status, "sent");
    assert.equal(stored.provider, "gmail");
    assert.equal(stored.providerMessageId, google.sent[0]!.id);
    assert.equal(google.sent[0]!.marker, o.id);
    assert.match(Buffer.from(google.sent[0]!.raw, "base64url").toString(), /List-Unsubscribe: <https:\/\/api\.reclaimbay\.example\/u\//);
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: p.id } })).status, "contacted");
  });

  test("authorized as another account, a send goes out as its verified Send As address; without that alias nothing is attempted", async () => {
    const { google, client } = fakeGmail(aliasGoogle("accepted"));
    const sender = gmailSender(client);
    const { o } = await queued();
    await switchOn(db, sender);
    const report = await dispatchQueued(db, { config: CFG, sender });
    assert.equal(report.sent.length, 1);
    const head = Buffer.from(google.sent[0]!.raw, "base64url").toString().split("\r\n\r\n")[0]!;
    assert.match(head, /^From: "Alex Rivera" <hello@reclaimbay\.example>$/m);
    assert.match(head, /^Reply-To: hello@reclaimbay\.example$/m);
    assert.equal((await row(o.id)).providerMessageId, google.sent[0]!.id);

    const pending = fakeGmail(aliasGoogle("pending"));
    const s2 = gmailSender(pending.client);
    const b = await queued();
    await switchOn(db, s2);
    const blocked = await dispatchQueued(db, { config: CFG, sender: s2 });
    assert.equal(blocked.unavailable.length, 1);
    assert.match(blocked.stoppedBecause!, /isn't ready to use \(Gmail says pending\)/);
    assert.equal(pending.google.sendCalls.length, 0);
    const r = await row(b.o.id);
    assert.deepEqual([r.status, r.sendAttempts, r.sendStartedAt], ["queued", 0, null], "untouched, ready once the alias is verified");
  });

  test("Google unavailable (auth or quota): nothing sent, the message untouched, the batch stops", async () => {
    const { google, client } = fakeGmail();
    const sender = gmailSender(client);
    const a = await queued();
    const b = await queued();
    await switchOn(db, sender);
    google.tokenAnswer = { status: 401, body: { error: "unauthorized_client" } };
    const report = await dispatchQueued(db, { config: CFG, sender });
    assert.equal(report.unavailable.length, 1);
    assert.match(report.stoppedBecause!, /can't send right now.*unauthorized_client/);
    assert.equal(google.sendCalls.length, 0);
    for (const { o } of [a, b]) {
      const r = await row(o.id);
      assert.deepEqual([r.status, r.sendAttempts, r.sendStartedAt, r.lastSendError], ["queued", 0, null, null], "as if never attempted");
    }
    google.tokenAnswer = null;
    google.sendAnswers = [{ status: 429, body: { error: { message: "User-rate limit exceeded" } } }];
    const quota = await dispatchQueued(db, { config: CFG, sender });
    assert.equal(quota.unavailable.length, 1);
    assert.equal(google.sent.length, 0);
    assert.equal((await dispatchQueued(db, { config: CFG, sender })).sent.length, 2, "sends once Google is back");
  });

  test("a lost response is retried safely: Sent is checked first, so one email only", async () => {
    const { google, client } = fakeGmail();
    const sender = gmailSender(client);
    const { o } = await queued();
    await switchOn(db, sender);
    google.sendAnswers = ["network"];
    const first = await dispatchQueued(db, { config: CFG, sender });
    assert.equal(first.uncertain.length, 1);
    assert.equal(google.sent.length, 1, "it actually went out");
    const second = await dispatchQueued(db, { config: CFG, sender });
    assert.equal(second.sent.length, 1);
    assert.equal(google.sent.length, 1, "found in Sent, not sent again");
    const stored = await row(o.id);
    assert.equal(stored.providerMessageId, google.sent[0]!.id);
    assert.equal(stored.sendAttempts, 2);
  });

  test("an invalid recipient fails the message and suppresses the address", async () => {
    const { google, client } = fakeGmail();
    const sender = gmailSender(client);
    const { p, o } = await queued();
    await switchOn(db, sender);
    google.sendAnswers = [{ status: 400, body: { error: { message: "Invalid To header", errors: [{ reason: "invalidArgument" }] } } }];
    const r = await dispatchQueued(db, { config: CFG, sender });
    assert.equal(r.failed.length, 1);
    assert.equal((await row(o.id)).status, "failed");
    assert.equal((await db.emailSuppression.findUniqueOrThrow({ where: { email: p.email! } })).reason, "invalid");
  });

  test("the daily limit: counted over a rolling 24 hours, and concurrent dispatchers can't overshoot it", async () => {
    const { google, client } = fakeGmail();
    const sender = gmailSender(client);
    for (let i = 0; i < 3; i++) await queued();
    await switchOn(db, sender);
    const cfg = { ...CFG, outreachDailyLimit: 2 };
    const r = await dispatchQueued(db, { config: cfg, sender });
    assert.equal(r.sent.length, 2);
    assert.match(r.stoppedBecause!, /daily sending limit is reached \(2 of 2/);
    assert.equal((await dispatchQueued(db, { config: cfg, sender })).sent.length, 0);
    const tomorrow = () => new Date(Date.now() + 25 * 60 * 60 * 1000);
    assert.equal((await dispatchQueued(db, { config: cfg, sender, now: tomorrow })).sent.length, 1, "a day later, the last one goes");
    assert.equal(google.sent.length, 3);

    await truncate(db);
    const g2 = fakeGmail();
    const s2 = gmailSender(g2.client);
    for (let i = 0; i < 4; i++) await queued();
    await switchOn(db, s2);
    await Promise.all([1, 2, 3, 4].map(() => dispatchQueued(db, { config: { ...CFG, outreachDailyLimit: 1 }, sender: s2 })));
    assert.equal(g2.google.sent.length, 1, "exactly the limit, even with four dispatchers at once");
  });

  test("the mailbox: replies, bounces, auto-replies, and emailed unsubscribes are recorded once; the rest is only reported", async () => {
    const { google, client } = fakeGmail();
    const sender = gmailSender(client);
    const a = await queued();
    const b = await queued();
    const c = await queued();
    const d = await queued();
    await switchOn(db, sender);
    await dispatchQueued(db, { config: CFG, sender });
    const thread = (o: { id: string }) => google.sent.find((s) => s.marker === o.id)!.threadId;

    google.inbox.push(
      inbound("in-reply", thread(a.o), { From: `Owner <${a.p.email}>`, Subject: "Re: Declined work at G Auto" }, [{ mimeType: "text/plain", text: "Sounds interesting, call me." }], "Sounds interesting, call me."),
      inbound("in-ooo", thread(b.o), { From: `Front <${b.p.email}>`, Subject: "Automatic reply: Declined work", "Auto-Submitted": "auto-replied" }),
      inbound("in-dsn", thread(c.o), { From: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", Subject: "Delivery Status Notification (Failure)" }, [
        { mimeType: "message/delivery-status", text: "Action: failed\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550 5.1.1 does not exist" },
      ]),
      inbound("in-unsub", "th-new", { From: `${d.p.email}`, Subject: "unsubscribe" }),
      inbound("in-stranger", "th-other", { From: "someone@else.example.com", Subject: "Hello" }),
      inbound("in-delay", thread(b.o), { From: "mailer-daemon@googlemail.com", Subject: "Delivery Status Notification (Delay)" }, [{ mimeType: "message/delivery-status", text: "Action: delayed\nStatus: 4.4.7" }]),
    );

    const dry = await pollGmailInbox(db, client, { apply: false });
    assert.ok(dry.items.some((i) => i.result === "would record"));
    assert.equal(await db.outreachEvent.count({ where: { type: { in: ["replied", "bounced", "unsubscribed"] } } }), 0, "a dry run records nothing");

    const r = await pollGmailInbox(db, client, { apply: true });
    const by = (id: string) => r.items.find((i) => i.gmailId === id)!;
    assert.deepEqual([by("in-reply").kind, by("in-reply").result], ["reply", "recorded"]);
    assert.deepEqual([by("in-ooo").kind, by("in-ooo").result], ["auto_reply", "ignored"]);
    assert.deepEqual([by("in-dsn").kind, by("in-dsn").result], ["bounce", "recorded"]);
    assert.deepEqual([by("in-unsub").kind, by("in-unsub").result], ["unsubscribe", "recorded"]);
    assert.deepEqual([by("in-stranger").kind, by("in-stranger").result], ["reply", "unmatched"]);
    assert.deepEqual([by("in-delay").kind, by("in-delay").result], ["delay", "ignored"]);

    const ra = await row(a.o.id);
    assert.deepEqual([ra.status, ra.replyOutcome, ra.replySummary], ["replied", null, "Sounds interesting, call me."], "recorded unclassified, for a person");
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: a.p.id } })).status, "engaged");
    assert.equal((await row(b.o.id)).status, "sent", "an auto-reply and a delay change nothing");
    assert.equal((await row(c.o.id)).status, "bounced");
    assert.equal((await db.emailSuppression.findUniqueOrThrow({ where: { email: c.p.email! } })).reason, "bounced");
    assert.equal((await db.prospect.findUniqueOrThrow({ where: { id: d.p.id } })).status, "do_not_contact");
    assert.equal((await db.emailSuppression.findUniqueOrThrow({ where: { email: d.p.email! } })).reason, "unsubscribed");

    const before = await db.outreachEvent.count();
    const again = await pollGmailInbox(db, client, { apply: true });
    assert.equal(await db.outreachEvent.count(), before, "reading the same mail again records nothing");
    assert.ok(again.items.every((i) => ["duplicate", "ignored", "unmatched"].includes(i.result)), JSON.stringify(again.items.map((i) => i.result)));
    assert.equal(google.sendCalls.length, 4, "reading the mailbox never sends");
    void MAILBOX;
  });
});

describe("authorizing the Gmail mailbox (HTTP)", { skip: skipReason }, () => {
  const SECRET = "integration-test-secret-0123456789";
  const FORM = { "content-type": "application/x-www-form-urlencoded" };
  const KEY = randomBytes(32).toString("base64");
  let db: Db;
  let realCalls: string[] = [];
  const realFetch = globalThis.fetch;
  const apps: FastifyInstance[] = [];
  const env = (over: Record<string, string> = {}) => ({
    DATABASE_URL: TEST_DATABASE_URL,
    ALLOWED_ORIGIN: "https://reclaimbay.com",
    ADMIN_SECRET: SECRET,
    TRUST_PROXY_HOPS: "0",
    OUTREACH_PROVIDER: "gmail",
    GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: "test-client-secret",
    GMAIL_TOKEN_ENCRYPTION_KEY: KEY,
    PUBLIC_API_URL: "https://api.reclaimbay.example",
    OUTREACH_SENDER_EMAIL: MAILBOX,
    OUTREACH_SENDER_NAME: "Alex Rivera",
    OUTREACH_POSTAL_ADDRESS: "1 Main St, Ventura, CA 93001",
    ...over,
  });
  /** The app as it would be deployed with this environment, every Google call going to the fake. */
  const start = async (google: FakeGoogle, over: Record<string, string> = {}) => {
    const app = await buildApp(loadConfig(env(over)), db, false, { googleFetch: google.fetch });
    apps.push(app);
    const login = await app.inject({ method: "POST", url: "/admin/login", headers: FORM, payload: new URLSearchParams({ secret: SECRET }).toString() });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    return { app, get: (url: string) => app.inject({ method: "GET", url, headers: { cookie } }) };
  };
  /** Starts authorization as the admin; returns Google's URL and the state cookie. */
  const begin = async (get: (url: string) => Promise<{ statusCode: number; headers: Record<string, unknown> }>) => {
    const res = await get("/admin/outreach/gmail/authorize");
    assert.equal(res.statusCode, 302);
    const setCookie = String(res.headers["set-cookie"]);
    assert.match(setCookie, /^rb_gmail_oauth=[^;]+; Path=\/oauth\/gmail; HttpOnly; SameSite=Lax; Max-Age=600/);
    return { google: new URL(String(res.headers.location)), stateCookie: setCookie.split(";")[0]! };
  };
  const sealedFrom = (html: string) => /<textarea[^>]*>([^<]+)<\/textarea>/.exec(html)?.[1] ?? null;

  before(async () => {
    db = await freshDb();
  });
  beforeEach(async () => {
    await truncate(db);
    realCalls = [];
    globalThis.fetch = (async (url: unknown) => {
      realCalls.push(String(url));
      throw new Error("real network call");
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    assert.deepEqual(realCalls, [], "no real network call");
  });
  after(async () => {
    for (const a of apps) await a.close();
    await db?.$disconnect();
  });

  test("an admin authorizes the mailbox once; the refresh token is only ever shown sealed", async () => {
    const google = new FakeGoogle();
    const { app, get } = await start(google);
    const page = (await get("/admin/outreach")).body;
    assert.match(page, /authorized yet/);
    assert.match(page, /Authorize hello@reclaimbay\.example with Google/);

    const { google: url, stateCookie } = await begin(get);
    assert.equal(url.origin, "https://accounts.google.com");
    assert.equal(url.searchParams.get("access_type"), "offline");
    const state = url.searchParams.get("state")!;

    // Google sends the admin back. The admin session cookie isn't sent on this redirect (SameSite=Strict).
    const callback = (q: string, cookie?: string) => app.inject({ method: "GET", url: `/oauth/gmail/callback?${q}`, headers: cookie ? { cookie } : {} });
    assert.equal((await callback(`state=${state}&code=good-code`)).statusCode, 400, "no state cookie: refused");
    assert.equal((await callback("state=wrong&code=good-code", stateCookie)).statusCode, 400, "wrong state: refused");
    assert.equal(google.tokenCalls.length, 0, "nothing exchanged for a refused callback");

    const ok = await callback(`state=${state}&code=good-code`, stateCookie);
    assert.equal(ok.statusCode, 200);
    assert.match(ok.body, /hello@reclaimbay\.example<\/b> is authorized/);
    assert.match(String(ok.headers["set-cookie"]), /rb_gmail_oauth=; Path=\/oauth\/gmail; .*Max-Age=0/, "the state is single-use");
    assert.equal(ok.headers["cache-control"], "no-store");
    const sealed = sealedFrom(ok.body)!;
    const { refreshToken: refresh } = openSealedToken(sealed, gmailOAuthConfig(loadConfig(env())) as GmailOAuthConfig)!;
    assert.ok(google.validRefreshTokens.has(refresh));
    assert.ok(!ok.body.includes(refresh), "the plain refresh token is never shown");

    // Once stored as GMAIL_REFRESH_TOKEN_SEALED (and the service restarted), the admin sees it verified live.
    const authorized = await start(google, { GMAIL_REFRESH_TOKEN_SEALED: sealed });
    const live = (await authorized.get("/admin/outreach")).body;
    assert.match(live, /Authorized as hello@reclaimbay\.example/);
    assert.match(live, /Reauthorize hello@reclaimbay\.example with Google/);
    assert.equal(google.sendCalls.length, 0, "authorizing never sends");
  });

  test("the wrong Google account is refused, its access revoked, and nothing is issued", async () => {
    const google = new FakeGoogle();
    google.account = "personal@gmail.com";
    const { app, get } = await start(google);
    const { google: url, stateCookie } = await begin(get);
    const res = await app.inject({ method: "GET", url: `/oauth/gmail/callback?state=${url.searchParams.get("state")}&code=good-code`, headers: { cookie: stateCookie } });
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /That was personal@gmail\.com, which can&#39;t send as hello@reclaimbay\.example/);
    assert.equal(sealedFrom(res.body), null);
    assert.equal(google.revoked.length, 1);
    assert.equal(google.validRefreshTokens.size, 0);
  });

  test("the account that has the sender as a verified Send As address is authorized; a pending alias is refused", async () => {
    const google = aliasGoogle("accepted");
    const { app, get } = await start(google);
    const { google: url, stateCookie } = await begin(get);
    assert.equal(url.searchParams.get("login_hint"), null, "no hint to sign in as the alias");
    const ok = await app.inject({ method: "GET", url: `/oauth/gmail/callback?state=${url.searchParams.get("state")}&code=good-code`, headers: { cookie: stateCookie } });
    assert.equal(ok.statusCode, 200);
    assert.match(ok.body, /alex@reclaimbay\.example<\/b> is authorized for sending as hello@reclaimbay\.example/);
    const sealed = sealedFrom(ok.body)!;
    assert.equal(openSealedToken(sealed, gmailOAuthConfig(loadConfig(env())) as GmailOAuthConfig)!.account, ACCOUNT);
    assert.deepEqual(google.revoked, []);

    const live = (await (await start(google, { GMAIL_REFRESH_TOKEN_SEALED: sealed })).get("/admin/outreach")).body;
    assert.match(live, /Authorized as alex@reclaimbay\.example, sending as hello@reclaimbay\.example\./);

    // The alias is still awaiting verification: refused, revoked, nothing issued.
    const pending = aliasGoogle("pending");
    const p = await start(pending);
    const second = await begin(p.get);
    const res = await p.app.inject({ method: "GET", url: `/oauth/gmail/callback?state=${second.google.searchParams.get("state")}&code=good-code`, headers: { cookie: second.stateCookie } });
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /isn&#39;t ready to use \(Gmail says pending\)/);
    assert.equal(sealedFrom(res.body), null);
    assert.equal(pending.revoked.length, 1);
    assert.equal(google.sendCalls.length + pending.sendCalls.length, 0, "authorizing never sends");
  });

  test("a cancelled consent changes nothing", async () => {
    const google = new FakeGoogle();
    const { app, get } = await start(google);
    const { google: url, stateCookie } = await begin(get);
    const res = await app.inject({ method: "GET", url: `/oauth/gmail/callback?state=${url.searchParams.get("state")}&error=access_denied`, headers: { cookie: stateCookie } });
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /Authorization cancelled/);
    assert.equal(google.tokenCalls.length, 0);
  });

  test("a revoked authorization fails closed: the admin says reauthorize, and nothing is sent", async () => {
    const google = new FakeGoogle();
    const { app, get } = await start(google);
    const { google: url, stateCookie } = await begin(get);
    const ok = await app.inject({ method: "GET", url: `/oauth/gmail/callback?state=${url.searchParams.get("state")}&code=good-code`, headers: { cookie: stateCookie } });
    const sealed = sealedFrom(ok.body)!;
    const config = loadConfig(env({ GMAIL_REFRESH_TOKEN_SEALED: sealed, OUTREACH_SENDING_ENABLED: "1" }));

    // A queued message, with sending switched on.
    const site = "https://revoked.example.com";
    const p = await createProspect(db, readyForm({ businessName: "Revoked Auto", website: site, phoneSourceUrl: `${site}/c`, email: "owner@revoked.example.com", emailSourceUrl: `${site}/c` }));
    await addEvidence(db, p.id, { signalKey: "independent_shop", sourceUrl: `${site}/about`, excerpt: "Family owned." });
    const { outreach } = await createOutreachDraft(db, p.id, { siteUrl: "https://reclaimbay.com", sender: config.outreachSender });
    await queueOutreach(db, outreach.id, config);
    const sender = senderFromConfig(config, google.fetch);
    await switchOn(db, sender);

    // The mailbox owner revokes access in their Google account.
    google.validRefreshTokens.clear();
    const report = await dispatchQueued(db, { config, sender });
    assert.equal(report.unavailable.length, 1);
    assert.match(report.stoppedBecause!, /revoked or has expired: reauthorize/);
    assert.equal(google.sendCalls.length, 0);
    const stored = await db.outreach.findUniqueOrThrow({ where: { id: outreach.id } });
    assert.deepEqual([stored.status, stored.sendAttempts, stored.sendStartedAt], ["queued", 0, null], "untouched, ready once reauthorized");

    const page = (await (await start(google, { GMAIL_REFRESH_TOKEN_SEALED: sealed })).get("/admin/outreach")).body;
    assert.match(page, /Reauthorization required\./);
  });

  test("without OUTREACH_PROVIDER, or with Gmail half-configured, nothing can send and the admin says why", async () => {
    const google = new FakeGoogle();
    const none = await start(google, { OUTREACH_PROVIDER: "" });
    const page = (await none.get("/admin/outreach")).body;
    assert.match(page, /No email provider is configured/);
    assert.doesNotMatch(page, /Authorize hello/);
    const half = await start(google, { GOOGLE_OAUTH_CLIENT_SECRET: "" });
    assert.match((await half.get("/admin/outreach")).body, /GOOGLE_OAUTH_CLIENT_SECRET is missing/);
    assert.equal((await half.get("/admin/outreach/gmail/authorize")).statusCode, 400);
    assert.equal(google.calls.length, 0);
  });
});
