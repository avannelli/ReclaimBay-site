"use client";

import { BrandLogo } from "./Brand";

/** How long the transition plays before a report is revealed. */
export const TRANSITION_HOLD_MS = 550;
/** A shorter hold when the next screen is the mapper or an error. */
export const TRANSITION_SHORT_HOLD_MS = 220;
export const TRANSITION_OUT_MS = 140;
/** Reduced motion adds no artificial hold. */
export const TRANSITION_REDUCED_HOLD_MS = 0;

/**
 * Full-screen branded state shown while a report is read and analyzed.
 * A brief reading state connects upload and review, without invented progress percentages.
 */
export default function BrandTransition({ leaving }: { leaving: boolean }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{ animationDuration: "140ms" }}
      className={`fixed inset-0 z-[80] grid place-items-center bg-canvas px-6 motion-reduce:animate-none ${
        leaving ? "animate-fade-out" : "animate-fade-in"
      }`}
    >
      <div className="relative">
        <BrandLogo className="h-10 sm:h-12" eager />
        <span className="processing-line mx-auto mt-8" aria-hidden />
        <p className="mt-5 text-center text-sm text-ink-3">Reviewing your report on this device…</p>
      </div>
    </div>
  );
}
