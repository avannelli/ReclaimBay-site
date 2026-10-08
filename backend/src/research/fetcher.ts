/*
 * Polite, bounded HTTP for research. Every request goes through
 * PoliteFetcher, which:
 *
 *   - honours robots.txt (per site, fetched once per run);
 *   - waits at least RESEARCH_LIMITS.perHostDelayMs between requests to a host;
 *   - times out each request and caps how much of a page is read;
 *   - retries once, and only for transient failures (5xx, 429, network);
 *   - accepts HTML only;
 *   - records every request (URL, status, outcome) as a source. Page bodies
 *     are used in memory for analysis and never stored.
 *
 * HttpGet is injectable so tests never touch the network.
 */
import { parseRobots, robotsAllows, type RobotsRules } from "@avannelli/aos/robots";

export const RESEARCH_USER_AGENT = "ReclaimBayResearch/1.0 (+https://reclaimbay.com)";

export const RESEARCH_LIMITS = {
  /** Per request. */
  timeoutMs: 10_000,
  robotsTimeoutMs: 5_000,
  /** Bytes read from any one page. */
  maxBytes: 1_500_000,
  /** Pages of the business's site per run (robots.txt and the HTTPS check not counted). */
  maxPages: 5,
  /** Minimum gap between two requests to the same host. */
  perHostDelayMs: 1_000,
  /** One retry, after this wait, for transient failures only. */
  retryDelayMs: 2_000,
  maxRetries: 1,
} as const;

export interface HttpResult {
  url: string;
  finalUrl: string | null;
  status: number | null;
  contentType: string | null;
  body: string | null;
  bytes: number;
  /** Network-level failure, e.g. "timeout", "dns", "tls", "connection". */
  error: string | null;
}

export type HttpGet = (url: string, opts: { timeoutMs: number; maxBytes: number; userAgent: string }) => Promise<HttpResult>;

function classify(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = e?.cause?.code ?? "";
  const text = `${e?.name ?? ""} ${e?.message ?? ""} ${code} ${e?.cause?.message ?? ""}`;
  if (/TimeoutError|aborted|timeout/i.test(text)) return "timeout";
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) return "dns";
  if (/CERT|SSL|TLS|self[- ]signed|UNABLE_TO_VERIFY|ALTNAME/i.test(text)) return "tls";
  return "connection";
}

/** The real network. Reads at most `maxBytes`; follows redirects. */
export const defaultHttpGet: HttpGet = async (url, opts) => {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs),
      headers: { "user-agent": opts.userAgent, accept: "text/html,application/xhtml+xml,text/plain;q=0.8" },
    });
    const contentType = res.headers.get("content-type");
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        chunks.push(value);
        bytes += value.byteLength;
        if (bytes >= opts.maxBytes) {
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    }
    const body = new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks).subarray(0, opts.maxBytes));
    return { url, finalUrl: res.url || url, status: res.status, contentType, body, bytes, error: null };
  } catch (err) {
    return { url, finalUrl: null, status: null, contentType: null, body: null, bytes: 0, error: classify(err) };
  }
};

export interface SourceRecord {
  kind: "website" | "robots" | "https_check";
  url: string;
  finalUrl: string | null;
  fetchedAt: Date;
  httpStatus: number | null;
  ok: boolean;
  contentType: string | null;
  bytes: number | null;
  note: string | null;
}

export interface PageResult {
  source: SourceRecord;
  /** HTML body, when the page loaded and is HTML. Never stored. */
  html: string | null;
  result: HttpResult | null;
}

const isTransient = (r: HttpResult) =>
  (r.error !== null && r.error !== "dns" && r.error !== "tls") || r.status === 429 || (r.status !== null && r.status >= 500);

const isHtml = (ct: string | null) => !ct || /text\/html|application\/xhtml\+xml/i.test(ct);

export interface PoliteFetcherOptions {
  get?: HttpGet;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  userAgent?: string;
}

export class PoliteFetcher {
  readonly sources: SourceRecord[] = [];
  private readonly get: HttpGet;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly userAgent: string;
  private readonly robots = new Map<string, RobotsRules | "unavailable" | "unreachable">();
  /** Why an origin's robots.txt couldn't be fetched ("tls", "dns", ...), when it couldn't. */
  private readonly robotsErrors = new Map<string, string>();
  private readonly lastHit = new Map<string, number>();

  constructor(opts: PoliteFetcherOptions = {}) {
    this.get = opts.get ?? defaultHttpGet;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
    this.userAgent = opts.userAgent ?? RESEARCH_USER_AGENT;
  }

  private async pace(host: string) {
    const last = this.lastHit.get(host);
    if (last !== undefined) {
      const wait = last + RESEARCH_LIMITS.perHostDelayMs - this.now();
      if (wait > 0) await this.sleep(wait);
    }
    this.lastHit.set(host, this.now());
  }

  private async request(url: string, timeoutMs: number): Promise<{ result: HttpResult; attempts: number }> {
    const host = new URL(url).host;
    let attempts = 0;
    let result: HttpResult;
    for (;;) {
      attempts++;
      await this.pace(host);
      result = await this.get(url, { timeoutMs, maxBytes: RESEARCH_LIMITS.maxBytes, userAgent: this.userAgent });
      if (attempts > RESEARCH_LIMITS.maxRetries || !isTransient(result)) break;
      await this.sleep(RESEARCH_LIMITS.retryDelayMs);
    }
    return { result, attempts };
  }

