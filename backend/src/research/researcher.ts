/*
 * Researches one candidate from its stored website: reads the page it
 * points to, then at most a few relevant pages it links to on the same site
 * (contact, about, services, team), checks HTTPS, and analyses them.
 * No database access; the service stores the result.
 *
 * Finding a website for a candidate that has none is NOT automated: there is
 * no free, terms-compatible search API (Bing's was retired in August 2025,
 * and Google's Places data can't be stored), so research reports it and a
 * person searches by hand.
 */
import { isOwnWebsiteHost } from "../discovery/normalize.js";
import type { CategoryResult } from "../discovery/categoryCheck.js";
import { analyze, type Fact, type Page, type PageRole, type SignalProposal, type Subject, type ContactProposal } from "./analyze.js";
import { RESEARCH_LIMITS, type PoliteFetcher, type SourceRecord } from "./fetcher.js";
import { parseHtml } from "./html.js";

/** Bumped whenever a rule changes, so runs say which rules produced them. */
export const RESEARCH_VERSION = "r14";

export type ResearchOutcome =
  | "website_verified"
  | "website_unconfirmed"
  | "website_mismatch"
  | "no_website"
  | "website_unreachable"
  | "access_blocked"
  /** Older runs (r1) only; blocked sites are now "access_blocked". */
  | "robots_disallowed";

export const OUTCOME_LABELS: Record<ResearchOutcome, string> = {
  website_verified: "Website verified",
  website_unconfirmed: "Website not confirmed",
  website_mismatch: "Website looks like another business",
  no_website: "No website known",
  website_unreachable: "Website unreachable",
  access_blocked: "Website blocks automated access",
  robots_disallowed: "Website disallows automated reading",
};

/** Shown on every run whose website refused automated access. */
export const BLOCKED_WARNING = "Website blocks automated access; verify manually.";

/** Why the first page wasn't read: the site refused automated access, or it couldn't be reached. */
function failureKind(note: string | null | undefined): "blocked" | "unreachable" {
  return /^(skipped|blocked)/.test(note ?? "") ? "blocked" : "unreachable";
}

export interface ResearchResult {
  /** "failed" only when the website could not be read at all. */
  status: "completed" | "failed";
  outcome: ResearchOutcome;
  error: string | null;
  facts: Fact[];
  signals: SignalProposal[];
  contact: ContactProposal;
  warnings: string[];
  sources: SourceRecord[];
  /** Pages of the business's site that loaded. */
  pagesFetched: number;
  websiteVerified: boolean;
  /** Website-stage category check (only for a verified website), or null. */
  category: CategoryResult | null;
}

const ROLE_PATTERNS: [PageRole, RegExp][] = [
  ["contact", /contact|location|directions|find-us|visit/i],
  ["about", /about|who-we-are|our-story|why-us|why-choose/i],
  ["services", /service|repair|collision|accident|body|dent|paint|structural|insurance|maintenance|what-we-do|brakes|diagnostic/i],
  ["team", /team|staff|technician|meet-us|our-people/i],
];

const SKIP = /\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|docx?|xlsx?)(\?|$)|\/(wp-admin|wp-login|cart|checkout|login|account|feed)\b|^(javascript|mailto|tel|sms):/i;

const sameSite = (a: string, b: string) => a.replace(/^www\./, "") === b.replace(/^www\./, "");

/** Up to `max` same-site pages worth reading, best first: contact, about, services, team. */
export function pickPages(home: Page, max: number): { url: string; role: PageRole }[] {
  const base = new URL(home.url);
  const picked = new Map<string, PageRole>();
  for (const [role, re] of ROLE_PATTERNS) {
    const links = role === "services" ? [...home.parsed.links].sort((a, b) => Number(/collision|body|accident|dent|structural/i.test(b.href + " " + b.text)) - Number(/collision|body|accident|dent|structural/i.test(a.href + " " + a.text))) : home.parsed.links;
    for (const link of links) {
      if (picked.size >= max) break;
      if (SKIP.test(link.href)) continue;
      let u: URL;
      try {
        u = new URL(link.href, base);
      } catch {
        continue;
      }
      if (!/^https?:$/.test(u.protocol) || !sameSite(u.hostname, base.hostname)) continue;
      u.hash = "";
      const key = u.toString();
      if (key === home.url || picked.has(key) || u.pathname === base.pathname) continue;
      if (re.test(u.pathname) || re.test(link.text)) {
        picked.set(key, role);
        break; // one page per role
      }
    }
  }
  return [...picked].map(([url, role]) => ({ url, role }));
}

