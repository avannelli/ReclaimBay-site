import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { readinessErrors } from "../../src/outreach/dispatch.js";
import { GmailClient, buildRawMessage, gmailConfigFromEnv, gmailSender, type GmailConfig } from "../../src/outreach/gmail.js";
import { classifyInbound } from "../../src/outreach/gmailInbox.js";
import { disabledSender, senderFromEnv, type OutgoingMessage } from "../../src/outreach/sender.js";
import { FakeGoogle, MAILBOX, fakeGmail, inbound, testServiceAccount } from "../fixtures/fakeGmail.js";

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

describe("Gmail configuration", () => {
  const { json } = testServiceAccount();

  test("needs a service account JSON key and the mailbox; reports exactly what is wrong", () => {
    assert.match((gmailConfigFromEnv({ OUTREACH_SENDER_EMAIL: MAILBOX }) as { problem: string }).problem, /GMAIL_SERVICE_ACCOUNT_JSON is missing/);
    assert.match((gmailConfigFromEnv({ GMAIL_SERVICE_ACCOUNT_JSON: "{not json", OUTREACH_SENDER_EMAIL: MAILBOX }) as { problem: string }).problem, /isn't a service account JSON key/);
    assert.match((gmailConfigFromEnv({ GMAIL_SERVICE_ACCOUNT_JSON: '{"client_email":"x"}', OUTREACH_SENDER_EMAIL: MAILBOX }) as { problem: string }).problem, /no client_email or private_key/);
    assert.match((gmailConfigFromEnv({ GMAIL_SERVICE_ACCOUNT_JSON: '{"client_email":"x","private_key":"nope"}', OUTREACH_SENDER_EMAIL: MAILBOX }) as { problem: string }).problem, /private_key can't be read/);
    assert.match((gmailConfigFromEnv({ GMAIL_SERVICE_ACCOUNT_JSON: json }) as { problem: string }).problem, /OUTREACH_SENDER_EMAIL/);
    const ok = gmailConfigFromEnv({ GMAIL_SERVICE_ACCOUNT_JSON: Buffer.from(json).toString("base64"), OUTREACH_SENDER_EMAIL: MAILBOX.toUpperCase() }) as GmailConfig;
    assert.equal(ok.mailbox, MAILBOX, "a base64 key is accepted; the mailbox is normalised");
  });

  test("sending stays disabled unless OUTREACH_PROVIDER=gmail is set and complete", () => {
    assert.equal(senderFromEnv({}), disabledSender, "disabled by default");
    assert.equal(senderFromEnv({ GMAIL_SERVICE_ACCOUNT_JSON: json, OUTREACH_SENDER_EMAIL: MAILBOX }), disabledSender, "credentials alone enable nothing");
    const broken = senderFromEnv({ OUTREACH_PROVIDER: "gmail", OUTREACH_SENDER_EMAIL: MAILBOX });
    assert.equal(broken.enabled, false);
    assert.match(broken.problem!, /GMAIL_SERVICE_ACCOUNT_JSON/);
    const cfg = { outreachSender: { name: "A", email: MAILBOX, postalAddress: "1 Main St" }, publicApiUrl: "https://api.x", outreachSendingArmed: true };
    assert.match(readinessErrors(cfg, broken).join(" "), /GMAIL_SERVICE_ACCOUNT_JSON is missing/, "the admin sees why");
    assert.match(senderFromEnv({ OUTREACH_PROVIDER: "resend" }).problem!, /Unknown OUTREACH_PROVIDER "resend"/);
    const gmail = senderFromEnv({ OUTREACH_PROVIDER: "gmail", GMAIL_SERVICE_ACCOUNT_JSON: json, OUTREACH_SENDER_EMAIL: MAILBOX });
    assert.deepEqual([gmail.name, gmail.enabled, gmail.supportsIdempotency], ["gmail", true, true]);
    assert.deepEqual(readinessErrors({ ...cfg, outreachSendingArmed: false }, gmail).length, 1, "the deployment arm is still required");
  });
});

describe("the Gmail message", () => {
  test("is the reviewed plain text with the sender, recipient, unsubscribe headers, and outreach marker", () => {
    const raw = decodeRaw(buildRawMessage(message()));
    const [head, body] = raw.split("\r\n\r\n");
    assert.match(head!, /^From: "Alex Rivera" <alex@reclaimbay\.example>$/m);
    assert.match(head!, /^To: service@shop\.example\.com$/m);
    assert.match(head!, /^Reply-To: alex@reclaimbay\.example$/m);
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
    assert.match(head, /^From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <alex@reclaimbay\.example>$/m);
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
  });

  test("Gmail's errors map to the dispatcher's outcomes", async () => {
    const cases: [ConstructorParameters<typeof FakeGoogle> extends never ? never : { status: number; body: unknown } | "network", string, boolean?][] = [
      [{ status: 400, body: { error: { message: "Invalid To header", errors: [{ reason: "invalidArgument" }] } } }, "rejected", true],
      [{ status: 400, body: { error: { message: "Bad raw", errors: [{ reason: "badRequest" }] } } }, "rejected", false],
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
      google.sendAnswers = [answer];
      const r = await gmailSender(client).send(message());
      assert.equal(r.status, expected, JSON.stringify(answer));
      if (r.status === "rejected") assert.equal(Boolean(r.invalidRecipient), invalid, JSON.stringify(answer));
    }
  });

  test("an authentication failure means nothing was sent, and never leaks the key", async () => {
    const { google, client, account } = fakeGmail();
    google.tokenAnswer = { status: 401, body: { error: "unauthorized_client", error_description: "Client is unauthorized to retrieve access tokens" } };
    const r = await gmailSender(client).send(message());
    assert.equal(r.status, "unavailable");
    assert.match((r as { reason: string }).reason, /unauthorized_client.*domain-wide delegation/);
    assert.ok(!(r as { reason: string }).reason.includes("PRIVATE KEY"));
    assert.ok(!(r as { reason: string }).reason.includes(JSON.parse(account.json).private_key.slice(40, 80)));
    assert.equal(google.sendCalls.length, 0);

    const net = fakeGmail();
    net.google.tokenAnswer = "network";
    assert.equal((await gmailSender(net.client).send(message())).status, "unavailable", "no token, so nothing could have been sent");
  });

  test("a different From than the configured mailbox is refused before calling Gmail", async () => {
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
    const { config } = fakeGmail();
    const c = new GmailClient(config); // the global fetch, replaced in this test file
    await assert.rejects(c.listMessages({}), /token request failed/);
    assert.equal(realCalls.length, 1);
    realCalls.length = 0;
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
  });
});
