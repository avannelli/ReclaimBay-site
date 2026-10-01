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
    assert.deepEqual([r.status, r.outcome], ["completed", "access_blocked"], "a robots.txt block is 'automated access blocked'");
    assert.deepEqual(s.calls, ["https://saviersauto.example.com/robots.txt"]);
  });

  test("an unreachable robots.txt (server error) means the site is skipped, to be safe", async () => {
    const s = server({ "https://saviersauto.example.com/robots.txt": { status: 500, body: "" } });
    const r = await researchCandidate(subject(), s.fetcher(), TODAY);
    assert.equal(r.outcome, "access_blocked");
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

/*
 * Refinements from the 10-candidate real-data batch (2026-10-01):
 * dealership evidence, the phone of this location, and blocked sites.
 */

const siteWith = (home: string): Record<string, Fixture> => ({
  "https://saviersauto.example.com/robots.txt": { status: 404 },
  "https://saviersauto.example.com/": { body: home },
});

describe("dealership evidence", () => {
  const verify = "<p>(805) 555-0101 · 5577 Saviers Rd, Oxnard</p>";
  const run = async (title: string, body: string, name = "Saviers Road Auto Repair") => {
    const s = server(siteWith(page(title, `<h1>${name}</h1>${verify}${body}`)));
    return researchCandidate(subject({ businessName: name }), s.fetcher(), TODAY);
  };

  test("HOUSE Automotive: an independent Porsche specialist comparing itself to a dealership is not a dealership", async () => {
    const r = await run(
      "HOUSE Automotive | Independent Porsche Service Center",
      "<p>Whatever your Porsche needs, we handle it. At HOUSE you get the tools, training, and genuine parts of a dealership, without the dealership price.</p>",
      "HOUSE Automotive",
    );
    assert.equal(r.outcome, "website_verified");
    assert.notEqual(fact(r, "business_type")!.value, "dealership");
    assert.equal(signal(r, "independent_shop")!.value, "yes", "explicit independent-shop language is respected");
    assert.match(signal(r, "independent_shop")!.excerpt, /Independent Porsche Service Center/);
    assert.ok(signal(r, "independent_shop")!.sourceUrl.startsWith("https://saviersauto.example.com/"), "the quote keeps its source");
  });

  test("an independent brand specialist that mentions dealerships stays independent", async () => {
    const r = await run("Saviers Road Auto Repair | Independent BMW repair", "<p>Dealer-level service at independent prices. Skip the trip to the dealership.</p>");
    assert.equal(signal(r, "independent_shop")!.value, "yes");
    assert.notEqual(fact(r, "business_type")!.value, "dealership");
  });

  test("'independent Mercedes service' is an independence statement despite the make in between", async () => {
    const r = await run("Saviers Road Auto Repair", "<p>Your independent Mercedes service specialists since 1990.</p>");
    assert.equal(signal(r, "independent_shop")!.value, "yes");
  });

  test("an actual dealership (new inventory, certified pre-owned, test drives) is not independent", async () => {
    const r = await run("Saviers Road Auto Repair | Toyota of Oxnard", "<p>Browse our new inventory and certified pre-owned vehicles. Schedule a test drive today.</p>");
    assert.equal(signal(r, "independent_shop")!.value, "no");
    assert.match(signal(r, "independent_shop")!.excerpt, /^Dealership \(toyota\): /i, "the make is only a label on the evidence");
    assert.equal(fact(r, "business_type")!.value, "dealership");
  });

  test("a business identifying itself as a dealer is a dealership", async () => {
    const r = await run("Saviers Road Auto Repair", "<p>We are your local Chevrolet dealer serving Oxnard.</p>");
    assert.equal(signal(r, "independent_shop")!.value, "no");
  });

  test("a make in the title alone is not a dealership, and independence stays unknown", async () => {
    const r = await run("Saviers Road Auto Repair | Honda & Acura Repair Oxnard", "<p>Honda and Acura repair, brakes, and maintenance.</p>");
    assert.equal(signal(r, "independent_shop"), undefined, "neither dealer nor independent is established");
    assert.equal(fact(r, "business_type")!.state, "uncertain");
  });

  test("the word 'dealership' in a comparison is never dealer evidence", async () => {
    for (const body of [
      "<p>Better than the dealership, at half the price.</p>",
      "<p>Unlike a dealership, we explain every repair.</p>",
      "<p>A trusted alternative to the dealership for over 20 years.</p>",
      "<p>Dealership quality without the dealership price.</p>",
    ]) {
      const r = await run("Saviers Road Auto Repair", body);
      assert.notEqual(fact(r, "business_type")!.value, "dealership", body);
      assert.notEqual(signal(r, "independent_shop")?.value, "no", body);
    }
  });

  test("independence and dealer activity on the same site: uncertain, not guessed", async () => {
    const r = await run("Saviers Road Auto Repair | Independent Ford Service", "<p>Shop our new inventory and certified pre-owned trucks.</p>");
    assert.equal(signal(r, "independent_shop"), undefined);
    assert.equal(fact(r, "business_type")!.state, "uncertain");
  });
});

describe("the phone of this location", () => {
  const name = "<h1>Saviers Road Auto Repair</h1>";
  const filler = "<p>" + "Quality repairs for every make and model. ".repeat(20) + "</p>";
  const home = (body: string, head = "") => siteWith(page("Saviers Road Auto Repair", `${name}${body}`, head));

  test("the provider's number, when the site lists it, is verified as before", async () => {
    const s = server(home(`<p>Call (877) 555-0000 or (805) 555-0101. 5577 Saviers Rd.</p>`));
    const r = await researchCandidate(subject(), s.fetcher(), TODAY);
    assert.equal(r.contact.phone, "(805) 555-0101");
    assert.equal(fact(r, "phone")!.state, "verified");
    assert.match(fact(r, "phone")!.note!, /provider-reported number/);
  });

  test("multi-location site: the phone next to this location's address wins over the central toll-free number", async () => {
    const s = server(
      home(
        `<p>Call (866) 656-5307 for all locations.</p>${filler}<p>Ventura: 9 Main St, (805) 555-0201</p>${filler}<p>Oxnard: 5577 Saviers Rd · (805) 555-0303</p>${filler}<p>Thousand Oaks: 3 Oak Ave · (805) 555-0404</p>`,
      ),
    );
    const r = await researchCandidate(subject({ providerPhone: "+18059990000" }), s.fetcher(), TODAY);
    assert.equal(r.outcome, "website_verified");
    assert.equal(r.contact.phone, "(805) 555-0303");
    assert.match(fact(r, "phone")!.note!, /next to this location's street address/);
  });

  test("HOUSE Automotive: side-by-side location cards; the number by this address in this area code is chosen", async () => {
    const s = server(
      home(
        `<p>Call (866) 656-5307.</p>${filler}<div>Encino 16101 Ventura Blvd Encino, CA 91436 Mon–Fri: 8AM – 5PM (818) 403-3904 4.9 • 577 reviews</div>` +
          `<div>Oxnard 5577 Saviers Rd Oxnard, CA 93033 Mon–Fri: 8AM – 5PM (805) 555-0303 4.9 • 223 reviews</div>${filler}<div>Pasadena (626) 740-3903 · (805) 929-1900 fleet line</div>`,
      ),
    );
    const r = await researchCandidate(subject({ providerPhone: "+18056789769" }), s.fetcher(), TODAY);
    assert.equal(r.contact.phone, "(805) 555-0303", "not the central toll-free number and not the neighbouring location's");
    assert.match(fact(r, "phone")!.note!, /area code next to its street address/);
  });

  test("two numbers next to the address and none in this area code: uncertain, not the first", async () => {
    const s = server(home(`${filler}<div>Encino (818) 403-3904</div><div>5577 Saviers Rd (213) 555-0303</div>${filler}`));
    const r = await researchCandidate(subject({ providerPhone: "+18056789769" }), s.fetcher(), TODAY);
    assert.equal(r.contact.phone, undefined);
    assert.equal(fact(r, "phone")!.state, "uncertain");
  });

  test("a location's structured data with its address gives its phone", async () => {
    const ld = `<script type="application/ld+json">{"@type":"AutoRepair","name":"Saviers Road Auto Repair","telephone":"(805) 555-0505","address":{"streetAddress":"5577 Saviers Rd","addressLocality":"Oxnard"}}</script>`;
    const s = server(home(`<p>Call (877) 555-0000 or (805) 555-0606.</p>`, ld));
    const r = await researchCandidate(subject({ providerPhone: null }), s.fetcher(), TODAY);
    assert.equal(r.contact.phone, "(805) 555-0505");
    assert.match(fact(r, "phone")!.note!, /business data/);
  });

  test("the only number in this location's area code is chosen when nothing else ties a phone to it", async () => {
    const s = server(home(`<p>Call (877) 555-0000, (213) 555-0700 or (805) 555-0800.</p>${filler}${filler}<footer>5577 Saviers Rd, Oxnard</footer>`));
    const r = await researchCandidate(subject({ providerPhone: "+18059990000" }), s.fetcher(), TODAY);
    assert.equal(r.contact.phone, "(805) 555-0800");
    assert.match(fact(r, "phone")!.note!, /area code/);
  });

  test("a central toll-free number beside one local number: the local one is chosen, not the first", async () => {
    const s = server(home(`<p>Call (866) 656-5307 or (805) 555-0900.</p>${filler}${filler}<footer>5577 Saviers Rd</footer>`));
    const r = await researchCandidate(subject({ providerPhone: null }), s.fetcher(), TODAY);
    assert.equal(r.contact.phone, "(805) 555-0900");
    assert.match(fact(r, "phone")!.note!, /only local number/);
  });

  test("a site whose only number is toll-free: that is the business's published phone", async () => {
    const s = server(home(`<p>Call (866) 656-5307.</p><p>5577 Saviers Rd</p>`));
    const r = await researchCandidate(subject({ providerPhone: null }), s.fetcher(), TODAY);
    assert.equal(r.contact.phone, "(866) 656-5307");
  });

  test("several numbers and no tie to this location: no phone is guessed; it is uncertain and flagged", async () => {
    const s = server(home(`<p>(805) 555-1001 · (805) 555-1002 · (805) 555-1003 · (626) 555-1004</p>${filler}${filler}<footer>5577 Saviers Rd, Oxnard</footer>`));
    const r = await researchCandidate(subject({ providerPhone: "+18059990000" }), s.fetcher(), TODAY);
    assert.equal(r.outcome, "website_verified", "name and address still confirm the website");
    assert.equal(r.contact.phone, undefined);
    assert.equal(fact(r, "phone")!.state, "uncertain");
    assert.match(fact(r, "phone")!.value!, /\(805\) 555-1001/);
    assert.ok(r.warnings.some((w) => /none could be tied to this location/.test(w)));
    assert.notEqual(fact(r, "provider_phone")!.state, "verified", "the provider phone is not confirmed by another number");
  });

  test("two unrelated numbers, no provider phone, no address tie: uncertain", async () => {
    const s = server(home(`<p>(213) 555-2001 · (626) 555-2002</p>${filler}${filler}<footer>5577 Saviers Rd</footer>`));
    const r = await researchCandidate(subject({ providerPhone: null }), s.fetcher(), TODAY);
    assert.equal(r.contact.phone, undefined);
    assert.equal(fact(r, "phone")!.state, "uncertain");
  });
});

describe("blocked vs unreachable sites", () => {
  for (const status of [401, 403]) {
    test(`HTTP ${status}: automated access blocked, recorded clearly, no root retry, not dead and not a mismatch`, async () => {
      const s = server({
        "https://saviersauto.example.com/robots.txt": { status: 404 },
        "https://saviersauto.example.com/locations/oxnard": { status, body: "Forbidden" },
      });
      const r = await researchCandidate(subject({ website: "https://saviersauto.example.com/locations/oxnard" }), s.fetcher(), TODAY);
      assert.deepEqual([r.status, r.outcome, r.error], ["completed", "access_blocked", null]);
      assert.deepEqual(r.warnings, ["Website blocks automated access; verify manually."]);
      assert.ok(!s.calls.includes("https://saviersauto.example.com/"), "no root retry after a block");
      assert.equal(s.calls.filter((u) => u.endsWith("/oxnard")).length, 1, "a block is never retried");
      const src = r.sources.find((x) => x.kind === "website")!;
      assert.equal(src.httpStatus, status);
      assert.equal(src.note, `blocked: HTTP ${status} (automated access refused)`);
      assert.match(fact(r, "website")!.note!, new RegExp(`blocks automated access \\(HTTP ${status}\\)`));
      assert.equal(fact(r, "website")!.state, "uncertain");
    });
  }

  test("a robots.txt disallow is 'automated access blocked'", async () => {
    const s = server({ "https://saviersauto.example.com/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /\n" } });
    const r = await researchCandidate(subject(), s.fetcher(), TODAY);
    assert.deepEqual([r.status, r.outcome], ["completed", "access_blocked"]);
    assert.deepEqual(r.warnings, ["Website blocks automated access; verify manually."]);
    assert.match(fact(r, "website")!.note!, /its robots\.txt/);
  });

  test("a DNS failure on the page is 'unreachable' (a failed run), not blocked", async () => {
    const s = server({ "https://saviersauto.example.com/robots.txt": { status: 404 }, "https://saviersauto.example.com/": { error: "dns" } });
    const r = await researchCandidate(subject(), s.fetcher(), TODAY);
    assert.deepEqual([r.status, r.outcome], ["failed", "website_unreachable"]);
  });

  test("a timeout is 'unreachable' after one retry, and the root is not tried", async () => {
    const s = server({ "https://saviersauto.example.com/robots.txt": { status: 404 }, "https://saviersauto.example.com/shop/oxnard": { error: "timeout" } });
    const r = await researchCandidate(subject({ website: "https://saviersauto.example.com/shop/oxnard" }), s.fetcher(), TODAY);
    assert.deepEqual([r.status, r.outcome], ["failed", "website_unreachable"]);
    assert.equal(s.calls.filter((u) => u.endsWith("/shop/oxnard")).length, 2);
    assert.ok(!s.calls.includes("https://saviersauto.example.com/"));
  });

  test("a connection failure is 'unreachable'", async () => {
    const s = server({ "https://saviersauto.example.com/robots.txt": { status: 404 }, "https://saviersauto.example.com/": { error: "connection" } });
    const r = await researchCandidate(subject(), s.fetcher(), TODAY);
    assert.deepEqual([r.status, r.outcome], ["failed", "website_unreachable"]);
  });

  test("an ordinary 404 on a deep link still falls back to the site root", async () => {
    const s = server({ ...goodSite(), "https://saviersauto.example.com/old-page": { status: 404, body: "gone" } });
    const r = await researchCandidate(subject({ website: "https://saviersauto.example.com/old-page" }), s.fetcher(), TODAY);
    assert.equal(r.outcome, "website_verified");
    assert.ok(s.calls.includes("https://saviersauto.example.com/"));
  });
});

/* Batch #2 (2026-10-01): a numbered feature list read as a technician count. */
describe("bay and technician counts vs. numbered lists", () => {
  const run = async (body: string) => {
    const s = server(siteWith(page("Saviers Road Auto Repair", `<h1>Saviers Road Auto Repair</h1><p>(805) 555-0101 · 5577 Saviers Rd, Oxnard</p>${body}`)));
    const r = await researchCandidate(subject(), s.fetcher(), TODAY);
    assert.equal(r.outcome, "website_verified");
    return signal(r, "multiple_bays_or_staff");
  };

  test("Ojai Valley Imports: '03 ASE Certified Technicians' in a zero-padded list is not a count", async () => {
    const list = ["01 Locally Owned &amp; Operated Since 1979", "02 Premium Quality Automotive Parts", "03 ASE Certified Technicians", "04 3 6-Month / 36k-Mile Warranty", "05 ' Best of Ojai' Winner for 9 Years Running", "06 R eliable &amp; Transparent"];
    assert.equal(await run(`<p>Why choose a full-service Auto Repair Shop</p><ul>${list.map((x) => `<li>${x}</li>`).join("")}</ul>`), undefined);
  });

  test("a sequential numbered list without zero padding is not a count", async () => {
    assert.equal(await run(`<ol><li>1 Locally Owned</li><li>2 Premium Quality Parts</li><li>3 ASE Certified Technicians</li><li>4 Nationwide Warranty</li></ol>`), undefined);
    assert.equal(await run(`<h3>2 Honest Estimates</h3><h3>3 Certified Technicians</h3><h3>4 Fast Turnaround</h3>`), undefined, "a list starting mid-way");
  });

  for (const [text, quoted] of [
    ["<p>Our 3 technicians handle every make.</p>", "3 technicians"],
    ["<p>We have 4 ASE certified technicians on staff.</p>", "4 ASE certified technicians"],
    ["<p>5 ASE-certified technicians, one shop.</p>", "5 ASE-certified technicians"],
    ["<p>The shop has 3 service bays.</p>", "3 service bays"],
    ["<p>Since 1988 our team includes 6 technicians who handle everything from brakes to engines.</p>", "6 technicians"],
    ["<p>We run 3 service bays and 4 technicians, open 5 days a week.</p>", "3 service bays"],
  ] as const) {
    test(`a count statement still counts: "${quoted}"`, async () => {
      const s = await run(text);
      assert.equal(s?.value, "yes");
      assert.match(s!.excerpt, new RegExp(quoted));
      assert.equal(s!.sourceUrl, "https://saviersauto.example.com/");
    });
  }

  test("a real count after a numbered list is still found", async () => {
    const s = await run(`<ol><li>1 Honest Pricing</li><li>2 Certified Technicians</li><li>3 Fast Service</li></ol><p>Today our 7 technicians cover two shifts.</p>`);
    assert.equal(s?.value, "yes");
    assert.match(s!.excerpt, /7 technicians/);
  });

  test("a small count is still 'no', and number words still work", async () => {
    assert.equal((await run("<p>Our 2 bays keep things personal.</p>"))?.value, "no");
    assert.equal((await run("<p>Three master technicians on staff.</p>"))?.value, "yes");
  });
});

/* Production batch #1 (2026-10-01): "2180 1st St" (provider) vs "2180 First St" (website). */
describe("ordinal street names on the website", () => {
  const run = async (providerStreet: string, footer: string, name = "Saviers Road Auto Repair") => {
    const s = server(siteWith(page(name, `<h1>${name}</h1><p>Honest repairs since 1997.</p><footer>${footer}</footer>`)));
    return researchCandidate(subject({ businessName: name, streetAddress: providerStreet, providerPhone: null }), s.fetcher(), TODAY);
  };

  test("Perry's Quality Auto Repair: provider '2180 1st St', site '2180 First St, Suite C-10' match", async () => {
    const r = await run("2180 1st St", "2180 First St, Suite C-10, Simi Valley, CA 93065", "Perry's Quality Auto Repair");
    assert.equal(fact(r, "address")!.state, "verified");
    assert.match(fact(r, "address")!.excerpt!, /2180 First St/);
    assert.equal(r.outcome, "website_verified", "name + address now confirms the site");
  });

  test("the reverse: provider 'First', site '1st'", async () => {
    const r = await run("2180 First St", "2180 1st St, Simi Valley, CA 93065");
    assert.equal(fact(r, "address")!.state, "verified");
  });

  test("'123 12th Street' and '123 Twelfth Street' match", async () => {
    const r = await run("123 12th Street", "123 Twelfth Street, Oxnard, CA");
    assert.equal(fact(r, "address")!.state, "verified");
  });

  test("a different ordinal or house number still does not match", async () => {
    for (const footer of ["2180 Second St, Simi Valley", "2181 First St, Simi Valley"]) {
      const r = await run("2180 1st St", footer);
      assert.notEqual(fact(r, "address")!.state, "verified", footer);
      assert.equal(r.outcome, "website_unconfirmed", footer);
    }
  });

  test("structured data with an ordinal written as a word matches too", async () => {
    const ld = `<script type="application/ld+json">{"@type":"AutoRepair","name":"Saviers Road Auto Repair","telephone":"(805) 555-0505","address":{"streetAddress":"2180 First Street","addressLocality":"Simi Valley"}}</script>`;
    const s = server(siteWith(page("Saviers Road Auto Repair", "<h1>Saviers Road Auto Repair</h1><p>Call (805) 555-0505 or (805) 555-0606.</p>", ld)));
    const r = await researchCandidate(subject({ streetAddress: "2180 1st St", providerPhone: null }), s.fetcher(), TODAY);
    assert.equal(fact(r, "address")!.state, "verified");
  });
});

/* Production batch #2 (2026-10-01): parts-brand "Authorized Dealer" badges. */
describe("parts-brand 'Authorized Dealer' badges are not a vehicle dealership", () => {
  const run = async (title: string, body: string, name = "Saviers Road Auto Repair") => {
    const s = server(siteWith(page(title, `<h1>${name}</h1><p>(805) 555-0101 · 5577 Saviers Rd, Oxnard</p>${body}`)));
    return researchCandidate(subject({ businessName: name }), s.fetcher(), TODAY);
  };
  const BENDERS_BADGES =
    "<p>Part of a network of top-tier repair shops committed to premium lubricants and exceptional service standards.</p>" +
    "<ul><li>Xtreme Diesel Authorized Dealer</li><li>Skyjacker Authorized Dealer</li><li>Rough Country Authorized Dealer</li><li>O'Reilly Auto Parts Warranty Partner</li></ul>";

  test("Bender's Automotive: the exact badges are not dealership evidence", async () => {
    const r = await run("Bender's Automotive | Thousand Oaks", BENDERS_BADGES, "Bender's Automotive");
    assert.equal(r.outcome, "website_verified");
    assert.notEqual(signal(r, "independent_shop")?.value, "no");
    assert.notEqual(fact(r, "business_type")!.value, "dealership");
  });

  test("the badges with an independence statement: independent", async () => {
    const r = await run("Saviers Road Auto Repair", `<p>Family owned since 1984.</p>${BENDERS_BADGES}`);
    assert.equal(signal(r, "independent_shop")!.value, "yes");
  });

  test("'we are an authorized Rough Country dealer' is not a vehicle dealership", async () => {
    const r = await run("Saviers Road Auto Repair", "<p>We are an authorized Rough Country dealer and installer.</p>");
    assert.notEqual(signal(r, "independent_shop")?.value, "no");
  });

  for (const text of [
    "<p>Your authorized Toyota dealer in Oxnard.</p>",
    "<p>The official Ford dealership for Ventura County.</p>",
    "<p>Subaru Authorized Dealer</p>",
    "<p>An authorized new car dealer since 1975.</p>",
    "<p>We are your local Chevrolet dealer.</p>",
    "<p>Kirby is a trusted auto dealer for Ventura drivers.</p>",
  ]) {
    test(`a genuine vehicle dealer is still a dealership: ${text.replace(/<[^>]+>/g, "")}`, async () => {
      const r = await run("Saviers Road Auto Repair", text);
      assert.equal(signal(r, "independent_shop")?.value, "no");
      assert.equal(fact(r, "business_type")!.value, "dealership");
    });
  }
});

/* Production batch #2 (2026-10-01): a confirmed site giving another address than the provider. */
describe("a confirmed website that gives a different address", () => {
  const ld = (o: object) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
  const pops = (address: object, extra = "") =>
    server(
      siteWith(
        page(
          "Auto Repair Fillmore, CA - Expert Mechanics - Pops Auto Repair",
          `<h1>Pops Auto Repair</h1><p>Call 805-873-2610</p>${extra}`,
          ld({ "@type": "AutoRepair", name: "Pops Auto Repair", telephone: "805-873-2610", address }),
        ),
      ),
    );
  const POPS = subject({ businessName: "Pops Auto Repair", streetAddress: "17958 E Telegraph Rd", city: "Santa Paula", state: "CA", postalCode: "93060", providerPhone: "+18058732610" });
  const discrepancy = (w: string[]) => w.filter((x) => /gives a different business address/.test(x));

  test("Pops Auto Repair: provider 17958 E Telegraph Rd, Santa Paula; site 665 Ventura St, Fillmore", async () => {
    const r = await researchCandidate(POPS, pops({ streetAddress: "665 Ventura St", addressLocality: "Fillmore", addressRegion: "CA", postalCode: "93015" }).fetcher(), TODAY);
    assert.equal(r.outcome, "website_verified", "a different address does not undo ownership");
    const [w] = discrepancy(r.warnings);
    assert.ok(w, "a warning is shown");
    assert.match(w!, /665 Ventura St, Fillmore 93015/);
    assert.match(w!, /17958 E Telegraph Rd, Santa Paula, CA 93060/);
    assert.match(w!, /Verify the current location by hand/);
    assert.equal(discrepancy(r.warnings).length, 1);
    const a = fact(r, "address")!;
    assert.deepEqual([a.value, a.state], ["17958 E Telegraph Rd", "unverified"], "the provider address is not replaced");
    assert.equal(signal(r, "independent_shop"), undefined, "no signal comes from the address");
  });

  test("the same address: no warning (and the address is verified)", async () => {
    const r = await researchCandidate(POPS, pops({ streetAddress: "17958 East Telegraph Road", addressLocality: "Santa Paula" }).fetcher(), TODAY);
    assert.equal(fact(r, "address")!.state, "verified");
    assert.deepEqual(discrepancy(r.warnings), []);
  });

  test("an ordinal or abbreviation written differently: no warning", async () => {
    for (const [provider, site] of [
      ["2180 1st St", "2180 First Street, Suite C-10"],
      ["1200 East Thousand Oaks Boulevard", "1200 E. Thousand Oaks Blvd #4"],
    ]) {
      const r = await researchCandidate({ ...POPS, streetAddress: provider! }, pops({ streetAddress: site }).fetcher(), TODAY);
      assert.deepEqual(discrepancy(r.warnings), [], `${provider} / ${site}`);
    }
  });

  test("a site that isn't confirmed: no discrepancy warning", async () => {
    const r = await researchCandidate({ ...POPS, providerPhone: "+18059990000" }, server(
      siteWith(page("Pops Auto Repair", "<h1>Pops Auto Repair</h1>", ld({ "@type": "AutoRepair", name: "Pops Auto Repair", address: { streetAddress: "665 Ventura St" } }))),
    ).fetcher(), TODAY);
    assert.equal(r.outcome, "website_unconfirmed");
    assert.deepEqual(discrepancy(r.warnings), []);
  });

  test("a site that belongs to another business: no discrepancy warning", async () => {
    const r = await researchCandidate(POPS, server(
      siteWith(page("Valley Glass", "<h1>Valley Glass</h1><p>(805) 555-7777</p>", ld({ "@type": "LocalBusiness", name: "Valley Glass", telephone: "(805) 555-7777", address: { streetAddress: "12 Main St" } }))),
    ).fetcher(), TODAY);
    assert.equal(r.outcome, "website_mismatch");
    assert.deepEqual(discrepancy(r.warnings), []);
  });

  test("several locations in the site's data, or another organization's address: no warning", async () => {
    const multi = server(
      siteWith(
        page(
          "Pops Auto Repair",
          "<h1>Pops Auto Repair</h1><p>Call 805-873-2610</p>",
          ld([
            { "@type": "AutoRepair", name: "Pops Auto Repair Fillmore", telephone: "805-873-2610", address: { streetAddress: "665 Ventura St" } },
            { "@type": "AutoRepair", name: "Pops Auto Repair Piru", address: { streetAddress: "400 Main St" } },
          ]),
        ),
      ),
    );
    assert.deepEqual(discrepancy((await researchCandidate(POPS, multi.fetcher(), TODAY)).warnings), [], "multi-location");
    const agency = pops({ streetAddress: "17958 E Telegraph Rd" }, ld({ "@type": "Organization", name: "Web Wizards Agency", telephone: "(213) 555-0000", address: { streetAddress: "1 Market St" } }));
    assert.deepEqual(discrepancy((await researchCandidate(POPS, agency.fetcher(), TODAY)).warnings), [], "the site builder's address is not the business's");
  });
});

/* Production batch #3 (2026-10-01): the HTTPS robots.txt itself fails the certificate check. */
describe("HTTPS check when https://…/robots.txt fails", () => {
  const httpSite = () => Object.fromEntries(Object.entries(goodSite()).map(([k, v]) => [k.replace("https://", "http://"), v]));
  const run = async (httpsRobots: Fixture, httpsHome?: Fixture) => {
    const s = server({ ...httpSite(), "https://saviersauto.example.com/robots.txt": httpsRobots, ...(httpsHome ? { "https://saviersauto.example.com/": httpsHome } : {}) });
    const r = await researchCandidate(subject({ website: "http://saviersauto.example.com/" }), s.fetcher(), TODAY);
    return { r, s, check: r.sources.find((x) => x.kind === "https_check")! };
  };

  test("S P Tune Up Center: a certificate error on HTTPS robots.txt means website_not_https 'yes'", async () => {
    const { r, s, check } = await run({ error: "tls" });
    assert.equal(r.outcome, "website_verified", "ownership is unaffected");
    assert.equal(signal(r, "website_not_https")!.value, "yes");
    assert.deepEqual([check.ok, check.note], [false, "certificate error over HTTPS"]);
    assert.ok(!s.calls.includes("https://saviersauto.example.com/"), "the certificate already failed: no second HTTPS request");
  });

  for (const error of ["dns", "connection", "timeout"]) {
    test(`a ${error} failure on HTTPS robots.txt stays 'HTTPS unreachable' (unknown)`, async () => {
      const { r, check } = await run({ error });
      assert.equal(signal(r, "website_not_https"), undefined);
      assert.equal(check.note, "HTTPS unreachable");
    });
  }

  test("HTTPS robots.txt 404 with a valid HTTPS home page: secure ('no')", async () => {
    const { r, check } = await run({ status: 404 }, { body: HOME });
    assert.equal(signal(r, "website_not_https")!.value, "no");
    assert.equal(check.note, "loads over HTTPS");
  });
});
