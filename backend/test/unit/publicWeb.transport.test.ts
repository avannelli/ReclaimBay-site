import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import dnsPromises from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import { createServer, type Server, type RequestListener } from "node:http";
import { createServer as createTlsServer } from "node:https";
import net, { Socket, type AddressInfo, type TcpNetConnectOpts } from "node:net";
import tls, { type ConnectionOptions } from "node:tls";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { after, before, describe, mock, test } from "node:test";
import { defaultHttpGet } from "@avannelli/aos/fetch";
import { createPublicWebTransport, type AddressResolver } from "../../src/research/publicWeb.js";
import { researchFetcher } from "../../src/research/fetcher.js";

const options = { timeoutMs: 2_000, maxBytes: 1_000, userAgent: "FixtureBrowser/1.0" };

describe("redirect-by-redirect URL validation (injected responses, no network)", () => {
  async function redirects(targets: string[]) {
    const calls: string[] = [];
    const signals: (AbortSignal | null | undefined)[] = [];
    const transport = createPublicWebTransport({ fetch: async (url, opts) => {
      calls.push(url); signals.push(opts.signal);
      assert.equal(opts.redirect, "manual");
      return calls.length <= targets.length
        ? new Response("redirect body", { status: 302, headers: { location: targets[calls.length - 1]! } })
        : new Response("done", { headers: { "content-type": "text/html" } });
    } });
    try { return { result: await transport.get("https://public.example.com/start", options), calls, signals }; }
    finally { await transport.close(); }
  }
  test("public redirects, relative locations and both protocol changes work", async () => {
    const r = await redirects(["http://next.example.com/path", "https://next.example.com/end", "/final"]);
    assert.equal(r.result.body, "done"); assert.equal(r.result.finalUrl, "https://next.example.com/final");
    assert.equal(new Set(r.signals).size, 1, "one timeout budget across the chain");
  });
  for (const target of ["http://127.0.0.1/", "http://10.0.0.1/", "http://[fc00::1]/", "http://[::ffff:127.0.0.1]/", "http://localhost/", "http://foo.internal/", "http://2130706433/", "http://0x7f000001/"]) {
    test(`blocks redirect to ${target} before requesting it`, async () => {
      const r = await redirects([target]); assert.equal(r.result.error, "destination_blocked"); assert.equal(r.calls.length, 1);
    });
  }
  test("a later private hop stops the chain", async () => {
    const r = await redirects(["https://next.example.com/", "http://169.254.169.254/"]);
    assert.equal(r.result.error, "destination_blocked"); assert.equal(r.calls.length, 2);
  });
  test("redirect loops are bounded at fetch's existing 20-redirect limit", async () => {
    const r = await redirects(Array<string>(25).fill("https://public.example.com/again"));
    assert.equal(r.result.error, "connection"); assert.equal(r.calls.length, 21);
  });
});

