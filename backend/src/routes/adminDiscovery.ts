import type { FastifyInstance, FastifyReply } from "fastify";
import { candidateDetailPage, candidateFormPage, discoveryPage } from "../admin/discoveryViews.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { discoveryProviders } from "../discovery/providers.js";
import {
  addCandidateEvidence,
  addCandidateNote,
  addManualCandidate,
  approveCandidate,
  candidateFormValues,
  candidateStatusCounts,
  changeCandidateStatus,
  deleteCandidateEvidence,
  getCandidateDetail,
  listCandidates,
  recentRuns,
  processDiscoveryRun,
  runDiscovery,
  updateCandidate,
} from "../discovery/service.js";
import { recentImports } from "../discovery/staging.js";
import { MAX_BATCH, candidateResearch, enqueueResearch, processQueuedResearch, researchQueue, type ProcessDeps } from "../research/service.js";
import { ProspectError } from "../prospects.js";

type Form = Record<string, string>;
type Values = Record<string, string | undefined>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Confirmations shown after a redirect, keyed so no free text is reflected. */
const NOTICES: Record<string, string> = {
  added: "Candidate added. It is not a prospect until you approve it.",
  saved: "Research saved.",
  status: "Status changed.",
  note: "Note added.",
  evidence: "Evidence added.",
  evidence_removed: "Evidence removed.",
  research: "Research queued. It runs in the background (about 10 seconds per website); refresh to see the results.",
};

const pick = (body: Form | undefined, keys: string[]): Values =>
  Object.fromEntries(keys.map((k) => [k, typeof body?.[k] === "string" ? body[k] : undefined]));

/**
 * Discovery admin. Registered inside the admin scope, so every route here
 * already requires a session, same-origin POSTs, and the admin security
 * headers: nothing is reachable without signing in.
 */
