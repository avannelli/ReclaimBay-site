import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import Dashboard from "../components/Dashboard";
import UploadPanel from "../components/UploadPanel";
import { contactPayload, CONTACT_ENDPOINT, emailProblem, emptyDraft, sendContact } from "../lib/contactForm";
import { demoAnalysis, DEMO_DATE } from "../lib/demoReport";
import { cleanContact, contactEmail, onRequestPost } from "../functions/api/contact.js";

/*
 * The "Talk to ReclaimBay" form: the client builds exactly the form's fields,
 * and the Pages Function (functions/api/contact.js) accepts exactly those,
 * rate-limits, and hands Resend a plain email with Reply-To set to the visitor.
 * Fake Resend, fake KV, no network.
 */

const noop = () => undefined;
const ORIGIN = "https://reclaimbay.com";
const VALID = { name: "Pat Quinn", shopName: "Quinn Auto", email: "pat@quinnauto.example", shopSoftware: "Shop system", message: "How do I find my export?", website: "" };

describe("the contact form's client side", () => {
  test("email is required and must look like an address; everything else may be blank", () => {
    assert.equal(emailProblem(""), "Enter your email address.");
    assert.equal(emailProblem("   "), "Enter your email address.");
    assert.equal(emailProblem("pat"), "Enter a valid email address.");
    assert.equal(emailProblem("pat@shop"), "Enter a valid email address.");
    assert.equal(emailProblem(`${"a".repeat(250)}@x.example`), "Enter a valid email address.");
    assert.equal(emailProblem("  pat@quinnauto.example  "), null);
    assert.deepEqual(contactPayload({ ...emptyDraft(), email: " pat@quinnauto.example " }, ""), { name: "", shopName: "", email: "pat@quinnauto.example", shopSoftware: "", message: "", website: "" });
  });

  test("the request carries exactly the form's fields, trimmed: never report or page state", async () => {
    // Even if something else were attached to the draft object, it is not forwarded.
    const draft = Object.assign(emptyDraft(), { name: " Pat ", email: "pat@quinnauto.example", total: 4327.48, rows: [["Riley Chen"]], fileName: "export.csv" });
    const payload = contactPayload(draft, "");
    assert.deepEqual(Object.keys(payload).sort(), ["email", "message", "name", "shopName", "shopSoftware", "website"]);
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response("{\"ok\":true}", { status: 200 }); }) as unknown as typeof fetch;
    assert.equal(await sendContact(payload, fake), "sent");
    assert.equal(calls[0]!.url, CONTACT_ENDPOINT);
    assert.equal(calls[0]!.init.method, "POST");
    const body = JSON.parse(String(calls[0]!.init.body));
    assert.deepEqual(body, { name: "Pat", shopName: "", email: "pat@quinnauto.example", shopSoftware: "", message: "", website: "" });
    assert.doesNotMatch(String(calls[0]!.init.body), /4327|Riley|export\.csv|rows|total/);
  });

  test("any refusal or network failure is simply 'failed'", async () => {
    assert.equal(await sendContact(contactPayload(emptyDraft(), ""), (async () => new Response("{}", { status: 502 })) as unknown as typeof fetch), "failed");
    assert.equal(await sendContact(contactPayload(emptyDraft(), ""), (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch), "failed");
  });

  test("every contact entry point opens the in-site form, not an email app", () => {
    const home = renderToStaticMarkup(<UploadPanel onFile={noop} onSample={noop} busy={false} error={null} />);
    assert.match(home, /<button type="button" aria-haspopup="dialog"[^>]*>Questions\? Talk to ReclaimBay<\/button>/);
    assert.match(home, /Not sure which report to export\? <button type="button" aria-haspopup="dialog"[^>]*>Talk to ReclaimBay<\/button>/);
    assert.doesNotMatch(home, /mailto:/);
    const { analysis, table } = demoAnalysis();
    const report = renderToStaticMarkup(<Dashboard analysis={analysis} fileName={table.fileName} isSample analyzedAt={DEMO_DATE} onReset={noop} />);
    assert.equal((report.match(/aria-haspopup="dialog"[^>]*>(Questions\? )?Talk to ReclaimBay<\/button>/g) ?? []).length, 2, "the report hero's link and the contact card's button");
    assert.doesNotMatch(report, /mailto:/);
    assert.match(report, /nothing from it is included in the contact form/);
    // The dialog reuses the existing accessible Dialog, and only its own fields reach the request.
    const dialog = readFileSync(new URL("../components/ContactDialog.tsx", import.meta.url), "utf8");
    assert.match(dialog, /import \{ Dialog, dialogPrimary, dialogSecondary \} from "\.\/overlay"/);
    assert.match(dialog, /sendContact\(contactPayload\(draft, honeypot\.current\?\.value \?\? ""\)\)/);
    assert.doesNotMatch(dialog, /analysis|fileName|localStorage|sessionStorage|trackEvent/);
  });
});

