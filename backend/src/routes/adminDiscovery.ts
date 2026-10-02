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
  changeCandidateStatus,
  deleteCandidateEvidence,
  getCandidateDetail,
  isQueueView,
  queuePosition,
  recentRuns,
  processDiscoveryRun,
  resolveDuplicate,
  reviewQueue,
  type QueueView,
  runDiscovery,
  setCandidateCategory,
  updateCandidate,
} from "../discovery/service.js";
import { recentImports } from "../discovery/staging.js";
import { MAX_BATCH, autoResearchIds, candidateResearch, enqueueResearch, processQueuedResearch, researchQueue, type ProcessDeps } from "../research/service.js";
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
  category: "Category check updated. This is not qualification and did not change the status.",
};

/** Decision confirmations that name the business; the names come from the database, never the request. */
const DECISION_NOTICES: Record<string, (name: string, match: string) => string> = {
  not_duplicate: (name, match) => `Duplicate resolved: ${name} is not a duplicate of ${match}.`,
  not_duplicate_held: (name, match) =>
    `Duplicate resolved: ${name} is not a duplicate of ${match}. It stays in Needs review because a person also put it on hold.`,
  duplicate: (name, match) => `Marked as a duplicate: ${name} is the same business as ${match}. It will not become a prospect.`,
  unresolved: (name) => `Left unresolved: ${name} keeps its possible-duplicate warning and stays in review.`,
  kept: (name) => `${name} is kept for review.`,
  disregarded: (name) => `${name} was disregarded. It will not become a prospect; reopen it from its page if that was a mistake.`,
  reopened: (name) => `${name} was reopened for review.`,
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
    extra: { notice?: string; noticeLink?: { href: string; label: string }; errors?: string[]; values?: Values; view?: QueueView } = {},
  ) => {
    const { view = "all", ...rest } = extra;
    const [queue, runs, runCount, imports, research] = await Promise.all([
      reviewQueue(db, filters, view),
      recentRuns(db),
      db.discoveryRun.count(),
      recentImports(db),
      researchQueue(db),
    ]);
    return html(reply, discoveryPage({ providers: providerOptions, queue, runs, runCount, imports, research, filters, ...rest }));
  };

  /** Where a queue action returns to: the same view, with a confirmation keyed by `done`. */
  const backToQueue = (body: Form | undefined, done: string, id: string) => {
    const view = isQueueView(body?.view) && body.view !== "all" ? `&view=${body.view}` : "";
    return `/admin/discovery?done=${done}&c=${id}${view}`;
  };

  const renderDetail = async (reply: FastifyReply, id: string, extra: { notice?: string; done?: string; errors?: string[]; values?: Values } = {}) => {
    const detail = await getCandidateDetail(db, id);
    if (!detail) return notFound(reply);
    const [research, position] = await Promise.all([candidateResearch(db, id), queuePosition(db, id)]);
    const { done, ...rest } = extra;
    const decided = done ? DECISION_NOTICES[done] : undefined;
    const match = detail.dupCandidate?.businessName ?? detail.dupProspect?.businessName ?? "the flagged record";
    const notice = rest.notice ?? (decided ? decided(detail.candidate.businessName, match) : done ? NOTICES[done] : undefined);
    return html(reply, candidateDetailPage({ detail, research, position, ...rest, notice, decided: Boolean(decided) }));
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
      category: q.category,
      provider: q.provider,
      run: q.run && UUID_RE.test(q.run) ? q.run : undefined,
      sort: q.sort,
    };
    const view: QueueView = isQueueView(q.view) ? q.view : "all";
    let notice: string | undefined;
    let noticeLink: { href: string; label: string } | undefined;
    // A queue action's confirmation names the business; the name comes from the database.
    if ((q.done === "approved" || q.done === "research_one") && q.c && UUID_RE.test(q.c)) {
      const c = await db.discoveryCandidate.findUnique({ where: { id: q.c }, select: { businessName: true, prospectId: true } });
      if (c && q.done === "approved") {
        notice = `${c.businessName} was approved and added to your prospect pipeline as New.`;
        if (c.prospectId) noticeLink = { href: `/admin/prospects/${c.prospectId}`, label: "Open prospect" };
      } else if (c) {
        notice = `Research queued for ${c.businessName}. It runs in the background; refresh to see the result.`;
      }
    }
    if (q.done === "research_batch") {
      notice = "Research queued for up to 10 candidates in this view. It runs in the background, one website at a time; refresh to see progress.";
    } else if (q.done === "research_none") {
      notice = "Nothing to research in this view: every candidate here has been researched, has research queued, can't be researched, or is outside the target category.";
    }
    if (q.done === "run" && q.run && UUID_RE.test(q.run)) {
      const run = await db.discoveryRun.findUnique({ where: { id: q.run } });
      if (run?.status === "completed") {
        notice = `Discovery finished: ${run.created} new candidate(s), ${run.duplicates} duplicate(s) skipped, ${run.flagged} flagged for review${run.invalid ? `, ${run.invalid} unusable record(s) ignored` : ""}.`;
      } else if (run?.status === "queued" || run?.status === "running") {
        notice = "Discovery run queued. It runs in the background; refresh to see progress under Discovery runs.";
      } else if (run?.status === "failed") {
        return renderOverview(reply.code(502), filters, { errors: [run.error ?? "The provider failed."], view });
      }
    }
    return renderOverview(reply, filters, { notice, noticeLink, view });
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

  app.get<{ Params: { id: string }; Querystring: { done?: string; act?: string } }>("/admin/discovery/candidates/:id", async (req, reply) => {
    if (!validId(req.params.id, reply)) return reply;
    // From the queue's "Disregard…": open the reason form, prefilled, so it is one more deliberate click.
    return renderDetail(reply, req.params.id, { done: req.query.done, values: req.query.act === "disregard" ? { intent: "disregard" } : undefined });
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
      // The decision buttons say which human decision this was; the advanced form doesn't.
      const intent = req.body?.intent;
      const done =
        intent === "keep" && to === "needs_review" ? "kept" : intent === "disregard" && to === "rejected" ? "disregarded" : intent === "reopen" && to === "discovered" ? "reopened" : "status";
      return reply.redirect(`/admin/discovery/candidates/${id}?done=${done}`, 303);
    } catch (err) {
      return handleError(err, reply, (errors) => renderDetail(reply, id, { errors, values: pick(req.body, ["status", "reason", "intent"]) }));
    }
  });

  // A person's answer to a possible-duplicate flag: not a duplicate, duplicate, or left unresolved.
  app.post<{ Params: { id: string }; Body: Form }>("/admin/discovery/candidates/:id/duplicate", writeLimit, async (req, reply) => {
    const { id } = req.params;
    if (!validId(id, reply)) return reply;
    try {
      const r = await resolveDuplicate(db, id, req.body?.decision ?? "");
      req.log.info({ candidateId: id, decision: r.answer, from: r.from, to: r.to }, "candidate duplicate decision");
      return reply.redirect(`/admin/discovery/candidates/${id}?done=${r.kept ? "not_duplicate_held" : r.answer}`, 303);
    } catch (err) {
      return handleError(err, reply, (errors) => renderDetail(reply, id, { errors }));
    }
  });

  // A person's category decision: not qualification, and never a status change.
  app.post<{ Params: { id: string }; Body: Form }>("/admin/discovery/candidates/:id/category", writeLimit, async (req, reply) => {
    const { id } = req.params;
    if (!validId(id, reply)) return reply;
    try {
      const r = await setCandidateCategory(db, id, req.body?.categoryVerdict ?? "", req.body?.categoryReason);
      req.log.info({ candidateId: id, verdict: r.verdict, source: r.source }, "candidate category set");
      return reply.redirect(`/admin/discovery/candidates/${id}?done=category`, 303);
    } catch (err) {
      return handleError(err, reply, (errors) => renderDetail(reply, id, { errors, values: pick(req.body, ["categoryVerdict", "categoryReason"]) }));
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

  app.post<{ Params: { id: string }; Body: Form }>("/admin/discovery/candidates/:id/research", writeLimit, async (req, reply) => {
    if (!validId(req.params.id, reply)) return reply;
    const fromQueue = req.body?.from === "queue";
    const r = await enqueueResearch(db, [req.params.id], "admin");
    const skipped = r.skipped[0];
    if (skipped?.reason === "not found") return notFound(reply);
    if (skipped) {
      const errors = [`Research can't start: ${skipped.reason}.`];
      return fromQueue ? renderOverview(reply.code(409), {}, { errors }) : renderDetail(reply.code(409), req.params.id, { errors });
    }
    startResearch();
    return reply.redirect(fromQueue ? backToQueue(req.body, "research_one", req.params.id) : `/admin/discovery/candidates/${req.params.id}?done=research`, 303);
  });

  app.post<{ Body: Form }>(
    "/admin/discovery/research",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const b = req.body ?? {};
      const filters = pick(b, ["q", "status", "qualification", "band", "state", "city", "flagged", "tier", "category", "provider", "sort"]);
      const run = typeof b.run === "string" && UUID_RE.test(b.run) ? b.run : undefined;
      const view: QueueView = isQueueView(b.view) ? b.view : "all";
      const queue = await reviewQueue(db, { ...filters, run }, view);
      // Only candidates never researched (so a batch moves through the list),
      // and never one outside the target category.
      const ids = autoResearchIds(queue.items, MAX_BATCH);
      const r = await enqueueResearch(db, ids, "batch");
      const back = view === "all" ? "" : `&view=${view}`;
      if (!r.queued.length) return reply.redirect(`/admin/discovery?done=research_none${back}`, 303);
      startResearch();
      return reply.redirect(`/admin/discovery?done=research_batch${back}`, 303);
    },
  );

  app.post<{ Params: { id: string }; Body: Form }>("/admin/discovery/candidates/:id/approve", writeLimit, async (req, reply) => {
    const { id } = req.params;
    if (!validId(id, reply)) return reply;
    // Approving from the queue returns to the queue, so the next item is right there.
    const fromQueue = req.body?.from === "queue";
    try {
      const { prospect } = await approveCandidate(db, id);
      req.log.info({ candidateId: id, prospectId: prospect.id, fromQueue }, "candidate approved");
      return reply.redirect(fromQueue ? backToQueue(req.body, "approved", id) : `/admin/prospects/${prospect.id}?done=created`, 303);
    } catch (err) {
      return handleError(err, reply, (errors) => (fromQueue ? renderOverview(reply, {}, { errors }) : renderDetail(reply, id, { errors })));
    }
  });
}
