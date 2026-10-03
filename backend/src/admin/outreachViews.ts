import type { OutreachFact } from "../outreach/compose.js";
import {
  AWAITING_REPLY,
  OUTREACH_KIND_LABELS,
  OUTREACH_STATUSES,
  OUTREACH_STATUS_LABELS,
  OUTREACH_STATUS_MEANINGS,
  REPLY_OUTCOMES,
  REPLY_OUTCOME_LABELS,
  type OutreachStatus,
} from "../outreach/lifecycle.js";
import type { invitationForOutreach } from "../invitations/service.js";
import { INVITATION_STATUS_LABELS, INVITATION_STATUS_MEANINGS, type InvitationStatus } from "../invitations/status.js";
import { hideInvitationTokens } from "../invitations/tokens.js";
import { invitationStatus } from "../invitations/status.js";
import type { FunnelRow } from "../outreach/metrics.js";
import type { SendingStatus } from "../outreach/dispatch.js";
import { NO_CAMPAIGN, PAGE_SIZE, STALE_QUEUE_MS, type ActivityRow, type EligibleRow, type InvitationSummary, type MessageFilters, type MessageRow, type MessageView } from "../outreach/operations.js";
import { PREPARE_LIMIT, type PrepareReport } from "../outreach/prepare.js";
import type { getOutreachDetail, outreachAttention, prospectOutreach } from "../outreach/service.js";
import { FIELD_LIMITS, scoringInputFromRecord } from "../prospects.js";
import { MAX_SCORE, bandFor, scoreProspect } from "../scoring.js";
import { appPage } from "./views.js";
import { bandBadge, crumbs, emptyState, errorSummary, esc, extLink, fieldErrors, fmtDate, notice, options, pageHead, qualificationBadge, section, statusBadge } from "./ui.js";

/* Admin pages for outreach. Server-rendered, no scripts, all values escaped. */

type Summary = Awaited<ReturnType<typeof prospectOutreach>>;
type Detail = NonNullable<Awaited<ReturnType<typeof getOutreachDetail>>>;
type Values = Record<string, string | undefined>;

export const outreachBadge = (s: OutreachStatus) => `<span class="st os-${s}">${esc(OUTREACH_STATUS_LABELS[s])}</span>`;

const SENDING_NOTE =
  "Nothing is emailed unless sending is switched on (Outreach page), the deployment is armed (OUTREACH_SENDING_ENABLED=1), and an email provider is configured (OUTREACH_PROVIDER).";

const replyOptions = (selected?: string) => options([["", "Choose…"], ...REPLY_OUTCOMES.map((r): [string, string] => [r, REPLY_OUTCOME_LABELS[r]])], selected);

/**
 * Free text that can quote an email (a reply, a provider's or a person's
 * reason): invitation tokens hidden first, then escaped. Escaping alone would
 * still show a quoted token.
 */
const safeText = (text: string | null | undefined) => esc(hideInvitationTokens(text ?? ""));

/** A link into the operations views; empty values are left out. */
export function messagesHref(params: Record<string, string | number | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return `/admin/outreach/messages${s ? `?${s}` : ""}`;
}

/**
 * The Outreach area's own navigation: the control page and each operations
 * view. The eligible count needs the eligibility dry run, so it is shown only
 * where that ran anyway (null elsewhere).
 */
function outreachNav(current: "overview" | MessageView, n: { eligible: number | null; messages: number; unclassified: number; activity: number }): string {
  const chip = (key: string, href: string, label: string, count: number | null, attn = false) =>
    `<a class="chip${attn ? " attn" : ""}" href="${esc(href)}"${current === key ? ' aria-current="true"' : ""}>${esc(label)}${count === null ? "" : ` <span class="n">${count}</span>`}</a>`;
  return `<nav class="chips" aria-label="Outreach views">${[
    chip("overview", "/admin/outreach", "Overview", null),
    chip("eligible", messagesHref({ view: "eligible" }), "Eligible now", n.eligible),
    chip("messages", messagesHref({}), "Messages", n.messages),
    chip("replies", messagesHref({ view: "replies" }), "Replies to classify", n.unclassified, n.unclassified > 0),
    chip("activity", messagesHref({ view: "activity" }), "Invitation activity", n.activity),
    chip("funnel", "/admin/outreach#funnel", "Funnel by campaign", null),
  ].join("")}</nav>`;
}

/** A message's invitation, in one cell: status, first open, opens, activation. */
function invitationCell(kind: MessageRow["kind"], inv: InvitationSummary | null): string {
  if (kind === "follow_up") return `<span class="small muted">Uses the first message's</span>`;
  if (!inv) return `<span class="small muted">No invitation</span>`;
  const status = invitationStatus(inv, inv.activatedAt);
  const [tone, glyph] = INVITATION_TONE[status];
  const lines = [
    inv.firstOpenedAt ? `First opened ${fmtDate(inv.firstOpenedAt)}` : "",
    inv.openCount ? `${inv.openCount} open${inv.openCount === 1 ? "" : "s"}` : "",
    inv.activatedAt ? `Activated ${fmtDate(inv.activatedAt)}` : "",
  ].filter(Boolean);
  return `<span class="vd ${tone}"><span aria-hidden="true">${glyph}</span> ${esc(INVITATION_STATUS_LABELS[status])}</span>${lines.map((l) => `<div class="sub">${l}</div>`).join("")}`;
}

/** Why a message is where it is, when its status has a reason. */
function statusReason(m: MessageRow): string {
  if (m.status === "queued" && m.sendStartedAt) return `Send started ${fmtDate(m.sendStartedAt)}, outcome unknown${m.lastSendError ? `: ${safeText(m.lastSendError)}` : ""}`;
  if (m.status === "queued" && m.lastSendError) return safeText(m.lastSendError);
  if ((m.status === "failed" || m.status === "bounced") && m.failureReason) return safeText(m.failureReason);
  if (m.status === "cancelled" && m.cancelReason) return safeText(m.cancelReason);
  return "";
}

const replyLabel = (m: Pick<MessageRow, "status" | "replyOutcome">) =>
  m.status !== "replied" ? '<span class="muted">—</span>' : m.replyOutcome ? esc(REPLY_OUTCOME_LABELS[m.replyOutcome]) : "<b>Not yet classified</b>";

const businessCell = (p: { id: string; businessName: string | null }, sub?: string) =>
  `<a class="name" href="/admin/prospects/${esc(p.id)}">${esc(p.businessName ?? "Prospect")}</a>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}`;

const campaignCell = (c: string | null) => (c ? `<code style="white-space:nowrap">${esc(c)}</code>` : '<span class="muted">—</span>');

