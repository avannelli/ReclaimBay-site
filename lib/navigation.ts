/*
 * Browser history for the one-page flow.
 *
 * The landing page and the report workspace (header and column matching,
 * results) are one document, so on their own the browser's Back button would
 * leave ReclaimBay. Entering the workspace adds one history entry, and Back
 * and Forward move between it and the landing page.
 *
 * Entries carry only a view name, an opaque per-report key, and the landing
 * page's scroll position: never anything read from a report. The report
 * itself stays in memory, so a reload still clears it.
 */

/** Landing-page sections that links (such as the header's) can point to. */
export const LANDING_SECTIONS = ["how-it-works", "scan", "privacy"] as const;

export type NavEntry =
  | { rb: "home"; scrollY: number }
  | { rb: "report"; report: string };

export type Destination =
  | { view: "report"; scroll?: { y: number } }
  | { view: "home"; scroll: { section: string } | { y: number }; forgotten?: boolean };

const REPORT_KEY = /^[0-9]{1,16}:[0-9]{1,9}$/;

export const homeEntry = (scrollY = 0): NavEntry => ({ rb: "home", scrollY: Math.max(0, Math.round(scrollY)) });
export const reportEntry = (report: string): NavEntry => ({ rb: "report", report });

/** A key unique to one report in one page load: so an entry left over from before a reload never matches. */
export const reportKey = (pageLoad: number, count: number) => `${Math.round(pageLoad)}:${count}`;

/** Our part of a history entry's state, or null for entries we didn't make. */
export function readNavEntry(state: unknown): NavEntry | null {
  if (!state || typeof state !== "object") return null;
  const { rb, scrollY, report } = state as Record<string, unknown>;
  if (rb === "home") return homeEntry(typeof scrollY === "number" && Number.isFinite(scrollY) ? scrollY : 0);
  if (rb === "report" && typeof report === "string" && REPORT_KEY.test(report)) return reportEntry(report);
  return null;
}

/** The landing section a URL fragment names, or null. */
export function landingSection(hash: string): string | null {
  const id = hash.replace(/^#/, "");
  return (LANDING_SECTIONS as readonly string[]).includes(id) ? id : null;
}

/**
 * Where a history change should land: the entry the browser moved to (Back,
 * Forward, or an in-page link), given the report still held in memory.
 * Null means it isn't ours to handle, such as the skip link's #main.
 */
export function resolveDestination(state: unknown, hash: string, openReport: string | null): Destination | null {
  const entry = readNavEntry(state);
  if (entry?.rb === "report") {
    // A report from before a reload, or one replaced by a newer scan, is gone.
    return entry.report === openReport ? { view: "report" } : { view: "home", scroll: { y: 0 }, forgotten: true };
  }
  if (entry?.rb === "home") return { view: "home", scroll: { y: entry.scrollY } };
  const section = landingSection(hash);
  return section ? { view: "home", scroll: { section } } : null;
}
