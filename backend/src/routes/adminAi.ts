/*
 * The AI shadow and gold-set evaluation pages. Registered inside the admin
 * scope, so they share its session check, same-origin check on every POST,
 * and headers. The only writes are a gold-set cohort and human labels;
 * nothing here changes a candidate, prospect, or outreach record. AI output
 * for a case is shown only after its blind label is saved.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "../db.js";
import { evaluateCohort } from "../ai/evaluation.js";
import { AiEvalError, adjudicateLabel, blindLabel, blindedCandidateIds, caseLabels, cohortProgress, createCohort, labelingView, nextUnlabeledCase } from "../ai/goldSet.js";
import { aiEvaluation, candidateAiDecisions } from "../ai/records.js";
import { adjudicationForm, blindLabelPage, cohortSection } from "../admin/aiLabelViews.js";
import { aiCaseReviewPage, aiCohortEvaluationPage, aiDisagreementsPage, aiEvaluationPage } from "../admin/aiViews.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Form = Record<string, string | undefined>;
const NOTICES: Record<string, string> = { cohort: "Gold set created.", complete: "Every case in this gold set has its blind label." };

export async function aiRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  const writeLimit = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };
  const html = (reply: FastifyReply, body: string) => reply.type("text/html; charset=utf-8").send(body);
  const notFound = (reply: FastifyReply) => reply.code(404).type("text/plain").send("Not found");
  const valid = (id: string, reply: FastifyReply) => UUID_RE.test(id) || (notFound(reply), false);
  const fail = (err: unknown, reply: FastifyReply, render: (errors: string[]) => unknown) => {
    if (!(err instanceof AiEvalError)) throw err;
    if (err.kind === "not_found") return notFound(reply);
    reply.code(err.kind === "conflict" ? 409 : 400);
    return render(err.messages);
  };

  const overview = async (reply: FastifyReply, extra: { notice?: string; cohortErrors?: string[] } = {}) => {
    const [evaluation, cohorts, blinded] = await Promise.all([aiEvaluation(db), cohortProgress(db), blindedCandidateIds(db)]);
    return html(reply, aiEvaluationPage(evaluation, { blinded, gold: cohortSection(cohorts, extra.cohortErrors), notice: extra.notice }));
  };

  app.get<{ Querystring: { done?: string } }>("/admin/ai", async (req, reply) => overview(reply, { notice: req.query.done ? NOTICES[req.query.done] : undefined }));

  app.post<{ Body: Form }>("/admin/ai/cohorts", writeLimit, async (req, reply) => {
    try {
      await createCohort(db, { name: req.body?.name ?? "", seed: req.body?.seed ?? "" });
      return reply.redirect("/admin/ai?done=cohort", 303);
    } catch (err) {
      return fail(err, reply, (errors) => overview(reply, { cohortErrors: errors }));
    }
  });

  app.get<{ Params: { id: string }; Querystring: { model?: string; prompt?: string; done?: string } }>("/admin/ai/cohorts/:id", async (req, reply) => {
    if (!valid(req.params.id, reply)) return reply;
    const ev = await evaluateCohort(db, req.params.id, { model: req.query.model, promptVersion: req.query.prompt });
    return ev ? html(reply, aiCohortEvaluationPage(ev)) : notFound(reply);
  });

  app.get<{ Params: { id: string }; Querystring: { model?: string; prompt?: string } }>("/admin/ai/cohorts/:id/disagreements", async (req, reply) => {
    if (!valid(req.params.id, reply)) return reply;
    const ev = await evaluateCohort(db, req.params.id, { model: req.query.model, promptVersion: req.query.prompt });
    return ev ? html(reply, aiDisagreementsPage(ev)) : notFound(reply);
  });

  app.get<{ Params: { id: string } }>("/admin/ai/cohorts/:id/next", async (req, reply) => {
    if (!valid(req.params.id, reply)) return reply;
    const next = await nextUnlabeledCase(db, req.params.id);
    return reply.redirect(next ? `/admin/ai/label/${next.id}` : `/admin/ai/cohorts/${req.params.id}?done=complete`, 303);
  });

  // Blind labeling: this page and its handler read no AI output (labelingView can't).
  const renderLabel = async (reply: FastifyReply, caseId: string, errors?: string[]) => {
    const v = await labelingView(db, caseId);
    if (!v) return notFound(reply);
    return html(reply, blindLabelPage(v, { errors, reviewHref: v.labeled.length ? `/admin/ai/cases/${caseId}` : undefined }));
  };

  app.get<{ Params: { caseId: string } }>("/admin/ai/label/:caseId", async (req, reply) => {
    if (!valid(req.params.caseId, reply)) return reply;
    return renderLabel(reply, req.params.caseId);
  });

  app.post<{ Params: { caseId: string }; Body: Form }>("/admin/ai/label/:caseId", writeLimit, async (req, reply) => {
    const { caseId } = req.params;
    if (!valid(caseId, reply)) return reply;
    try {
      await blindLabel(db, caseId, req.body ?? {});
      const v = await labelingView(db, caseId);
      return reply.redirect(v ? `/admin/ai/cohorts/${v.cohort.id}/next` : "/admin/ai", 303);
    } catch (err) {
      return fail(err, reply, (errors) => renderLabel(reply, caseId, errors));
    }
  });

  // After the blind label only: the case with the AI's answers, and adjudication.
  const renderReview = async (reply: FastifyReply, caseId: string, errors?: string[]) => {
    const c = await caseLabels(db, caseId);
    if (!c) return notFound(reply);
    if (!c.blindDone) return reply.redirect(`/admin/ai/label/${caseId}`, 303);
    const decisions = await candidateAiDecisions(db, c.candidateId, 10);
    return html(reply, aiCaseReviewPage(c, decisions, adjudicationForm(caseId, errors)));
  };

  app.get<{ Params: { caseId: string } }>("/admin/ai/cases/:caseId", async (req, reply) => {
    if (!valid(req.params.caseId, reply)) return reply;
    return renderReview(reply, req.params.caseId);
  });

  app.post<{ Params: { caseId: string }; Body: Form }>("/admin/ai/label/:caseId/adjudicate", writeLimit, async (req, reply) => {
    const { caseId } = req.params;
    if (!valid(caseId, reply)) return reply;
    try {
      await adjudicateLabel(db, caseId, req.body ?? {});
      return reply.redirect(`/admin/ai/cases/${caseId}`, 303);
    } catch (err) {
      return fail(err, reply, (errors) => renderReview(reply, caseId, errors));
    }
  });
}
