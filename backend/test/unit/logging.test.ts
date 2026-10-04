import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { format } from "node:util";
import { describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { Db } from "../../src/db.js";
import { createContentLogger, LOG_REDACTED, safeConsole, sanitizeCliError, sanitizeLogLine, sanitizeLogText } from "../../src/logging.js";

const INVITE = "invitation-private_" + "A".repeat(24);
const UNSUBSCRIBE = "unsubscribe-private_" + "B".repeat(12);
const ID = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
const INVITE_URL = `https://reclaimbay.example/invite#${INVITE}`;
const UNSUBSCRIBE_URL = `https://api.reclaimbay.example/u/${UNSUBSCRIBE}`;
const REFERRAL = "https://reclaimbay.com/?ref=public_referral&campaign=test";
const LONG_ID = "provider-message-identifier_" + "C".repeat(64);
const encoded = (s: string) => [...s].map((c) => `%${c.charCodeAt(0).toString(16)}`).join("");
const unicode = (s: string) => [...s].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
const representations = (token: string) => [
  token, encoded(token), encodeURIComponent(encoded(token)), unicode(token),
  encodeURIComponent(unicode(token)), encodeURIComponent(encodeURIComponent(unicode(token))),
  // Mix encodings within one token, and encode JSON's doubled backslashes.
  [...token].map((char, i) => [char, encoded(char), unicode(char), encodeURIComponent(unicode(char))][i % 4]).join(""),
  encodeURIComponent(JSON.stringify(unicode(token)).slice(1, -1)),
];

// Independent canonical comparison catches secrets left in nested encodings,
// not merely their original literal spelling in serialized output.
function visibleText(out: string): string {
  for (let i = 0; i < 16; i++) {
    const next = out.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\+u([0-9a-f]{4})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\+([/"'])/g, "$1");
    if (next === out) break;
    out = next;
  }
  return out;
}

function assertPrivate(out: string, tokens = [INVITE, UNSUBSCRIBE]) {
  const visible = visibleText(out);
  for (const token of tokens) assert.ok(!visible.includes(token), "no raw or recoverable encoded token reaches the log destination");
}

async function loggedApp(db: Db, run: (app: FastifyInstance, lines: string[]) => Promise<void>) {
  const lines: string[] = [];
  const app = await buildApp(loadConfig({ DATABASE_URL: "postgresql://unused/unused", TRUST_PROXY_HOPS: "0" }), db, true, {
    logStream: { write: (line) => { lines.push(line); } },
  });
  try { await run(app, lines); } finally { await app.close(); }
}

describe("application token log boundary", () => {
  test("exact context covers every accepted length, UUID collisions and adjacent identifiers", () => {
    for (let length = 16; length <= 64; length++) {
      const token = "T".repeat(length);
      assert.equal(sanitizeLogText(`prefix${token}suffix`, [token]), `prefix${LOG_REDACTED}suffix`);
    }
    const token = ID.slice(0, 32);
    assert.equal(sanitizeLogText(ID, [token]), `${LOG_REDACTED}${ID.slice(32)}`);
    assert.equal(sanitizeLogText(ID, [ID]), LOG_REDACTED, "no UUID exemption");
    assert.equal(sanitizeLogText(`Error: ${INVITE} ${UNSUBSCRIBE}`, [INVITE, UNSUBSCRIBE]), `Error: ${LOG_REDACTED} ${LOG_REDACTED}`);
  });

  test("percent, double and Unicode encodings are actually removed, including nested JSON strings", () => {
    for (const token of [INVITE, UNSUBSCRIBE, "T".repeat(16), "L".repeat(64)]) {
      const variants = [...representations(token), JSON.stringify({ token: unicode(token) })];
      for (const input of variants) {
        const out = sanitizeLogText(input, [token]);
        assertPrivate(out, [token]);
        assert.ok(out.includes(LOG_REDACTED));
      }
    }
    let deep = INVITE_URL;
    for (let i = 0; i < 12; i++) deep = encodeURIComponent(deep);
    assert.equal(sanitizeLogText(deep), LOG_REDACTED);
    assert.equal(sanitizeLogText("safe%0aline%09text"), "safe%0aline%09text");
  });

  test("malformed encodings cannot crash logging; excessive encoding fails closed and safe spelling survives", () => {
    assert.equal(unicode("S"), String.raw`\u0053`, "runtime fixture contains a literal backslash, not an interpreted source escape");
    assert.ok(JSON.stringify({ msg: unicode("S") }).includes(String.raw`\\u0053`), "serialization doubles that actual backslash");
    const malformed = ["%", "%5", "%GG", "%C0%AF", "%E2%28%A1", "%FF", String.raw`\u005`, String.raw`\u0G53`, "%5Cu005", "%5Cu0G53"];
    const safe = [REFERRAL, ID, LONG_ID, "public_referral", String.raw`C:\users\u0053\diagnostic`, "https://shop.example/?ref=%5Cu0053&campaign=test"];
    for (const value of safe) assert.equal(sanitizeLogText(value), value);
    for (const value of malformed) {
      assert.equal(sanitizeLogText(value), value);
      const line = sanitizeLogLine(JSON.stringify({ msg: value, level: 30 }));
      assert.equal(JSON.parse(line).msg, value);
    }
    for (const bad of malformed) {
      const line = sanitizeLogLine(JSON.stringify({ msg: `${bad} ${encodeURIComponent(unicode(UNSUBSCRIBE))}` }), [UNSUBSCRIBE]);
      assertPrivate(line, [UNSUBSCRIBE]);
      assert.ok(JSON.parse(line).msg.includes(LOG_REDACTED));
    }
    let deeplyEncoded = unicode(UNSUBSCRIBE);
    for (let depth = 1; depth <= 12; depth++) {
      deeplyEncoded = encodeURIComponent(deeplyEncoded);
      const line = sanitizeLogLine(JSON.stringify({ msg: deeplyEncoded }), [UNSUBSCRIBE]);
      assertPrivate(line, [UNSUBSCRIBE]);
      assert.equal(JSON.parse(line).msg, LOG_REDACTED);
    }
  });

  test("sensitive paths/fields are recognized while content policy preserves safe URLs and identifiers", () => {
    for (const input of [INVITE_URL, UNSUBSCRIBE_URL, `/invite?token=${INVITE}`, `/u/${UNSUBSCRIBE}/missing`, `/invite/${INVITE}`, encoded(INVITE_URL), unicode(UNSUBSCRIBE_URL)]) {
      assertPrivate(sanitizeLogText(input));
    }
    for (const safe of [REFERRAL, "https://shop.example/contact?department=service#hours", "https://shop.example/a%2Fb?ref=public", ID, LONG_ID, "ERR_SOME_LONG_OPERATIONAL_ERROR_IDENTIFIER", "/u/:token", "/invite#(the invitation, made when the draft is stored)"]) {
      assert.equal(sanitizeLogText(safe), safe);
    }
    assert.equal(sanitizeLogText(`/health?other=${INVITE}`, [], "http"), `/health${LOG_REDACTED}`);
    assertPrivate(sanitizeLogText(`Key (unsubscribeToken)=(${UNSUBSCRIBE}) already exists.`));
  });

  test("final JSON covers nested objects, arrays, fields/keys and bare copies elsewhere in the entry", () => {
    const short = "S".repeat(16);
    const out = sanitizeLogLine(JSON.stringify({
      query: { token: short }, data: [{ unsubscribeToken: UNSUBSCRIBE, invitationToken: INVITE }],
      msg: `${short} ${encoded(INVITE)} ${ID}`, prospectId: ID, providerMessageId: LONG_ID,
      extra: [{ [INVITE]: unicode(UNSUBSCRIBE) }], level: 50, responseTime: 1.5,
    }));
    assertPrivate(out, [short, INVITE, UNSUBSCRIBE]);
    const entry = JSON.parse(out);
    assert.equal(entry.prospectId, ID);
    assert.equal(entry.providerMessageId, LONG_ID);
    assert.equal(entry.responseTime, 1.5);
    assert.equal(entry.level, 50);
    assert.equal(JSON.parse(sanitizeLogLine(`broken ${INVITE_URL}`)).msg, "log entry omitted: sanitization failed");
  });

  test("real Pino destination covers Error.message/stack/cause, interpolation and child bindings", async () => {
    await loggedApp({} as Db, async (app, lines) => {
      const cause = Object.assign(new Error(`fetch ${INVITE_URL}`), { unsubscribeToken: UNSUBSCRIBE });
      const err = Object.assign(new Error(`request ${UNSUBSCRIBE_URL}`, { cause }), { code: "P2024", context: { originalUrl: INVITE_URL } });
      app.log.error({ err, prospectId: ID }, err.message);
      app.log.child({ unsubscribeToken: UNSUBSCRIBE }).info("provider echoed %s", unicode(UNSUBSCRIBE));
      assertPrivate(lines.join(""));
      const entry = lines.map((line) => JSON.parse(line)).find((line) => line.prospectId === ID);
      assert.equal(entry.err.code, "P2024");
      assert.ok(entry.err.stack.includes("Error"));
      assert.equal(entry.level, 50);
    });
  });

  test("invitation requests retain correlated method/route/status/duration without body or query tokens", async () => {
    const db = { invitation: { findUnique: async () => null } } as unknown as Db;
    await loggedApp(db, async (app, lines) => {
      const response = await app.inject({ method: "POST", url: `/api/invitations/open?token=${encoded(INVITE)}`, payload: { token: INVITE } });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { active: false });
      assertPrivate(lines.join(""));
      const entries = lines.map((line) => JSON.parse(line));
      const incoming = entries.find((line) => line.msg === "incoming request");
      const completed = entries.find((line) => line.reqId === incoming.reqId && line.msg === "request completed");
      assert.deepEqual([incoming.req.method, incoming.req.url], ["POST", "/api/invitations/open"]);
      assert.equal(completed.res.statusCode, 200);
      assert.equal(typeof completed.responseTime, "number");
    });
  });

  test("actual unsubscribe errors hide bare/encoded tokens, UUID suffixes and child/root logger copies", async () => {
    let token = "";
    const db = { outreach: { findUnique: async () => {
      throw Object.assign(new Error(`lookup ${token}${token === ID.slice(0, 32) ? ID.slice(32) : "suffix"}`, { cause: new Error(unicode(token)) }), { code: "P2024", context: [{ bare: encodeURIComponent(encoded(token)) }] });
    } } } as unknown as Db;
    await loggedApp(db, async (app, lines) => {
      app.addHook("preHandler", async (req) => {
        req.log.child({ providerMessageId: LONG_ID }).info({ nested: [{ bare: unicode(token) }] }, `child ${token}`);
        app.log.error(new Error(`root ${token}`), "root request error");
      });
      for (token of ["S".repeat(16), UNSUBSCRIBE, ID.slice(0, 32), ID, "L".repeat(64)]) {
        lines.length = 0;
        const response = await app.inject({ method: "POST", url: `/u/${encoded(token)}` });
        assert.equal(response.statusCode, 500);
        assertPrivate(lines.join(""), [token]);
        const entries = lines.map((line) => JSON.parse(line));
        assert.ok(entries.some((line) => line.err?.code === "P2024" && line.err.stack && line.res?.statusCode === 500));
        assert.ok(entries.some((line) => line.providerMessageId === LONG_ID && line.msg.startsWith("child")));
        assert.ok(entries.some((line) => line.msg === "root request error" && line.err.message.includes(LOG_REDACTED)));
        assert.ok(entries.some((line) => line.req?.url === "/u/:token"));
      }
      lines.length = 0;
      app.log.info({ prospectId: ID, providerMessageId: LONG_ID }, "outside request");
      const entry = JSON.parse(lines[0]!);
      assert.equal(entry.prospectId, ID, "request secrets do not leak into unrelated logging context");
      assert.equal(entry.providerMessageId, LONG_ID);
    });
  });

  test("real unsubscribe 500 output hides mixed encodings in messages, stacks, nested JSON and child bindings", async () => {
    let token = "";
    let representation = "";
    const db = { outreach: { findUnique: async () => {
      const err = Object.assign(new Error(`lookup diagnostic ${representation}suffix`, { cause: new Error(representation) }), {
        code: "P2024", context: [{ echo: representation }, JSON.stringify({ echo: representation })],
      });
      assert.ok(err.message.includes(representation));
      throw err;
    } } } as unknown as Db;
    await loggedApp(db, async (app, lines) => {
      app.addHook("preHandler", async (req) => {
        req.log.child({ diagnostic: representation, providerMessageId: LONG_ID }).info({ nested: [{ echo: representation }] }, `mixed ${representation}`);
      });
      for (token of ["S".repeat(16), UNSUBSCRIBE, "L".repeat(64)]) {
        for (representation of representations(token)) {
          lines.length = 0;
          assert.equal((await app.inject({ method: "POST", url: `/u/${token}` })).statusCode, 500);
          assertPrivate(lines.join(""), [token]);
          const entries = lines.map((line) => JSON.parse(line));
          const error = entries.find((line) => line.err?.code === "P2024");
          assert.equal(error.res.statusCode, 500);
          assert.equal(error.err.message, `lookup diagnostic ${LOG_REDACTED}suffix: ${LOG_REDACTED}`);
          assert.ok(error.err.stack.includes(`lookup diagnostic ${LOG_REDACTED}suffix`));
          assert.ok(entries.some((line) => line.diagnostic === LOG_REDACTED && line.providerMessageId === LONG_ID && line.nested[0].echo === LOG_REDACTED));
          assert.ok(entries.some((line) => line.req?.url === "/u/:token"));
          assert.ok(entries.some((line) => line.msg === "request completed" && typeof line.responseTime === "number"));
        }
      }
    });
  });

  test("native request output hides raw and encoded unsubscribe URL representations without changing routing", async () => {
    const token = "S".repeat(16);
    const db = { outreach: { findUnique: async () => { throw new Error("lookup diagnostic " + encodeURIComponent(unicode(token))); } } } as unknown as Db;
    await loggedApp(db, async (app, lines) => {
      for (const [index, representation] of representations(token).entries()) {
        lines.length = 0;
        const response = await app.inject({ method: "POST", url: `/u/${representation}` });
        // Only raw/singly percent-encoded paths decode to an accepted token.
        // Other spellings remain invalid links or exceed Fastify's parameter
        // length limit; sanitization cannot decode them for routing.
        assert.ok(index < 2 ? response.statusCode === 500 : [200, 404, 414].includes(response.statusCode));
        assertPrivate(lines.join(""), [token]);
        if (response.statusCode === 414) {
          assert.equal(lines.length, 0, "native router rejects oversized parameters before request logging");
        } else {
          assert.ok(lines.map((line) => JSON.parse(line)).some((line) => line.msg === "request completed" && line.res.statusCode === response.statusCode));
        }
      }
    });
  });

  test("native 404 output cannot bypass the final hook, including encoded sensitive URLs", async () => {
    await loggedApp({} as Db, async (app, lines) => {
      for (const url of [`/invite?token=${INVITE}`, `/u/${UNSUBSCRIBE}/missing`, `/missing?other=${encodeURIComponent(encoded(INVITE))}`, `/u/${encoded(UNSUBSCRIBE)}/missing`]) {
        assert.equal((await app.inject({ method: "GET", url })).statusCode, 404);
      }
      assertPrivate(lines.join(""));
      const entries = lines.map((line) => JSON.parse(line));
      assert.ok(entries.some((line) => line.msg.includes("not found")));
      assert.ok(entries.some((line) => line.req?.url === "[unmatched]"));
    });
  });

  test("caught invitation errors see body tokens before the route, even without a query token", async () => {
    const db = { invitation: { findUnique: async () => { throw Object.assign(new Error("failure"), { name: INVITE, code: "P2024" }); } } } as unknown as Db;
    await loggedApp(db, async (app, lines) => {
      assert.equal((await app.inject({ method: "POST", url: "/api/invitations/open", payload: { token: INVITE } })).statusCode, 500);
      assertPrivate(lines.join(""));
      assert.ok(lines.map((line) => JSON.parse(line)).some((line) => line.msg === "invitation open failed" && line.err.name === LOG_REDACTED));
    });
  });

  test("safe health metadata, validation and rate limits still work", async () => {
    await loggedApp({ $queryRaw: async () => [] } as unknown as Db, async (app, lines) => {
      assert.equal((await app.inject({ method: "GET", url: "/health?probe=1" })).statusCode, 200);
      assert.equal((await app.inject({ method: "POST", url: `/api/invitations/open?token=${INVITE}`, payload: { token: INVITE, extra: true } })).statusCode, 400);
      let status = 200;
      for (let i = 0; i < 35 && status === 200; i++) status = (await app.inject({ method: "GET", url: `/u/${UNSUBSCRIBE}` })).statusCode;
      assert.equal(status, 429);
      assertPrivate(lines.join(""));
      const entries = lines.map((line) => JSON.parse(line));
      assert.ok(entries.some((line) => line.req?.url === "/health" && line.req.method === "GET"));
      assert.ok(entries.some((line) => line.res?.statusCode === 429 && typeof line.responseTime === "number"));
    });
  });

  test("concurrent requests keep distinct token contexts and asynchronous child bindings", async () => {
    await loggedApp({} as Db, async (app, lines) => {
      app.get<{ Params: { token: string } }>("/context/:token", async (req) => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        req.log.child({ operation: "context" }).info(`own ${req.params.token}`);
        return { ok: true };
      });
      const tokens = ["X".repeat(16), "Y".repeat(64)];
      await Promise.all(tokens.map((token) => app.inject({ method: "GET", url: `/context/${token}` })));
      assertPrivate(lines.join(""), tokens);
      assert.equal(lines.map((line) => JSON.parse(line)).filter((line) => line.operation === "context").length, 2);
    });
  });

  test("content console retains functional URLs, long IDs and ordinary formatting", (t) => {
    const lines: string[] = [];
    t.mock.method(console, "log", (line: string) => lines.push(line));
    t.mock.method(console, "error", (line: string) => lines.push(line));
    safeConsole.log("Link: %s", REFERRAL);
    safeConsole.log({ prospectId: ID, providerMessageId: LONG_ID });
    safeConsole.log("Body: %s", `Visit ${INVITE_URL}`);
    safeConsole.error(Object.assign(new Error(`provider ${UNSUBSCRIBE_URL}`), { unsubscribeToken: "short" }));
    assert.equal(lines[0], `Link: ${REFERRAL}`);
    assert.equal(lines[1], format({ prospectId: ID, providerMessageId: LONG_ID }));
    assertPrivate(lines.join("\n"));
    assert.ok(!lines.join("\n").includes("short"));
  });

  test("send-result logging hides bare provider echoes and preserves safe message IDs", (t) => {
    const lines: string[] = [];
    t.mock.method(console, "log", (line: string) => lines.push(line));
    const content = createContentLogger();
    content.remember({ text: `Visit ${INVITE_URL}`, headers: { "List-Unsubscribe": `<${UNSUBSCRIBE_URL}>` } });
    content.console.log(`Failed ${ID}: echoed ${unicode(INVITE)} ${UNSUBSCRIBE}suffix`);
    content.console.log(`Sent ${ID} (${LONG_ID})`);
    assertPrivate(lines.join("\n"));
    assert.equal(lines[1], `Sent ${ID} (${LONG_ID})`);
    const error = content.error(new Error(`${INVITE} ${UNSUBSCRIBE}`));
    assertPrivate(format(error));
  });

  test("terminal diagnostic copies preserve safe codes/causes and do not mutate the original error", () => {
    const source = Object.assign(new Error(`${INVITE} ${REFERRAL}`, { cause: new Error(UNSUBSCRIBE) }), { invitationToken: INVITE, unsubscribeToken: UNSUBSCRIBE, code: "P2024" });
    const copy = sanitizeCliError(source) as Error & { code: string };
    assertPrivate(format(copy));
    assert.equal(copy.code, "P2024");
    assert.ok(copy.message.includes(REFERRAL));
    assert.ok(source.message.includes(INVITE));
    assert.equal(copy.name, source.name);
  });

  test("import has no process-handler side effects and fatal CLI diagnostics retain Node exit behavior", () => {
    const module = new URL("../../src/logging.ts", import.meta.url).href;
    const script = `const before = process.listenerCount('uncaughtException'); const logging = await import(${JSON.stringify(module)}); if(process.listenerCount('uncaughtException') !== before) throw new Error('handler added'); try { throw new Error(${JSON.stringify(`failed ${INVITE_URL} ${UNSUBSCRIBE_URL}`)}); } catch (err) { throw logging.sanitizeCliError(err); }`;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { encoding: "utf8", timeout: 15_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assertPrivate(result.stderr + result.stdout);
    assert.match(result.stderr, /failed/);
    assert.match(result.stderr, /\[redacted\]/);
    assert.doesNotMatch(result.stderr, /handler added/);
  });
});
