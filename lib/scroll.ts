/*
 * All programmatic scrolling goes through here so it respects reduced
 * motion and lands below the sticky report bar consistently.
 */

/** Height of the sticky report bar (h-14). */
export const STICKY_BAR_HEIGHT = 56;
/** Breathing room left above a scroll target. */
export const SCROLL_MARGIN = 24;

export const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Scrolls the page; smooth unless reduced motion is on or `instant` is set. */
export function scrollPageTo(top: number, { instant = false } = {}) {
  window.scrollTo({
    top: Math.max(0, Math.round(top)),
    behavior: instant || prefersReducedMotion() ? "instant" : "smooth",
  });
}

/** Brings an element's top to `offset` pixels from the top of the viewport. */
export function scrollToElement(
  el: HTMLElement,
  offset = STICKY_BAR_HEIGHT + SCROLL_MARGIN,
  options?: { instant?: boolean },
) {
  scrollPageTo(window.scrollY + el.getBoundingClientRect().top - offset, options);
}
