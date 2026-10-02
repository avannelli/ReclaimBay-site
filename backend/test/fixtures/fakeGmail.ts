/*
 * A fake Google for Gmail adapter tests: the OAuth token endpoint (which
 * verifies the service account's JWT against a key pair generated for the
 * test) and the Gmail endpoints the adapter uses. Nothing here reaches the
 * network, and no real credential exists anywhere in the repository.
 */
import { createVerify, generateKeyPairSync } from "node:crypto";
import { GmailClient, gmailConfigFromEnv, type GmailConfig, type GmailMessage, type GmailPart } from "../../src/outreach/gmail.js";

export const MAILBOX = "alex@reclaimbay.example";

/** A throwaway service account, made fresh for the test run. */
export function testServiceAccount() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const json = JSON.stringify({
    type: "service_account",
    client_email: "outreach@test-project.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  });
  return { json, publicKey };
}

export interface FakeCall {
  url: string;
  method: string;
  body: string;
}

type Answer = { status: number; body: unknown } | "network";

/** An inbound message, built from headers and text parts. */
export function inbound(id: string, threadId: string, headers: Record<string, string>, parts: { mimeType: string; text: string }[] = [], snippet = ""): GmailMessage {
  const toPart = (p: { mimeType: string; text: string }): GmailPart => ({ mimeType: p.mimeType, body: { data: Buffer.from(p.text).toString("base64url") } });
  return {
    id,
    threadId,
    internalDate: String(Date.parse("2026-10-05T12:00:00Z")),
    snippet,
    payload: {
      mimeType: parts.length > 1 ? "multipart/report" : (parts[0]?.mimeType ?? "text/plain"),
      headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
      parts: parts.map(toPart),
    },
  };
}

export class FakeGoogle {
  readonly calls: FakeCall[] = [];
  readonly sent: { id: string; threadId: string; raw: string; marker: string | null }[] = [];
  readonly inbox: GmailMessage[] = [];
  /** Answers for the next send calls, in order; default: success. */
  sendAnswers: Answer[] = [];
  tokenAnswer: Answer | null = null;
  listAnswer: Answer | null = null;
  private seq = 0;

  constructor(private readonly publicKey: ReturnType<typeof testServiceAccount>["publicKey"]) {}

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : "";
    this.calls.push({ url, method, body });
    const reply = (a: Answer) => {
      if (a === "network") throw new TypeError("fetch failed");
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
    };

    if (url === "https://oauth2.googleapis.com/token") {
      if (this.tokenAnswer) return reply(this.tokenAnswer);
      const assertion = new URLSearchParams(body).get("assertion") ?? "";
      const [h, c, sig] = assertion.split(".");
      const valid = createVerify("RSA-SHA256").update(`${h}.${c}`).verify(this.publicKey, Buffer.from(sig ?? "", "base64url"));
      const claims = JSON.parse(Buffer.from(c ?? "", "base64url").toString());
      if (!valid || claims.sub !== MAILBOX || claims.aud !== "https://oauth2.googleapis.com/token") return reply({ status: 400, body: { error: "invalid_grant" } });
      return reply({ status: 200, body: { access_token: `token-${++this.seq}`, expires_in: 3600 } });
    }

    const api = "https://gmail.googleapis.com/gmail/v1/users/me";
    if (!url.startsWith(api)) throw new Error(`unexpected request to ${url}`);
    const path = url.slice(api.length);
    if (path === "/messages/send" && method === "POST") {
      const answer = this.sendAnswers.shift();
      const raw = JSON.parse(body).raw as string;
      const decoded = Buffer.from(raw, "base64url").toString();
      const marker = /^X-ReclaimBay-Outreach: (.+)$/m.exec(decoded)?.[1]?.trim() ?? null;
      if (answer && answer !== "network" && answer.status >= 400) return reply(answer);
      // A "network" answer models a send that went through but whose response was lost.
      const id = `gm-${++this.seq}`;
      this.sent.push({ id, threadId: `th-${id}`, raw, marker });
      if (answer === "network") throw new TypeError("socket hang up");
      if (answer) return reply(answer);
      return reply({ status: 200, body: { id, threadId: `th-${id}` } });
    }
    if (path.startsWith("/messages?")) {
      if (this.listAnswer) return reply(this.listAnswer);
      const params = new URLSearchParams(path.slice("/messages?".length));
      const messages =
        params.get("labelIds") === "SENT"
          ? this.sent.map((s) => ({ id: s.id, threadId: s.threadId }))
          : this.inbox.map((m) => ({ id: m.id, threadId: m.threadId }));
      return reply({ status: 200, body: { messages } });
    }
    const msg = /^\/messages\/([^?]+)\?/.exec(path)?.[1];
    if (msg) {
      const sent = this.sent.find((s) => s.id === msg);
      if (sent) return reply({ status: 200, body: { id: sent.id, threadId: sent.threadId, payload: { headers: sent.marker ? [{ name: "X-ReclaimBay-Outreach", value: sent.marker }] : [] } } });
      const m = this.inbox.find((x) => x.id === msg);
      return m ? reply({ status: 200, body: m }) : reply({ status: 404, body: { error: { message: "Not Found" } } });
    }
    const thread = /^\/threads\/([^?]+)\?/.exec(path)?.[1];
    if (thread) {
      const ids = [...this.sent.filter((s) => s.threadId === thread).map((s) => s.id), ...this.inbox.filter((m) => m.threadId === thread).map((m) => m.id)];
      return reply({ status: 200, body: { id: thread, messages: ids.map((id) => ({ id })) } });
    }
    throw new Error(`unexpected Gmail call ${method} ${path}`);
  }) as typeof fetch;

  get sendCalls() {
    return this.calls.filter((c) => c.url.endsWith("/messages/send"));
  }
  get tokenCalls() {
    return this.calls.filter((c) => c.url === "https://oauth2.googleapis.com/token");
  }
}

/** A Gmail client and its fake Google, configured like production. */
export function fakeGmail() {
  const account = testServiceAccount();
  const google = new FakeGoogle(account.publicKey);
  const config = gmailConfigFromEnv({ GMAIL_SERVICE_ACCOUNT_JSON: account.json, OUTREACH_SENDER_EMAIL: MAILBOX }) as GmailConfig;
  return { google, account, config, client: new GmailClient(config, google.fetch) };
}