export async function discoveryRoutes(app: FastifyInstance, opts: { config: Config; db: Db; research?: ProcessDeps }) {
  const { config, db } = opts;
  /** Processes queued research after the response; never inside a request. */
  const startResearch = () =>
    setImmediate(() => {
      processQueuedResearch(db, opts.research ?? {}).then(
        (r) => r.processed.length && app.log.info({ processed: r.processed.length }, "research processed"),
        (err: unknown) => app.log.error({ err }, "research worker crashed"),
      );
    });
  const providers = discoveryProviders(config, db);
  const providerOptions = [...providers.values()].map((p) => ({ name: p.name, label: p.label, background: p.mode === "background" }));

  const html = (reply: FastifyReply, body: string) => reply.type("text/html; charset=utf-8").send(body);
  const notFound = (reply: FastifyReply) => reply.code(404).type("text/plain").send("Not found");
  const validId = (id: string, reply: FastifyReply) => {
    if (UUID_RE.test(id)) return true;
    notFound(reply);
    return false;
  };
  const writeLimit = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };

  /** Maps service errors to a page; anything unexpected is rethrown. */
  const handleError = (err: unknown, reply: FastifyReply, render: (errors: string[]) => Promise<unknown> | unknown) => {
    if (!(err instanceof ProspectError)) throw err;
    if (err.kind === "not_found") return notFound(reply);
    reply.code(err.kind === "conflict" ? 409 : 400);
    return render(err.messages);
  };

  const renderOverview = async (
    reply: FastifyReply,
    filters: Values,
    extra: { notice?: string; errors?: string[]; values?: Values } = {},
  ) => {
    const [list, runs, runCount, statusCounts, imports, research] = await Promise.all([
      listCandidates(db, filters),
      recentRuns(db),
      db.discoveryRun.count(),
      candidateStatusCounts(db),
      recentImports(db),
      researchQueue(db),
    ]);
    return html(reply, discoveryPage({ providers: providerOptions, list, runs, runCount, imports, research, statusCounts, filters, ...extra }));
  };

  const renderDetail = async (reply: FastifyReply, id: string, extra: { notice?: string; errors?: string[]; values?: Values } = {}) => {
    const detail = await getCandidateDetail(db, id);
    if (!detail) return notFound(reply);
    const research = await candidateResearch(db, id);
    return html(reply, candidateDetailPage({ detail, research, ...extra }));
  };

  // ---------- overview and runs ----------

  app.get<{ Querystring: Values }>("/admin/discovery", async (req, reply) => {
    const q = req.query;
    const filters = {
      q: q.q,
      status: q.status,
      qualification: q.qualification,
      band: q.band,
      state: q.state,
      city: q.city,
      flagged: q.flagged,
      tier: q.tier,
      provider: q.provider,
      run: q.run && UUID_RE.test(q.run) ? q.run : undefined,
      sort: q.sort,
    };
    let notice: string | undefined;
    if (q.done === "research_batch") {
      notice = "Research queued for up to 10 candidates in this view. It runs in the background, one website at a time; refresh to see progress.";
    } else if (q.done === "research_none") {
      notice = "Nothing to research in this view: every candidate here has been researched, has research queued, or can't be researched.";
    }
    if (q.done === "run" && q.run && UUID_RE.test(q.run)) {
      const run = await db.discoveryRun.findUnique({ where: { id: q.run } });
      if (run?.status === "completed") {
        notice = `Discovery finished: ${run.created} new candidate(s), ${run.duplicates} duplicate(s) skipped, ${run.flagged} flagged for review${run.invalid ? `, ${run.invalid} unusable record(s) ignored` : ""}.`;
      } else if (run?.status === "queued" || run?.status === "running") {
        notice = "Discovery run queued. It runs in the background; refresh to see progress under Discovery runs.";
      } else if (run?.status === "failed") {
        return renderOverview(reply.code(502), filters, { errors: [run.error ?? "The provider failed."] });
      }
    }
    return renderOverview(reply, filters, { notice });
  });

  app.post<{ Body: Form }>(
    "/admin/discovery/runs",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      try {
        const run = await runDiscovery(db, providers, req.body ?? {});
        req.log.info({ runId: run.id, provider: run.provider, status: run.status }, "discovery run submitted");
        if (run.status === "queued") {
          // Processed after the response, in batches; never inside the request.
          setImmediate(() => {
            processDiscoveryRun(db, providers, run.id).then(
              (done) => done && req.log.info({ runId: run.id, status: done.status }, "background discovery run finished"),
              (err: unknown) => req.log.error({ err, runId: run.id }, "background discovery run crashed"),
            );
          });
        }
        return reply.redirect(`/admin/discovery?done=run&run=${run.id}`, 303);
      } catch (err) {
        return handleError(err, reply, (errors) =>
          renderOverview(reply, {}, { errors, values: pick(req.body, ["provider", "region", "city", "businessType", "tiers"]) }),
        );
      }
    },
  );

  // ---------- candidates ----------

  app.get("/admin/discovery/candidates/new", (_req, reply) => html(reply, candidateFormPage({ mode: "new" }, {})));

  app.post<{ Body: Form }>("/admin/discovery/candidates", writeLimit, async (req, reply) => {
    try {
      const c = await addManualCandidate(db, req.body ?? {});
      return reply.redirect(`/admin/discovery/candidates/${c.id}?done=added`, 303);
    } catch (err) {
      return handleError(err, reply, (errors) => html(reply, candidateFormPage({ mode: "new" }, req.body ?? {}, errors)));
    }
  });

  app.get<{ Params: { id: string }; Querystring: { done?: string } }>("/admin/discovery/candidates/:id", async (req, reply) => {
    if (!validId(req.params.id, reply)) return reply;
    return renderDetail(reply, req.params.id, { notice: req.query.done ? NOTICES[req.query.done] : undefined });
  });

  app.get<{ Params: { id: string } }>("/admin/discovery/candidates/:id/edit", async (req, reply) => {
    if (!validId(req.params.id, reply)) return reply;
    const c = await db.discoveryCandidate.findUnique({ where: { id: req.params.id }, include: { signals: true, evidence: true } });
    if (!c) return notFound(reply);
    if (c.status === "approved") return reply.redirect(`/admin/discovery/candidates/${c.id}`, 303);
    return html(reply, candidateFormPage({ mode: "edit", id: c.id, name: c.businessName, providerPhone: c.providerPhone }, candidateFormValues(c)));
  });

  app.post<{ Params: { id: string }; Body: Form }>("/admin/discovery/candidates/:id", writeLimit, async (req, reply) => {
    const { id } = req.params;
    if (!validId(id, reply)) return reply;
    try {
      await updateCandidate(db, id, req.body ?? {});
      return reply.redirect(`/admin/discovery/candidates/${id}?done=saved`, 303);
    } catch (err) {
      return handleError(err, reply, async (errors) => {
        const c = await db.discoveryCandidate.findUnique({ where: { id }, select: { businessName: true } });
        return html(reply, candidateFormPage({ mode: "edit", id, name: c?.businessName ?? "candidate" }, req.body ?? {}, errors));
      });
    }
  });

  app.post<{ Params: { id: string }; Body: Form }>("/admin/discovery/candidates/:id/status", writeLimit, async (req, reply) => {
    const { id } = req.params;
    if (!validId(id, reply)) return reply;
    try {
      const { from, to } = await changeCandidateStatus(db, id, req.body?.status ?? "", req.body?.reason);
      req.log.info({ candidateId: id, from, to }, "candidate status changed");
      return reply.redirect(`/admin/discovery/candidates/${id}?done=status`, 303);
    } catch (err) {
      return handleError(err, reply, (errors) => renderDetail(reply, id, { errors, values: pick(req.body, ["status", "reason"]) }));
    }
  });

  app.post<{ Params: { id: string }; Body: Form }>("/admin/discovery/candidates/:id/notes", writeLimit, async (req, reply) => {
    const { id } = req.params;
    if (!validId(id, reply)) return reply;
    try {
      await addCandidateNote(db, id, req.body?.body);
      return reply.redirect(`/admin/discovery/candidates/${id}?done=note`, 303);
    } catch (err) {
      return handleError(err, reply, (errors) => renderDetail(reply, id, { errors, values: pick(req.body, ["body"]) }));
    }
  });

  app.post<{ Params: { id: string }; Body: Form }>("/admin/discovery/candidates/:id/evidence", writeLimit, async (req, reply) => {
    const { id } = req.params;
    if (!validId(id, reply)) return reply;
    try {
      await addCandidateEvidence(db, id, req.body ?? {});
      return reply.redirect(`/admin/discovery/candidates/${id}?done=evidence`, 303);
    } catch (err) {
      return handleError(err, reply, (errors) =>
        renderDetail(reply, id, { errors, values: pick(req.body, ["signalKey", "sourceUrl", "excerpt"]) }),
      );
    }
  });

  app.post<{ Params: { id: string; evidenceId: string } }>(
    "/admin/discovery/candidates/:id/evidence/:evidenceId/delete",
    writeLimit,
    async (req, reply) => {
      const { id, evidenceId } = req.params;
      if (!validId(id, reply) || !validId(evidenceId, reply)) return reply;
      try {
        await deleteCandidateEvidence(db, id, evidenceId);
        return reply.redirect(`/admin/discovery/candidates/${id}?done=evidence_removed`, 303);
      } catch (err) {
        return handleError(err, reply, (errors) => renderDetail(reply, id, { errors }));
      }
    },
  );

  // The only route that creates a prospect from a candidate: an explicit human POST.
  // ---------- automated research (queued; processed in the background) ----------

  app.post<{ Params: { id: string } }>("/admin/discovery/candidates/:id/research", writeLimit, async (req, reply) => {
    if (!validId(req.params.id, reply)) return reply;
    const r = await enqueueResearch(db, [req.params.id], "admin");
    const skipped = r.skipped[0];
    if (skipped?.reason === "not found") return notFound(reply);
    if (skipped) return renderDetail(reply.code(409), req.params.id, { errors: [`Research can't start: ${skipped.reason}.`] });
    startResearch();
    return reply.redirect(`/admin/discovery/candidates/${req.params.id}?done=research`, 303);
  });

  app.post<{ Body: Form }>(
    "/admin/discovery/research",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const b = req.body ?? {};
      const filters = pick(b, ["q", "status", "qualification", "band", "state", "city", "flagged", "tier", "provider", "sort"]);
      const run = typeof b.run === "string" && UUID_RE.test(b.run) ? b.run : undefined;
      const list = await listCandidates(db, { ...filters, run });
      // Only candidates never researched, so a batch moves through the list.
      const ids = list.rows.filter((r) => !r.candidate.research.length && !["approved", "rejected", "duplicate"].includes(r.candidate.status)).map((r) => r.candidate.id);
      const r = await enqueueResearch(db, ids.slice(0, MAX_BATCH), "batch");
      if (!r.queued.length) return reply.redirect("/admin/discovery?done=research_none", 303);
      startResearch();
      return reply.redirect("/admin/discovery?done=research_batch", 303);
    },
  );

  app.post<{ Params: { id: string } }>("/admin/discovery/candidates/:id/approve", writeLimit, async (req, reply) => {
    const { id } = req.params;
    if (!validId(id, reply)) return reply;
    try {
      const { prospect } = await approveCandidate(db, id);
      req.log.info({ candidateId: id, prospectId: prospect.id }, "candidate approved");
      return reply.redirect(`/admin/prospects/${prospect.id}?done=created`, 303);
    } catch (err) {
      return handleError(err, reply, (errors) => renderDetail(reply, id, { errors }));
    }
  });
}