  private record(kind: SourceRecord["kind"], url: string, r: HttpResult | null, ok: boolean, note: string | null): SourceRecord {
    const source: SourceRecord = {
      kind,
      url: url.slice(0, 500),
      finalUrl: r?.finalUrl?.slice(0, 500) ?? null,
      fetchedAt: new Date(this.now()),
      httpStatus: r?.status ?? null,
      ok,
      contentType: r?.contentType?.slice(0, 100) ?? null,
      bytes: r ? r.bytes : null,
      note: note?.slice(0, 200) ?? null,
    };
    this.sources.push(source);
    return source;
  }

  /**
   * robots.txt rules for an origin, fetched once. "unavailable" (a server
   * error) means do not read the site; "unreachable" means the site itself
   * can't be reached (DNS, connection, timeout).
   */
  private async rulesFor(origin: string): Promise<RobotsRules | "unavailable" | "unreachable"> {
    const cached = this.robots.get(origin);
    if (cached) return cached;
    const url = `${origin}/robots.txt`;
    const { result: r } = await this.request(url, RESEARCH_LIMITS.robotsTimeoutMs);
    let rules: RobotsRules | "unavailable" | "unreachable";
    let note: string;
    if (r.status !== null && r.status >= 200 && r.status < 300 && r.body !== null) {
      rules = parseRobots(r.body, "ReclaimBayResearch");
      note = "robots.txt read";
    } else if (r.status !== null && r.status >= 400 && r.status < 500) {
      // RFC 9309: a missing robots.txt means everything may be fetched.
      rules = { allow: [], disallow: [] };
      note = `no robots.txt (HTTP ${r.status}): no restrictions`;
    } else if (r.error) {
      rules = "unreachable";
      note = `site unreachable (${r.error})`;
      this.robotsErrors.set(origin, r.error);
    } else {
      // A server error on robots.txt: treat the whole site as disallowed.
      rules = "unavailable";
      note = `robots.txt error (HTTP ${r.status}): site skipped`;
    }
    this.record("robots", url, r, typeof rules === "object", note);
    this.robots.set(origin, rules);
    return rules;
  }

  /** Fetches one page of a site, if robots.txt allows it. */
  async page(url: string): Promise<PageResult> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { source: this.record("website", url, null, false, "invalid URL"), html: null, result: null };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { source: this.record("website", url, null, false, "not an http(s) URL"), html: null, result: null };
    }
    const rules = await this.rulesFor(parsed.origin);
    if (rules === "unreachable") return { source: this.record("website", url, null, false, "failed: site unreachable"), html: null, result: null };
    if (rules === "unavailable" || !robotsAllows(rules, parsed.pathname + parsed.search)) {
      const note = rules === "unavailable" ? "skipped: robots.txt unavailable" : "skipped: disallowed by robots.txt";
      return { source: this.record("website", url, null, false, note), html: null, result: null };
    }
    const { result: r, attempts } = await this.request(url, RESEARCH_LIMITS.timeoutMs);
    const retried = attempts > 1 ? " (after a retry)" : "";
    if (r.error) return { source: this.record("website", url, r, false, `failed: ${r.error}${retried}`), html: null, result: r };
    if (r.status === 401 || r.status === 403) {
      // The site refuses automated access: blocked, not dead. Never retried.
      return { source: this.record("website", url, r, false, `blocked: HTTP ${r.status} (automated access refused)`), html: null, result: r };
    }
    if (r.status === null || r.status < 200 || r.status >= 300) {
      return { source: this.record("website", url, r, false, `HTTP ${r.status}${retried}`), html: null, result: r };
    }
    if (!isHtml(r.contentType)) return { source: this.record("website", url, r, false, "not an HTML page"), html: null, result: r };
    return { source: this.record("website", url, r, true, r.bytes >= RESEARCH_LIMITS.maxBytes ? "read the first part only" : null), html: r.body, result: r };
  }

  /** Whether https://host/ loads with a valid certificate (for the website_not_https signal). */
  async httpsCheck(host: string): Promise<{ source: SourceRecord; secure: boolean | null }> {
    const url = `https://${host}/`;
    const rules = await this.rulesFor(`https://${host}`);
    // A certificate error on robots.txt is the site's certificate failing:
    // not secure, as for the page itself.
    if (rules === "unreachable" && this.robotsErrors.get(`https://${host}`) === "tls") {
      return { source: this.record("https_check", url, null, false, "certificate error over HTTPS"), secure: false };
    }
    if (rules === "unreachable") return { source: this.record("https_check", url, null, false, "HTTPS unreachable"), secure: null };
    if (rules === "unavailable" || !robotsAllows(rules, "/")) {
      return { source: this.record("https_check", url, null, false, "skipped: robots.txt"), secure: null };
    }
    const { result: r } = await this.request(url, RESEARCH_LIMITS.timeoutMs);
    if (r.error === "tls") return { source: this.record("https_check", url, r, false, "certificate error over HTTPS"), secure: false };
    if (r.error) return { source: this.record("https_check", url, r, false, `failed: ${r.error}`), secure: null };
    const finalHttps = (r.finalUrl ?? url).startsWith("https://");
    if (!finalHttps) return { source: this.record("https_check", url, r, false, "HTTPS redirects to http://"), secure: false };
    const ok = r.status !== null && r.status < 400;
    return { source: this.record("https_check", url, r, ok, ok ? "loads over HTTPS" : `HTTP ${r.status} over HTTPS`), secure: ok ? true : null };
  }
}
