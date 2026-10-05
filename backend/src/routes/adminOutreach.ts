import type { FastifyInstance, FastifyReply } from "fastify";
import { outreachControlPage, outreachDetailPage, outreachMessagesPage, type MessagesPageData } from "../admin/outreachViews.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { confirmStuckSent, dailyCapacity, readinessErrors, sendingStatus, sendingSwitch, setSendingSwitch, stuckMessages } from "../outreach/dispatch.js";
import { STATE_COOKIE, authorizationUrl, gmailCredentialsFromConfig, gmailOAuthConfig, newOAuthState } from "../outreach/gmailAuth.js";
import { invitationForOutreach, revokeInvitationForOutreach } from "../invitations/service.js";
import { outreachMetrics } from "../outreach/metrics.js";
import {
  listActivity,
  listEligible,
  listMessages,
  listReplies,
  messageCampaigns,
  parseMessageFilters,
  queueLooksStale,
  recentActivity,
  waitingQueue,
} from "../outreach/operations.js";
import { PREPARE_LIMIT, PREPARE_OUTCOMES, prepareEligibleOutreach, prepareSelectedOutreach, type PrepareOutcome } from "../outreach/prepare.js";
import type { OutreachSender } from "../outreach/sender.js";
import { classifyReply, createOutreachDraft, discardOutreach, getOutreachDetail, outreachAttention, queueOutreach, recordReply } from "../outreach/service.js";
import { ProspectError } from "../prospects.js";

type Form = Record<string, string>;
type Values = Record<string, string | undefined>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Confirmations shown after a redirect, keyed so no free text is reflected. */
const NOTICES: Record<string, string> = {
  drafted: "Draft prepared from the stored evidence. Nothing was sent.",
  existing: "This prospect already has an open message, so no new draft was made.",
  discarded: "Message discarded. It stays in the history as Cancelled.",
  queued: "Queued. Nothing was sent by this action: the dispatcher sends queued messages only while sending is switched on.",
  reply: "Reply recorded.",
  classified: "Reply classified.",
  confirmed: "Recorded as sent.",
  already_sent: "This message already has a recorded send outcome. Nothing changed.",
  switched_on: "Sending switched on.",
  switched_off: "Sending switched off. No further message will be sent.",
  invitation_revoked: "Invitation revoked. Its link no longer works; everything it recorded is kept.",
  invitation_already_revoked: "This invitation was already revoked; nothing changed.",
};

const pick = (body: Form | undefined, keys: string[]): Values =>
  Object.fromEntries(keys.map((k) => [k, typeof body?.[k] === "string" ? body[k] : undefined]));

/**
 * The prospects chosen on the Eligible view. Each checkbox is its own field,
 * "p:<prospect id>", because the admin's form parser keeps one value per name.
 */
const chosenProspects = (body: Form | undefined) =>
  Object.keys(body ?? {}).flatMap((k) => {
    const id = k.startsWith("p:") ? k.slice(2) : "";
    return UUID_RE.test(id) ? [id] : [];
  });

/** A bulk preparation's result, as counts only (numbers, so nothing typed is reflected). */
function preparedNotice(q: Record<string, string | undefined>): string | undefined {
  const n = (k: PrepareOutcome) => (/^\d{1,3}$/.test(q[k] ?? "") ? Number(q[k]) : 0);
  const parts = [
    [n("prepared"), "draft prepared", "drafts prepared"],
    [n("existing"), "already had an open message", "already had an open message"],
    [n("ineligible"), "isn't eligible now", "aren't eligible now"],
    [n("refused"), "changed while being drafted and was left alone", "changed while being drafted and were left alone"],
    [n("failed"), "failed unexpectedly and was left alone (see the server log)", "failed unexpectedly and were left alone (see the server log)"],
  ] as const;
  const said = parts.filter(([count]) => count > 0).map(([count, one, many]) => `${count} ${count === 1 ? one : many}`);
  return said.length ? `${said.join("; ")}. Nothing was queued or sent: review each draft, then queue it from its page.` : "No prospect was prepared.";
}

/**
 * Outreach admin. Registered inside the admin scope, so every route here
 * requires a session, same-origin POSTs, and the admin security headers.
 * No route here sends: queued messages are sent by the dispatcher job
 * (npm run outreach:send), and only while the global switch is on.
 */
