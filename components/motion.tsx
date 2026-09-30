"use client";

import {
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

/**
 * Small animation helpers. All of them respect the user's
 * "reduce motion" setting by jumping straight to the final state.
 */

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const easeOutQuart = (t: number) => 1 - Math.pow(1 - t, 4);

/** Animates from 0 to `target` with a decelerating ease. */
export function useCountUp(target: number, durationMs = 1500): number {
  const [value, setValue] = useState(0);

  useEffect(() => {
    let raf = 0;
    if (prefersReducedMotion()) {
      raf = requestAnimationFrame(() => setValue(target));
      return () => cancelAnimationFrame(raf);
    }
    let start: number | null = null;
    const tick = (now: number) => {
      start ??= now;
      const progress = Math.min((now - start) / durationMs, 1);
      setValue(target * easeOutQuart(progress));
      if (progress < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);

  return value;
}

/**
 * Count-up number. Screen readers get the final value immediately.
 * `settleClassName` is applied once the count finishes, for a one-time
 * landing effect.
 */
export function CountUp({
  value,
  format,
  durationMs,
  settleClassName = "",
}: {
  value: number;
  format: (n: number) => string;
  durationMs?: number;
  settleClassName?: string;
}) {
  const current = useCountUp(value, durationMs);
  const done = current === value;
  return (
    <>
      <span
        aria-hidden
        className={`inline-block ${done ? settleClassName : ""}`}
      >
        {format(current)}
      </span>
      <span className="sr-only">{format(value)}</span>
    </>
  );
}

/** Flips to true shortly after mount, so CSS transitions can fill from empty. */
export function useEntered(): boolean {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return entered;
}

/** A bar that fills from empty to `percent` (0-100) on mount. */
export function FillBar({
  percent,
  className = "",
  delayMs = 200,
}: {
  percent: number;
  className?: string;
  delayMs?: number;
}) {
  const entered = useEntered();
  return (
    <div
      className={`h-full rounded-full transition-[width] duration-1000 ease-out motion-reduce:transition-none ${className}`}
      style={{
        width: `${entered ? percent : 0}%`,
        transitionDelay: `${delayMs}ms`,
      }}
    />
  );
}

/** Fades and slides its children in; `delay` (ms) staggers siblings. */
export function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const style: CSSProperties = { animationDelay: `${delay}ms` };
  return (
    <div
      style={style}
      className={`animate-fade-up motion-reduce:animate-none ${className}`}
    >
      {children}
    </div>
  );
}
