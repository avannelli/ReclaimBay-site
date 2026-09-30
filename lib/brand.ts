/** Product naming used across the UI, metadata, and exports. */
export const BRAND = {
  name: "ReclaimBay",
  /** The wordmark is set in two colors: "Reclaim" navy, "Bay" amber. */
  nameParts: ["Reclaim", "Bay"],
  descriptor: "Declined-work intelligence for repair shops",
  /** Used once, in the footer. */
  tagline: "Bring declined work back into view.",
  /** Prefix for exported file names. */
  fileSlug: "reclaimbay",
} as const;

/*
 * The ReclaimBay mark, on a 40 x 32 grid: a service-bay outline (two posts
 * and a roofline), three rising bars inside it, and an amber arrow swooping
 * up and out through the open roof: declined work brought back as value.
 *
 * components/Brand.tsx renders this as SVG, the favicons are generated from
 * it, and lib/pdfReport.ts redraws it with the same numbers.
 */
export const MARK = {
  width: 40,
  height: 32,
  /** Left post, roofline, and right post. */
  bay: "M3.75 30.5V12.25L17.5 6.25l5 2.25M36.25 30.5V14.5",
  /** Bars as [x, top]; all stand on `floor` and share `barWidth`. */
  bars: [
    [9.25, 24.5],
    [16.25, 21],
    [23.25, 17],
  ],
  barWidth: 4.25,
  floor: 30.5,
  /** The swoop and its arrowhead. */
  arrow: "M6.5 21.5C15 21 25.5 16 32.25 7.25",
  head: "M36.4 2.6 29.7 4.1l5.25 5.1z",
  stroke: { bay: 3.25, arrow: 2.75 },
} as const;
