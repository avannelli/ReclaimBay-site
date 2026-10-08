/*
 * ReclaimBay's research crawler configuration.
 *
 * The polite fetcher itself (robots.txt, per-host pacing, timeouts, response
 * cap, retries, HTML-only, source records) is the generic
 * @avannelli/aos/fetch. It has no identity or tuning of its own: ReclaimBay
 * supplies its user agent, its robots.txt agent token and its limits here, and
 * every research, AI shadow and AI smoke fetcher is built by researchFetcher().
 * The transport, sleep and clock stay injectable so tests never touch the network.
 */
import { PoliteFetcher, type FetchLimits, type PoliteFetcherOptions } from "@avannelli/aos/fetch";

export const RESEARCH_USER_AGENT = "ReclaimBayResearch/1.0 (+https://reclaimbay.com)";

/** The product token matched against robots.txt `User-agent` lines. */
export const RESEARCH_ROBOTS_AGENT = "ReclaimBayResearch";

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

/** The fetch limits AOS applies (maxPages is research's own: researcher and the AI shadow use it). */
const FETCH_LIMITS: FetchLimits = {
  timeoutMs: RESEARCH_LIMITS.timeoutMs,
  robotsTimeoutMs: RESEARCH_LIMITS.robotsTimeoutMs,
  maxBytes: RESEARCH_LIMITS.maxBytes,
  perHostDelayMs: RESEARCH_LIMITS.perHostDelayMs,
  retryDelayMs: RESEARCH_LIMITS.retryDelayMs,
  maxRetries: RESEARCH_LIMITS.maxRetries,
};

/** A fetcher with ReclaimBay's identity and limits. Only the transport, sleep and clock can be injected. */
export function researchFetcher(deps: Pick<PoliteFetcherOptions, "get" | "sleep" | "now"> = {}): PoliteFetcher {
  return new PoliteFetcher({
    userAgent: RESEARCH_USER_AGENT,
    robotsAgent: RESEARCH_ROBOTS_AGENT,
    limits: FETCH_LIMITS,
    get: deps.get,
    sleep: deps.sleep,
    now: deps.now,
  });
}
