/*
 * Shared button styles, so every action follows one hierarchy:
 * primary = amber, secondary = outlined neutral, utility = quiet text.
 * Only color changes on hover/press; size never shifts between states.
 */

const base =
  "inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy disabled:cursor-not-allowed disabled:opacity-50";

export const button = {
  primary: `${base} bg-opportunity text-navy-deep shadow-cta enabled:hover:bg-opportunity-hover enabled:active:brightness-95`,
  secondary: `${base} border border-slate-300 bg-surface text-navy enabled:hover:border-slate-400 enabled:hover:bg-canvas enabled:active:bg-slate-100`,
  /** Secondary with a firmer outline, for an alternative the user may well need. */
  secondaryStrong: `${base} border border-navy/40 bg-surface text-navy enabled:hover:border-navy enabled:hover:bg-canvas enabled:active:bg-slate-100`,
};

export const size = {
  lg: "h-12 px-6 text-[15px]",
  md: "h-10 px-4 text-sm",
  sm: "h-9 px-3.5 text-sm",
};