describe("POST /api/contact (the Pages Function)", () => {
  const sent: { url: string; init: RequestInit }[] = [];
  let resendStatus = 200;
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    sent.length = 0; resendStatus = 200;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      if (url !== "https://api.resend.com/emails") throw new Error(`unexpected request to ${url}`);
      sent.push({ url, init });
      return new Response(JSON.stringify(resendStatus === 200 ? { id: "email-1" } : { message: "Internal provider detail" }), { status: resendStatus });
    }) as unknown as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  const kv = () => { const m = new Map<string, string>(); return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); }, map: m }; };
  const env = (over: Record<string, unknown> = {}) => ({ RESEND_API_KEY: "test-key", CONTACT_RATE_LIMIT: kv(), ...over });
  const post = (body: unknown, headers: Record<string, string> = {}, e = env()) => onRequestPost({
    request: new Request(`${ORIGIN}/api/contact`, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": "203.0.113.5", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }),
    env: e,
  });
  const answer = async (r: Response) => ({ status: r.status, body: await r.json() });

  test("a valid message goes to the contact inbox, from ReclaimBay, with Reply-To the visitor", async () => {
    assert.deepEqual(await answer(await post(VALID)), { status: 200, body: { ok: true } });
    assert.equal(sent.length, 1);
    assert.equal((sent[0]!.init.headers as Record<string, string>).Authorization, "Bearer test-key");
    const email = JSON.parse(String(sent[0]!.init.body));
    assert.deepEqual(email.to, ["hello@reclaimbay.com"]);
    assert.equal(email.from, "ReclaimBay Website <contact@reclaimbay.com>");
    assert.equal(email.reply_to, "pat@quinnauto.example");
    assert.equal(email.subject, "ReclaimBay contact — Quinn Auto");
    assert.equal(email.text, "New message from the ReclaimBay website.\n\nName: Pat Quinn\nShop name: Quinn Auto\nEmail: pat@quinnauto.example\nShop software: Shop system\n\nMessage:\n\nHow do I find my export?");
  });

  test("only the email is required; blank optional fields are left out of the email", async () => {
    assert.equal((await post({ email: "pat@quinnauto.example" })).status, 200);
    const email = JSON.parse(String(sent[0]!.init.body));
    assert.equal(email.subject, "ReclaimBay contact — pat@quinnauto.example");
    assert.equal(email.text, "New message from the ReclaimBay website.\n\nEmail: pat@quinnauto.example\n\n(No message.)");
    assert.equal(contactEmail(cleanContact({ ...VALID, shopName: "" })!).subject, "ReclaimBay contact — Pat Quinn");
  });

  test("malformed, unknown, or injected fields are refused with a 4xx and nothing is sent", async () => {
    for (const bad of [
      { ...VALID, email: "" }, { ...VALID, email: "not-an-address" }, { ...VALID, email: 42 },
      { ...VALID, name: "Pat\r\nBcc: victim@example.com" }, { ...VALID, email: "pat@x.example\nBcc: v@x.example" },
      { ...VALID, message: "x".repeat(5001) }, { ...VALID, message: "http://a http://b http://c http://d" },
      { ...VALID, total: 4327.48 }, { ...VALID, rows: [["Riley Chen", "2014 Ford F-150"]] }, { ...VALID, fileName: "export.csv" },
      [VALID], "null",
    ]) {
      const r = await post(bad);
      assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 80));
    }
    assert.equal((await post("{not json")).status, 400);
    assert.equal(sent.length, 0);
  });

  test("a filled honeypot looks like success to the bot and sends nothing", async () => {
    assert.deepEqual(await answer(await post({ ...VALID, website: "https://spam.example" })), { status: 200, body: { ok: true } });
    assert.equal(sent.length, 0);
  });

  test("other sites, other content types, oversized bodies, and missing configuration are refused", async () => {
    assert.equal((await post(VALID, { Origin: "https://evil.example" })).status, 403);
    assert.equal((await post(VALID, { "Content-Type": "text/plain" })).status, 415);
    assert.equal((await post({ ...VALID, message: "x".repeat(13000) })).status, 413);
    assert.equal((await post(VALID, {}, env({ RESEND_API_KEY: undefined }))).status, 503);
    assert.equal((await post(VALID, {}, env({ CONTACT_RATE_LIMIT: undefined }))).status, 503);
    assert.equal(sent.length, 0);
  });

  test("five messages per visitor per ten minutes, by hashed IP; the sixth is refused", async () => {
    const shared = env();
    for (let i = 0; i < 5; i++) assert.equal((await post(VALID, {}, shared)).status, 200);
    assert.equal((await post(VALID, {}, shared)).status, 429);
    assert.equal(sent.length, 5);
    const keys = [...(shared.CONTACT_RATE_LIMIT as ReturnType<typeof kv>).map.keys()];
    assert.equal(keys.length, 1);
    assert.match(keys[0]!, /^contact:[0-9a-f]{64}$/);
    assert.doesNotMatch(keys[0]!, /203\.0\.113\.5/);
    assert.equal((await post(VALID, { "CF-Connecting-IP": "198.51.100.7" }, shared)).status, 200, "another visitor is unaffected");
  });

  test("a Resend failure is a calm 502 that reveals nothing about the provider", async () => {
    resendStatus = 500;
    const r = await answer(await post(VALID));
    assert.equal(r.status, 502);
    assert.doesNotMatch(JSON.stringify(r.body), /provider|Internal|resend|key/i);
  });
});
