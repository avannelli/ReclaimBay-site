"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TourState } from "@/lib/prefs";
import { SCROLL_MARGIN, prefersReducedMotion, scrollPageTo } from "@/lib/scroll";
import { button, size } from "./ui";
import { useFocusTrap } from "./overlay";

interface Step {
  /** Matches a `data-tour` attribute on the results page. */
  target: string;
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    target: "total",
    title: "Reported declined value",
    body: "This totals the declined estimates included from your report. Review current job status before following up; recovery is not tracked.",
  },
  {
    target: "opportunities",
    title: "Start with the biggest jobs",
    body: "These are the individual declined jobs contributing the most value.",
  },
  {
    target: "recency",
    title: "See what’s recent",
    body: "This shows how much declined work happened recently versus older opportunities.",
  },
  {
    target: "categories",
    title: "See where value is concentrated",
    body: "This shows which repair categories contain the most declined value.",
  },
  {
    target: "exports",
    title: "Keep your review",
    body: "Download a PDF summary or the full job list as CSV for your own review and follow-up.",
  },
];

const targetOf = (step: Step) =>
  document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);

/** Below this width the card becomes a bottom sheet. */
const SHEET_BREAKPOINT = 640;
const SPOT_PAD = 8;

/**
 * Five-step spotlight tour of the results page. Dims the page, outlines the
 * current section, and shows a card beside it (a bottom sheet on phones).
 * Steps whose section isn't on the page (e.g. no dates) are skipped.
 */
