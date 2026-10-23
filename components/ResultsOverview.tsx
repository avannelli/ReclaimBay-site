import { allocatePercents, formatAverage, formatDateTime } from "@/lib/format";
import { TIER_LABEL, TIER_ORDER, type FollowUpPlan } from "@/lib/followUps";
import type { Analysis } from "@/lib/types";
import FollowUpList, { TIER_TONE, ageLabel, tierHint } from "./FollowUpList";
import PrivacyBadge from "./PrivacyBadge";

/**
 * The results overview shown before purchase, and for the fictional sample.
 * Every figure comes from the uploaded export; cards appear only when the
 * export has the fields behind them. For a real report it never shows
 * customer names, vehicles or contact details: who to call is the paid list.
 */

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

function Kpi({ label, value, note, accent }: { label: string; value: string; note: string; accent: string }) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-line bg-surface px-4 py-4 shadow-sm sm:px-5">
      <span aria-hidden className={`absolute inset-x-0 top-0 h-0.5 ${accent}`} />
      <p className="text-[11px] font-semibold uppercase tracking-widest text-ink-3">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums text-ink sm:text-3xl">{value}</p>
      <p className="mt-1 text-sm leading-snug text-ink-3">{note}</p>
    </div>
  );
}

function Panel({ title, subtitle, children, id }: { title: string; subtitle?: string; children: React.ReactNode; id?: string }) {
  return (
    <section id={id} aria-label={title} className="report-section">
      <header>
        <h2 className="text-base font-semibold tracking-tight text-navy">{title}</h2>
        {subtitle && <p className="mt-0.5 text-sm text-ink-3">{subtitle}</p>}
      </header>
      <div className="px-5 py-5 sm:px-6">{children}</div>
    </section>
  );
}

