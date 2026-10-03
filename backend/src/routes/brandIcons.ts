import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

/*
 * The browser-tab icon for this service's pages (the admin): the site's own
 * approved icon files (app/favicon.ico, icon.svg, apple-icon.png), copied
 * byte for byte into backend/assets/brand; a unit test keeps them identical.
 * Public, like any favicon: the files carry nothing but the brand mark.
 */

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const ICONS = [
  { route: "/favicon.ico", file: "favicon.ico", type: "image/x-icon", rel: "icon", sizes: "48x48" },
  { route: "/icon.svg", file: "icon.svg", type: "image/svg+xml", rel: "icon", sizes: "any" },
  { route: "/apple-touch-icon.png", file: "apple-icon.png", type: "image/png", rel: "apple-touch-icon", sizes: "180x180" },
] as const;

const loaded = ICONS.map((i) => {
  const body = readFileSync(path.join(backendRoot, "assets", "brand", i.file));
  // A content version in the link, as the site does, so a new icon is picked up despite caching.
  return { ...i, body, version: createHash("sha256").update(body).digest("hex").slice(0, 12) };
});

/** The <link> tags for a page's <head>: the same three icons, sizes, and types as the public site. */
export const ICON_LINKS = loaded.map((i) => `<link rel="${i.rel}" href="${i.route}?v=${i.version}" sizes="${i.sizes}" type="${i.type}">`).join("");

export async function brandIconRoutes(app: FastifyInstance) {
  for (const i of loaded) {
    app.get(i.route, async (_req, reply) =>
      reply
        .header("Content-Type", i.type)
        .header("Cache-Control", "public, max-age=86400")
        .header("X-Content-Type-Options", "nosniff")
        // An SVG opened on its own is a document: it may run nothing and load nothing.
        .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
        .send(i.body),
    );
  }
}