/** The Outreach section of a prospect's page. */
export function outreachSection(prospectId: string, o: Summary): string {
  const id = esc(prospectId);
  const m = o.messages;
  const reached = (statuses: OutreachStatus[]) => m.filter((x) => statuses.includes(x.status)).length;
  const metrics: [string, number][] = [
    ["Drafts", m.length],
    ["Sent", m.filter((x) => x.sentAt).length],
    ["Delivered", m.filter((x) => x.deliveredAt).length],
    ["Bounced", reached(["bounced"])],
    ["Replies", reached(["replied"])],
    ["Follow-ups", m.filter((x) => x.kind === "follow_up").length],
  ];
  const rows = m
    .map(
      (x) => `<tr>
  <td><a class="name" href="/admin/outreach/${esc(x.id)}">${esc(x.subject)}</a><div class="sub">${esc(OUTREACH_KIND_LABELS[x.kind])} · <code>${esc(x.template)}</code></div></td>
  <td data-label="Status">${outreachBadge(x.status)}${x.replyOutcome ? `<div class="sub">${esc(REPLY_OUTCOME_LABELS[x.replyOutcome])}</div>` : ""}</td>
  <td data-label="To">${esc(x.recipientEmail)}</td>
  <td class="small muted" data-label="Updated">${fmtDate(x.statusChangedAt)}</td>
</tr>`,
    )
    .join("");
  const action = o.open
    ? `<p class="small" style="margin:0">An unsent message is open: <a href="/admin/outreach/${esc(o.open.id)}">${esc(o.open.subject)}</a>. Only one can be open at a time.</p>`
    : o.canDraft
      ? `<form method="post" action="/admin/prospects/${id}/outreach" class="inline-form"><button type="submit">Prepare outreach draft</button></form>
<span class="small muted">Generated from this prospect's stored evidence. Nothing is sent.</span>`
      : `<p class="small" style="margin:0"><b>No draft can be prepared:</b></p><ul class="small" style="margin:4px 0 0">${o.draftErrors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`;
  return section(
    "outreach",
    "Outreach",
    `<div class="card">
<dl class="metrics">${metrics.map(([l, n]) => `<div><dt>${esc(l)}</dt><dd>${n}</dd></div>`).join("")}</dl>
<div class="callout" style="margin:12px 0">${esc(SENDING_NOTE)}</div>
${
  m.length
    ? `<div class="scroll"><table class="tbl cards"><caption class="sr-only">Outreach messages</caption>
<thead><tr><th scope="col">Message</th><th scope="col">Status</th><th scope="col">To</th><th scope="col">Updated</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : emptyState("No outreach yet.")
}
<div style="margin-top:12px">${action}</div>
<p class="small muted" style="margin-top:10px">The commercial outcome (engaged, meeting, proposal, customer, lost) is the prospect's status above.</p>
</div>`,
  );
}

const factRow = (f: OutreachFact) => `<article class="ev">
  <div><b>${esc(f.statement)}</b></div>
  ${f.excerpt ? `<blockquote>${esc(f.excerpt)}</blockquote>` : ""}
  <div class="meta"><span>${f.signalKey ? `Signal <code>${esc(f.signalKey)}</code>` : "Stored prospect field"}</span>${f.sourceUrl ? `<span>Source: ${extLink(f.sourceUrl)}</span>` : ""}</div>
</article>`;

type InvitationView = NonNullable<Awaited<ReturnType<typeof invitationForOutreach>>>;

/** Each status pairs its tone with a glyph and words (the .vd pills of the review pages). */
const INVITATION_TONE: Record<InvitationStatus, [string, string]> = {
  not_opened: ["vd-quiet", "○"],
  opened: ["vd-info", "◔"],
  activated: ["vd-pos", "✓"],
  revoked: ["vd-neg", "✕"],
};

/**
 * The invitation in a first message: its status and what it recorded, and
 * Revoke behind the same two-step disclosure as Discovery's Disregard, with
 * a reason and an explicit confirmation. Never the token or its hash.
 */
function invitationSection(o: Detail, inv: InvitationView | null | undefined, values: Values, errors: string[]): string {
  if (o.kind !== "initial") {
    return o.followUpOf
      ? section("invitation", "Invitation", `<p class="small muted" style="margin:0">A follow-up uses the invitation of <a href="/admin/outreach/${esc(o.followUpOf.id)}">the first message</a>.</p>`)
      : "";
  }
  if (!inv) return section("invitation", "Invitation", `<div class="card">${emptyState("No invitation for this message.")}</div>`);
  const [tone, glyph] = INVITATION_TONE[inv.status];
  const facts: [string, string][] = [
    ["Created", fmtDate(inv.createdAt)],
    ["First opened", fmtDate(inv.firstOpenedAt)],
    ["Last opened", fmtDate(inv.lastOpenedAt)],
    ["Opens", String(inv.openCount)],
    ["Activated", fmtDate(inv.activatedAt)],
    ...(inv.revokedAt ? ([["Revoked", fmtDate(inv.revokedAt)], ["Reason", esc(inv.revokeReason ?? "")]] as [string, string][]) : []),
  ];
  const own = values.intent === "revoke";
  const revoke = inv.revokedAt
    ? ""
    : `<details class="rv-disregard" style="margin-top:14px"${own ? " open" : ""}><summary class="btn btn-danger">× Revoke invitation…</summary>
  <form method="post" action="/admin/outreach/${esc(o.id)}/invitation/revoke" class="rv-reason-form" novalidate>
    <input type="hidden" name="intent" value="revoke">
    <p class="small" style="margin:0 0 10px">The link stops working for anyone who has it. Everything it recorded is kept, and the message itself doesn't change.</p>
    <label class="lbl" for="f-rreason">Why? <span class="muted" style="font-weight:400">(kept on the record)</span></label>
    <input id="f-rreason" type="text" name="reason" value="${esc(own ? values.reason : "")}" maxlength="200"${own && errors.length ? ' aria-invalid="true"' : ""}>
    <label class="small" style="display:flex;gap:8px;align-items:center;margin-top:10px"><input type="checkbox" name="confirm" value="1"> Yes, stop this invitation link from working.</label>
    ${own ? errors.map((e) => `<div class="ferr">${esc(e)}</div>`).join("") : ""}
    <div style="margin-top:10px"><button type="submit" class="btn-danger">Revoke invitation</button></div>
  </form></details>`;
  return section(
    "invitation",
    "Invitation",
    `<div class="card">
  <p style="margin:0 0 10px"><span class="vd ${tone}"><span aria-hidden="true">${glyph}</span> ${esc(INVITATION_STATUS_LABELS[inv.status])}</span> <span class="small muted">${esc(INVITATION_STATUS_MEANINGS[inv.status])}</span></p>
  <dl class="kv">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>
  <p class="small muted" style="margin:10px 0 0">An open is counted each time the invitation page loads. Activated means a visitor who arrived through the link ran a real scan (the sample report doesn't count).</p>
  ${revoke}
</div>`,
  );
}

/**
 * The message's state, as the first thing on its page: the status's own label
 * and meaning (lifecycle.ts), and for the two unsent states, that nothing has
 * been sent and what would send it.
 */
function messageState(o: Detail): string {
  const label = OUTREACH_STATUS_LABELS[o.status].toUpperCase();
  const [tone, glyph, title, detail]: [string, string, string, string] =
    o.status === "draft"
      ? ["warn", "✎", `${label} — NOT SENT`, `Review the message, the evidence it uses, and its invitation below. Queue it when it's right, or discard it. ${SENDING_NOTE}`]
      : o.status === "queued" && o.sendStartedAt
        ? ["neg", "⚠", `${label} — SEND OUTCOME UNKNOWN`, `A send started ${fmtDate(o.sendStartedAt)} and its outcome is unknown: check the provider, then record it below.`]
        : o.status === "queued"
          ? ["warn", "→", `${label} — NOT SENT BY THIS ACTION`, `It waits for the dispatcher. ${SENDING_NOTE} Discard it to stop it.`]
          : o.status === "bounced" || o.status === "failed"
            ? ["neg", "✕", label, OUTREACH_STATUS_MEANINGS[o.status]]
            : o.status === "cancelled"
              ? ["quiet", "—", label, OUTREACH_STATUS_MEANINGS[o.status]]
              : ["pos", "✓", label, OUTREACH_STATUS_MEANINGS[o.status]];
  return `<section class="o-status t-${tone}" aria-labelledby="state-h"><div class="o-status-main">
  <h2 id="state-h" class="o-status-l"><span aria-hidden="true">${glyph}</span> ${esc(title)}</h2>
  <p class="o-status-d">${esc(detail)}</p>
</div></section>`;
}

/** Discarding: the same two-step disclosure as revoking, with a reason and an explicit confirmation. */
function discardForm(o: Detail, values: Values, errors: string[]): string {
  const own = values.intent === "discard";
  const what = o.status === "draft" ? "draft" : "queued message";
  return `<div class="card"><details class="rv-disregard"${own ? " open" : ""}><summary class="btn btn-danger">× Discard this ${what}…</summary>
  <form method="post" action="/admin/outreach/${esc(o.id)}/discard" class="rv-reason-form" novalidate>
    <p class="small" style="margin:0 0 10px">It will never be sent, and stays in the history as Cancelled. Its invitation is left as it is: revoke that separately if its link should stop working. The prospect can be prepared again.</p>
    <label class="lbl" for="f-dreason">Why? <span class="muted" style="font-weight:400">(kept on the record)</span></label>
    <input id="f-dreason" type="text" name="reason" value="${esc(own ? values.reason : "")}" maxlength="${FIELD_LIMITS.reason}"${own && errors.length ? ' aria-invalid="true"' : ""}>
    <label class="small" style="display:flex;gap:8px;align-items:center;margin-top:10px"><input type="checkbox" name="confirm" value="1"> Yes, this message should never be sent.</label>
    ${own ? errors.map((e) => `<div class="ferr">${esc(e)}</div>`).join("") : ""}
    <div style="margin-top:10px"><button type="submit" class="btn-danger">Discard ${what}</button></div>
  </form></details></div>`;
}

export function outreachDetailPage(opts: { detail: Detail; invitation?: InvitationView | null; notice?: string; errors?: string[]; values?: Values }): string {
  const { detail: o, values = {} } = opts;
  const id = esc(o.id);
  const fe = fieldErrors(opts.errors);
  const facts = (Array.isArray(o.evidence) ? o.evidence : []) as unknown as OutreachFact[];
  const name = o.prospect.businessName ?? "Prospect";
  const open = o.status === "draft" || o.status === "queued";
  const awaiting = AWAITING_REPLY.includes(o.status);
  const stuck = o.status === "queued" && o.sendStartedAt !== null;

  const actions = [
    o.status === "draft"
      ? o.queueErrors.length
        ? `<div class="card"><div class="card-h" style="margin:0">Not ready to queue</div><ul class="small" style="margin:6px 0 0">${o.queueErrors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>`
        : `<form method="post" action="/admin/outreach/${id}/queue" class="card stack">
  <div class="card-h" style="margin:0">Queue for sending</div>
  <div><button type="submit">Queue</button> <span class="small muted">Queueing sends nothing: the dispatcher sends queued messages only while sending is switched on. A first message moves the prospect to Ready to contact. Everything is checked again first.</span></div>
</form>`
      : "",
    stuck
      ? `<form method="post" action="/admin/outreach/${id}/confirm-sent" class="card stack">
  <div class="card-h" style="margin:0">Send started ${fmtDate(o.sendStartedAt)}, outcome unknown</div>
  <p class="small" style="margin:0">Check the provider. If it was sent, record it here; if it wasn't, discard this message. It is never retried automatically unless the provider can deduplicate it.${o.lastSendError ? ` Last error: ${esc(hideInvitationTokens(o.lastSendError))}` : ""}</p>
  <div><button type="submit">It was sent</button></div>
</form>`
      : "",
    open ? discardForm(o, values, opts.errors ?? []) : "",
    awaiting
      ? `<form method="post" action="/admin/outreach/${id}/reply" class="card stack">
  <div class="card-h" style="margin:0">Record a reply</div>
  <div class="field"><label for="f-outcome">How did they reply?</label><select id="f-outcome" name="outcome">${replyOptions(values.outcome)}</select></div>
  <div class="field"><label for="f-summary">Summary <span class="muted" style="font-weight:400">(optional)</span></label><textarea id="f-summary" name="summary" maxlength="${FIELD_LIMITS.note}">${esc(values.summary)}</textarea></div>
  <div><button type="submit">Record reply</button> <span class="small muted">Interested → Engaged, Not interested → Lost, Asked not to be contacted → Do not contact.</span></div>
</form>
<form method="post" action="/admin/outreach/${id}/follow-up" class="inline-form"><button class="btn-secondary" type="submit">Prepare follow-up draft</button></form>`
      : "",
    o.status === "replied" && !o.replyOutcome
      ? `<form method="post" action="/admin/outreach/${id}/classify" class="card stack">
  <div class="card-h" style="margin:0">Classify this reply</div>
  <div class="field"><label for="f-outcome">How did they reply?</label><select id="f-outcome" name="outcome">${replyOptions(values.outcome)}</select></div>
  <div><button type="submit">Classify</button></div>
</form>`
      : "",
  ].filter(Boolean);

  const factList = facts.length ? facts.map(factRow).join("") : `<div class="card">${emptyState("No facts recorded.")}</div>`;
  // Why this business was contacted at all: its qualification, from the scoring the prospect pages use.
  const qualification = scoreProspect(scoringInputFromRecord(o.prospect));

  return appPage(
    `${o.subject} · ReclaimBay admin`,
    "outreach",
    `${crumbs([{ label: "Outreach", href: "/admin/outreach" }, { label: "Messages", href: messagesHref({ status: o.status }) }, { label: o.subject }])}
${notice(opts.notice)}${errorSummary(opts.errors, fe, "Not done")}
${pageHead({
  title: o.subject,
  badges: `${outreachBadge(o.status)}<span class="muted small">${esc(OUTREACH_KIND_LABELS[o.kind])}</span><span class="muted small">Prospect: ${statusBadge(o.prospect.status)}</span>`,
})}
${messageState(o)}
${o.suppressed ? `<div class="callout warn" style="margin-bottom:14px">${esc(o.recipientEmail)} is suppressed: it will never be emailed again.</div>` : ""}

${section(
  "message",
  "Message",
  `<div class="grid-2">
  <div class="card"><dl class="kv">
    <dt>Business</dt><dd><a href="/admin/prospects/${esc(o.prospect.id)}">${esc(name)}</a> ${statusBadge(o.prospect.status)}</dd>
    <dt>Qualification</dt><dd>${qualificationBadge(qualification.qualification)} <span class="small muted">Opportunity score <b>${qualification.score}</b>/${MAX_SCORE}</span> ${bandBadge(qualification.band)}</dd>
    <dt>To</dt><dd>${esc(o.recipientEmail)}<div class="src">found at ${extLink(o.recipientSourceUrl)}</div></dd>
    <dt>From</dt><dd>${o.senderEmail ? esc(`${o.senderName ?? ""} <${o.senderEmail}>`.trim()) : '<span class="muted">Not configured (OUTREACH_SENDER_EMAIL)</span>'}</dd>
    <dt>Subject</dt><dd>${esc(o.subject)}</dd>
  </dl></div>
  <div class="card"><dl class="kv">
    <dt>Template</dt><dd><code>${esc(o.template)}</code></dd>
    <dt>Campaign</dt><dd>${o.campaign ? `<code>${esc(o.campaign)}</code>` : "—"}</dd>
    <dt>Generated</dt><dd>${fmtDate(o.generatedAt)}</dd>
    ${o.followUpOf ? `<dt>Follows up</dt><dd><a href="/admin/outreach/${esc(o.followUpOf.id)}">${esc(o.followUpOf.subject)}</a></dd>` : ""}
    ${o.followUps.map((f) => `<dt>Follow-up</dt><dd><a href="/admin/outreach/${esc(f.id)}">${esc(f.subject)}</a> ${outreachBadge(f.status)}</dd>`).join("")}
  </dl></div>
</div>
<div class="card" style="margin-top:14px"><pre class="msg">${esc(hideInvitationTokens(o.body))}</pre>${
    hideInvitationTokens(o.body) !== o.body
      ? `<p class="small muted" style="margin:10px 0 0">The invitation link is hidden here, so opening it from the admin can&#39;t count as the business&#39;s visit. The email carries the full link.</p>`
      : ""
  }</div>`,
)}

${invitationSection(o, opts.invitation, values, opts.errors ?? [])}

${section("facts", "Evidence used", `<p class="small muted" style="margin:-4px 0 10px">Every personal detail in the message comes from one of these stored facts.</p>${factList}`)}

${section(
  "lifecycle",
  "What happened",
  `<div class="card"><dl class="kv">
    <dt>Queued</dt><dd>${fmtDate(o.queuedAt)}</dd>
    <dt>Send started</dt><dd>${fmtDate(o.sendStartedAt)}${o.sendAttempts ? ` <span class="muted small">${o.sendAttempts} attempt(s)</span>` : ""}</dd>
    <dt>Sent</dt><dd>${fmtDate(o.sentAt)}${o.provider ? ` <span class="muted small">${esc(o.provider)} ${esc(o.providerMessageId)}</span>` : ""}</dd>
    <dt>Delivered</dt><dd>${fmtDate(o.deliveredAt)}</dd>
    <dt>Bounced / failed</dt><dd>${fmtDate(o.failedAt)}${o.failureReason ? ` · ${esc(hideInvitationTokens(o.failureReason))}` : ""}</dd>
    <dt>Reply</dt><dd>${fmtDate(o.repliedAt)}${o.status === "replied" ? ` · <b>${esc(o.replyOutcome ? REPLY_OUTCOME_LABELS[o.replyOutcome] : "Not yet classified")}</b>` : ""}${o.replySummary ? `<div class="small">${esc(hideInvitationTokens(o.replySummary))}</div>` : ""}</dd>
    <dt>Cancelled</dt><dd>${fmtDate(o.cancelledAt)}${o.cancelReason ? ` · ${esc(hideInvitationTokens(o.cancelReason))}` : ""}</dd>
  </dl>
  <h3 class="card-h" style="margin-top:16px">Events</h3>
  <ul class="timeline">${o.events.map((e) => `<li><span class="when">${fmtDate(e.createdAt)}</span><b>${esc(e.type)}</b>${e.detail ? ` · ${esc(hideInvitationTokens(e.detail))}` : ""}</li>`).join("")}</ul></div>`,
)}

${actions.length ? section("actions", "Actions", `<div class="stack">${actions.join("\n")}</div>`) : ""}`,
  );
}

// ---------- the outreach control page ----------

export interface ControlPageData {
  sw: { enabled: boolean; reason: string; at: Date | null };
  /** Whether mail is going out now, and why not (dispatch.ts sendingStatus). */
  status: SendingStatus;
  /** Everything blocking sending, the switch aside: what must be fixed before it can be switched on. */
  readiness: string[];
  /** The same, plus the provider's live check. */
  blockers: string[];
  /** The daily limit as the dispatcher counts it. */
  capacity: { used: number; limit: number; remaining: number };
  attention: Awaited<ReturnType<typeof outreachAttention>>;
  /** The enabled provider's name; null when none can send. */
  provider: string | null;
  counts: Partial<Record<OutreachStatus, number>>;
  stuck: { id: string; subject: string; recipientEmail: string; sendStartedAt: Date | null; lastSendError: string | null }[];
  eligible: PrepareReport;
  metrics: FunnelRow[];
  /** Invitations opened or activated in the last 7 days (operations.ts recentActivity). */
  activity: { count: number; rows: ActivityRow[] };
  /** Queued messages not yet claimed by a dispatcher, and whether that looks like a stopped sender job (queueLooksStale). */
  waiting: { count: number; oldestQueuedAt: Date | null; stale: boolean };
  /** All messages, for the navigation. */
  totalMessages: number;
  /** Opened invitations, for the navigation. */
  openedInvitations: number;
  /**
   * The Gmail provider's state; null when OUTREACH_PROVIDER isn't gmail. `mailbox` is the
   * sender (OUTREACH_SENDER_EMAIL); `account` the Google account authorized to send as it.
   */
  gmail?: { mailbox: string | null; account: string | null; canAuthorize: boolean; authorized: boolean; problem: string | null } | null;
}

const METRIC_COLUMNS: [keyof FunnelRow, string][] = [
  ["drafted", "Drafted"],
  ["queued", "Queued"],
  ["prospectsEntered", "Prospects reached"],
  ["sent", "Sent"],
  ["delivered", "Delivered"],
  ["bounced", "Bounced"],
  ["failed", "Failed"],
  ["replied", "Replied"],
  ["positive", "Positive"],
  ["negative", "Negative"],
  ["unsubscribed", "Unsubscribed"],
  ["complained", "Complaints"],
  ["invited", "Invited"],
  ["opened", "Opened"],
  ["activated", "Activated"],
  ["meetings", "Meetings"],
  ["proposals", "Proposals"],
  ["customers", "Customers"],
  ["lost", "Lost"],
];

function gmailCard(g: NonNullable<ControlPageData["gmail"]>): string {
  const account = g.account ?? g.mailbox;
  const status = g.authorized
    ? `<p><b>Authorized as ${esc(account)}${account !== g.mailbox ? `, sending as ${esc(g.mailbox)}` : ""}.</b> <span class="small muted">Checked with Gmail just now.</span></p>`
    : `<p><b>${g.problem && /reauthoriz/i.test(g.problem) ? "Reauthorization required." : "Not ready."}</b></p><p class="small" style="margin:0">${esc(g.problem)}</p>`;
  const action = g.canAuthorize
    ? `<p style="margin-top:12px"><a class="btn${g.authorized ? " btn-secondary" : ""}" href="/admin/outreach/gmail/authorize">${g.authorized ? "Reauthorize" : "Authorize"} ${esc(g.mailbox)} with Google</a></p>
<p class="small muted" style="margin:6px 0 0">Sign in as ${esc(g.mailbox)}, or as the Google account that has it as a verified Send As address. Google asks for two permissions only: send email, and read email (bounces and replies). Afterwards you get a sealed value to store as GMAIL_REFRESH_TOKEN_SEALED.</p>`
    : "";
  return status + action;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One "needs attention" group: a heading with its count, a short why, and the messages (linked). Items are already escaped. */
function attentionGroup(tone: "warn" | "neg" | "pos", glyph: string, title: string, total: number, why: string, items: string[]): string {
  if (!total) return "";
  const more = total > items.length ? `<li class="muted">and ${total - items.length} more</li>` : "";
  return `<div class="o-attn t-${tone}"><h3><span aria-hidden="true">${glyph}</span> ${esc(title)} <span class="q-count">${total}</span></h3><p class="q-hint">${esc(why)}</p><ul>${items.join("")}${more}</ul></div>`;
}

export function outreachControlPage(d: ControlPageData, opts: { notice?: string; errors?: string[] } = {}): string {
  const fe = fieldErrors(opts.errors);
  const s = d.status;
  const a = d.attention;

  // The one action that matters now: stop while on; switch on only when everything else is ready.
  const action = d.sw.enabled
    ? `<form method="post" action="/admin/outreach/switch"><input type="hidden" name="enabled" value="0"><button class="btn-danger" type="submit">Stop all sending now</button><div class="small muted" style="margin-top:4px">Takes effect before the next message.</div></form>`
    : d.readiness.length
      ? ""
      : `<form method="post" action="/admin/outreach/switch" class="row" style="align-items:flex-end"><input type="hidden" name="enabled" value="1">
  <div style="flex:1;min-width:220px"><label class="lbl" for="f-reason">Reason for switching on</label><input id="f-reason" type="text" name="reason" maxlength="500" required></div>
  <button type="submit">Switch sending on</button></form>`;
  const notReady =
    !d.sw.enabled && d.readiness.length
      ? `<div class="o-blockers"><p><b>Sending can't be switched on until:</b></p><ul>${d.readiness.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>`
      : "";
  // Blocked by the provider's authorization: the fix is further down this page, so point to it.
  const providerFix = d.sw.enabled && s.tone === "neg" && Boolean(d.gmail && !d.gmail.authorized && d.gmail.canAuthorize);
  const statusBlock = `<section class="o-status t-${s.tone}" aria-labelledby="sending-h">
  <div class="o-status-main">
    <h2 id="sending-h" class="o-status-l"><span aria-hidden="true">${s.glyph}</span> ${esc(s.label)}</h2>
    <p class="o-status-d">${esc(s.detail)}${providerFix ? ` <a href="#provider">Fix it under Email provider ↓</a>` : ""}</p>
    <p class="small muted" style="margin:0">Switch: ${esc(d.sw.reason)}${d.sw.at ? ` · ${fmtDate(d.sw.at)}` : ""} · Last message sent: ${a.lastSentAt ? fmtDate(a.lastSentAt) : "never"}</p>
  </div>
  ${action ? `<div class="o-status-act">${action}</div>` : ""}
  ${notReady}
</section>`;

  const tile = (tone: "pos" | "warn" | "info", glyph: string, n: string, label: string, hint: string, zero: boolean) =>
    `<div class="q-tile t-${tone}${zero ? " zero" : ""}"><span class="q-tile-n">${n}</span><span class="q-tile-l"><span aria-hidden="true">${glyph}</span> ${esc(label)}</span><span class="q-tile-h">${esc(hint)}</span></div>`;
  const c = d.capacity;
  const eligibleN = d.eligible.drafted.length;
  const drafts = d.counts.draft ?? 0;
  const queued = d.counts.queued ?? 0;
  const tiles = `<section class="q-tiles" aria-label="Outreach at a glance">
${tile("pos", "✓", String(eligibleN), "Eligible now", "can get a first draft", eligibleN === 0)}
${tile("info", "✎", String(drafts), "Drafts", "prepared, not yet queued", drafts === 0)}
${tile("info", "→", String(queued), "Queued", "waiting to be sent", queued === 0)}
${tile(c.remaining === 0 ? "warn" : "info", "✉", `${c.used} / ${c.limit}`, "Sent, last 24 hours", `${c.remaining} left under the daily limit`, c.used === 0)}
</section>`;

  const msg = (id: string, subject: string, extra: string) => `<li><a href="/admin/outreach/${esc(id)}">${esc(subject)}</a> <span class="small muted">${extra}</span></li>`;
  const w = d.waiting;
  const attention = [
    w.stale
      ? attentionGroup(
          "warn",
          "⏱",
          "Queued mail isn't going out",
          w.count,
          `Sending is on and nothing blocks it, but nothing has been sent for over ${STALE_QUEUE_MS / 3_600_000} hours and the oldest queued message has waited since ${fmtDate(w.oldestQueuedAt)}. Check that the sender job (npm run outreach:send -- --apply) is scheduled and running; if it runs only in business hours, this is expected outside them.`,
          [`<li><a href="${esc(messagesHref({ status: "queued" }))}">See the queued messages</a></li>`],
        )
      : "",
    attentionGroup(
      "warn",
      "⚠",
      "Send outcome unknown",
      d.stuck.length,
      "The provider may or may not have sent these. Check it, then record It was sent or discard the message.",
      d.stuck.slice(0, 20).map((m) => msg(m.id, m.subject, `to ${esc(m.recipientEmail)} · started ${fmtDate(m.sendStartedAt)}${m.lastSendError ? ` · ${safeText(m.lastSendError)}` : ""}`)),
    ),
    attentionGroup(
      "warn",
      "↩",
      "Replies to classify",
      a.replyCount,
      "Read each reply and record how they answered. An opt-out must be honoured promptly.",
      a.replies.map((m) => msg(m.id, m.subject, `from ${esc(m.recipientEmail)} · ${fmtDate(m.repliedAt)}`)),
    ),
    attentionGroup(
      "neg",
      "✕",
      "Refused by the provider, last 7 days",
      a.failureCount,
      "Not sent. An invalid address is suppressed; anything else can be prepared again once the cause is fixed.",
      a.failures.map((m) => msg(m.id, m.subject, `to ${esc(m.recipientEmail)} · ${fmtDate(m.failedAt)}${m.failureReason ? ` · ${safeText(m.failureReason)}` : ""}`)),
    ),
    attentionGroup(
      "pos",
      "✓",
      "Invitation activity, last 7 days",
      d.activity.count,
      "These businesses opened their invitation, or ran a real scan after opening it. Worth a look before any follow-up.",
      d.activity.rows.map((r) =>
        msg(
          r.outreach.id,
          r.prospect.businessName ?? r.outreach.subject,
          `${r.latestKind === "activated" ? "ran a real scan" : `opened the invitation${r.openCount > 1 ? ` (${r.openCount} opens)` : ""}`} · ${fmtDate(r.latest)}`,
        ),
      ),
    ),
  ].filter(Boolean);
  const attentionBlock = attention.length ? section("attention", "Needs attention", `<div class="stack">${attention.join("\n")}</div>`) : "";

  const skipped = d.eligible.skipped;
  const prepare = section(
    "prepare",
    "Prepare messages",
    `<div class="card">
<p style="margin:0 0 12px">${eligibleN ? `<b>${plural(eligibleN, "prospect is", "prospects are")} eligible</b> for a first message now.` : "<b>No prospect is eligible</b> for a first message now."} <span class="muted">Each draft is written from that prospect's stored evidence; nothing is sent here.</span></p>
${
  eligibleN
    ? `<p style="margin:0"><a class="btn" href="${esc(messagesHref({ view: "eligible" }))}">Choose prospects to prepare</a></p>
<p class="small muted" style="margin:10px 0 0">Prepare drafts for the prospects you choose, review each one, then queue it from its page. Queueing doesn't send: the dispatcher sends queued messages only while sending is on.</p>`
    : ""
}
${
  skipped.length
    ? `<details class="o-why"><summary>Why ${plural(skipped.length, "other prospect isn't", "other prospects aren't")} eligible</summary><ul class="small">${skipped
        .slice(0, 50)
        .map((p) => `<li><a href="/admin/prospects/${esc(p.prospectId)}#outreach">${esc(p.businessName ?? "Prospect")}</a>: ${esc(p.reasons.join(" "))}</li>`)
        .join("")}</ul></details>`
    : ""
}</div>`,
  );

  const provider = section(
    "provider",
    "Email provider",
    `<div class="card">${
      d.gmail
        ? gmailCard(d.gmail)
        : d.provider
          ? `<p style="margin:0"><b>${esc(d.provider)}</b> is configured.</p>`
          : `<p style="margin:0"><b>No email provider is configured.</b> <span class="small muted">Set OUTREACH_PROVIDER=gmail and its credentials (see OUTREACH.md). Until then nothing can be sent.</span></p>`
    }</div>`,
  );

  const counts = OUTREACH_STATUSES.map((st) => `<div><dt>${esc(OUTREACH_STATUS_LABELS[st])}</dt><dd>${d.counts[st] ?? 0}</dd></div>`).join("");
  // Invited, Opened, and Activated lead to the messages behind them. The last row is the total ("all"): no campaign filter.
  const funnelLink = (r: FunnelRow, isTotal: boolean, k: keyof FunnelRow): string | null => {
    const campaign = isTotal ? undefined : r.campaign;
    if (k === "invited") return messagesHref({ kind: "initial", campaign });
    if (k === "opened") return messagesHref({ view: "activity", campaign });
    if (k === "activated") return messagesHref({ view: "activity", campaign, activated: "1" });
    return null;
  };
  const metricRows = d.metrics
    .map((r, i, all) => {
      const cells = METRIC_COLUMNS.map(([k]) => {
        const href = r[k] ? funnelLink(r, i === all.length - 1, k) : null;
        return `<td class="num">${href ? `<a href="${esc(href)}">${r[k]}</a>` : r[k]}</td>`;
      }).join("");
      return `<tr><td><code>${esc(r.campaign)}</code></td>${cells}</tr>`;
    })
    .join("");
  const total = Object.values(d.counts).reduce((n, v) => n + (v ?? 0), 0);
  const details = `<section class="section" aria-label="Details">
<details class="disc" id="messages"><summary><h2>Messages by status</h2><span class="disc-sum">${plural(total, "message", "messages")}</span></summary><div class="disc-body"><dl class="metrics">${counts}</dl></div></details>
<details class="disc" id="funnel"><summary><h2>Funnel by campaign</h2><span class="disc-sum">drafted to customer</span></summary><div class="disc-body">
<div class="scroll"><table class="tbl"><caption class="sr-only">Outreach funnel by campaign</caption><thead><tr><th scope="col">Campaign</th>${METRIC_COLUMNS.map(([, l]) => `<th scope="col" class="num">${esc(l)}</th>`).join("")}</tr></thead><tbody>${metricRows}</tbody></table></div>
<p class="small muted">Computed from the stored messages, their events, and prospect status history. Outcomes (meetings to lost) count prospects that ever reached that status, by the campaign of their first sent message. Delivered counts only what a provider reports; Gmail reports no deliveries, so with Gmail it stays 0 and "sent, not bounced" is the closest measure. Invited counts invitations made; Opened, those opened at least once; Activated, those where a visitor who arrived through the link ran a real scan after opening it (the sample report doesn't count). Revenue isn't recorded yet.</p>
</div></details>
</section>`;

  return appPage(
    "Outreach · ReclaimBay admin",
    "outreach",
    `${notice(opts.notice)}${errorSummary(opts.errors, fe, "Not done")}
${pageHead({ title: "Outreach", lede: "Approved prospects get one personal email each, written from their stored evidence. Nothing is sent unless sending is switched on." })}
${outreachNav("overview", { eligible: eligibleN, messages: d.totalMessages, unclassified: a.replyCount, activity: d.openedInvitations })}
${statusBlock}
${tiles}
${attentionBlock}
${prepare}
${provider}
${details}`,
  );
}

// ---------- operations views (/admin/outreach/messages) ----------

export type MessagesPageData = {
  filters: MessageFilters;
  campaigns: { campaign: string; count: number }[];
  nav: { eligible: number | null; messages: number; unclassified: number; activity: number };
} & (
  | { view: "messages"; total: number; rows: MessageRow[]; statusCounts: Partial<Record<OutreachStatus, number>> }
  | { view: "replies"; total: number; unclassified: number; rows: MessageRow[] }
  | { view: "activity"; total: number; rows: ActivityRow[] }
  /** `notice`: the result of a preparation, counts only (routes/adminOutreach.ts preparedNotice). */
  | { view: "eligible"; total: number; capped: boolean; rows: EligibleRow[]; notice?: string }
);

const VIEW_TITLES: Record<MessageView, [string, string]> = {
  messages: ["Messages", "Every outreach message and what happened to it. Open one for its full history and actions."],
  replies: ["Replies", "Messages the business answered. Unclassified replies come first: read each one and record how they answered."],
  activity: ["Invitation activity", "Invitations that were opened, newest activity first. Activated means a visitor who arrived through the link ran a real scan."],
  eligible: ["Eligible now", "Prospects a first message could be prepared for right now, highest score first. Nothing here prepares or sends anything."],
};

function filterForm(d: MessagesPageData): string {
  const f = d.filters;
  if (d.view === "eligible") return "";
  const campaign = `<div><label class="lbl" for="f-campaign">Campaign</label><select id="f-campaign" name="campaign">${options(
    [["", "Any"], ...d.campaigns.map((c): [string, string] => [c.campaign, `${c.campaign} (${c.count})`])],
    f.campaign ?? undefined,
  )}</select></div>`;
  const status =
    d.view === "messages"
      ? `<div><label class="lbl" for="f-status">Status</label><select id="f-status" name="status">${options([["", "Any"], ...OUTREACH_STATUSES.map((s): [string, string] => [s, OUTREACH_STATUS_LABELS[s]])], f.status ?? undefined)}</select></div>`
      : "";
  const kind =
    d.view !== "activity"
      ? `<div><label class="lbl" for="f-kind">Kind</label><select id="f-kind" name="kind">${options([["", "Any"], ["initial", OUTREACH_KIND_LABELS.initial], ["follow_up", OUTREACH_KIND_LABELS.follow_up]], f.kind ?? undefined)}</select></div>`
      : `<div><label class="lbl" for="f-activated">Activation</label><select id="f-activated" name="activated">${options([["", "Opened or activated"], ["1", "Activated only"]], f.activated ? "1" : undefined)}</select></div>`;
  return `<form class="card filters" method="get" action="/admin/outreach/messages" aria-label="Filter ${esc(VIEW_TITLES[d.view][0].toLowerCase())}">
  ${d.view === "messages" ? "" : `<input type="hidden" name="view" value="${esc(d.view)}">`}
  <div class="filter-row">${status}${kind}${campaign}
    <div class="filter-actions"><button type="submit">Apply filters</button><a class="btn btn-secondary" href="${esc(messagesHref({ view: d.view === "messages" ? undefined : d.view }))}">Reset</a></div>
  </div>
</form>`;
}

/** "Showing 51–100 of 240", with Previous and Next links that keep the filters. */
function pager(d: MessagesPageData): string {
  const f = d.filters;
  const from = d.total === 0 ? 0 : (f.page - 1) * PAGE_SIZE + 1;
  const to = Math.min(d.total, f.page * PAGE_SIZE);
  const keep = {
    view: f.view === "messages" ? undefined : f.view,
    status: f.status,
    kind: f.kind,
    campaign: f.campaign,
    activated: f.activated ? "1" : undefined,
  };
  const prev = f.page > 1 ? `<a href="${esc(messagesHref({ ...keep, page: f.page - 1 }))}">← Previous</a>` : "";
  const next = to < d.total ? `<a href="${esc(messagesHref({ ...keep, page: f.page + 1 }))}">Next →</a>` : "";
  const extra =
    d.view === "replies" ? ` · ${d.unclassified} not yet classified` : d.view === "eligible" && d.capped ? " · only the first 1,000 eligible prospects are checked" : "";
  return `<div class="result-line"><span><b>${d.total ? `Showing ${from}–${to} of ${d.total}` : "Nothing to show"}</b>${esc(extra)}</span><span>${[prev, next].filter(Boolean).join(" · ")}</span></div>`;
}

const table = (caption: string, head: string[], rows: string[]) =>
  `<div class="scroll"><table class="tbl cards"><caption class="sr-only">${esc(caption)}</caption>
<thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("\n")}</tbody></table></div>`;

function messagesTable(rows: MessageRow[]): string {
  return table(
    "Outreach messages",
    ["Message", "Business", "Campaign", "Status", "Queued / sent", "Invitation", "Reply"],
    rows.map((m) => {
      const reason = statusReason(m);
      return `<tr${m.status === "replied" && !m.replyOutcome ? ' class="attn"' : ""}>
  <td><a class="name" href="/admin/outreach/${esc(m.id)}">${esc(m.subject)}</a><div class="sub">${esc(OUTREACH_KIND_LABELS[m.kind])} · <code>${esc(m.template)}</code></div></td>
  <td data-label="Business">${businessCell(m.prospect, m.recipientEmail)}</td>
  <td data-label="Campaign">${campaignCell(m.campaign)}</td>
  <td data-label="Status">${outreachBadge(m.status)}${reason ? `<div class="sub">${reason}</div>` : ""}</td>
  <td class="small" data-label="Queued / sent">${m.queuedAt ? `Queued ${fmtDate(m.queuedAt)}` : '<span class="muted">Not queued</span>'}${m.sentAt ? `<div>Sent ${fmtDate(m.sentAt)}</div>` : ""}</td>
  <td data-label="Invitation">${invitationCell(m.kind, m.invitation)}</td>
  <td class="small" data-label="Reply">${replyLabel(m)}</td>
</tr>`;
    }),
  );
}

function repliesTable(rows: MessageRow[]): string {
  return table(
    "Replies",
    ["Business", "Campaign", "Message", "Replied", "Classification", "Reply summary"],
    rows.map(
      (m) => `<tr${m.replyOutcome ? "" : ' class="attn"'}>
  <td>${businessCell(m.prospect, m.recipientEmail)}</td>
  <td data-label="Campaign">${campaignCell(m.campaign)}</td>
  <td data-label="Message"><a href="/admin/outreach/${esc(m.id)}">${esc(m.subject)}</a><div class="sub">${esc(OUTREACH_KIND_LABELS[m.kind])}</div></td>
  <td class="small" data-label="Replied">${fmtDate(m.repliedAt)}</td>
  <td data-label="Classification">${replyLabel(m)}</td>
  <td class="small" data-label="Reply summary">${m.replySummary ? safeText(m.replySummary) : '<span class="muted">No summary recorded</span>'}</td>
</tr>`,
    ),
  );
}

function activityTable(rows: ActivityRow[]): string {
  return table(
    "Invitation activity",
    ["Business", "Campaign", "Message", "First opened", "Opens", "Activated", "Latest activity"],
    rows.map((a) => {
      const status = invitationStatus(a, a.activatedAt);
      const [tone, glyph] = INVITATION_TONE[status];
      return `<tr>
  <td>${businessCell(a.prospect, a.outreach.recipientEmail)}</td>
  <td data-label="Campaign">${campaignCell(a.campaign)}</td>
  <td data-label="Message"><a href="/admin/outreach/${esc(a.outreach.id)}">${esc(a.outreach.subject)}</a><div class="sub">${outreachBadge(a.outreach.status)}</div></td>
  <td class="small" data-label="First opened">${fmtDate(a.firstOpenedAt)}</td>
  <td class="num" data-label="Opens">${a.openCount}</td>
  <td data-label="Activated"><span class="vd ${tone}"><span aria-hidden="true">${glyph}</span> ${esc(INVITATION_STATUS_LABELS[status])}</span>${a.activatedAt ? `<div class="sub">${fmtDate(a.activatedAt)}</div>` : ""}</td>
  <td class="small" data-label="Latest activity">${a.latestKind === "activated" ? "Ran a real scan" : "Opened the invitation"}<div class="sub">${fmtDate(a.latest)}</div></td>
</tr>`;
    }),
  );
}

/**
 * The eligible list is one form: tick prospects and prepare their drafts
 * together (POST /admin/outreach/prepare), or prepare one with its row's own
 * button, which posts to the prospect's existing draft route instead. Each
 * checkbox is its own field ("p:<id>"), since the admin's form parser keeps
 * one value per name. Drafts only: nothing here queues or sends.
 */
function eligibleTable(rows: EligibleRow[]): string {
  return `<form method="post" action="/admin/outreach/prepare" aria-label="Prepare drafts for eligible prospects">
<div class="row" style="margin-bottom:10px"><button type="submit">Prepare drafts for the chosen prospects</button>
<span class="small muted">Tick the ones to prepare (at most ${PREPARE_LIMIT} at a time). Each is checked again first. Drafts only: nothing is queued or sent. Review each draft, then queue it from its page.</span></div>
${table(
    "Eligible prospects",
    ["Choose", "Prospect", "Location", "Business email", "Qualification", "Opportunity score", "Evidence", "Draft"],
    rows.map(
      (p) => `<tr>
  <td data-label="Choose"><input type="checkbox" name="p:${esc(p.id)}" value="1" aria-label="Choose ${esc(p.businessName ?? "this prospect")}"></td>
  <td>${businessCell(p)}</td>
  <td data-label="Location">${esc([p.city, p.state].filter(Boolean).join(", ")) || '<span class="muted">—</span>'}</td>
  <td data-label="Business email">${esc(p.email)}${p.emailSourceUrl ? `<div class="src">found at ${extLink(p.emailSourceUrl)}</div>` : ""}</td>
  <td data-label="Qualification">${qualificationBadge(p.qualification)}</td>
  <td data-label="Opportunity score"><span class="score-cell"><b>${p.score}</b><span class="of">/${MAX_SCORE}</span></span> ${bandBadge(bandFor(p.score))}</td>
  <td class="small" data-label="Evidence">${p.evidence} excerpt${p.evidence === 1 ? "" : "s"}<div class="sub">${p.known}/${p.totalSignals} signals known</div></td>
  <td data-label="Draft"><button type="submit" class="btn-secondary" formaction="/admin/prospects/${esc(p.id)}/outreach">Prepare draft</button></td>
</tr>`,
    ),
  )}
</form>`;
}

/** Quick links to the messages in each state, with counts (Messages view). */
function statusLinks(d: Extract<MessagesPageData, { view: "messages" }>): string {
  const links: [OutreachStatus, string][] = [
    ["draft", "Drafts to review"],
    ["queued", OUTREACH_STATUS_LABELS.queued],
    ["sent", OUTREACH_STATUS_LABELS.sent],
    ["replied", OUTREACH_STATUS_LABELS.replied],
    ["bounced", OUTREACH_STATUS_LABELS.bounced],
    ["failed", OUTREACH_STATUS_LABELS.failed],
    ["cancelled", OUTREACH_STATUS_LABELS.cancelled],
  ];
  const chip = (status: OutreachStatus | null, label: string, n: number) =>
    `<a class="chip${status === "draft" && n > 0 ? " attn" : ""}" href="${esc(messagesHref({ status }))}"${d.filters.status === status ? ' aria-current="true"' : ""}>${esc(label)} <span class="n">${n}</span></a>`;
  const all = Object.values(d.statusCounts).reduce((n, v) => n + (v ?? 0), 0);
  return `<nav class="chips" aria-label="Messages by status">${[chip(null, "Any status", all), ...links.map(([s, l]) => chip(s, l, d.statusCounts[s] ?? 0))].join("")}</nav>`;
}

const EMPTY: Record<MessageView, [string, string]> = {
  messages: ["No messages match.", "Messages appear here once drafts are prepared."],
  replies: ["No replies yet.", "Replies are recorded by the mailbox reader (npm run outreach:inbox) or by a person on a message's page."],
  activity: ["No invitation has been opened yet.", "An invitation appears here once the business opens its link."],
  eligible: ["No prospect is eligible right now.", "The Outreach page explains why each prospect isn't."],
};

export function outreachMessagesPage(d: MessagesPageData): string {
  const [title, lede] = VIEW_TITLES[d.view];
  const body =
    d.view === "messages"
      ? d.rows.length && messagesTable(d.rows)
      : d.view === "replies"
        ? d.rows.length && repliesTable(d.rows)
        : d.view === "activity"
          ? d.rows.length && activityTable(d.rows)
          : d.rows.length && eligibleTable(d.rows);
  const [emptyTitle, emptyHint] = EMPTY[d.view];
  return appPage(
    `${title} · Outreach · ReclaimBay admin`,
    "outreach",
    `${crumbs([{ label: "Outreach", href: "/admin/outreach" }, { label: title }])}
${d.view === "eligible" ? notice(d.notice) : ""}
${pageHead({ title, lede: esc(lede) })}
${outreachNav(d.view, d.nav)}
${d.view === "messages" ? statusLinks(d) : ""}
${filterForm(d)}
${pager(d)}
${body || `<div class="card">${emptyState(emptyTitle, emptyHint)}</div>`}`,
  );
}