export default function ResultsOverview({
  analysis: a,
  plan,
  isSample,
  fileName,
  analyzedAt,
  money,
}: {
  analysis: Analysis;
  plan: FollowUpPlan;
  isSample: boolean;
  fileName: string;
  analyzedAt: Date;
  money: (n: number) => string;
}) {
  const followUps = plan.followUps.length;
  const byCustomer = plan.basis === "customer";
  const showRecency = a.hasDates && a.recency.recent.count + a.recency.older.count > 0;
  const [recentPct] = allocatePercents([a.recency.recent.value, a.recency.older.value]);
  const callFirst = plan.tiers.call_first;
  const reachable = followUps - plan.contact.none.count;
  const topCategories = a.categories.slice(0, 3);
  const categoryPcts = allocatePercents(a.categories.map((c) => c.value));
  const tierPcts = allocatePercents(TIER_ORDER.map((t) => plan.tiers[t].value));
  const top = plan.followUps[0];

  const kpis = [
    byCustomer
      ? { label: "Follow-ups", value: followUps.toLocaleString("en-US"), note: plan.combinedFollowUps ? `Customers and vehicles · ${plural(plan.combinedFollowUps, "has", "have")} several jobs` : "Customers and vehicles", accent: "bg-navy/70" }
      : { label: "Declined jobs", value: a.count.toLocaleString("en-US"), note: "No customer column, so each line stands alone", accent: "bg-navy/70" },
    showRecency && { label: `Last ${a.recency.thresholdDays} days`, value: money(a.recency.recent.value), note: `${recentPct}% of dated declined value`, accent: "bg-positive" },
    plan.hasContactFields && { label: "Reachable", value: `${reachable.toLocaleString("en-US")} of ${followUps.toLocaleString("en-US")}`, note: `${byCustomer ? "Follow-ups" : "Jobs"} with a phone or email`, accent: "bg-opportunity" },
    { label: "Average job", value: formatAverage(a.average, a.showCents), note: `Across ${plural(a.count, "declined job", "declined jobs")}`, accent: "bg-slate-400" },
  ].filter((k): k is { label: string; value: string; note: string; accent: string } => Boolean(k));

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-1">
        <p className="eyebrow text-ink-2">{isSample ? "Fictional sample" : "Free scanner preview"}</p>
        <h1 className="text-3xl font-medium tracking-tight text-ink sm:text-4xl">
          {isSample ? "A complete report, on made-up data" : "Your declined-work follow-up plan"}
        </h1>
        <p className="wrap-anywhere text-sm text-ink-2">
          {fileName} · Analyzed {formatDateTime(analyzedAt)}
        </p>
      </header>

      {isSample && (
        <p className="rounded-xl border border-navy/10 bg-navy/[0.035] px-4 py-3 text-sm text-ink-2">
          Every shop, customer, phone number and email here is made up. Open your own export to see your numbers.
        </p>
      )}

      <section aria-label="Reported declined value" className="report-hero relative overflow-hidden">
        <div className="grid gap-8 lg:grid-cols-12 lg:items-end lg:gap-10">
          <div className="min-w-0 lg:col-span-7">
            <p className="eyebrow text-opportunity">Reported declined value</p>
            <p className="mt-3 text-5xl font-semibold leading-none tracking-tight tabular-nums sm:text-7xl">{money(a.total)}</p>
            <p className="mt-4 text-base text-slate-300">
              <span className="font-semibold text-white">{plural(a.count, "declined job", "declined jobs")}</span>
              {byCustomer && <> across <span className="font-semibold text-white">{plural(followUps, "follow-up", "follow-ups")}</span></>}
              {showRecency && <> · <span className="font-semibold text-positive-bright">{money(a.recency.recent.value)}</span> declined in the last {a.recency.thresholdDays} days</>}
            </p>
            <p className="mt-3 max-w-lg text-sm leading-relaxed text-slate-400">
              Estimates from your export, not recovered revenue. Confirm each job is still needed before following up.
            </p>
            <PrivacyBadge onDark className="mt-5" />
          </div>
          <div className="min-w-0 border-t border-white/15 pt-5 lg:col-span-5 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
            {plan.hasContactFields ? (
              <>
                <p className="eyebrow text-slate-400">Call first</p>
                <p className="mt-3 text-3xl font-semibold tracking-tight tabular-nums text-white">
                  {plural(callFirst.count, "follow-up", "follow-ups")}
                </p>
                <p className="mt-1 text-lg font-semibold tabular-nums text-opportunity">{money(callFirst.value)}</p>
                <p className="mt-2 text-sm text-slate-400">{tierHint("call_first", plan.hasDates)}, ordered by value.</p>
              </>
            ) : (
              <>
                <p className="eyebrow text-slate-400">Contact details</p>
                <p className="mt-3 text-sm leading-relaxed text-slate-300">
                  This export has no phone or email column, so follow-ups can&rsquo;t be ranked by who you can reach. Include them in your export to get a Call first list.
                </p>
              </>
            )}
          </div>
        </div>
      </section>

      <div className={`grid grid-cols-2 gap-3 sm:gap-4 ${kpis.length >= 4 ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
        {kpis.map((k) => (
          <Kpi key={k.label} {...k} />
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {plan.hasContactFields && (
          <Panel title="Follow-up priority" subtitle={byCustomer ? "Customer vehicles grouped by who to call first." : "Declined jobs grouped by who to call first."}>
            <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-slate-100" aria-hidden>
              {TIER_ORDER.map((t, i) => tierPcts[i] > 0 && <span key={t} className={TIER_TONE[t].bar} style={{ width: `${tierPcts[i]}%` }} />)}
            </div>
            <dl className="mt-4 divide-y divide-line">
              {TIER_ORDER.filter((t) => plan.hasDates || t !== "next").map((t) => (
                <div key={t} className="flex items-baseline justify-between gap-4 py-2.5">
                  <dt className="min-w-0">
                    <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                      <span aria-hidden className={`h-2 w-2 rounded-full ${TIER_TONE[t].dot}`} />
                      {TIER_LABEL[t]}
                    </span>
                    <span className="block pl-4 text-xs text-ink-3">{tierHint(t, plan.hasDates)}</span>
                  </dt>
                  <dd className="shrink-0 text-right text-sm tabular-nums text-ink-2">
                    {plural(plan.tiers[t].count, "follow-up", "follow-ups")}
                    <span className="block font-semibold text-ink">{money(plan.tiers[t].value)}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </Panel>
        )}
        <Panel title="Where declined value is concentrated" subtitle="Largest service categories by declined value.">
          <ul className="space-y-3.5">
            {topCategories.map((c, i) => (
              <li key={c.label}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0 font-medium text-ink">{c.label}</span>
                  <span className="shrink-0 tabular-nums text-ink-2">
                    <span className="font-semibold text-ink">{money(c.value)}</span> · {categoryPcts[i]}%
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100" aria-hidden>
                  <span className={`block h-full rounded-full ${i === 0 ? "bg-opportunity" : "bg-navy/70"}`} style={{ width: `${Math.max(categoryPcts[i], 2)}%` }} />
                </div>
                <p className="mt-1 text-xs text-ink-3">{plural(c.count, "job", "jobs")}</p>
              </li>
            ))}
          </ul>
          {a.categories.length > topCategories.length && (
            <p className="mt-4 border-t border-line pt-3 text-xs text-ink-3">
              {plural(a.categories.length - topCategories.length, "more category", "more categories")} in the complete report.
            </p>
          )}
        </Panel>
      </div>

      {isSample ? (
        <section aria-labelledby="sample-call-list" className="report-section">
          <header>
            <h2 id="sample-call-list" className="text-base font-semibold tracking-tight text-navy">The call list in the complete report</h2>
            <p className="mt-0.5 text-sm text-ink-3">
              Every customer and vehicle, with its declined jobs, contact details from the export and how long ago it was declined.
            </p>
          </header>
          <FollowUpList plan={plan} money={money} />
        </section>
      ) : (
        top && (
          <section aria-labelledby="top-follow-up" className="report-section">
            <header>
              <h2 id="top-follow-up" className="text-base font-semibold tracking-tight text-navy">Top of your call list</h2>
              <p className="mt-0.5 text-sm text-ink-3">Names, vehicles and contact details are in the complete report.</p>
            </header>
            <div className="grid grid-cols-[2rem_minmax(0,1fr)_auto] gap-x-3 px-4 py-4 sm:grid-cols-[2.25rem_minmax(0,1fr)_auto] sm:gap-x-5 sm:px-6">
              <span className="pt-0.5 text-xs font-semibold tabular-nums text-ink-3">01</span>
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <span className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${TIER_TONE[top.tier].chip}`}>{TIER_LABEL[top.tier]}</span>
                  <span className="text-ink-3">
                    {ageLabel(top.latestAgeDays)} · {top.reachable ? (top.phone ? "Phone on file" : "Email on file") : "No contact details"}
                  </span>
                </p>
                <ul className="mt-2 space-y-0.5 text-sm text-ink">
                  {top.items.map((o) => (
                    <li key={o.id} className="wrap-anywhere">
                      {o.service} <span className="tabular-nums text-ink-3">· {money(o.amount)}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <p className="text-right text-base font-semibold tabular-nums text-navy">{money(top.total)}</p>
            </div>
            {followUps > 1 && (
              <div className="relative border-t border-line px-4 py-4 sm:px-6">
                <div aria-hidden className="space-y-2.5 opacity-60">
                  {Array.from({ length: Math.min(3, followUps - 1) }, (_, i) => (
                    <div key={i} className="flex items-center gap-4">
                      <span className="h-2.5 w-6 rounded bg-slate-200" />
                      <span className="h-2.5 flex-1 rounded bg-slate-200" style={{ maxWidth: `${70 - i * 12}%` }} />
                      <span className="h-2.5 w-14 rounded bg-slate-200" />
                    </div>
                  ))}
                </div>
                <p className="mt-3 flex items-center gap-2 text-sm font-medium text-ink-2">
                  <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4 text-navy" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                    <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
                    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
                  </svg>
                  {plural(followUps - 1, "more follow-up", "more follow-ups")} in the complete call list
                </p>
              </div>
            )}
          </section>
        )
      )}

      <p className="text-xs text-ink-3">
        Report checks: {plural(a.quality.skippedRows, "row", "rows")} without a usable amount left out;{" "}
        {plural(a.quality.confirmedDuplicateRows, "confirmed duplicate", "confirmed duplicates")} removed;{" "}
        {plural(a.quality.possibleDuplicateRows, "possible repeat", "possible repeats")} kept in the total.
        {plan.unnamedLines > 0 && byCustomer && ` ${plural(plan.unnamedLines, "line has", "lines have")} no customer name and ${plan.unnamedLines === 1 ? "stays" : "stay"} on ${plan.unnamedLines === 1 ? "its" : "their"} own.`}
      </p>
    </div>
  );
}
