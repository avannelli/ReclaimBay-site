/** Product naming used across the UI, metadata, and exports. */
export const BRAND = {
  name: "ReclaimBay",
  descriptor: "Declined-work intelligence for repair shops",
  /** Used once, in the footer. */
  tagline: "Bring declined work back into view.",
  /** Prefix for exported file names. */
  fileSlug: "reclaimbay",
} as const;

/*
 * The logo is the approved artwork in brand/reclaimbay-logo.png: a garage
 * outline with rising bars and a gold arrow, "Reclaim" in navy, "Bay" in
 * gold, and the descriptor as its tagline. It is never redrawn by hand.
 * Everything else is traced or rendered from it:
 *
 *   public/brand/*.svg    vector logo files (full, lockup without tagline,
 *                         mark); full and lockup also in a reverse version
 *                         for navy
 *   lib/brandArt.ts       the same vectors, for the inline animated lockup
 *   lib/brandRaster.ts    PNG renders for the PDF report
 *   app/icon.svg, favicon.ico, apple-icon.png   the mark on a navy tile
 */
export const LOGO = {
  /** Header: original letterforms with a smaller, optically aligned mark. */
  header: { src: "/brand/reclaimbay-header.svg?v=balanced-mark", width: 140, height: 26 },
  /** Mark and wordmark: headers, footers, compact places. */
  lockup: { src: "/brand/reclaimbay-lockup.svg", width: 1824, height: 361 },
  /** The full logo with its tagline: where it is large enough to read. */
  full: { src: "/brand/reclaimbay-logo.svg", width: 1824, height: 361 },
} as const;
