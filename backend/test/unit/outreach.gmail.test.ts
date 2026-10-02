import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { readinessErrors } from "../../src/outreach/dispatch.js";
import { GmailClient, buildRawMessage, gmailSender } from "../../src/outreach/gmail.js";
import { classifyInbound } from "../../src/outreach/gmailInbox.js";
import { disabledSender, senderFromConfig, type OutgoingMessage } from "../../src/outreach/sender.js";
import { ACCOUNT, FakeGoogle, MAILBOX, aliasGoogle, authorizedConfig, fakeGmail, gmailTestConfig, inbound } from "../fixtures/fakeGmail.js";

/*
 * The Gmail adapter against a fake Google. Any real network call fails the
 * test: the global fetch is replaced for the duration of each test.
 */

let realCalls: string[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
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

const OUTREACH_ID = "0b7e9a52-4d1f-4c4e-9a7d-2f5b8c1d3e4f";
const message = (over: Partial<OutgoingMessage> = {}): OutgoingMessage => ({
  outreachId: OUTREACH_ID,
  idempotencyKey: `outreach-${OUTREACH_ID}`,
  attempt: 1,
  firstAttemptAt: new Date("2026-10-05T10:00:00Z"),
  to: "service@shop.example.com",
  from: { name: "Alex Rivera", email: MAILBOX },
  replyTo: MAILBOX,
  subject: "Declined work at Shop Auto",
  text: "Hi Shop Auto team,\n\nLine two.\n\nThe ReclaimBay team",
  headers: { "List-Unsubscribe": "<https://api.reclaimbay.example/u/tok>, <mailto:alex@reclaimbay.example?subject=unsubscribe>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  ...over,
});
const decodeRaw = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");

describe("Gmail provider selection", () => {
  const ready = { outreachSender: { name: "A", email: MAILBOX, postalAddress: "1 Main St" }, publicApiUrl: "https://api.x", outreachSendingArmed: true };

  test("sending stays disabled unless OUTREACH_PROVIDER=gmail is set, configured, and authorized", () => {
    assert.equal(senderFromConfig({ ...gmailTestConfig(), outreachProvider: null }), disabledSender, "disabled by default, even with OAuth configured");
    const unauthorized = senderFromConfig(gmailTestConfig());
    assert.equal(unauthorized.enabled, false);
    assert.match(unauthorized.problem!, /isn't authorized yet: authorize sending as hello@reclaimbay\.example in the admin/);
    assert.match(readinessErrors(ready, unauthorized).join(" "), /isn't authorized yet/, "the admin sees why");
    assert.match(senderFromConfig({ ...gmailTestConfig(), outreachProvider: "resend" }).problem!, /Unknown OUTREACH_PROVIDER "resend"/);
    const google = new FakeGoogle();
    const gmail = senderFromConfig(authorizedConfig(google), google.fetch);
    assert.deepEqual([gmail.name, gmail.enabled, gmail.supportsIdempotency], ["gmail", true, true]);
    assert.equal(readinessErrors({ ...ready, outreachSendingArmed: false }, gmail).length, 1, "the deployment arm is still required");
    assert.equal(google.calls.length, 0, "building the sender makes no call");
  });
});

describe("the Gmail message", () => {
  test("is the reviewed plain text with the sender, recipient, unsubscribe headers, and outreach marker", () => {
    const raw = decodeRaw(buildRawMessage(message()));
    const [head, body] = raw.split("\r\n\r\n");
    assert.match(head!, /^From: "Alex Rivera" <hello@reclaimbay\.example>$/m);
    assert.match(head!, /^To: service@shop\.example\.com$/m);
    assert.match(head!, /^Reply-To: hello@reclaimbay\.example$/m);
    assert.match(head!, /^Subject: Declined work at Shop Auto$/m);
    assert.match(head!, /^Content-Type: text\/plain; charset="UTF-8"$/m);
    assert.match(head!, new RegExp(`^X-ReclaimBay-Outreach: ${OUTREACH_ID}$`, "m"));
    assert.match(head!, /^List-Unsubscribe: <https:\/\/api\.reclaimbay\.example\/u\/tok>, <mailto:alex@reclaimbay\.example\?subject=unsubscribe>$/m);
    assert.match(head!, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);
    assert.equal(Buffer.from(body!.replace(/\r\n/g, ""), "base64").toString("utf8"), "Hi Shop Auto team,\r\n\r\nLine two.\r\n\r\nThe ReclaimBay team");
  });

  test("header values can't inject headers; non-ASCII is encoded", () => {
    const raw = decodeRaw(buildRawMessage(message({ subject: "Hi\r\nBcc: victim@example.com", from: { name: "Zoë", email: MAILBOX } })));
    const head = raw.split("\r\n\r\n")[0]!;
    assert.doesNotMatch(head, /^Bcc:/m);
    assert.match(head, /^Subject: Hi Bcc: victim@example\.com$/m);
    assert.match(head, /^From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <hello@reclaimbay\.example>$/m);
  });
});

describe("sending through Gmail", () => {
  test("a successful send authenticates as the mailbox and returns Gmail's message id", async () => {
    const { google, client } = fakeGmail();
    const sender = gmailSender(client);
    const r1 = await sender.send(message());
    const r2 = await sender.send(message({ outreachId: "1b7e9a52-4d1f-4c4e-9a7d-2f5b8c1d3e4f" }));
    assert.deepEqual(r1, { status: "accepted", providerMessageId: "gm-2" });
    assert.equal(r2.status, "accepted");
    assert.equal(google.tokenCalls.length, 1, "the access token is reused");
    assert.equal(google.sendCalls.length, 2);
    assert.match(google.calls.find((c) => c.url.endsWith("/messages/send"))!.url, /\/users\/me\/messages\/send$/);
    assert.equal(google.sent[0]!.marker, OUTREACH_ID);
    assert.equal(google.sendAsCalls.length, 0, "sending as the account itself needs no Send As lookup");
  });

  test("Gmail's errors map to the dispatcher's outcomes", async () => {
    const cases: [ConstructorParameters<typeof FakeGoogle> extends never ? never : { status: number; body: unknown } | "network", string, boolean?][] = [
      [{ status: 400, body: { error: { message: "Invalid To header", errors: [{ reason: "invalidArgument" }] } } }, "rejected", true],
      [{ status: 400, body: { error: { message: "Bad raw", errors: [{ reason: "badRequest" }] } } }, "rejected", false],
      // Two 401s in a row: still refused after a fresh token.
      [{ status: 401, body: { error: { message: "Invalid Credentials", errors: [{ reason: "authError" }] } } }, "unavailable"],
      [{ status: 403, body: { error: { message: "Rate limit", errors: [{ reason: "userRateLimitExceeded" }] } } }, "unavailable"],
      [{ status: 403, body: { error: { message: "Disabled", errors: [{ reason: "domainPolicy" }] } } }, "unavailable"],
      [{ status: 429, body: { error: { message: "User-rate limit exceeded" } } }, "unavailable"],
      [{ status: 503, body: { error: { message: "Backend Error", errors: [{ reason: "backendError" }] } } }, "uncertain"],
      ["network", "uncertain"],
      [{ status: 200, body: {} }, "uncertain"],
    ];
    for (const [answer, expected, invalid] of cases) {
      const { google, client } = fakeGmail();
      google.sendAnswers = answer !== "network" && answer.status === 401 ? [answer, answer] : [answer];
      const r = await gmailSender(client).send(message());
      assert.equal(r.status, expected, JSON.stringify(answer));
      if (r.status === "rejected") assert.equal(Boolean(r.invalidRecipient), invalid, JSON.stringify(answer));
    }
  });

  test("an expired access token is refreshed from the stored authorization, without a second send", async () => {
    const { google, client } = fakeGmail();
    const sender = gmailSender(client);
    assert.equal((await sender.send(message())).status, "accepted");
    assert.equal(google.refreshCalls.length, 1);
    google.expireAccessTokens();
    assert.equal((await sender.send(message({ outreachId: "1b7e9a52-4d1f-4c4e-9a7d-2f5b8c1d3e4f" }))).status, "accepted");
    assert.equal(google.refreshCalls.length, 2, "refreshed once, after Google refused the stale token");
    assert.equal(google.sent.length, 2, "the refused attempt wasn't processed by Google, so one email each");

    // A short-lived token is refreshed before use, too.
    const short = fakeGmail();
    short.google.accessTokenLifetime = 1;
    const s2 = gmailSender(short.client);
    await s2.send(message());
    await s2.send(message({ outreachId: "2b7e9a52-4d1f-4c4e-9a7d-2f5b8c1d3e4f" }));
    assert.ok(short.google.refreshCalls.length >= 2);
  });

  test("an authorization failure means nothing was sent, and never leaks a credential", async () => {
    const { google, client, config } = fakeGmail();
    google.validRefreshTokens.clear(); // revoked in the Google account
    const r = await gmailSender(client).send(message());
    assert.equal(r.status, "unavailable");
    assert.match((r as { reason: string }).reason, /revoked or has expired: reauthorize.*invalid_grant/);
    assert.ok(!(r as { reason: string }).reason.includes(config.gmailOAuth.sealedRefreshToken!));
    assert.ok(!(r as { reason: string }).reason.includes("test-client-secret"));
    assert.equal(google.sendCalls.length, 0);

    const net = fakeGmail();
    net.google.tokenAnswer = "network";
    assert.equal((await gmailSender(net.client).send(message())).status, "unavailable", "no token, so nothing could have been sent");
  });

  test("credentials for another Google account fail closed before anything is sent", async () => {
    const { google, client } = fakeGmail();
    google.account = "someone@gmail.com";
    const r = await gmailSender(client).send(message());
    assert.equal(r.status, "unavailable");
    assert.match((r as { reason: string }).reason, /authorized as someone@gmail\.com, not hello@reclaimbay\.example, the account that was authorized/);
    assert.equal(google.sendCalls.length, 0);
    assert.match((await gmailSender(client).check!())!, /the account that was authorized/);
  });

  test("a different From than the configured sender is refused before calling Gmail", async () => {
    const { google, client } = fakeGmail();
    const r = await gmailSender(client).send(message({ from: { name: "X", email: "other@reclaimbay.example" } }));
    assert.equal(r.status, "unavailable");
    assert.equal(google.calls.length, 0);
  });

  test("a retry first checks Sent for this message, and never sends it twice", async () => {
    const { google, client } = fakeGmail();
    const sender = gmailSender(client);
    google.sendAnswers = ["network"]; // went through, response lost
    assert.equal((await sender.send(message())).status, "uncertain");
    assert.equal(google.sent.length, 1);

    const retry = await sender.send(message({ attempt: 2 }));
    assert.deepEqual(retry, { status: "accepted", providerMessageId: google.sent[0]!.id });
    assert.equal(google.sent.length, 1, "found in Sent: not sent again");

    // Not in Sent: a retry does send.
    const other = message({ outreachId: "2b7e9a52-4d1f-4c4e-9a7d-2f5b8c1d3e4f", attempt: 2 });
    assert.equal((await sender.send(other)).status, "accepted");
    assert.equal(google.sent.length, 2);

    // Sent can't be checked: don't send.
    google.listAnswer = { status: 503, body: { error: { message: "Backend Error" } } };
    const blind = await sender.send(message({ outreachId: "3b7e9a52-4d1f-4c4e-9a7d-2f5b8c1d3e4f", attempt: 2 }));
    assert.equal(blind.status, "uncertain");
    assert.equal(google.sent.length, 2);
  });

  test("a first attempt doesn't search Sent", async () => {
    const { google, client } = fakeGmail();
    await gmailSender(client).send(message());
    assert.equal(google.calls.filter((c) => c.url.includes("/messages?")).length, 0);
  });

  test("the client only ever uses the fetch it was given", async () => {
    const { credentials } = fakeGmail();
    const c = new GmailClient(credentials); // the global fetch, replaced in this test file
    await assert.rejects(c.listMessages({}), /Gmail profile request failed/);
    assert.equal(realCalls.length, 1);
    realCalls.length = 0;
  });
});

describe("sending as a Send As address of the authorized account", () => {
  const headOf = (raw: string) => decodeRaw(raw).split("\r\n\r\n")[0]!;

  test("a verified alias: authorized as the account, sent with the sender in From, every safety header kept", async () => {
    const { google, client } = fakeGmail(aliasGoogle("accepted"));
    assert.deepEqual([client.account, client.sender], [ACCOUNT, MAILBOX]);
    const sender = gmailSender(client);
    assert.equal((await sender.send(message())).status, "accepted");
    assert.equal((await sender.send(message({ outreachId: "1b7e9a52-4d1f-4c4e-9a7d-2f5b8c1d3e4f" }))).status, "accepted");
    assert.equal(google.sendAsCalls.length, 1, "the alias is verified before the first send, then trusted for this client");
    assert.ok(google.calls.findIndex((c) => c.url.includes("/settings/sendAs/")) < google.calls.findIndex((c) => c.url.endsWith("/messages/send")), "verified before sending");

    const head = headOf(google.sent[0]!.raw);
    assert.match(head, /^From: "Alex Rivera" <hello@reclaimbay\.example>$/m, "From is the sender, never the account");
    assert.doesNotMatch(head, /^From:.*alex@reclaimbay\.example/m);
    assert.match(head, /^Reply-To: hello@reclaimbay\.example$/m);
    assert.match(head, /^To: service@shop\.example\.com$/m);
    assert.match(head, new RegExp(`^X-ReclaimBay-Outreach: ${OUTREACH_ID}$`, "m"));
    assert.match(head, /^List-Unsubscribe: <https:\/\/api\.reclaimbay\.example\/u\/tok>, /m);
    assert.match(head, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);
  });

  test("a Workspace alias, for which Gmail reports no verification status, can send", async () => {
    const { google, client } = fakeGmail(aliasGoogle(undefined));
    assert.equal((await gmailSender(client).send(message())).status, "accepted");
    assert.equal(google.sendCalls.length, 1);
  });

  test("a sender that isn't a ready alias of the account: refused before Gmail's send is called", async () => {
    const cases: [FakeGoogle, RegExp][] = [
      [aliasGoogle(null), /hello@reclaimbay\.example isn't a Send As address of alex@reclaimbay\.example in Gmail/],
      [aliasGoogle("pending"), /isn't ready to use \(Gmail says pending\)/],
      [aliasGoogle("someFutureStatus"), /isn't ready to use/],
    ];
    const unrelated = aliasGoogle(null);
    unrelated.sendAs = [{ sendAsEmail: "sales@reclaimbay.example", verificationStatus: "accepted" }];
    cases.push([unrelated, /isn't a Send As address of alex@reclaimbay\.example/]);
    for (const [google, why] of cases) {
      const { client } = fakeGmail(google);
      const sender = gmailSender(client);
      const r = await sender.send(message());
      assert.equal(r.status, "unavailable", String(why));
      assert.match((r as { reason: string }).reason, why);
      assert.equal(google.sendCalls.length, 0, `${why}: nothing sent`);
      assert.equal(google.sent.length, 0);
      assert.match((await sender.check!())!, why, "the admin sees why");
    }
  });

  test("an alias removed after authorization stops sending at the next run, never falling back to the account", async () => {
    const google = aliasGoogle("accepted");
    const { config } = fakeGmail(google);
    google.sendAs = [];
    const sender = senderFromConfig(config, google.fetch);
    const r = await sender.send(message());
    assert.equal(r.status, "unavailable");
    assert.equal(google.sendCalls.length, 0);
  });

  test("only the configured sender: the account's own address, or another of its aliases, is refused before calling Gmail", async () => {
    const google = aliasGoogle("accepted");
    google.sendAs.push({ sendAsEmail: "sales@reclaimbay.example", verificationStatus: "accepted" });
    const { client } = fakeGmail(google);
    for (const email of [ACCOUNT, "sales@reclaimbay.example", "anyone@else.example"]) {
      const r = await gmailSender(client).send(message({ from: { name: "X", email } }));
      assert.equal(r.status, "unavailable", email);
      assert.match((r as { reason: string }).reason, /isn't the configured Gmail sender/);
    }
    assert.equal(google.calls.length, 0, "Google isn't contacted at all");
  });

  test("a retry checks Sent in the account's mailbox, and never sends twice", async () => {
    const { google, client } = fakeGmail(aliasGoogle("accepted"));
    const sender = gmailSender(client);
    google.sendAnswers = ["network"];
    assert.equal((await sender.send(message())).status, "uncertain");
    assert.deepEqual(await sender.send(message({ attempt: 2 })), { status: "accepted", providerMessageId: google.sent[0]!.id });
    assert.equal(google.sent.length, 1);
  });
});

describe("classifying inbound mail", () => {
  const dsn = (status: string, subject = "Delivery Status Notification (Failure)") =>
    inbound("in-1", "th-1", { From: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", Subject: subject, "Content-Type": 'multipart/report; report-type=delivery-status; boundary="x"' }, [
      { mimeType: "text/plain", text: "Address not found" },
      { mimeType: "message/delivery-status", text: `Final-Recipient: rfc822; nobody@shop.example.com\nAction: ${status.startsWith("5") ? "failed" : "delayed"}\nStatus: ${status}\nDiagnostic-Code: smtp; 550 5.1.1 The email account that you tried to reach does not exist.` },
      { mimeType: "text/rfc822-headers", text: `From: Alex <${MAILBOX}>\nX-ReclaimBay-Outreach: ${OUTREACH_ID}` },
    ]);

  test("bounces: permanent, delayed, and unclear", () => {
    const hard = classifyInbound(dsn("5.1.1"), MAILBOX);
    assert.equal(hard.kind, "bounce");
    assert.match(hard.reason!, /550 5\.1\.1/);
    assert.equal(hard.markerOutreachId, OUTREACH_ID);
    assert.equal(classifyInbound(dsn("4.4.7", "Delivery Status Notification (Delay)"), MAILBOX).kind, "delay");
    const unclear = inbound("in-2", "th-2", { From: "postmaster@shop.example.com", Subject: "Returned mail" }, [{ mimeType: "text/plain", text: "Something happened." }]);
    assert.equal(classifyInbound(unclear, MAILBOX).kind, "bounce_unknown");
  });

  test("auto-replies are not replies; an 'unsubscribe' email is an opt-out; the rest are replies", () => {
    const h = (headers: Record<string, string>) => classifyInbound(inbound("x", "t", { From: "Owner <owner@shop.example.com>", Subject: "Re: Declined work", ...headers }), MAILBOX);
    assert.equal(h({ "Auto-Submitted": "auto-replied" }).kind, "auto_reply");
    assert.equal(h({ "X-Autoreply": "yes" }).kind, "auto_reply");
    assert.equal(h({ Precedence: "auto_reply" }).kind, "auto_reply");
    assert.equal(h({ Subject: "Out of Office: back Monday" }).kind, "auto_reply");
    assert.equal(h({ Subject: "Automatic reply: Declined work" }).kind, "auto_reply");
    assert.equal(h({ "Auto-Submitted": "no" }).kind, "reply");
    assert.equal(h({ Subject: "unsubscribe" }).kind, "unsubscribe");
    assert.equal(h({ Subject: "Re: unsubscribe" }).kind, "unsubscribe");
    assert.equal(h({}).kind, "reply");
    assert.equal(h({}).from, "owner@shop.example.com");
    assert.equal(classifyInbound(inbound("y", "t", { From: `Alex <${MAILBOX}>`, Subject: "x" }), MAILBOX).kind, "own");
    // Sending as an alias: mail from the account itself is ours too, never a prospect's reply.
    assert.equal(classifyInbound(inbound("z", "t", { From: `Alex <${ACCOUNT}>`, Subject: "Re: Declined work" }), [MAILBOX, ACCOUNT]).kind, "own");
    assert.equal(classifyInbound(inbound("z", "t", { From: `Alex <${ACCOUNT}>`, Subject: "Re: Declined work" }), MAILBOX).kind, "reply");
  });
});
