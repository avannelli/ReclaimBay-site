import { formatAge } from "@/lib/format";
import { TIER_LABEL, TIER_ORDER, type FollowUp, type FollowUpPlan, type FollowUpTier } from "@/lib/followUps";

/**
 * The call list: one row per customer and vehicle, grouped by follow-up
 * tier. Shared by the complete report and the fictional sample; it shows
 * only fields from the uploaded export and has no export or purchase code.
 */

export const TIER_TONE: Record<FollowUpTier, { dot: string; chip: string; bar: string }> = {
  call_first: { dot: "bg-opportunity", chip: "bg-opportunity-soft text-opportunity-ink ring-opportunity/30", bar: "bg-opportunity" },
  next: { dot: "bg-navy/80", chip: "bg-navy/[0.06] text-navy ring-navy/15", bar: "bg-navy/80" },
  review: { dot: "bg-slate-400", chip: "bg-slate-100 text-ink-2 ring-slate-200", bar: "bg-slate-300" },
};

/** Short tier meaning; without dates the tiers use contact details only. */
export const tierHint = (tier: FollowUpTier, hasDates: boolean) =>
  hasDates
    ? { call_first: "Reachable, declined in the last 90 days", next: "Reachable, declined 3–12 months ago", review: "Older, undated or no contact details" }[tier]
    : { call_first: "Phone or email on file", next: "", review: "No contact details" }[tier];

export const ageLabel = (days?: number) =>
  days === undefined ? "No date" : days === 0 ? "Today" : `${formatAge(days)} ago`;

function Row({ f, rank, money }: { f: FollowUp; rank: number; money: (n: number) => string }) {
  const tone = TIER_TONE[f.tier];
  return (
    <li className="grid grid-cols-[2rem_minmax(0,1fr)_auto] gap-x-3 gap-y-2 border-t border-line px-4 py-4 sm:grid-cols-[2.25rem_minmax(0,1.5fr)_minmax(0,1fr)_auto] sm:gap-x-5 sm:px-6">
      <span className="pt-0.5 text-xs font-semibold tabular-nums text-ink-3">{String(rank).padStart(2, "0")}</span>
      <div className="min-w-0">
        <p className="wrap-anywhere font-semibold text-ink">
          {f.customer ?? <span className="font-medium text-ink-3">No customer name in export</span>}
        </p>
        <p className="wrap-anywhere text-sm text-ink-2">{f.vehicle ?? "Vehicle not listed"}</p>
        <ul className="mt-2 space-y-0.5 text-sm text-ink-2">
          {f.items.map((o) => (
            <li key={o.id} className="flex gap-2">
              <span aria-hidden className={`mt-2 h-1 w-1 shrink-0 rounded-full ${tone.dot}`} />
              <span className="min-w-0 wrap-anywhere">
                {o.service} <span className="tabular-nums text-ink-3">· {money(o.amount)}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-right text-base font-semibold tabular-nums text-navy sm:order-last">{money(f.total)}</p>
      <div className="col-span-2 col-start-2 min-w-0 space-y-0.5 text-sm sm:col-span-1 sm:col-start-auto">
        {f.phone && (
          <p>
            <a href={`tel:${f.phone.replace(/[^\d+]/g, "")}`} className="font-medium text-navy underline decoration-navy/30 underline-offset-2 hover:decoration-navy">
              {f.phone}
            </a>
          </p>
        )}
        {f.email && <p className="wrap-anywhere text-ink-2">{f.email}</p>}
        {!f.reachable && <p className="text-ink-3">No phone or email in export</p>}
        <p className="text-ink-3">
          {f.latestAgeDays === undefined ? "No decline date" : `Declined ${ageLabel(f.latestAgeDays).toLowerCase()}`}
          {f.items.length > 1 && ` · ${f.items.length} jobs`}
        </p>
      </div>
    </li>
  );
}

export default function FollowUpList({
  plan,
  money,
}: {
  plan: FollowUpPlan;
  money: (n: number) => string;
}) {
  let rank = 0;
  return (
    <div>
      {TIER_ORDER.filter((t) => plan.tiers[t].count > 0).map((tier) => {
        const s = plan.tiers[tier],
          tone = TIER_TONE[tier],
          headingId = `follow-up-${tier}`;
        return (
          <section key={tier} aria-labelledby={headingId} className="border-t border-line first:border-t-0">
            <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 bg-canvas/60 px-4 py-3 sm:px-6">
              <h3 id={headingId} className="flex items-center gap-2.5 text-sm font-semibold text-ink">
                <span className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${tone.chip}`}>{TIER_LABEL[tier]}</span>
                <span className="font-normal text-ink-3">{tierHint(tier, plan.hasDates)}</span>
              </h3>
              <p className="text-sm tabular-nums text-ink-2">
                {s.count.toLocaleString("en-US")} {s.count === 1 ? "follow-up" : "follow-ups"} · <span className="font-semibold text-ink">{money(s.value)}</span>
              </p>
            </header>
            <ol>
              {plan.followUps
                .filter((f) => f.tier === tier)
                .map((f) => (
                  <Row key={f.id} f={f} rank={++rank} money={money} />
                ))}
            </ol>
          </section>
        );
      })}
    </div>
  );
}
