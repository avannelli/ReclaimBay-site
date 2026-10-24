/*
 * Prescreen: one read of a business's official website through the research crawler (robots.txt,
 * per-host pacing, timeouts, public-address checks) and the research analyzer, with Targeted
 * Outreach 03's acceptance rules. A business passes only with a verified website identity, a verified
 * location, strong positive repair evidence, a suitable ownership class and no conflicting evidence;
 * a published email that is suppressed or already belongs to someone keeps it out.
 *
 * Passing is not qualification: an accepted business is added to Discovery and researched by the
 * scheduled research worker, unchanged, like any other candidate.
 */
import { readSite } from "@avannelli/aos/crawl";
import { parseHtml } from "@avannelli/aos/html";
import { DEFAULT_SKIP, selectPages } from "@avannelli/aos/pages";
import type { StagedPlace } from "../discovery/types.js";
import { analyze, type Analysis, type PageRole } from "../research/analyze.js";
import { researchFetcher } from "../research/fetcher.js";
import { createPublicWebTransport, type AddressResolver } from "../research/publicWeb.js";
import { meteredFetch } from "./budget.js";

const REPAIR_SIGNALS = new Set(["automotive_repair_services", "collision_repair_services"]);

const ROLES: { role: PageRole; pattern: RegExp }[] = [
  { role: "services", pattern: /service|repair|collision|body|brake|diagnostic/i },
  { role: "contact", pattern: /contact|location|directions/i },
  { role: "about", pattern: /about|our.story|who.we.are/i },
  { role: "other", pattern: /privacy/i },
];

export type ScreenReason =
  | "site_unreadable"
  | "website_identity_unverified"
  | "location_identity_unverified"
  | "positive_repair_evidence_insufficient"
  | "unsuitable_ownership"
  | "scope_or_evidence_conflict"
  | "suppressed_or_existing_email"
  | "no_published_email";

export interface ScreenRules {
  /** Emails that must never be prescreened in: suppressed, opted out, or already a candidate's, prospect's or recipient's. */
  blockedEmails: ReadonlySet<string>;
  requirePublishedEmail: boolean;
}

/** Targeted Outreach 03's acceptance rules over one analysis. No reasons means accepted. */
export function screeningReasons(a: Analysis | null, rules: ScreenRules): { reasons: ScreenReason[]; email: string | null } {
  if (!a) return { reasons: ["site_unreadable"], email: null };
  const fact = (field: string) => a.facts.find((f) => f.field === field)?.value ?? null;
  const email = a.contact.email?.trim().toLowerCase() || null;
  const reasons: ScreenReason[] = [];
  if (a.ownership !== "verified") reasons.push("website_identity_unverified");
  if (!["verified_location", "single_location_site"].includes(fact("location_identity") ?? "")) reasons.push("location_identity_unverified");
  if (fact("service_evidence") !== "strong" || !a.signals.some((s) => REPAIR_SIGNALS.has(s.key) && s.value === "yes")) reasons.push("positive_repair_evidence_insufficient");
  if (!["independent", "regional", "unknown"].includes(fact("ownership_class") ?? "")) reasons.push("unsuitable_ownership");
  if (a.warnings.some((w) => /contradictory|conflict|fleet operation|dealership service/i.test(w))) reasons.push("scope_or_evidence_conflict");
  if (email && rules.blockedEmails.has(email)) reasons.push("suppressed_or_existing_email");
  if (!email && rules.requirePublishedEmail) reasons.push("no_published_email");
  return { reasons, email };
}

export interface ScreenOutcome {
  status: "accepted" | "rejected" | "error";
  reasons: string[];
  email: string | null;
  fetches: number;
  bytes: number;
  /** Compact and reviewable: what was read and what decided it. No page bodies. */
  evidence: Record<string, unknown>;
}

export interface ScreenDeps {
  /** The physical HTTP fetch under the research transport (tests inject one; the default is the network). */
  transportFetch?: (url: string, init: RequestInit & { dispatcher?: unknown }) => Promise<Response>;
  resolve?: AddressResolver;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export async function screenBusiness(
  place: StagedPlace,
  rules: ScreenRules,
  caps: { fetches: number; bytes: number; pages: number },
  deps: ScreenDeps = {},
): Promise<ScreenOutcome> {
  const clock = deps.now ?? Date.now;
  const meter = meteredFetch(caps, deps.transportFetch);
  const transport = createPublicWebTransport({ fetch: meter.fetch, resolve: deps.resolve });
  const fetcher = researchFetcher({ get: transport.get, sleep: deps.sleep, now: deps.now });
  try {
    const site = await readSite(fetcher, place.website!, {
      parse: parseHtml,
      select: (home) => selectPages({ url: home.url, links: home.parsed.links }, { roles: ROLES, skip: DEFAULT_SKIP, max: Math.max(0, caps.pages - 1) }),
      maxPages: caps.pages,
      rootFallback: true,
    });
    const analysis = site.pages.length
      ? analyze(
          {
            businessName: place.businessName, website: place.website ?? null, streetAddress: place.streetAddress ?? null, city: place.city ?? null,
            state: place.state ?? null, postalCode: place.postalCode ?? null, providerPhone: place.phone ?? null, providerBrand: place.brand ?? null,
            providerStatus: place.operatingStatus ?? null, provider: "overture",
          },
          site.pages,
          null,
          new Date(clock()),
        )
      : null;
    const { reasons, email } = screeningReasons(analysis, rules);
    const fact = (field: string) => analysis?.facts.find((f) => f.field === field) ?? null;
    const used = meter.used();
    const evidence = {
      checkedAt: new Date(clock()).toISOString(),
      readStatus: site.status,
      pages: site.pages.map((p) => ({ url: p.url, role: p.role, title: p.parsed.title?.slice(0, 120) ?? null })),
      requests: fetcher.sources.length,
      ownership: analysis?.ownership ?? null,
      ownershipClass: fact("ownership_class")?.value ?? null,
      locationIdentity: fact("location_identity")?.value ?? null,
      serviceEvidence: fact("service_evidence")?.value ?? null,
      repairQuotes: (analysis?.signals ?? []).filter((s) => REPAIR_SIGNALS.has(s.key) && s.value === "yes").slice(0, 3).map((s) => ({ key: s.key, url: s.sourceUrl, excerpt: s.excerpt.slice(0, 200) })),
      warnings: (analysis?.warnings ?? []).slice(0, 10).map((w) => w.slice(0, 200)),
      emailSource: analysis?.contact.emailSourceUrl ?? null,
    };
    // A cut-off read is never used as positive evidence.
    if (meter.exceeded()) return { status: "error", reasons: ["request_budget_exceeded"], email: null, ...used, evidence };
    return { status: reasons.length ? "rejected" : "accepted", reasons, email, ...used, evidence };
  } catch (e) {
    return { status: "error", reasons: ["screen_error"], email: null, ...meter.used(), evidence: { error: e instanceof Error ? e.name : "Error" } };
  } finally {
    await transport.close();
  }
}
