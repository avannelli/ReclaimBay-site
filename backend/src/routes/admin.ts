import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ADMIN_COOKIE,
  clearedCookie,
  issueToken,
  readCookie,
  safeEqual,
  sessionCookie,
  verifyToken,
} from "../admin/auth.js";
import { loadProspectRows, loadSummary } from "../admin/stats.js";
import { dashboardPage, disabledPage, loginPage } from "../admin/views.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { cleanProspectInput, createProspect } from "../prospects.js";

type Form = Record<string, string>;

/**
 * Private admin at /admin, protected server-side by ADMIN_SECRET. The
 * secret never reaches the static frontend.
 */
export async function adminRoutes(app: FastifyInstance, opts: { config: Config; db: Db }) {
  const { config, db } = opts;
  const secret = config.adminSecret;

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string", bodyLimit: 4_096 },
    (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );

  await app.register(rateLimit, { global: false });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Robots-Tag", "noindex, nofollow");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    return payload;
  });

  const html = (reply: FastifyReply, body: string, code = 200) =>
    reply.code(code).type("text/html; charset=utf-8").send(body);

  if (!secret) {
    app.log.warn("ADMIN_SECRET missing or too short: /admin is disabled");
    app.all("/admin", (_req, reply) => html(reply, disabledPage(), 503));
    app.all("/admin/*", (_req, reply) => html(reply, disabledPage(), 503));
    return;
  }

  const isAuthed = (req: FastifyRequest) => verifyToken(secret, readCookie(req.headers.cookie, ADMIN_COOKIE));

  /** Rejects cross-site form posts (defense in depth on top of SameSite=Strict). */
  const sameOrigin = (req: FastifyRequest) => {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.host;
    } catch {
      return false;
    }
  };

  app.get("/admin/login", (req, reply) =>
    isAuthed(req) ? reply.redirect("/admin", 303) : html(reply, loginPage()),
  );

  app.post<{ Body: Form }>(
    "/admin/login",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    (req, reply) => {
      if (!sameOrigin(req)) return reply.code(403).send();
      const given = typeof req.body?.secret === "string" ? req.body.secret : "";
      if (!safeEqual(given, secret)) {
        req.log.warn("admin login failed");
        return html(reply, loginPage("Incorrect secret."), 401);
      }
      reply.header("Set-Cookie", sessionCookie(issueToken(secret), config.secureCookies));
      return reply.redirect("/admin", 303);
    },
  );

  app.post("/admin/logout", (req, reply) => {
    if (!sameOrigin(req)) return reply.code(403).send();
    reply.header("Set-Cookie", clearedCookie(config.secureCookies));
    return reply.redirect("/admin/login", 303);
  });

  const renderDashboard = async (reply: FastifyReply, extra: { highlightId?: string; formError?: string } = {}) => {
    const [summary, rows] = await Promise.all([loadSummary(db), loadProspectRows(db)]);
    return html(reply, dashboardPage({ summary, rows, siteUrl: config.publicSiteUrl, ...extra }), extra.formError ? 400 : 200);
  };

  app.get<{ Querystring: { created?: string } }>("/admin", async (req, reply) => {
    if (!isAuthed(req)) return reply.redirect("/admin/login", 303);
    return renderDashboard(reply, { highlightId: req.query.created });
  });

  app.post<{ Body: Form }>(
    "/admin/prospects",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      if (!isAuthed(req)) return reply.redirect("/admin/login", 303);
      if (!sameOrigin(req)) return reply.code(403).send();
      const cleaned = cleanProspectInput({ businessName: req.body?.businessName, website: req.body?.website });
      if (typeof cleaned === "string") return renderDashboard(reply, { formError: cleaned });
      const prospect = await createProspect(db, cleaned);
      req.log.info({ prospectId: prospect.id }, "prospect created");
      return reply.redirect(`/admin?created=${encodeURIComponent(prospect.id)}`, 303);
    },
  );
}
