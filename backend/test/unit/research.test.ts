import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Subject } from "../../src/research/analyze.js";
import { PoliteFetcher, RESEARCH_LIMITS, type HttpGet, type HttpResult } from "../../src/research/fetcher.js";
import { parseHtml } from "../../src/research/html.js";
import { researchCandidate } from "../../src/research/researcher.js";
import { parseRobots, robotsAllows } from "../../src/research/robots.js";

/*
 * Research runs against fixture websites served by an in-memory HttpGet:
 * no test touches the network.
 */

type Fixture = Partial<HttpResult> & { body?: string };

function server(routes: Record<string, Fixture | Fixture[]>) {
  const calls: string[] = [];
  const counts = new Map<string, number>();
  const get: HttpGet = async (url) => {
    calls.push(url);
    const n = counts.get(url) ?? 0;
    counts.set(url, n + 1);
    const route = routes[url];
    const f = Array.isArray(route) ? route[Math.min(n, route.length - 1)] : route;
    if (!f) return { url, finalUrl: url, status: 404, contentType: "text/html", body: "not found", bytes: 9, error: null };
    return {
      url,
      finalUrl: f.finalUrl ?? url,
      status: f.status ?? (f.error ? null : 200),
      contentType: f.contentType ?? (f.error ? null : "text/html; charset=utf-8"),
      body: f.body ?? null,
      bytes: f.body?.length ?? 0,
      error: f.error ?? null,
    };
  };
  const slept: number[] = [];
  let clock = 0;
  const fetcher = () =>
    new PoliteFetcher({
      get,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
      now: () => clock,
    });
  return { get, calls, slept, fetcher };
}

const TODAY = new Date("2026-10-01T12:00:00Z");

const subject = (over: Partial<Subject> = {}): Subject => ({
  businessName: "Saviers Road Auto Repair",
  website: "https://saviersauto.example.com/",
  streetAddress: "5577 Saviers Rd",
  city: "Oxnard",
  state: "CA",
  postalCode: "93033",
  providerPhone: "+18055550101",
  providerBrand: null,
  providerStatus: "open",
  provider: "overture",
  ...over,
});

const page = (title: string, body: string, head = "") =>
  `<!doctype html><html><head><title>${title}</title>${head}</head><body><nav><a href="/contact-us">Contact Us</a> <a href="/services">Our Services</a> <a href="/about">About</a></nav>${body}<script>var x = "(805) 999-9999 should never be read";</script></body></html>`;

const HOME = page(
  "Saviers Road Auto Repair | Oxnard Auto Repair",
  `<h1>Saviers Road Auto Repair</h1><p>Family owned and operated since 1988. Our 6 service bays are open Monday to Friday.</p>
   <p>Call <a href="tel:+18055550101">(805) 555-0101</a> · 5577 Saviers Rd, Oxnard, CA 93033</p><footer>© 2025 Saviers Road Auto Repair</footer>`,
  `<meta property="og:site_name" content="Saviers Road Auto Repair">`,
);
const SERVICES = page(
  "Services | Saviers Road Auto Repair",
  `<h1>Our Services</h1><ul><li>Brake repair and pads</li><li>Check engine light diagnostics</li><li>Oil changes and scheduled maintenance</li><li>A/C repair</li><li>Transmission service</li></ul><p>Every visit includes a digital vehicle inspection with photos sent by text.</p>`,
);
const CONTACT = page(
  "Contact | Saviers Road Auto Repair",
  `<h1>Contact us</h1><p>Email <a href="mailto:service@saviersauto.example.com">service@saviersauto.example.com</a></p><p>Call to schedule: (805) 555-0101</p>`,
);
const ABOUT = page("About | Saviers Road Auto Repair", `<h1>About us</h1><p>Our 4 ASE-certified technicians treat every car like their own.</p>`);

const goodSite = (extra: Record<string, Fixture | Fixture[]> = {}) => ({
  "https://saviersauto.example.com/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /admin/\n", contentType: "text/plain" },
  "https://saviersauto.example.com/": { body: HOME },
  "https://saviersauto.example.com/services": { body: SERVICES },
  "https://saviersauto.example.com/contact-us": { body: CONTACT },
  "https://saviersauto.example.com/about": { body: ABOUT },
  ...extra,
});

