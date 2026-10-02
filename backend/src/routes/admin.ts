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
import { prospectDetailPage, prospectFormPage, prospectListPage } from "../admin/prospectViews.js";
import { loadProspectRows, loadSummary } from "../admin/stats.js";
import { dashboardPage, disabledPage, loginPage } from "../admin/views.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { reviewQueue } from "../discovery/service.js";
import type { Status } from "../prospectStatus.js";
import type { ProcessDeps } from "../research/service.js";
import type { OutreachSender } from "../outreach/sender.js";
import { createOutreachDraft, prospectOutreach } from "../outreach/service.js";
import { discoveryRoutes } from "./adminDiscovery.js";
import { outreachRoutes } from "./adminOutreach.js";
import {
  ProspectError,
  addEvidence,
  addNote,
  changeStatus,
  createProspect,
  deleteEvidence,
  formValuesOf,
  getProspectDetail,
  listProspects,
  updateProspect,
} from "../prospects.js";

type Form = Record<string, string>;
type Values = Record<string, string | undefined>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Confirmation shown after a redirect, keyed so no free text is reflected. */
const NOTICES: Record<string, string> = {
  created: "Prospect created.",
  saved: "Changes saved. Score recalculated.",
  status: "Status changed.",
  note: "Note added.",
  evidence: "Evidence added.",
  evidence_removed: "Evidence removed.",
};

/** Paths reachable without a session. */
const PUBLIC_PATHS = new Set(["/admin/login", "/admin/logout"]);

/**
 * Private admin at /admin, protected server-side by ADMIN_SECRET. The
 * secret never reaches the static frontend.
 */
