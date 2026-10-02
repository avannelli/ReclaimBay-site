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
import type { FunnelRow } from "../outreach/metrics.js";
import type { PrepareReport } from "../outreach/prepare.js";
import type { getOutreachDetail, prospectOutreach } from "../outreach/service.js";
import { FIELD_LIMITS } from "../prospects.js";
import { appPage } from "./views.js";
import { crumbs, emptyState, errorSummary, esc, extLink, fieldErrors, fmtDate, notice, options, pageHead, section, statusBadge } from "./ui.js";

/* Admin pages for outreach. Server-rendered, no scripts, all values escaped. */

type Summary = Awaited<ReturnType<typeof prospectOutreach>>;
type Detail = NonNullable<Awaited<ReturnType<typeof getOutreachDetail>>>;
type Values = Record<string, string | undefined>;

export const outreachBadge = (s: OutreachStatus) => `<span class="st os-${s}">${esc(OUTREACH_STATUS_LABELS[s])}</span>`;

const SENDING_NOTE =
  "Nothing is emailed unless sending is switched on (Outreach page), the deployment is armed (OUTREACH_SENDING_ENABLED=1), and an email provider is configured (OUTREACH_PROVIDER).";

const replyOptions = (selected?: string) => options([["", "Choose…"], ...REPLY_OUTCOMES.map((r): [string, string] => [r, REPLY_OUTCOME_LABELS[r]])], selected);

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

