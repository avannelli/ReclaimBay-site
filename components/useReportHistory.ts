"use client";

import { useEffect, useEffectEvent, useRef, type RefObject } from "react";
import { homeEntry, readNavEntry, reportEntry, reportKey, resolveDestination, type Destination, type NavEntry } from "@/lib/navigation";

/** Next.js's own fields in a history entry (its router marks every entry it can traverse). */
export function routerFields(state: unknown): Record<string, unknown> | null {
  if (!state || typeof state !== "object" || !("__NA" in state)) return null;
  return Object.fromEntries(Object.entries(state).filter(([key]) => key.startsWith("__")));
}

/*
 * Next.js reloads the page on Back or Forward to an entry without its router
 * fields. An in-page link (the hero's #scan) makes an entry with no state at
 * all, so every entry written here carries the router fields last seen. The
 * URL is left as it is, so the router has nothing to resynchronize.
 */
function write(router: RefObject<Record<string, unknown> | null>, method: "pushState" | "replaceState", entry: NavEntry) {
  router.current = routerFields(window.history.state) ?? router.current;
  window.history[method]({ ...router.current, ...entry }, "");
  // The browser restores the landing page's scroll. A report's is restored by the
  // app, at once: the browser's own would animate with the page's smooth scrolling.
  window.history.scrollRestoration = entry.rb === "report" ? "manual" : "auto";
}

/**
 * Keeps the browser's history in step with the report workspace; see
 * lib/navigation.ts for the model. `inWorkspace` says whether a report screen
 * is showing; `onNavigate` switches views when the visitor goes Back or
 * Forward, or follows a link to a landing section from a report.
 */
export function useReportHistory(inWorkspace: boolean, onNavigate: (destination: Destination) => void) {
  const router = useRef<Record<string, unknown> | null>(null);
  useEffect(() => { router.current = routerFields(window.history.state); }, []);
  // The report entry whose screen is still in memory, and how many have been opened.
  const openReport = useRef<string | null>(null);
  const opened = useRef(0);
  // The landing page's scroll position when a scan left it, so Back returns there.
  const leftAt = useRef(0);
  // What is showing right now, updated as soon as a history change is handled.
  const showingWorkspace = useRef(inWorkspace);
  // How far down the open report the visitor was, for Forward.
  const reportY = useRef(0);
  useEffect(() => {
    if (!inWorkspace) return;
    const remember = () => { if (showingWorkspace.current) reportY.current = window.scrollY; };
    window.addEventListener("scroll", remember, { passive: true });
    return () => window.removeEventListener("scroll", remember);
  }, [inWorkspace]);

  // Leaving the workspace without Back, Forward, or a link (a report that couldn't
  // be analyzed returns to the upload area) clears it, as starting over does.
  useEffect(() => {
    if (!inWorkspace && showingWorkspace.current) {
      openReport.current = null;
      write(router, "replaceState", homeEntry());
    }
    showingWorkspace.current = inWorkspace;
  }, [inWorkspace]);

  // Entering the workspace adds its entry; later steps (matching, then results) share it.
  useEffect(() => {
    if (!inWorkspace) return;
    const entry = readNavEntry(window.history.state);
    if (entry?.rb === "report" && entry.report === openReport.current) return;
    const report = reportKey(performance.timeOrigin, ++opened.current);
    write(router, "replaceState", homeEntry(leftAt.current));
    write(router, "pushState", reportEntry(report));
    openReport.current = report;
    reportY.current = 0;
  }, [inWorkspace]);

  const handleHistoryChange = useEffectEvent(() => {
    const destination = resolveDestination(window.history.state, window.location.hash, openReport.current);
    if (!destination) return;
    if (destination.view === "home" && destination.forgotten) write(router, "replaceState", homeEntry());
    const toWorkspace = destination.view === "report";
    // Already showing it (say, Back between two landing entries): the browser handles scrolling.
    if (toWorkspace === showingWorkspace.current) return;
    showingWorkspace.current = toWorkspace;
    onNavigate(toWorkspace ? { view: "report", scroll: { y: reportY.current } } : destination);
  });

  useEffect(() => {
    // A fragment link can fire both events; the second finds the view already switched.
    const listener = () => handleHistoryChange();
    window.addEventListener("popstate", listener);
    window.addEventListener("hashchange", listener);
    return () => {
      window.removeEventListener("popstate", listener);
      window.removeEventListener("hashchange", listener);
    };
  }, []);

  return {
    /** Before a scan leaves the landing page: remembers where it was. */
    leavingHome: () => { leftAt.current = window.scrollY; },
    /**
     * A report screen's own way out (start over, cancel) clears the report, as
     * its confirmation promises: its entry becomes a landing entry, so neither
     * Back nor Forward can bring it back.
     */
    clearingReport: () => {
      openReport.current = null;
      write(router, "replaceState", homeEntry());
      showingWorkspace.current = false;
    },
  };
}