const providerFacts = (s: Subject): Fact[] => [
  ...(s.providerPhone ? [{ field: "provider_phone", value: s.providerPhone, state: "unverified" as const, note: `Reported by ${s.provider}; not confirmed by research.` }] : []),
  ...(s.providerStatus
    ? [{ field: "operating_status", value: s.providerStatus, state: "unverified" as const, note: `Reported by ${s.provider}; not confirmed by research.` }]
    : []),
];

/** Researches one candidate. Never throws for network problems; they become sources and outcomes. */
export async function researchCandidate(subject: Subject, fetcher: PoliteFetcher, today = new Date()): Promise<ResearchResult> {
  const base = {
    signals: [] as SignalProposal[],
    contact: {} as ContactProposal,
    sources: fetcher.sources,
    websiteVerified: false,
    category: null as CategoryResult | null,
  };

  if (!subject.website || !isOwnWebsiteHost(subject.website)) {
    return {
      ...base,
      status: "completed",
      outcome: "no_website",
      error: null,
      pagesFetched: 0,
      facts: [
        {
          field: "website",
          value: null,
          state: "not_found",
          note: "No website is known. Finding one is not automated: search for the business by hand and add it if it has one.",
        },
        ...providerFacts(subject),
      ],
      warnings: ["No website to research. Contact and signals can only be verified by hand."],
    };
  }

  const pages: Page[] = [];
  const read = async (url: string, role: PageRole) => {
    const r = await fetcher.page(url);
    if (r.html !== null && r.result) pages.push({ url: r.result.finalUrl ?? url, role, parsed: parseHtml(r.html), html: r.html });
    return r;
  };

  // The page the website points to; if it answered with an ordinary HTTP
  // error (e.g. 404) and has a path, the site root. Never after a block
  // (401/403, robots.txt) or when the site can't be reached at all.
  let first = await read(subject.website, "home");
  if (!pages.length) {
    const root = new URL(subject.website);
    const httpError = first.result?.status !== null && first.result?.status !== undefined && failureKind(first.source.note) === "unreachable";
    if (root.pathname !== "/" && httpError) {
      root.pathname = "/";
      root.search = "";
      first = await read(root.toString(), "home");
    }
  }
  if (!pages.length) {
    // Blocked (HTTP 401/403, robots.txt) is not dead and not a mismatch: the
    // site exists but refuses automated reading. Unreachable (DNS,
    // connection, timeout, server error) is a failed run that can be retried.
    const blocked = failureKind(first.source.note) === "blocked";
    const note = first.source.note ?? "could not be read";
    const how = /robots\.txt/.test(note) ? "its robots.txt" : `HTTP ${first.result?.status ?? ""}`.trim();
    return {
      ...base,
      status: blocked ? "completed" : "failed",
      outcome: blocked ? "access_blocked" : "website_unreachable",
      error: blocked ? null : `The website could not be read: ${note}.`,
      pagesFetched: 0,
      facts: [
        {
          field: "website",
          value: subject.website,
          state: "uncertain",
          note: blocked ? `The website blocks automated access (${how}); it was not read. Verify it by hand.` : `Could not be read (${note}).`,
        },
        ...providerFacts(subject),
      ],
      warnings: [blocked ? BLOCKED_WARNING : "The website could not be loaded. Try again later, or check it by hand."],
    };
  }

  for (const next of pickPages(pages[0]!, RESEARCH_LIMITS.maxPages - 1)) await read(next.url, next.role);

  const finalUrl = new URL(pages[0]!.url);
  const secure = finalUrl.protocol === "https:" ? true : (await fetcher.httpsCheck(finalUrl.host)).secure;
  const a = analyze(subject, pages, secure, today);
  const outcome: ResearchOutcome = a.ownership === "verified" ? "website_verified" : a.ownership === "uncertain" ? "website_unconfirmed" : "website_mismatch";
  return {
    ...base,
    status: "completed",
    outcome,
    error: null,
    facts: a.facts,
    signals: a.signals,
    contact: a.contact,
    warnings: a.warnings,
    pagesFetched: pages.length,
    websiteVerified: a.ownership === "verified",
    category: a.category,
  };
}