describe("checked connector and native fetch (explicit loopback network fixture)", () => {
  let http: Server, https: Server, httpPort: number, httpsPort: number;
  const hits: { url: string; host: string | undefined }[] = [];
  const connections: { host: string; addresses: string[]; servername?: string }[] = [];
  const cert = readFileSync(new URL("../fixtures/public-web-cert.txt", import.meta.url));
  const key = readFileSync(new URL("../fixtures/public-web-key.txt", import.meta.url));
  const originalTlsConnect = tls.connect;
  // These fake keys/CA are ONLY for this local fixture, never supplied to production.
  // The socket shim records the actual connector lookup and then simulates the
  // public endpoint with a local server. No test connects to a public IP.
  function fixtureSocket(opts: TcpNetConnectOpts, raw: Socket, fail: (error: Error) => void, servername?: string) {
    assert.equal(typeof opts.lookup, "function", "the real Undici connector must use our checked lookup");
    opts.lookup!(opts.host!, { all: true }, (error, addresses) => {
      if (error) return fail(error);
      assert.ok(Array.isArray(addresses));
      connections.push({ host: opts.host!, addresses: addresses.map((a) => a.address), ...(servername ? { servername } : {}) });
      raw.connect({ host: "127.0.0.1", port: opts.port });
    });
  }
  before(async () => {
    const serve: RequestListener = (req, res) => {
      hits.push({ url: req.url ?? "/", host: req.headers.host });
      const path = req.url ?? "/";
      if (path === "/robots.txt") { res.writeHead(404); res.end(); }
      else if (path === "/html") { res.writeHead(200, { "content-type": "text/html; charset=utf-8", connection: "close" }); res.end("<p>héllo ✓</p>"); }
      else if (path === "/latin1") { res.writeHead(200, { "content-type": "text/html; charset=iso-8859-1" }); res.end(Buffer.from([99, 97, 102, 233])); }
      else if (path === "/big") { res.writeHead(200, { "content-type": "text/html" }); res.end("y".repeat(5_000)); }
      else if (path === "/huge") { res.writeHead(200, { "content-type": "text/html" }); res.end("y".repeat(1_600_000)); }
      else if (["/gzip", "/deflate", "/br"].includes(path)) {
        const body = Buffer.from("<p>compressed UTF-8 ✓</p>"); const encoding = path.slice(1);
        res.writeHead(200, { "content-type": "text/html", "content-encoding": encoding });
        res.end(encoding === "gzip" ? gzipSync(body) : encoding === "deflate" ? deflateSync(body) : brotliCompressSync(body));
      }
      else if (path === "/redirect") { res.writeHead(302, { location: "/html" }); res.end(); }
      else if (path === "/to-http") { res.writeHead(302, { location: `http://next.example.com:${httpPort}/html` }); res.end(); }
      else if (path === "/to-https") { res.writeHead(302, { location: `https://next.example.com:${httpsPort}/html` }); res.end(); }
      else if (path === "/private-dns") { res.writeHead(302, { location: `http://private.example.com:${httpPort}/html` }); res.end(); }
      else if (path === "/empty") { res.writeHead(204); res.end(); }
      else if (path === "/notype") { res.end("plain"); }
      else if (path === "/slow") { setTimeout(() => { if (!res.destroyed) res.end("late"); }, 150); }
      else if (path === "/ua") { res.end(`${req.headers["user-agent"]}|${req.headers.accept}`); }
      else { res.writeHead(Number(path.slice(1)) || 404); res.end("response"); }
    };
    http = createServer(serve); https = createTlsServer({ cert, key }, serve);
    await Promise.all([new Promise<void>((done) => http.listen(0, "127.0.0.1", done)), new Promise<void>((done) => https.listen(0, "127.0.0.1", done))]);
    httpPort = (http.address() as AddressInfo).port; httpsPort = (https.address() as AddressInfo).port;
    mock.method(net, "connect", (options: unknown) => {
      const opts = options as TcpNetConnectOpts; const raw = new Socket();
      // The old default transport's explicit loopback fixture has no policy lookup.
      if (opts.host === "127.0.0.1" && !opts.lookup) return raw.connect({ host: opts.host, port: opts.port });
      fixtureSocket(opts, raw, (error) => raw.destroy(error)); return raw;
    });
    mock.method(tls, "connect", (options: unknown) => {
      const opts = options as ConnectionOptions & TcpNetConnectOpts;
      assert.notEqual(opts.rejectUnauthorized, false, "TLS verification must remain enabled");
      const raw = new Socket();
      const secure = originalTlsConnect({ ...opts, socket: raw, ca: cert });
      fixtureSocket(opts, raw, (error) => secure.destroy(error), opts.servername);
      return secure;
    });
  });
  after(async () => {
    mock.restoreAll(); http.closeAllConnections(); https.closeAllConnections();
    await Promise.all([new Promise<void>((done) => http.close(() => done())), new Promise<void>((done) => https.close(() => done()))]);
  });
  const publicDns: AddressResolver = async () => [{ address: "8.8.8.8", family: 4 }];
  async function request(path: string, config: { resolve?: AddressResolver; secure?: boolean; timeoutMs?: number; host?: string } = {}) {
    const transport = createPublicWebTransport({ resolve: config.resolve ?? publicDns });
    try {
      const url = `${config.secure ? "https" : "http"}://${config.host ?? "public.example.com"}:${config.secure ? httpsPort : httpPort}${path}`;
      return await transport.get(url, { ...options, timeoutMs: config.timeoutMs ?? options.timeoutMs });
    } finally { await transport.close(); }
  }
  test("HTTP and TLS connect using checked addresses while preserving Host and SNI", async () => {
    assert.equal((await request("/html")).body, "<p>héllo ✓</p>");
    assert.equal((await request("/html", { secure: true })).body, "<p>héllo ✓</p>");
    assert.deepEqual(connections.at(-1), { host: "public.example.com", addresses: ["8.8.8.8"], servername: "public.example.com" });
    assert.equal(hits.at(-1)?.host, `public.example.com:${httpsPort}`);
  });
  test("valid HTTP -> HTTPS and HTTPS -> HTTP redirects work", async () => {
    assert.equal((await request("/to-https")).finalUrl, `https://next.example.com:${httpsPort}/html`);
    assert.equal((await request("/to-http", { secure: true })).finalUrl, `http://next.example.com:${httpPort}/html`);
  });
  test("redirected DNS is checked, and private/mixed answers cause no endpoint request", async () => {
    const before = hits.length;
    const result = await request("/private-dns", { resolve: async (host) => [{ address: host === "private.example.com" ? "10.0.0.1" : "8.8.8.8", family: 4 }] });
    assert.equal(result.error, "destination_blocked"); assert.equal(hits.length, before + 1);
    for (const answers of [[{ address: "10.0.0.1", family: 4 }], [{ address: "8.8.8.8", family: 4 }, { address: "fc00::1", family: 6 }]]) {
      const count = hits.length; assert.equal((await request("/html", { resolve: async () => answers })).error, "destination_blocked"); assert.equal(hits.length, count);
    }
  });
  test("no second DNS lookup between validation and the connection", async () => {
    let calls = 0;
    const result = await request("/html", { resolve: async () => [{ address: ++calls === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }] });
    assert.equal(result.error, null); assert.equal(calls, 1);
    assert.deepEqual(connections.at(-1)?.addresses, ["8.8.8.8"]);
  });
  test("the real default resolver asks Node for all answers without overriding DNS ordering", async () => {
    let calls = 0;
    const lookup = mock.method(dnsPromises, "lookup", async (host: unknown, opts?: unknown) => {
      calls++; assert.equal(host, "public.example.com"); assert.deepEqual(opts, { all: true });
      return [{ address: "8.8.8.8", family: 4 }];
    });
    syncBuiltinESMExports();
    const transport = createPublicWebTransport();
    try {
      assert.equal((await transport.get(`http://public.example.com:${httpPort}/html`, options)).error, null);
      assert.equal(calls, 1);
    } finally { await transport.close(); lookup.mock.restore(); syncBuiltinESMExports(); }
  });
  test("multiple public answers reach the connector unchanged", async () => {
    assert.equal((await request("/html", { resolve: async () => [{ address: "8.8.8.8", family: 4 }, { address: "1.1.1.1", family: 4 }] })).error, null);
    assert.deepEqual(connections.at(-1)?.addresses, ["8.8.8.8", "1.1.1.1"]);
  });
  test("a fresh connection after DNS changes to private is rejected", async () => {
    let calls = 0;
    const transport = createPublicWebTransport({ resolve: async () => [{ address: ++calls === 1 ? "8.8.8.8" : "10.0.0.1", family: 4 }] });
    const count = hits.length;
    try {
      const url = `http://public.example.com:${httpPort}/html`; // Fixture closes each connection.
      assert.equal((await transport.get(url, options)).error, null);
      assert.equal((await transport.get(url, options)).error, "destination_blocked");
      assert.equal(calls, 2); assert.equal(hits.length, count + 1);
    } finally { await transport.close(); }
  });
  test("DNS errors, certificate identity errors and shared timeouts retain classification", async () => {
    assert.equal((await request("/html", { resolve: async () => { throw Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" }); } })).error, "dns");
    assert.equal((await request("/html", { secure: true, host: "wrong.example.com" })).error, "tls");
    assert.equal((await request("/slow", { timeoutMs: 30 })).error, "timeout");
    assert.equal((await request("/html", { timeoutMs: 30, resolve: async () => { await new Promise((done) => setTimeout(done, 90)); return [{ address: "8.8.8.8", family: 4 }]; } })).error, "timeout");
  });
  test("native body/status/encoding/header behavior matches the old transport on loopback", async () => {
    // The old transport uses literal loopback; new requests use the public-endpoint shim.
    for (const path of ["/html", "/latin1", "/gzip", "/deflate", "/br", "/big", "/empty", "/notype", "/ua", "/401", "/403", "/404", "/500", "/redirect"]) {
      const expected = await defaultHttpGet(`http://127.0.0.1:${httpPort}${path}`, options);
      const actual = await request(path);
      assert.deepEqual([actual.status, actual.contentType, actual.body, actual.bytes, actual.error], [expected.status, expected.contentType, expected.body, expected.bytes, expected.error], path);
    }
  });
  test("AOS keeps robots, retries, partial notes and source records around the new transport", async () => {
    const transport = createPublicWebTransport({ resolve: publicDns });
    try {
      let clock = 0;
      const fetcher = researchFetcher({ get: transport.get, sleep: async (ms) => void (clock += ms), now: () => clock });
      const page = await fetcher.page(`http://public.example.com:${httpPort}/big`);
      assert.equal(page.html?.length, 5_000); // ReclaimBay's 1.5 MB cap is unchanged.
      const partial = await fetcher.page(`http://public.example.com:${httpPort}/huge`);
      assert.equal(partial.html?.length, 1_500_000);
      assert.equal(partial.source.note, "read the first part only");
      assert.ok(partial.source.bytes! >= 1_500_000);
      const busy = await fetcher.page(`http://public.example.com:${httpPort}/500`);
      assert.match(busy.source.note!, /after a retry/);
      assert.equal(fetcher.sources[0]?.kind, "robots");
      assert.ok(clock >= 2_000);
    } finally { await transport.close(); }
  });
  test("the default research factory blocks loopback; an explicit fixture HttpGet still works", async () => {
    const count = hits.length;
    const fetcher = researchFetcher({ sleep: async () => undefined, now: () => 0 });
    const result = await fetcher.page(`http://127.0.0.1:${httpPort}/html`);
    assert.equal(result.html, null);
    assert.equal(hits.length, count);
    assert.match(fetcher.sources[0]!.note!, /destination_blocked/);
    const fixture = researchFetcher({ get: defaultHttpGet, sleep: async () => undefined, now: () => 0 });
    assert.equal((await fixture.page(`http://127.0.0.1:${httpPort}/html`)).html, "<p>héllo ✓</p>");
  });
});

describe("unchanged network-error classification (injected fetch)", () => {
  for (const [error, expected] of [
    [Object.assign(new Error("failed"), { cause: { code: "EAI_AGAIN" } }), "dns"],
    [Object.assign(new Error("failed"), { cause: { code: "CERT_HAS_EXPIRED" } }), "tls"],
    [Object.assign(new Error("failed"), { cause: { code: "ECONNREFUSED" } }), "connection"],
    [Object.assign(new Error("failed"), { cause: { code: "ECONNRESET" } }), "connection"],
    [new DOMException("The operation was aborted due to timeout", "TimeoutError"), "timeout"],
  ] as const) test(expected + ": " + error.message, async () => {
    const transport = createPublicWebTransport({ fetch: async () => { throw error; } });
    try { assert.equal((await transport.get("https://public.example.com/", options)).error, expected); }
    finally { await transport.close(); }
  });
});
