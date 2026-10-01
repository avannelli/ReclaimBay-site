/*
 * Reads the few things research needs from an HTML page, without a DOM:
 * title, site name, headings, links, tel:/mailto: links, visible text, and
 * schema.org JSON-LD business data. Tolerant of messy markup; nothing here
 * executes or fetches anything. The page itself is never stored.
 */

export interface PageLink {
  href: string;
  text: string;
}

/** schema.org data a business site may embed (LocalBusiness, AutoRepair, ...). */
export interface StructuredBusiness {
  types: string[];
  name: string | null;
  telephone: string | null;
  email: string | null;
  streetAddress: string | null;
  locality: string | null;
  postalCode: string | null;
}

export interface ParsedPage {
  title: string | null;
  siteName: string | null;
  headings: string[];
  links: PageLink[];
  tels: string[];
  emails: string[];
  text: string;
  structured: StructuredBusiness[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const squash = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? "") : null;
}

function readStructured(json: string): StructuredBusiness[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const out: StructuredBusiness[] = [];
  const visit = (node: unknown, depth: number) => {
    if (depth > 6 || !node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach((n) => visit(n, depth + 1));
    const o = node as Record<string, unknown>;
    if (Array.isArray(o["@graph"])) visit(o["@graph"], depth + 1);
    const types = ([] as unknown[]).concat(o["@type"] ?? []).filter((t): t is string => typeof t === "string");
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null);
    const address = (Array.isArray(o.address) ? o.address[0] : o.address) as Record<string, unknown> | undefined;
    if (types.length && (o.telephone || o.address || o.name)) {
      out.push({
        types,
        name: str(o.name),
        telephone: str(o.telephone),
        email: str(o.email),
        streetAddress: address && typeof address === "object" ? str(address.streetAddress) : null,
        locality: address && typeof address === "object" ? str(address.addressLocality) : null,
        postalCode: address && typeof address === "object" ? str(address.postalCode) : null,
      });
    }
  };
  visit(data, 0);
  return out;
}

export function parseHtml(html: string): ParsedPage {
  const structured = [...html.matchAll(/<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)].flatMap((m) =>
    readStructured(m[1]!.trim()),
  );
  const clean = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, " ");

  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(clean)?.[1];
  let siteName: string | null = null;
  for (const m of clean.matchAll(/<meta\b[^>]*>/gi)) {
    const prop = (attr(m[0], "property") ?? attr(m[0], "name") ?? "").toLowerCase();
    if (prop === "og:site_name") siteName = (attr(m[0], "content") ?? "").trim() || null;
  }
  const headings = [...clean.matchAll(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/gi)].map((m) => squash(m[1]!)).filter(Boolean).slice(0, 20);
  const links: PageLink[] = [];
  const tels: string[] = [];
  const emails: string[] = [];
  for (const m of clean.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(`<a ${m[1]}>`, "href")?.trim();
    if (!href) continue;
    if (/^tel:/i.test(href)) tels.push(decodeURIComponent(href.slice(4)).trim());
    else if (/^mailto:/i.test(href)) emails.push(decodeURIComponent(href.slice(7).split("?")[0]!).trim().toLowerCase());
    else links.push({ href, text: squash(m[2]!).slice(0, 120) });
  }
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(clean)?.[1] ?? clean;
  const text = squash(body.replace(/<(br|p|div|li|h\d|tr|section|footer|header)\b/gi, " $&")).slice(0, 200_000);
  return {
    title: title ? squash(title).slice(0, 200) || null : null,
    siteName,
    headings,
    links: links.slice(0, 400),
    tels: [...new Set(tels)].slice(0, 20),
    emails: [...new Set(emails)].slice(0, 20),
    text,
    structured,
  };
}