export default function ReportTour({
  onFinish,
}: {
  onFinish: (state: TourState) => void;
}) {
  const [steps] = useState(() => STEPS.filter((s) => targetOf(s)));
  const [index, setIndex] = useState(0);
  const cardRef = useRef<HTMLDivElement>(null);
  const spotRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();

  useFocusTrap(cardRef, true, () => onFinish("dismissed"));

  const step = steps[index];
  const last = index === steps.length - 1;

  useEffect(() => {
    const target = step && targetOf(step);
    const card = cardRef.current;
    const spot = spotRef.current;
    if (!target || !card || !spot) return;
    const reduce = prefersReducedMotion();
    let raf = 0;
    let settleTimer = 0;

    const place = () => {
      const r = target.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const sheet = vw < SHEET_BREAKPOINT;
      const floor = sheet ? vh - card.offsetHeight - 8 : vh - 8;

      // Spotlight: the visible part of the section, above the sheet on phones.
      const top = Math.max(r.top - SPOT_PAD, 8);
      const bottom = Math.min(r.bottom + SPOT_PAD, floor);
      spot.style.top = `${top}px`;
      spot.style.left = `${Math.max(r.left - SPOT_PAD, 4)}px`;
      spot.style.width = `${Math.min(r.width + SPOT_PAD * 2, vw - 8)}px`;
      spot.style.height = `${Math.max(bottom - top, 0)}px`;
      spot.style.opacity = "1";

      if (sheet) {
        card.style.top = "";
        card.style.left = "";
        return;
      }
      const gap = 14;
      const m = 16;
      const w = card.offsetWidth;
      const h = card.offsetHeight;
      let cardTop: number;
      let cardLeft = Math.min(Math.max(r.left, m), vw - w - m);
      if (r.bottom + SPOT_PAD + gap + h <= vh - m) {
        cardTop = r.bottom + SPOT_PAD + gap;
      } else if (r.top - SPOT_PAD - gap - h >= m) {
        cardTop = r.top - SPOT_PAD - gap - h;
      } else {
        // Tall section: float the card in the lower right, over the section.
        cardTop = vh - h - 24;
        cardLeft = vw - w - 24;
      }
      card.style.top = `${Math.round(cardTop)}px`;
      card.style.left = `${Math.round(cardLeft)}px`;
    };

    const show = () => {
      card.style.opacity = "1";
      place();
    };

    // Bring the section into view first, then reveal the card beside it.
    // (The sticky report bar is hidden while the tour runs.)
    const sheet = document.documentElement.clientWidth < SHEET_BREAKPOINT;
    const floor =
      window.innerHeight - (sheet ? card.offsetHeight : 0) - SCROLL_MARGIN;
    const r = target.getBoundingClientRect();
    const inView =
      r.top >= SCROLL_MARGIN && Math.min(r.bottom, r.top + 360) <= floor;
    if (inView) {
      show();
    } else {
      card.style.opacity = "0";
      scrollPageTo(window.scrollY + r.top - SCROLL_MARGIN);
      place();
      if (reduce) {
        show();
      } else {
        const done = () => {
          window.clearTimeout(settleTimer);
          window.removeEventListener("scrollend", done);
          show();
        };
        window.addEventListener("scrollend", done, { once: true });
        settleTimer = window.setTimeout(done, 900);
      }
    }

    const onMove = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(place);
    };
    window.addEventListener("scroll", onMove, { passive: true });
    window.addEventListener("resize", onMove);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settleTimer);
      window.removeEventListener("scroll", onMove);
      window.removeEventListener("resize", onMove);
    };
  }, [step]);

  // Keep keyboard focus in the card when a step change disables a button.
  useEffect(() => {
    const card = cardRef.current;
    if (card && !card.contains(document.activeElement)) {
      primaryRef.current?.focus({ preventScroll: true });
    }
  }, [index]);

  if (!step) return null;

  return createPortal(
    <div className="fixed inset-0 z-[60]">
      {/* Blocks clicks on the page; the spotlight's shadow does the dimming. */}
      <div className="absolute inset-0" aria-hidden />
      <div
        ref={spotRef}
        aria-hidden
        style={{
          opacity: 0,
          // Amber outline, soft glow, then the dimmed page, in one shadow
          // (a Tailwind ring would be overwritten by this inline shadow).
          boxShadow:
            "0 0 0 2px rgb(217 144 26 / 0.9), 0 0 0 7px rgb(217 144 26 / 0.18), 0 0 32px 4px rgb(217 144 26 / 0.25), 0 0 0 9999px rgb(7 23 37 / 0.58)",
        }}
        className="pointer-events-none fixed rounded-2xl transition-[top,left,width,height,opacity] duration-300 ease-out motion-reduce:transition-none"
      />
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        style={{ opacity: 0 }}
        className="fixed inset-x-0 bottom-0 rounded-t-2xl bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-lift ring-1 ring-line transition-[top,left,opacity] duration-300 ease-out motion-reduce:transition-none sm:inset-x-auto sm:bottom-auto sm:w-[23rem] sm:rounded-2xl sm:pb-5"
      >
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-semibold tabular-nums text-ink-3">
            {index + 1} of {steps.length}
          </p>
          <button
            type="button"
            onClick={() => onFinish("dismissed")}
            className="-m-1.5 grid h-8 w-8 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-canvas hover:text-navy focus-visible:outline-2 focus-visible:outline-navy"
          >
            <span className="sr-only">Close tour</span>
            <svg
              aria-hidden
              viewBox="0 0 16 16"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            >
              <path d="m4 4 8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
        <div
          aria-hidden
          className="mt-2 flex gap-1"
        >
          {steps.map((s, i) => (
            <span
              key={s.target}
              className={`h-1 flex-1 rounded-full transition-colors duration-300 motion-reduce:transition-none ${
                i <= index ? "bg-opportunity" : "bg-slate-200"
              }`}
            />
          ))}
        </div>
        <div
          key={index}
          className="animate-fade-in motion-reduce:animate-none"
        >
          <h2
            id={titleId}
            className="mt-4 text-base font-semibold tracking-tight text-navy"
          >
            {step.title}
          </h2>
          <p id={bodyId} className="mt-1 text-sm leading-relaxed text-ink-2">
            {step.body}
          </p>
        </div>
        <div className="mt-5 flex items-center justify-between gap-3">
          {last ? (
            <span />
          ) : (
            <button
              type="button"
              onClick={() => onFinish("dismissed")}
              className="rounded-md px-1 text-sm font-medium text-ink-3 transition-colors hover:text-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy"
            >
              Skip tour
            </button>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={index === 0}
              onClick={() => setIndex((i) => i - 1)}
              className={`${button.secondary} ${size.sm}`}
            >
              Back
            </button>
            <button
              ref={primaryRef}
              type="button"
              data-autofocus
              onClick={() =>
                last ? onFinish("completed") : setIndex((i) => i + 1)
              }
              className={`${button.primary} ${size.sm} min-w-20`}
            >
              {last ? "Done" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
