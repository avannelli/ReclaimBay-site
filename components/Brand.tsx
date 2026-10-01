import Image from "next/image";
import { BRAND, LOGO } from "@/lib/brand";
import { LOGO_BOX, LOGO_GRADIENTS, LOGO_PATHS, LOGO_SOLIDS, type Gradient } from "@/lib/brandArt";

/*
 * ReclaimBay logo pieces. Both render the approved artwork (lib/brand.ts):
 * BrandLogo as a static vector file, AnimatedBrandLockup inline so its parts
 * can play the upload transition (see the rb-* rules in globals.css, which
 * do nothing under reduced motion).
 */

/** The logo as an image. Callers set only a height; the width follows. */
export function BrandLogo({
  variant = "lockup",
  className = "h-10",
  eager = false,
}: {
  variant?: keyof typeof LOGO;
  className?: string;
  /** Above the fold: load it first. */
  eager?: boolean;
}) {
  const file = LOGO[variant];
  return (
    <Image
      src={file.src}
      alt={variant === "full" ? `${BRAND.name}: ${BRAND.descriptor}` : BRAND.name}
      width={file.width}
      height={file.height}
      className={`w-auto max-w-full ${className}`}
      loading={eager ? "eager" : "lazy"}
      fetchPriority={eager ? "high" : "auto"}
      draggable={false}
    />
  );
}

function LinearGradient({ id, g }: { id: string; g: Gradient }) {
  const span = g.to - g.from;
  const axis = g.axis === "y" ? { x1: 0, y1: g.from, x2: 0, y2: g.to } : { x1: g.from, y1: 0, x2: g.to, y2: 0 };
  return (
    <linearGradient id={id} gradientUnits="userSpaceOnUse" {...axis}>
      {g.stops.map(([at, color]) => (
        <stop key={at} offset={(at - g.from) / span} stopColor={color} />
      ))}
    </linearGradient>
  );
}

/**
 * The mark and wordmark, inline, for the upload transition: the garage
 * fades in, the bars rise, the arrow sweeps up, and the wordmark fades in.
 * Rendered once per page, so its gradient ids are fixed.
 */
export function AnimatedBrandLockup({ className = "h-14" }: { className?: string }) {
  const [x, y, w, h] = LOGO_BOX.lockup;
  const id = (part: string) => `rb-t-${part}`;
  return (
    <svg
      role="img"
      aria-label={BRAND.name}
      viewBox={`${x} ${y} ${w} ${h}`}
      className={`rb-anim w-auto max-w-full ${className}`}
      style={{ aspectRatio: `${w} / ${h}` }}
    >
      <defs>
        <LinearGradient id={id("arrow")} g={LOGO_GRADIENTS.arrow} />
        <LinearGradient id={id("house")} g={LOGO_GRADIENTS.house} />
        <LinearGradient id={id("bay")} g={LOGO_GRADIENTS.bay} />
        {LOGO_GRADIENTS.bars.map((g, i) => (
          <LinearGradient key={i} id={id(`bar${i}`)} g={g} />
        ))}
      </defs>
      {/* The arrow's tail runs under the garage post, so it is drawn first. */}
      <g className="rb-lift">
        <path className="rb-arrow" fillRule="evenodd" fill={`url(#${id("arrow")})`} d={LOGO_PATHS.arrow} />
      </g>
      <path className="rb-bay" fillRule="evenodd" fill={`url(#${id("house")})`} d={LOGO_PATHS.house} />
      {LOGO_PATHS.bars.map((d, i) => (
        <path
          key={i}
          className="rb-bar"
          style={{ animationDelay: `${160 + i * 80}ms` }}
          fillRule="evenodd"
          fill={`url(#${id(`bar${i}`)})`}
          d={d}
        />
      ))}
      <g className="rb-word">
        <path fillRule="evenodd" fill={LOGO_SOLIDS.reclaim} d={LOGO_PATHS.reclaim} />
        <path fillRule="evenodd" fill={`url(#${id("bay")})`} d={LOGO_PATHS.bay} />
      </g>
    </svg>
  );
}
