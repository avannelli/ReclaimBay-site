import type { CSSProperties } from "react";
import { BRAND, MARK } from "@/lib/brand";

/*
 * ReclaimBay brand pieces. With `animated`, the mark plays the upload
 * transition: bay fades in, bars rise, the arrow swoops up (see the rb-*
 * rules in globals.css, which do nothing under reduced motion).
 */

const delay = (ms: number): CSSProperties => ({ animationDelay: `${ms}ms` });

export function BrandMark({
  className = "h-8 w-10",
  tone = "light",
  animated = false,
}: {
  className?: string;
  /** "dark" for navy backgrounds. */
  tone?: "light" | "dark";
  animated?: boolean;
}) {
  const bay = tone === "dark" ? "#ffffff" : "var(--color-navy)";
  const bar = tone === "dark" ? "#94a3b8" : "var(--color-ink-2)";
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${MARK.width} ${MARK.height}`}
      className={`${animated ? "rb-anim" : ""} ${className}`}
    >
      <path
        className="rb-bay"
        d={MARK.bay}
        fill="none"
        stroke={bay}
        strokeWidth={MARK.stroke.bay}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {MARK.bars.map(([x, top], i) => (
        <rect
          key={x}
          className="rb-bar"
          style={animated ? delay(160 + i * 90) : undefined}
          x={x}
          y={top}
          width={MARK.barWidth}
          height={MARK.floor - top}
          rx="0.9"
          fill={bar}
        />
      ))}
      <g className="rb-lift">
        <path
          className="rb-arrow"
          d={MARK.arrow}
          pathLength={1}
          fill="none"
          stroke="var(--color-opportunity)"
          strokeWidth={MARK.stroke.arrow}
          strokeLinecap="round"
        />
        <path
          className="rb-head"
          d={MARK.head}
          fill="var(--color-opportunity)"
          stroke="var(--color-opportunity)"
          strokeWidth="1"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}

/** "Reclaim" in navy, "Bay" in amber. Size comes from the caller. */
export function BrandWordmark({
  className = "",
  tone = "light",
}: {
  className?: string;
  tone?: "light" | "dark";
}) {
  const [first, second] = BRAND.nameParts;
  return (
    <span className={`font-bold tracking-tight ${className}`}>
      <span className={tone === "dark" ? "text-white" : "text-navy"}>{first}</span>
      <span className="text-opportunity">{second}</span>
    </span>
  );
}

/** Mark and wordmark for the header; the descriptor joins from `sm` up. */
export function BrandLockup() {
  return (
    <span className="inline-flex items-center gap-3">
      <BrandMark className="h-10 w-[3.125rem] shrink-0 sm:h-11 sm:w-[3.4375rem]" />
      <span className="flex flex-col">
        <BrandWordmark className="text-2xl leading-7 sm:text-[1.75rem] sm:leading-8" />
        <span className="hidden text-[13px] leading-4 text-ink-3 sm:block">
          {BRAND.descriptor}
        </span>
      </span>
    </span>
  );
}
