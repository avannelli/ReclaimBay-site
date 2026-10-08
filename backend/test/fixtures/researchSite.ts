/*
 * Fixture websites for research tests: an in-memory HttpGet, so no test
 * touches the network. All businesses and domains are synthetic.
 */
import type { HttpGet, HttpResult } from "@avannelli/aos/fetch";
import { researchFetcher } from "../../src/research/fetcher.js";

export type Fixture = Partial<HttpResult> & { body?: string };

export function fixtureWeb(routes: Record<string, Fixture | Fixture[]>) {
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
  const makeFetcher = () => researchFetcher({ get, sleep: async () => undefined });
  return { get, calls, makeFetcher };
}

export const page = (title: string, body: string, head = "") =>
  `<!doctype html><html><head><title>${title}</title>${head}</head><body><nav><a href="/contact-us">Contact Us</a> <a href="/services">Our Services</a> <a href="/about">About</a></nav>${body}</body></html>`;

/** A clear independent hybrid collision/mechanical shop at https://saviersauto.example.com. */
export function independentShop(host = "saviersauto.example.com", phone = "(805) 555-0101") {
  const digits = phone.replace(/\D/g, "");
  const origin = `https://${host}`;
  return {
    [`${origin}/robots.txt`]: { status: 200, body: "User-agent: *\nDisallow: /admin/\n", contentType: "text/plain" },
    [`${origin}/`]: {
      body: page(
        "Saviers Road Auto Repair | Oxnard Auto Repair",
        `<h1>Saviers Road Auto Repair</h1><p>Family owned and operated since 1988. Our 6 service bays are open Monday to Friday.</p>
         <p>Call <a href="tel:+1${digits}">${phone}</a> · 5577 Saviers Rd, Oxnard, CA 93033</p><footer>© 2025 Saviers Road Auto Repair</footer>`,
      ),
    },
    [`${origin}/services`]: {
      body: page(
        "Services",
        "<h1>Our Services</h1><ul><li>We provide collision repair.</li><li>Brake repair</li><li>Check engine diagnostics</li><li>Oil changes and scheduled maintenance</li><li>A/C repair</li></ul><p>Every visit includes a digital vehicle inspection with photos.</p>",
      ),
    },
    [`${origin}/contact-us`]: { body: page("Contact", `<h1>Contact</h1><p><a href="mailto:service@${host}">service@${host}</a></p>`) },
    [`${origin}/about`]: { body: page("About", "<h1>About</h1><p>Our 4 ASE-certified technicians.</p>") },
  } satisfies Record<string, Fixture>;
}