const fact = (r: { facts: { field: string }[] }, field: string) => r.facts.find((f) => f.field === field) as
  | { field: string; value: string | null; state: string; sourceUrl?: string | null; excerpt?: string | null; note?: string | null }
  | undefined;
const signal = (r: { signals: { key: string; value: string; sourceUrl: string; excerpt: string }[] }, key: string) => r.signals.find((s) => s.key === key);

describe("robots.txt", () => {
  const body = "User-agent: *\nDisallow: /private/\nAllow: /private/ok\nDisallow: /*.pdf$\n\nUser-agent: ReclaimBayResearch\nDisallow: /no-bots\n";
  test("our own group wins over *; longest rule wins; Allow on a tie", () => {
    const mine = parseRobots(body, "ReclaimBayResearch");
    assert.ok(!robotsAllows(mine, "/no-bots/x"));
    assert.ok(robotsAllows(mine, "/private/x"), "the * group doesn't apply when ours exists");
    const star = parseRobots(body, "SomeoneElse");
    assert.ok(!robotsAllows(star, "/private/x"));
    assert.ok(robotsAllows(star, "/private/ok"));
    assert.ok(!robotsAllows(star, "/files/menu.pdf"));
    assert.ok(robotsAllows(star, "/files/menu.pdf?x=1"), "$ anchors the end");
    assert.ok(robotsAllows(parseRobots("", "x"), "/anything"));
  });
});

describe("reading HTML", () => {
  test("title, site name, headings, tel/mailto links, JSON-LD; scripts and comments ignored", () => {
    const p = parseHtml(`<html><head><title>Bob&#39;s &amp; Sons</title><meta property="og:site_name" content="Bob's Garage">
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"AutoRepair","name":"Bob's Garage","telephone":"+1-805-555-0111","address":{"@type":"PostalAddress","streetAddress":"12 Main St","addressLocality":"Ventura","postalCode":"93001"}}</script>
      </head><body><!-- (805) 000-0000 --><h1>Welcome</h1><a href="tel:8055550111">Call</a><a href="mailto:Info@Bobs.example.com?subject=hi">Email</a>
      <a href="/about">About&nbsp;us</a><script>alert("(805) 999-9999")</script><p>Brakes &amp; more</p></body></html>`);
    assert.equal(p.title, "Bob's & Sons");
    assert.equal(p.siteName, "Bob's Garage");
    assert.deepEqual(p.headings, ["Welcome"]);
    assert.deepEqual(p.tels, ["8055550111"]);
    assert.deepEqual(p.emails, ["info@bobs.example.com"]);
    assert.deepEqual(p.links, [{ href: "/about", text: "About us" }]);
    assert.equal(p.structured[0]!.telephone, "+1-805-555-0111");
    assert.equal(p.structured[0]!.streetAddress, "12 Main St");
    assert.match(p.text, /Brakes & more/);
    assert.doesNotMatch(p.text, /999-9999|000-0000/);
  });
});