export async function outreachRoutes(app: FastifyInstance, opts: { config: Config; db: Db; sender: OutreachSender; googleFetch?: typeof fetch }) {
  const { config, db, sender } = opts;

  /** What the admin sees about the Gmail provider: configuration, authorization, and a live check. */
  const gmailStatus = async () => {
    if (config.outreachProvider !== "gmail") return null;
    const oauth = gmailOAuthConfig(config);
    const canAuthorize = !("problem" in oauth) && Boolean(oauth.redirectUri);
    const mailbox = config.outreachSender.email;
    // The account the stored authorization is for (read locally; the live check below confirms it with Gmail).
    const stored = gmailCredentialsFromConfig(config);
    const account = "problem" in stored ? null : stored.account;
    if ("problem" in oauth) return { mailbox, account, canAuthorize, authorized: false, problem: oauth.problem };
    if (!oauth.redirectUri) return { mailbox, account, canAuthorize, authorized: false, problem: "PUBLIC_API_URL isn't configured, so Google can't send the authorization back." };
    if (sender.problem) return { mailbox, account, canAuthorize, authorized: false, problem: sender.problem };
    const live = sender.check ? await sender.check() : null;
    return { mailbox, account, canAuthorize, authorized: live === null, problem: live };
  };
  const draftOptions = { siteUrl: config.publicSiteUrl, sender: config.outreachSender };
  const writeLimit = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };

  const html = (reply: FastifyReply, body: string, code = 200) => reply.code(code).type("text/html; charset=utf-8").send(body);
  const notFound = (reply: FastifyReply) => reply.code(404).type("text/plain").send("Not found");

  const renderDetail = async (reply: FastifyReply, id: string, extra: { notice?: string; errors?: string[]; values?: Values } = {}) => {
    const [detail, invitation] = await Promise.all([getOutreachDetail(db, id, config), invitationForOutreach(db, id)]);
    if (!detail) return notFound(reply);
    return html(reply, outreachDetailPage({ detail, invitation, ...extra }), reply.statusCode);
  };

  const renderControl = async (reply: FastifyReply, extra: { notice?: string; errors?: string[] } = {}) => {
    const now = new Date();
    const [sw, grouped, stuck, eligible, metrics, gmail, capacity, attention, activity, queue, openedInvitations] = await Promise.all([
      sendingSwitch(db),
      db.outreach.groupBy({ by: ["status"], _count: { _all: true } }),
      stuckMessages(db, now),
      prepareEligibleOutreach(db, { draft: draftOptions, compliance: config, apply: false, limit: 1_000 }),
      outreachMetrics(db),
      gmailStatus(),
      dailyCapacity(db, config, now),
      outreachAttention(db, now),
      recentActivity(db, now),
      waitingQueue(db),
      db.invitation.count({ where: { firstOpenedAt: { not: null } } }),
    ]);
    const counts = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
    const readiness = readinessErrors(config, sender);
    // What the dispatcher checks, plus the provider's live check (a revoked authorization).
    const blockers = [...new Set([...readiness, ...(gmail && !gmail.authorized && gmail.problem ? [gmail.problem] : [])])];
    const status = sendingStatus({ switchOn: sw.enabled, blockers, remaining: capacity.remaining, limit: capacity.limit, queued: counts.queued ?? 0 });
    // "Sending is ON" (tone pos) is the one state where a long-waiting queue means the sender job isn't running.
    const stale = queueLooksStale({ sendingLive: status.tone === "pos", switchedAt: sw.at, oldestQueuedAt: queue.oldestQueuedAt, lastSentAt: attention.lastSentAt, now });
    const totalMessages = grouped.reduce((n, g) => n + g._count._all, 0);
    const page = outreachControlPage(
      {
        sw,
        status,
        readiness,
        blockers,
        capacity,
        attention,
        provider: sender.enabled ? sender.name : null,
        counts,
        stuck,
        eligible,
        metrics,
        gmail,
        activity,
        waiting: { ...queue, stale },
        totalMessages,
        openedInvitations,
      },
      extra,
    );
    return html(reply, page, reply.statusCode);
  };

  /** Maps service errors to a page; anything unexpected is rethrown. */
  const handleError = (err: unknown, reply: FastifyReply, render: (errors: string[]) => unknown) => {
    if (!(err instanceof ProspectError)) throw err;
    if (err.kind === "not_found") return notFound(reply);
    reply.code(err.kind === "conflict" ? 409 : 400);
    return render(err.messages);
  };

  // ---------- control page ----------

  app.get<{ Querystring: { done?: string } }>("/admin/outreach", (req, reply) =>
    renderControl(reply, { notice: req.query.done ? NOTICES[req.query.done] : undefined }),
  );

  /**
   * Starts Google authorization of the outreach mailbox: a random state in a
   * signed, ten-minute cookie, then Google's consent screen. A plain link,
   * not a form, so the admin's form-action policy doesn't block the redirect.
   */
  app.get("/admin/outreach/gmail/authorize", async (req, reply) => {
    const oauth = gmailOAuthConfig(config);
    if ("problem" in oauth || !oauth.redirectUri || !config.adminSecret) {
      reply.code(400);
      return renderControl(reply, { errors: ["problem" in oauth ? oauth.problem : "PUBLIC_API_URL isn't configured, so Google can't send the authorization back."] });
    }
    const { state, cookie } = newOAuthState(config.adminSecret);
    reply.header("Set-Cookie", `${STATE_COOKIE}=${cookie}; Path=/oauth/gmail; HttpOnly; SameSite=Lax; Max-Age=600${config.secureCookies ? "; Secure" : ""}`);
    req.log.info("gmail authorization started");
    return reply.redirect(authorizationUrl(oauth, state, opts.googleFetch), 302);
  });

  app.post<{ Body: Form }>("/admin/outreach/switch", writeLimit, async (req, reply) => {
    const enabled = req.body?.enabled === "1";
    try {
      await setSendingSwitch(db, enabled, req.body?.reason, config, sender);
      req.log.warn({ enabled }, "outreach sending switch changed");
      return reply.redirect(`/admin/outreach?done=${enabled ? "switched_on" : "switched_off"}`, 303);
    } catch (err) {
      return handleError(err, reply, (errors) => renderControl(reply, { errors }));
    }
  });

  /**
   * Drafts first messages for the prospects chosen on the Eligible view (at
   * most PREPARE_LIMIT), each checked again first (prepareSelectedOutreach).
   * Drafts only: a draft is queued from its own page, after review. Never
   * sends. Redirects back with counts, so a refresh repeats nothing.
   */
  app.post<{ Body: Form }>("/admin/outreach/prepare", writeLimit, async (req, reply) => {
    const back = "/admin/outreach/messages?view=eligible";
    const chosen = chosenProspects(req.body);
    if (!chosen.length) return reply.redirect(`${back}&done=prepare_none`, 303);
    if (chosen.length > PREPARE_LIMIT) return reply.redirect(`${back}&done=prepare_too_many`, 303);
    const results = await prepareSelectedOutreach(db, chosen, {
      draft: draftOptions,
      onError: (prospectId, err) => req.log.error({ err, prospectId }, "outreach preparation failed for one prospect"),
    });
    const counts = Object.fromEntries(PREPARE_OUTCOMES.map((o) => [o, String(results.filter((r) => r.outcome === o).length)]));
    req.log.info({ counts, results: results.map((r) => ({ prospectId: r.prospectId, outcome: r.outcome, outreachId: r.outreachId })) }, "outreach drafts prepared");
    return reply.redirect(`${back}&done=prepared&${new URLSearchParams(counts)}`, 303);
  });

  // ---------- one message ----------

  // ---------- operations views (read-only) ----------

  /**
   * Messages, replies, invitation activity, and who is eligible now: read
   * from the stored records, filtered and paged in the database. Nothing here
   * drafts, queues, sends, or records anything. A static path, so it is
   * matched before /admin/outreach/:id.
   */
  app.get<{ Querystring: Record<string, string | undefined> }>("/admin/outreach/messages", async (req, reply) => {
    const q = req.query ?? {};
    const filters = parseMessageFilters(q);
    const [campaigns, grouped, unclassified, activity] = await Promise.all([
      messageCampaigns(db),
      db.outreach.groupBy({ by: ["status"], _count: { _all: true } }),
      db.outreachReply.count({ where: { outcome: null, outreach: { status: "replied" } } }),
      db.invitation.count({ where: { firstOpenedAt: { not: null } } }),
    ]);
    const statusCounts = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
    const messages = grouped.reduce((n, g) => n + g._count._all, 0);
    const nav = { eligible: null as number | null, messages, unclassified, activity };
    let data: MessagesPageData;
    if (filters.view === "replies") data = { view: "replies", filters, campaigns, nav, ...(await listReplies(db, filters)) };
    else if (filters.view === "activity") data = { view: "activity", filters, campaigns, nav, ...(await listActivity(db, filters)) };
    else if (filters.view === "eligible") {
      const eligible = await listEligible(db, filters, { draft: draftOptions, compliance: config });
      const notice =
        q.done === "prepared"
          ? preparedNotice(q)
          : q.done === "prepare_none"
            ? "Choose at least one prospect to prepare."
            : q.done === "prepare_too_many"
              ? `Choose at most ${PREPARE_LIMIT} prospects at a time.`
              : undefined;
      data = { view: "eligible", filters, campaigns, nav: { ...nav, eligible: eligible.total }, notice, ...eligible };
    } else data = { view: "messages", filters, campaigns, nav, statusCounts, ...(await listMessages(db, filters)) };
    return html(reply, outreachMessagesPage(data));
  });

  app.get<{ Params: { id: string }; Querystring: { done?: string } }>("/admin/outreach/:id", async (req, reply) => {
    if (!UUID_RE.test(req.params.id)) return notFound(reply);
    return renderDetail(reply, req.params.id, { notice: req.query.done ? NOTICES[req.query.done] : undefined });
  });

  // A first draft is prepared from the prospect's page (routes/admin.ts).

  /** Runs a service action on one message, then redirects with a notice or re-renders with its errors. */
  const action = (path: string, done: string, run: (id: string, body: Form) => Promise<unknown>, keep: string[] = []) =>
    app.post<{ Params: { id: string }; Body: Form }>(`/admin/outreach/:id/${path}`, writeLimit, async (req, reply) => {
      const { id } = req.params;
      if (!UUID_RE.test(id)) return notFound(reply);
      try {
        await run(id, req.body ?? {});
        return reply.redirect(`/admin/outreach/${id}?done=${done}`, 303);
      } catch (err) {
        return handleError(err, reply, (errors) => renderDetail(reply, id, { errors, values: pick(req.body, keep) }));
      }
    });

  action("queue", "queued", (id) => queueOutreach(db, id, config));

  /**
   * Discards a draft or a queued message so it can never be sent: needs a
   * reason and an explicit confirmation, like revoking an invitation. It stays
   * in the history as Cancelled. Its invitation is left exactly as it is
   * (revoking is its own action), and the prospect may get a new draft.
   */
  app.post<{ Params: { id: string }; Body: Form }>("/admin/outreach/:id/discard", writeLimit, async (req, reply) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return notFound(reply);
    const body = req.body ?? {};
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const errors = [
      ...(reason ? [] : ["Give a reason for discarding this message."]),
      ...(body.confirm === "1" ? [] : ["Confirm that this message should never be sent."]),
    ];
    if (errors.length) {
      reply.code(400);
      return renderDetail(reply, id, { errors, values: { intent: "discard", reason } });
    }
    try {
      await discardOutreach(db, id, reason);
      req.log.info({ outreachId: id }, "outreach discarded");
      return reply.redirect(`/admin/outreach/${id}?done=discarded`, 303);
    } catch (err) {
      return handleError(err, reply, (errs) => renderDetail(reply, id, { errors: errs, values: { intent: "discard", reason } }));
    }
  });
  action("reply", "reply", (id, body) => recordReply(db, id, { outcome: body.outcome, summary: body.summary, requireOutcome: true }), ["outcome", "summary"]);
  action("classify", "classified", (id, body) => classifyReply(db, id, body.outcome, new Date(), body.replyId), ["outcome", "replyId"]);
  app.post<{ Params: { id: string } }>("/admin/outreach/:id/confirm-sent", writeLimit, async (req, reply) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return notFound(reply);
    try {
      const result = await confirmStuckSent(db, id, sender.name);
      return reply.redirect(`/admin/outreach/${id}?done=${result.changed ? "confirmed" : "already_sent"}`, 303);
    } catch (err) {
      return handleError(err, reply, (errors) => renderDetail(reply, id, { errors }));
    }
  });

  /**
   * Revokes the message's invitation: needs a reason and an explicit
   * confirmation. The message, the prospect, and eligibility are untouched;
   * nothing is sent. Repeating it changes nothing (the first reason stays).
   */
  app.post<{ Params: { id: string }; Body: Form }>("/admin/outreach/:id/invitation/revoke", writeLimit, async (req, reply) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return notFound(reply);
    const body = req.body ?? {};
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const errors = [
      ...(reason ? [] : ["Give a reason for revoking the invitation."]),
      ...(body.confirm === "1" ? [] : ["Confirm that the invitation link should stop working."]),
    ];
    if (errors.length) {
      reply.code(400);
      return renderDetail(reply, id, { errors, values: { intent: "revoke", reason } });
    }
    try {
      const { changed } = await revokeInvitationForOutreach(db, id, reason);
      req.log.info({ outreachId: id, changed }, "invitation revoked");
      return reply.redirect(`/admin/outreach/${id}?done=${changed ? "invitation_revoked" : "invitation_already_revoked"}`, 303);
    } catch (err) {
      return handleError(err, reply, (errs) => renderDetail(reply, id, { errors: errs, values: { intent: "revoke", reason } }));
    }
  });

  app.post<{ Params: { id: string } }>("/admin/outreach/:id/follow-up", writeLimit, async (req, reply) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return notFound(reply);
    const original = await db.outreach.findUnique({ where: { id }, select: { prospectId: true } });
    if (!original) return notFound(reply);
    try {
      const { outreach, created } = await createOutreachDraft(db, original.prospectId, { ...draftOptions, followUpOfId: id });
      return reply.redirect(`/admin/outreach/${outreach.id}?done=${created ? "drafted" : "existing"}`, 303);
    } catch (err) {
      return handleError(err, reply, (errors) => renderDetail(reply, id, { errors }));
    }
  });
}