export function outreachDetailPage(opts: { detail: Detail; notice?: string; errors?: string[]; values?: Values }): string {
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
  <div><button type="submit">Queue</button> <span class="small muted">A first message moves the prospect to Ready to contact. It is sent only when sending is switched on.</span></div>
</form>`
      : "",
    stuck
      ? `<form method="post" action="/admin/outreach/${id}/confirm-sent" class="card stack">
  <div class="card-h" style="margin:0">Send started ${fmtDate(o.sendStartedAt)}, outcome unknown</div>
  <p class="small" style="margin:0">Check the provider. If it was sent, record it here; if it wasn't, discard this message. It is never retried automatically unless the provider can deduplicate it.${o.lastSendError ? ` Last error: ${esc(o.lastSendError)}` : ""}</p>
  <div><button type="submit">It was sent</button></div>
</form>`
      : "",
    open
      ? `<form method="post" action="/admin/outreach/${id}/discard" class="card stack">
  <div class="card-h" style="margin:0">Discard this ${o.status === "draft" ? "draft" : "message"}</div>
  <div class="field"><label for="f-reason">Reason <span class="muted" style="font-weight:400">(optional)</span></label><input id="f-reason" type="text" name="reason" value="${esc(values.reason)}" maxlength="${FIELD_LIMITS.reason}"></div>
  <div><button class="btn-danger" type="submit">Discard</button> <span class="small muted">It stays in the history as Cancelled.</span></div>
</form>`
      : "",
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

  return appPage(
    `${o.subject} · ReclaimBay admin`,
    "outreach",
    `${crumbs([{ label: "Prospects", href: "/admin/prospects" }, { label: name, href: `/admin/prospects/${o.prospect.id}#outreach` }, { label: "Outreach" }])}
${notice(opts.notice)}${errorSummary(opts.errors, fe, "Not done")}
${pageHead({
  title: o.subject,
  badges: `${outreachBadge(o.status)}<span class="muted small">${esc(OUTREACH_KIND_LABELS[o.kind])}</span><span class="muted small">Prospect: ${statusBadge(o.prospect.status)}</span>`,
  lede: esc(OUTREACH_STATUS_MEANINGS[o.status]),
})}
<div class="callout${o.status === "draft" ? " warn" : ""}" style="margin-bottom:14px">${esc(SENDING_NOTE)}</div>
${o.suppressed ? `<div class="callout warn" style="margin-bottom:14px">${esc(o.recipientEmail)} is suppressed: it will never be emailed again.</div>` : ""}

${section(
  "message",
  "Message",
  `<div class="grid-2">
  <div class="card"><dl class="kv">
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
<div class="card" style="margin-top:14px"><pre class="msg">${esc(o.body)}</pre></div>`,
)}

${section("facts", "Evidence used", `<p class="small muted" style="margin:-4px 0 10px">Every personal detail in the message comes from one of these stored facts.</p>${factList}`)}

${section(
  "lifecycle",
  "What happened",
  `<div class="card"><dl class="kv">
    <dt>Queued</dt><dd>${fmtDate(o.queuedAt)}</dd>
    <dt>Send started</dt><dd>${fmtDate(o.sendStartedAt)}${o.sendAttempts ? ` <span class="muted small">${o.sendAttempts} attempt(s)</span>` : ""}</dd>
    <dt>Sent</dt><dd>${fmtDate(o.sentAt)}${o.provider ? ` <span class="muted small">${esc(o.provider)} ${esc(o.providerMessageId)}</span>` : ""}</dd>
    <dt>Delivered</dt><dd>${fmtDate(o.deliveredAt)}</dd>
    <dt>Bounced / failed</dt><dd>${fmtDate(o.failedAt)}${o.failureReason ? ` · ${esc(o.failureReason)}` : ""}</dd>
    <dt>Reply</dt><dd>${fmtDate(o.repliedAt)}${o.status === "replied" ? ` · <b>${esc(o.replyOutcome ? REPLY_OUTCOME_LABELS[o.replyOutcome] : "Not yet classified")}</b>` : ""}${o.replySummary ? `<div class="small">${esc(o.replySummary)}</div>` : ""}</dd>
    <dt>Cancelled</dt><dd>${fmtDate(o.cancelledAt)}${o.cancelReason ? ` · ${esc(o.cancelReason)}` : ""}</dd>
  </dl>
  <h3 class="card-h" style="margin-top:16px">Events</h3>
  <ul class="timeline">${o.events.map((e) => `<li><span class="when">${fmtDate(e.createdAt)}</span><b>${esc(e.type)}</b>${e.detail ? ` · ${esc(e.detail)}` : ""}</li>`).join("")}</ul></div>`,
)}

${actions.length ? section("actions", "Actions", `<div class="stack">${actions.join("\n")}</div>`) : ""}`,
  );
}

// ---------- the outreach control page ----------

export interface ControlPageData {
  sw: { enabled: boolean; reason: string; at: Date | null };
  /** Everything blocking sending, the switch aside. */
  readiness: string[];
  counts: Partial<Record<OutreachStatus, number>>;
  stuck: { id: string; subject: string; recipientEmail: string; sendStartedAt: Date | null; lastSendError: string | null }[];
  eligible: PrepareReport;
  metrics: FunnelRow[];
  /**
   * The Gmail provider's state; null when OUTREACH_PROVIDER isn't gmail. `mailbox` is the
   * sender (OUTREACH_SENDER_EMAIL); `account` the Google account authorized to send as it.
   */
  gmail?: { mailbox: string | null; account: string | null; canAuthorize: boolean; authorized: boolean; problem: string | null } | null;
  prepared?: PrepareReport;
}

const METRIC_COLUMNS: [keyof FunnelRow, string][] = [
  ["drafted", "Drafted"],
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

export function outreachControlPage(d: ControlPageData, opts: { notice?: string; errors?: string[] } = {}): string {
  const fe = fieldErrors(opts.errors);
  const switchCard = d.sw.enabled
    ? `<p><b>Sending is ON.</b> <span class="small muted">${esc(d.sw.reason)} · ${fmtDate(d.sw.at)}</span></p>
<form method="post" action="/admin/outreach/switch" class="row"><input type="hidden" name="enabled" value="0"><button class="btn-danger" type="submit">Stop all sending now</button><span class="small muted">Takes effect before the next message.</span></form>`
    : `<p><b>Sending is OFF.</b> <span class="small muted">${esc(d.sw.reason)}${d.sw.at ? ` · ${fmtDate(d.sw.at)}` : ""}</span></p>
${
  d.readiness.length
    ? `<p class="small" style="margin:0"><b>It can't be switched on until:</b></p><ul class="small" style="margin:4px 0 0">${d.readiness.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`
    : `<form method="post" action="/admin/outreach/switch" class="row" style="align-items:flex-end"><input type="hidden" name="enabled" value="1">
  <div style="flex:1;min-width:240px"><label class="lbl" for="f-reason">Reason</label><input id="f-reason" type="text" name="reason" maxlength="500"></div>
  <button type="submit">Switch sending on</button></form>`
}`;
  const counts = OUTREACH_STATUSES.map((s) => `<div><dt>${esc(OUTREACH_STATUS_LABELS[s])}</dt><dd>${d.counts[s] ?? 0}</dd></div>`).join("");
  const stuck = d.stuck.length
    ? `<ul class="small">${d.stuck.map((s) => `<li><a href="/admin/outreach/${esc(s.id)}">${esc(s.subject)}</a> to ${esc(s.recipientEmail)} · started ${fmtDate(s.sendStartedAt)}${s.lastSendError ? ` · ${esc(s.lastSendError)}` : ""}</li>`).join("")}</ul>`
    : `<p class="small muted" style="margin:0">None.</p>`;
  const prepared = d.prepared
    ? `<div class="callout" style="margin-bottom:12px">Prepared ${d.prepared.drafted.length} draft(s)${d.prepared.queued.length ? `, queued ${d.prepared.queued.length}` : ""}.${d.prepared.notQueued.length ? ` ${d.prepared.notQueued.length} not queued: ${esc(d.prepared.notQueued[0]!.reasons.join(" "))}` : ""}</div>`
    : "";
  const metricRows = d.metrics
    .map((r) => `<tr><td><code>${esc(r.campaign)}</code></td>${METRIC_COLUMNS.map(([k]) => `<td class="num">${r[k]}</td>`).join("")}</tr>`)
    .join("");

  return appPage(
    "Outreach · ReclaimBay admin",
    "outreach",
    `${notice(opts.notice)}${errorSummary(opts.errors, fe, "Not done")}
${pageHead({ title: "Outreach", lede: "Preparing, sending, and measuring outreach. Every number below is computed from the stored messages, their events, and prospect status history." })}
${section("switch", "Sending", `<div class="card">${switchCard}</div>`)}
${d.gmail ? section("gmail", "Gmail", `<div class="card">${gmailCard(d.gmail)}</div>`) : ""}
${section(
  "prepare",
  "Automatic preparation",
  `<div class="card">${prepared}
<p style="margin:0 0 10px"><b>${d.eligible.drafted.length}</b> prospect(s) can get a first draft now (checked ${d.eligible.checked}; ${d.eligible.skipped.length} not eligible).</p>
<div class="row"><form method="post" action="/admin/outreach/prepare" class="inline-form"><button type="submit">Prepare drafts for all eligible prospects</button></form>
<form method="post" action="/admin/outreach/prepare" class="inline-form"><input type="hidden" name="queue" value="1"><button class="btn-secondary" type="submit">Prepare and queue</button></form></div>
<p class="small muted" style="margin-top:10px">Queueing checks the sender identity and each message's opt-out and postal address. Queued messages are sent only while sending is on.</p></div>`,
)}
${section("queue", "Messages", `<div class="card"><dl class="metrics">${counts}</dl></div>`)}
${section("stuck", "Send outcome unknown", `<div class="card">${stuck}</div>`)}
${section(
  "funnel",
  "Funnel by campaign",
  `<div class="scroll"><table class="tbl"><thead><tr><th scope="col">Campaign</th>${METRIC_COLUMNS.map(([, l]) => `<th scope="col" class="num">${esc(l)}</th>`).join("")}</tr></thead><tbody>${metricRows}</tbody></table></div>
<p class="small muted">Outcomes (meetings to lost) count prospects that ever reached that status, by the campaign of their first sent message. Delivered counts only what a provider reports; Gmail reports no deliveries, so with Gmail it stays 0 and "sent, not bounced" is the closest measure. Revenue isn't recorded yet.</p>`,
)}`,
  );
}