describe("researching an independent shop with its own website", () => {
  test("the website is verified and the evidence-backed signals follow the published rules", async () => {
    const s = server(goodSite());
    const r = await researchCandidate(subject(), s.fetcher(), TODAY);
    assert.equal(r.status, "completed");
    assert.equal(r.outcome, "website_verified");
    assert.ok(r.websiteVerified);
    assert.equal(r.pagesFetched, 4);

    assert.equal(fact(r, "website")!.state, "verified");
    assert.equal(fact(r, "business_name")!.state, "verified");
    assert.equal(fact(r, "address")!.state, "verified");
    assert.equal(fact(r, "phone")!.state, "verified");
    assert.equal(fact(r, "phone")!.value, "(805) 555-0101");
    assert.equal(fact(r, "provider_phone")!.state, "verified", "the provider phone is confirmed by the business's own site");
    assert.equal(fact(r, "email")!.value, "service@saviersauto.example.com");
    assert.equal(fact(r, "business_type")!.value, "independent");

    assert.equal(signal(r, "independent_shop")!.value, "yes");
    assert.match(signal(r, "independent_shop")!.excerpt, /Family owned/);
    assert.equal(signal(r, "general_repair_services")!.value, "yes");
    assert.equal(signal(r, "digital_inspections")!.value, "yes");
    assert.equal(signal(r, "no_online_booking")!.value, "yes", "'call to schedule' is not online booking");
    assert.equal(signal(r, "website_not_https")!.value, "no");
    assert.equal(signal(r, "website_no_recent_date")!.value, "no", "© 2025 is within the last two calendar years");
    assert.equal(signal(r, "multiple_bays_or_staff")!.value, "yes");
    for (const sig of r.signals) {
      assert.match(sig.sourceUrl, /^https:\/\/saviersauto\.example\.com\//, `${sig.key} cites the business's site`);
      assert.ok(sig.excerpt.length > 0 && sig.excerpt.length <= 280, `${sig.key} has a short excerpt`);
    }

    assert.deepEqual(r.contact, {
      phone: "(805) 555-0101",
      phoneSourceUrl: "https://saviersauto.example.com/",
      email: "service@saviersauto.example.com",
      emailSourceUrl: "https://saviersauto.example.com/contact-us",
    });
  });

  test("polite: robots.txt is read once, requests to a host are spaced, no more than the page cap", async () => {
    const links = Array.from({ length: 30 }, (_, i) => `<a href="/service-${i}">Service ${i}</a>`).join("");
    const s = server(goodSite({ "https://saviersauto.example.com/": { body: HOME.replace("<nav>", `<nav>${links}`) } }));
    const r = await researchCandidate(subject(), s.fetcher(), TODAY);
    assert.equal(s.calls.filter((u) => u.endsWith("/robots.txt")).length, 1);
    assert.ok(r.pagesFetched <= RESEARCH_LIMITS.maxPages);
    assert.ok(s.calls.length <= RESEARCH_LIMITS.maxPages + 1);
    assert.ok(s.slept.every((ms) => ms <= RESEARCH_LIMITS.perHostDelayMs));
    assert.ok(s.slept.length >= r.pagesFetched - 1, "requests to the same host waited between them");
    assert.ok(r.sources.every((src) => src.url.length <= 500));
  });

  test("an old copyright, an online booking link, and a small shop set the other values", async () => {
    const home = HOME.replace("© 2025", "© 2019").replace("Our 6 service bays", "Our 2 bays").replace("<nav>", `<nav><a href="https://shopmonkey.example/book">Book an appointment</a>`);
    const s = server(goodSite({ "https://saviersauto.example.com/": { body: home }, "https://saviersauto.example.com/about": { body: page("About", "<h1>About</h1>") } }));
    const r = await researchCandidate(subject(), s.fetcher(), TODAY);
    assert.equal(signal(r, "website_no_recent_date")!.value, "yes");
    assert.match(signal(r, "website_no_recent_date")!.excerpt, /2019/);
    assert.equal(signal(r, "no_online_booking")!.value, "no");
    assert.equal(signal(r, "multiple_bays_or_staff")!.value, "no");
  });
});

describe("chains, dealers, and specialty shops", () => {
  test("a franchise brand on the site makes independent_shop 'no', with the brand as evidence", async () => {
    const s = server(
      goodSite({
        "https://saviersauto.example.com/": {
          body: HOME.replace(/<title>[^<]*<\/title>/, "<title>Jiffy Lube Oil Change | Saviers Road Auto Repair</title>").replace("Family owned and operated since 1988.", ""),
        },
      }),
    );
    const r = await researchCandidate(subject({ providerBrand: "Jiffy Lube" }), s.fetcher(), TODAY);
    assert.equal(signal(r, "independent_shop")!.value, "no");
    assert.match(signal(r, "independent_shop")!.excerpt, /jiffy lube/i);
    assert.equal(fact(r, "business_type")!.value, "chain or franchise");
  });

  test("a dealership (make + new-vehicle wording) is not independent", async () => {
    const home = page(
      "Saviers Road Auto Repair | Toyota Service Center",
      `<h1>Saviers Road Auto Repair</h1><p>Shop new vehicles and certified pre-owned Toyota models.</p><p>(805) 555-0101 · 5577 Saviers Rd</p>`,
    );
    const s = server(goodSite({ "https://saviersauto.example.com/": { body: home } }));
    const r = await researchCandidate(subject(), s.fetcher(), TODAY);
    assert.equal(signal(r, "independent_shop")!.value, "no");
    assert.match(signal(r, "independent_shop")!.excerpt, /Dealership \(toyota\)/i);
  });

  test("a body shop with only specialty services fails 'Offers general repair'", async () => {
    const home = page("Saviers Road Auto Repair", `<h1>Saviers Road Auto Repair</h1><p>Collision repair, auto body and paint, windshield replacement.</p><p>(805) 555-0101</p>`);
    const s = server({
      "https://saviersauto.example.com/robots.txt": { status: 404 },
      "https://saviersauto.example.com/": { body: home },
    });
    const r = await researchCandidate(subject(), s.fetcher(), TODAY);
    assert.equal(signal(r, "general_repair_services")!.value, "no");
    assert.equal(fact(r, "performs_repair")!.value, "no");
  });

  test("no ownership statement and no brand: independence stays unknown, never assumed", async () => {
    const s = server(goodSite({ "https://saviersauto.example.com/": { body: HOME.replace("Family owned and operated since 1988.", "") } }));
    const r = await researchCandidate(subject(), s.fetcher(), TODAY);
    assert.equal(signal(r, "independent_shop"), undefined);
    assert.equal(fact(r, "business_type")!.state, "uncertain");
  });
});

describe("unverified, uncertain, and conflicting information", () => {
  test("no website: nothing is fetched, the provider phone stays unverified, and the gap is explicit", async () => {
    const s = server({});
    const r = await researchCandidate(subject({ website: null }), s.fetcher(), TODAY);
    assert.equal(s.calls.length, 0);
    assert.deepEqual([r.status, r.outcome], ["completed", "no_website"]);
    assert.equal(fact(r, "website")!.state, "not_found");
    assert.equal(fact(r, "provider_phone")!.state, "unverified");
    assert.deepEqual(r.signals, []);
    assert.deepEqual(r.contact, {});
  });

  test("a listing or social page is not a website to research", async () => {
    const s = server({});
    const r = await researchCandidate(subject({ website: "https://www.facebook.com/saviersauto" }), s.fetcher(), TODAY);
    assert.equal(r.outcome, "no_website");
    assert.equal(s.calls.length, 0);
  });

  test("a website belonging to another business is flagged; nothing from it is used", async () => {
    const other = page("Sparkle Car Wash", "<h1>Sparkle Car Wash</h1><p>Call (805) 555-7777 · 9 Other St</p>");
    const s = server({ "https://saviersauto.example.com/robots.txt": { status: 404 }, "https://saviersauto.example.com/": { body: other } });
    const r = await researchCandidate(subject(), s.fetcher(), TODAY);
    assert.equal(r.outcome, "website_mismatch");
    assert.ok(!r.websiteVerified);
    assert.deepEqual(r.signals, []);
    assert.deepEqual(r.contact, {}, "the site's phone is not verified contact");
    assert.equal(fact(r, "phone")!.state, "uncertain");
    assert.equal(fact(r, "provider_phone")!.state, "uncertain", "the site lists a different number");
    assert.ok(r.warnings.some((w) => /doesn't appear to belong/.test(w)));
  });

  test("the name alone is not enough to verify a website", async () => {
    const thin = page("Saviers Road Auto Repair", "<h1>Saviers Road Auto Repair</h1><p>Coming soon.</p>");
    const s = server({ "https://saviersauto.example.com/robots.txt": { status: 404 }, "https://saviersauto.example.com/": { body: thin } });
    const r = await researchCandidate(subject(), s.fetcher(), TODAY);
    assert.equal(r.outcome, "website_unconfirmed");
    assert.deepEqual(r.signals, []);
    assert.deepEqual(r.contact, {});
    assert.equal(fact(r, "phone")!.state, "not_found");
    assert.equal(fact(r, "provider_phone")!.state, "unverified");
  });

  test("conflicting phones: the site's own number is verified, the provider's is flagged as disagreeing", async () => {
    const home = HOME.replace(/\(805\) 555-0101/g, "(805) 555-0202").replace("tel:+18055550101", "tel:+18055550202");
    const contact = CONTACT.replace("(805) 555-0101", "(805) 555-0202");
    const s = server(goodSite({ "https://saviersauto.example.com/": { body: home }, "https://saviersauto.example.com/contact-us": { body: contact } }));
    const r = await researchCandidate(subject(), s.fetcher(), TODAY);
    assert.equal(r.outcome, "website_verified", "name and street address confirm the site");
    assert.equal(fact(r, "phone")!.value, "(805) 555-0202");
    assert.equal(fact(r, "phone")!.state, "verified");
    assert.equal(fact(r, "provider_phone")!.state, "uncertain");
    assert.equal(r.contact.phone, "(805) 555-0202");
    assert.ok(r.warnings.some((w) => /provider's phone is not on the website/.test(w)));
  });

  test("no phone and no email on the site: both are 'not found', and no contact is invented", async () => {
    const home = page("Saviers Road Auto Repair", "<h1>Saviers Road Auto Repair</h1><p>5577 Saviers Rd, Oxnard. Brakes and oil changes.</p>");
    const s = server({ "https://saviersauto.example.com/robots.txt": { status: 404 }, "https://saviersauto.example.com/": { body: home } });
    const r = await researchCandidate(subject({ providerPhone: null }), s.fetcher(), TODAY);
    assert.equal(r.outcome, "website_verified");
    assert.equal(fact(r, "phone")!.state, "not_found");
    assert.equal(fact(r, "email")!.state, "not_found");
    assert.deepEqual(r.contact, {});
  });

  test("an email on a free mail service is never recorded (it may be personal)", async () => {
    const contact = CONTACT.replace(/service@saviersauto\.example\.com/g, "bob.smith@gmail.com");
    const s = server(goodSite({ "https://saviersauto.example.com/contact-us": { body: contact } }));
    const r = await researchCandidate(subject(), s.fetcher(), TODAY);
    assert.equal(fact(r, "email")!.state, "uncertain");
    assert.equal(fact(r, "email")!.value, null);
    assert.equal(r.contact.email, undefined);
    assert.doesNotMatch(JSON.stringify(r), /bob\.smith/);
  });

  test("a site saying it has closed is reported, not trusted as a status", async () => {
    const s = server(goodSite({ "https://saviersauto.example.com/about": { body: page("About", "<h1>About</h1><p>After 30 years we have closed our doors for good.</p>") } }));
    const r = await researchCandidate(subject(), s.fetcher(), TODAY);
    assert.deepEqual([fact(r, "operating_status")!.value, fact(r, "operating_status")!.state], ["closed", "uncertain"]);
    assert.ok(r.warnings.some((w) => /has closed/.test(w)));
  });
});

describe("failures, retries, and robots.txt", () => {
  test("an unreachable site fails the run; DNS errors are not retried", async () => {
    const s = server({ "https://saviersauto.example.com/robots.txt": { status: 404 }, "https://saviersauto.example.com/": { error: "dns" } });
    const r = await researchCandidate(subject(), s.fetcher(), TODAY);
    assert.deepEqual([r.status, r.outcome], ["failed", "website_unreachable"]);
    assert.match(r.error!, /could not be read/);
    assert.equal(s.calls.filter((u) => u === "https://saviersauto.example.com/").length, 1);
    assert.equal(fact(r, "provider_phone")!.state, "unverified");
  });

  test("a server error is retried exactly once", async () => {
    const s = server(goodSite({ "https://saviersauto.example.com/": [{ status: 503, body: "busy" }, { body: HOME }] }));
    const r = await researchCandidate(subject(), s.fetcher(), TODAY);
    assert.equal(r.outcome, "website_verified");
    assert.equal(s.calls.filter((u) => u === "https://saviersauto.example.com/").length, 2);
    assert.ok(s.slept.includes(RESEARCH_LIMITS.retryDelayMs));
  });

  test("a persistent server error stops after one retry", async () => {
    const s = server({ "https://saviersauto.example.com/robots.txt": { status: 404 }, "https://saviersauto.example.com/": { status: 503, body: "down" } });
    const r = await researchCandidate(subject({ website: "https://saviersauto.example.com/" }), s.fetcher(), TODAY);
    assert.equal(r.status, "failed");
    assert.equal(s.calls.filter((u) => u === "https://saviersauto.example.com/").length, 2);
  });

  test("a site that disallows crawling is not read at all", async () => {
    const s = server({ "https://saviersauto.example.com/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /\n" } });
    const r = await researchCandidate(subject(), s.fetcher(), TODAY);
    assert.deepEqual([r.status, r.outcome], ["completed", "robots_disallowed"]);
    assert.deepEqual(s.calls, ["https://saviersauto.example.com/robots.txt"]);
  });

  test("an unreachable robots.txt (server error) means the site is skipped, to be safe", async () => {
    const s = server({ "https://saviersauto.example.com/robots.txt": { status: 500, body: "" } });
    const r = await researchCandidate(subject(), s.fetcher(), TODAY);
    assert.equal(r.outcome, "robots_disallowed");
    assert.ok(!s.calls.includes("https://saviersauto.example.com/"));
  });

  test("an http-only site with a broken certificate sets website_not_https 'yes'", async () => {
    const http = Object.fromEntries(Object.entries(goodSite()).map(([k, v]) => [k.replace("https://", "http://"), v]));
    const s = server({ ...http, "https://saviersauto.example.com/robots.txt": { status: 404 }, "https://saviersauto.example.com/": { error: "tls" } });
    const r = await researchCandidate(subject({ website: "http://saviersauto.example.com/" }), s.fetcher(), TODAY);
    assert.equal(signal(r, "website_not_https")!.value, "yes");
  });

  test("a non-HTML response is not read as a page", async () => {
    const s = server({ "https://saviersauto.example.com/robots.txt": { status: 404 }, "https://saviersauto.example.com/": { body: "%PDF", contentType: "application/pdf" } });
    const r = await researchCandidate(subject(), s.fetcher(), TODAY);
    assert.equal(r.outcome, "website_unreachable");
    assert.match(r.sources.find((x) => x.kind === "website")!.note!, /not an HTML page/);
  });
});

/* Regression cases from the first real validation run (Ventura County, 2026-10-01). */
describe("real-data regressions", () => {
  test("a domain that no longer resolves is 'unreachable' (a failed run), not 'disallowed'", async () => {
    const s = server({ "https://saviersauto.example.com/robots.txt": { error: "dns" } });
    const r = await researchCandidate(subject(), s.fetcher(), TODAY);
    assert.deepEqual([r.status, r.outcome], ["failed", "website_unreachable"]);
    assert.ok(!s.calls.includes("https://saviersauto.example.com/"), "nothing more is requested from a site that can't be reached");
  });

  test("'Digital Technician Video Inspection' counts as digital inspections", async () => {
    const services = SERVICES.replace("Every visit includes a digital vehicle inspection with photos sent by text.", "Get a Digital Technician Video Inspection, sent directly to your phone.");
    const s = server(goodSite({ "https://saviersauto.example.com/services": { body: services } }));
    const r = await researchCandidate(subject(), s.fetcher(), TODAY);
    assert.equal(signal(r, "digital_inspections")!.value, "yes");
  });

  test("only a service-booking action counts as online booking; a test drive or an FAQ link does not", async () => {
    const run = async (links: string) => {
      const s = server(goodSite({ "https://saviersauto.example.com/": { body: HOME.replace("<nav>", `<nav>${links}`) } }));
      return signal(await researchCandidate(subject(), s.fetcher(), TODAY), "no_online_booking")!.value;
    };
    assert.equal(await run(`<a href="/test-drive">Schedule Test Drive</a><a href="/faq/x">Do fleet managers need to make appointments ahead of time?</a>`), "yes");
    assert.equal(await run(`<a href="/serviceappmt.aspx">Service</a>`), "no", "a booking URL path");
    assert.equal(await run(`<a href="/go">Book an Appointment</a>`), "no", "a booking action");
    assert.equal(await run(`<a href="/contact-us">Request a Quote</a>`), "yes", "a quote request is not booking");
  });
});