export async function adminRoutes(app: FastifyInstance, opts: { config: Config; db: Db; research?: ProcessDeps; sender: OutreachSender; googleFetch?: typeof fetch }) {
  const { config, db } = opts;
  const secret = config.adminSecret;

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string", bodyLimit: 16_384 },
    (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );

  await app.register(rateLimit, { global: false });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Robots-Tag", "noindex, nofollow");
    // Not "no-referrer": with that policy browsers send `Origin: null` on the
    // admin's own form POSTs, which the same-origin check must reject.
    // "same-origin" still sends nothing to other sites.
    reply.header("Referrer-Policy", "same-origin");
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

  /**
   * Rejects cross-site form posts (defense in depth on top of SameSite=Strict).
   * Compares against this backend's own host (Railway domain or a custom one),
   * never ALLOWED_ORIGIN, which is only the frontend's CORS allowlist. An
   * opaque `Origin: null` is rejected: a hostile page can produce it.
   */
  const sameOrigin = (req: FastifyRequest) => {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.host;
    } catch {
      return false;
    }
  };

  // Every admin route requires a session, and every POST must be same-origin.
  app.addHook("preHandler", async (req, reply) => {
    if (req.method === "POST" && !sameOrigin(req)) {
      req.log.warn({ origin: req.headers.origin, host: req.host }, "admin POST rejected: origin does not match host");
      return reply.code(403).send();
    }
    const path = req.routeOptions.url ?? req.url;
    if (PUBLIC_PATHS.has(path)) return;
    if (!isAuthed(req)) return reply.redirect("/admin/login", 303);
  });

  // ---------- session ----------

  app.get("/admin/login", (req, reply) =>
    isAuthed(req) ? reply.redirect("/admin", 303) : html(reply, loginPage()),
  );

  app.post<{ Body: Form }>(
    "/admin/login",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    (req, reply) => {
      const given = typeof req.body?.secret === "string" ? req.body.secret : "";
      if (!safeEqual(given, secret)) {
        req.log.warn("admin login failed");
        return html(reply, loginPage("Incorrect secret."), 401);
      }
      reply.header("Set-Cookie", sessionCookie(issueToken(secret), config.secureCookies));
      return reply.redirect("/admin", 303);
    },
  );

  app.post("/admin/logout", (_req, reply) => {
    reply.header("Set-Cookie", clearedCookie(config.secureCookies));
    return reply.redirect("/admin/login", 303);
  });

  // ---------- funnel ----------

  app.get<{ Querystring: { created?: string } }>("/admin", async (req, reply) => {
    const [summary, rows, prospectStatuses, queue] = await Promise.all([
      loadSummary(db),
      loadProspectRows(db),
      db.prospect.groupBy({ by: ["status"], _count: { _all: true } }),
      // The Discovery work queue's own counts, so the funnel and the queue agree.
      reviewQueue(db, {}, "all"),
    ]);
    const count = (list: { status: string; _count: { _all: number } }[], status: string) =>
      list.find((g) => g.status === status)?._count._all ?? 0;
    const attention = {
      candidatesToDecide: queue.counts.decision,
      candidatesToApprove: queue.counts.ready,
      readyToContact: count(prospectStatuses, "ready_to_contact"),
      newProspects: count(prospectStatuses, "new"),
    };
    return html(reply, dashboardPage({ summary, rows, siteUrl: config.publicSiteUrl, attention, highlightId: req.query.created }));
  });

  // ---------- prospects ----------

  const writeLimit = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };

  /** Maps service errors to a page; anything unexpected is rethrown. */
  const handleError = (err: unknown, reply: FastifyReply, render: (errors: string[]) => Promise<unknown> | unknown) => {
    if (!(err instanceof ProspectError)) throw err;
    if (err.kind === "not_found") return reply.code(404).type("text/plain").send("Not found");
    reply.code(err.kind === "conflict" ? 409 : 400);
    return render(err.messages);
  };

  const draftOptions = { siteUrl: config.publicSiteUrl, sender: config.outreachSender };

  const renderDetail = async (reply: FastifyReply, id: string, extra: { notice?: string; errors?: string[]; values?: Values } = {}) => {
    const detail = await getProspectDetail(db, id);
    if (!detail) return reply.code(404).type("text/plain").send("Not found");
    const outreach = await prospectOutreach(db, id, draftOptions);
    return html(reply, prospectDetailPage({ detail, outreach, siteUrl: config.publicSiteUrl, ...extra }), reply.statusCode);
  };

  const validId = (id: string, reply: FastifyReply) => {
    if (UUID_RE.test(id)) return true;
    reply.code(404).type("text/plain").send("Not found");
    return false;
  };

  app.get<{ Querystring: Values }>("/admin/prospects", async (req, reply) => {
    const filters = {
      q: req.query.q,
      status: req.query.status,
      qualification: req.query.qualification,
      band: req.query.band,
      state: req.query.state,
      city: req.query.city,
      sort: req.query.sort,
    };
    const [list, grouped] = await Promise.all([
      listProspects(db, filters),
      db.prospect.groupBy({ by: ["status"], _count: { _all: true } }),
    ]);
    const statusCounts: Partial<Record<Status, number>> = {};
    for (const g of grouped) statusCounts[g.status] = g._count._all;
    return html(reply, prospectListPage({ list, filters, statusCounts }));
  });

  app.get("/admin/prospects/new", (_req, reply) => html(reply, prospectFormPage({ mode: "new" }, {})));

  app.post<{ Body: Form }>("/admin/prospects", writeLimit, async (req, reply) => {
    try {
      const prospect = await createProspect(db, req.body ?? {});
      req.log.info({ prospectId: prospect.id }, "prospect created");
      return reply.redirect(`/admin/prospects/${prospect.id}?done=created`, 303);
    } catch (err) {
      return handleError(err, reply, (errors) => html(reply, prospectFormPage({ mode: "new" }, req.body ?? {}, errors), reply.statusCode));
    }
  });

  app.get<{ Params: { id: string }; Querystring: { done?: string } }>("/admin/prospects/:id", async (req, reply) => {
    if (!validId(req.params.id, reply)) return reply;
    const notice = req.query.done ? NOTICES[req.query.done] : undefined;
    return renderDetail(reply, req.params.id, { notice });
  });

  app.get<{ Params: { id: string } }>("/admin/prospects/:id/edit", async (req, reply) => {
    if (!validId(req.params.id, reply)) return reply;
    const p = await db.prospect.findUnique({ where: { id: req.params.id }, include: { signals: true } });
    if (!p) return reply.code(404).type("text/plain").send("Not found");
    return html(reply, prospectFormPage({ mode: "edit", id: p.id, name: p.businessName, status: p.status }, formValuesOf(p)));
  });

  app.post<{ Params: { id: string }; Body: Form }>("/admin/prospects/:id", writeLimit, async (req, reply) => {
    const { id } = req.params;
    if (!validId(id, reply)) return reply;
    try {
      await updateProspect(db, id, req.body ?? {});
      return reply.redirect(`/admin/prospects/${id}?done=saved`, 303);
    } catch (err) {
      return handleError(err, reply, async (errors) => {
        const p = await db.prospect.findUnique({ where: { id }, select: { businessName: true, status: true } });
        return html(reply, prospectFormPage({ mode: "edit", id, name: p?.businessName ?? null, status: p?.status }, req.body ?? {}, errors), reply.statusCode);
      });
    }
  });

  app.post<{ Params: { id: string }; Body: Form }>("/admin/prospects/:id/status", writeLimit, async (req, reply) => {
    const { id } = req.params;
    if (!validId(id, reply)) return reply;
    try {
      const { from, to } = await changeStatus(db, id, req.body?.status ?? "", req.body?.reason);
      req.log.info({ prospectId: id, from, to }, "prospect status changed");
      return reply.redirect(`/admin/prospects/${id}?done=status`, 303);
    } catch (err) {
      return handleError(err, reply, (errors) => renderDetail(reply, id, { errors, values: pick(req.body, ["status", "reason"]) }));
    }
  });

  /** Prepares an outreach draft from stored evidence, or returns the open one. Never sends. */
  app.post<{ Params: { id: string } }>("/admin/prospects/:id/outreach", writeLimit, async (req, reply) => {
    const { id } = req.params;
    if (!validId(id, reply)) return reply;
    try {
      const { outreach, created } = await createOutreachDraft(db, id, draftOptions);
      req.log.info({ prospectId: id, outreachId: outreach.id, created }, "outreach draft");
      return reply.redirect(`/admin/outreach/${outreach.id}?done=${created ? "drafted" : "existing"}`, 303);
    } catch (err) {
      return handleError(err, reply, (errors) => renderDetail(reply, id, { errors }));
    }
  });

  app.post<{ Params: { id: string }; Body: Form }>("/admin/prospects/:id/notes", writeLimit, async (req, reply) => {
    const { id } = req.params;
    if (!validId(id, reply)) return reply;
    try {
      await addNote(db, id, req.body?.body);
      return reply.redirect(`/admin/prospects/${id}?done=note`, 303);
    } catch (err) {
      return handleError(err, reply, (errors) => renderDetail(reply, id, { errors, values: pick(req.body, ["body"]) }));
    }
  });

  app.post<{ Params: { id: string }; Body: Form }>("/admin/prospects/:id/evidence", writeLimit, async (req, reply) => {
    const { id } = req.params;
    if (!validId(id, reply)) return reply;
    try {
      await addEvidence(db, id, req.body ?? {});
      return reply.redirect(`/admin/prospects/${id}?done=evidence`, 303);
    } catch (err) {
      return handleError(err, reply, (errors) =>
        renderDetail(reply, id, { errors, values: pick(req.body, ["signalKey", "sourceUrl", "excerpt"]) }),
      );
    }
  });

  app.post<{ Params: { id: string; evidenceId: string } }>(
    "/admin/prospects/:id/evidence/:evidenceId/delete",
    writeLimit,
    async (req, reply) => {
      const { id, evidenceId } = req.params;
      if (!validId(id, reply) || !validId(evidenceId, reply)) return reply;
      try {
        await deleteEvidence(db, id, evidenceId);
        return reply.redirect(`/admin/prospects/${id}?done=evidence_removed`, 303);
      } catch (err) {
        return handleError(err, reply, (errors) => renderDetail(reply, id, { errors }));
      }
    },
  );

  // Discovery shares this scope's session check, origin check, and headers.
  await app.register(discoveryRoutes, { config, db, research: opts.research });
  await app.register(outreachRoutes, { config, db, sender: opts.sender, googleFetch: opts.googleFetch });
}

const pick = (body: Form | undefined, keys: string[]): Values =>
  Object.fromEntries(keys.map((k) => [k, typeof body?.[k] === "string" ? body[k] : undefined]));
