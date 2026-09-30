"use client";

import { BrandMark, BrandWordmark } from "./Brand";

/** How long the transition plays before a report is revealed. */
export const TRANSITION_HOLD_MS = 1400;
/** A shorter hold when the next screen is the mapper or an error. */
export const TRANSITION_SHORT_HOLD_MS = 600;
export const TRANSITION_OUT_MS = 260;
/** With reduced motion there's no animation, just a brief branded pause. */
export const TRANSITION_REDUCED_HOLD_MS = 450;

/**
 * Full-screen branded state shown while a report is read and analyzed.
 * The mark assembles itself, holds, and fades as the next screen arrives.
 */
export default function BrandTransition({ leaving }: { leaving: boolean }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed inset-0 z-[80] grid place-items-center bg-canvas px-6 motion-reduce:animate-none ${
        leaving ? "animate-fade-out" : "animate-fade-in"
      }`}
    >
      <div className="flex flex-col items-center">
        <div className="flex items-center gap-3 sm:gap-4">
          <BrandMark className="h-12 w-15 shrink-0 sm:h-14 sm:w-[4.375rem]" animated />
          <BrandWordmark className="rb-word text-[2rem] leading-none sm:text-[2.5rem]" />
        </div>
        <p className="rb-word mt-6 text-sm text-ink-3">Analyzing declined work…</p>
      </div>
    </div>
  );
}
