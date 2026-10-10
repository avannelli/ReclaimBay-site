"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { button, size } from "./ui";

/*
 * Shared overlay helpers: a focus trap for dialogs and the tour, a modal
 * dialog, and anchored panels (tooltips, popovers) that are positioned in
 * the viewport so card edges never clip them.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * While active: moves focus inside `ref` (to `[data-autofocus]` if present),
 * keeps Tab within it, calls `onEscape` on Escape, and restores focus to
 * whatever had it before when deactivated.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onEscape: () => void,
) {
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    onEscapeRef.current = onEscape;
  });

  useEffect(() => {
    const node = ref.current;
    if (!active || !node) return;
    const previous = document.activeElement as HTMLElement | null;
    const items = () =>
      [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.getClientRects().length > 0,
      );
    const initial =
      node.querySelector<HTMLElement>("[data-autofocus]") ?? items()[0] ?? node;
    initial.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onEscapeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const list = items();
      if (list.length === 0) {
        e.preventDefault();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const current = document.activeElement;
      const outside = !node.contains(current);
      if (e.shiftKey && (current === first || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || outside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (previous && document.contains(previous)) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [active, ref]);
}

export const dialogPrimary = `${button.primary} ${size.md}`;
export const dialogSecondary = `${button.secondary} ${size.md}`;

/**
 * Centered modal dialog. Escape and the backdrop call `onClose`. With a
 * `description`, only it describes the dialog (a form's fields don't), and
 * `children` follow it; otherwise `children` are the description.
 */
export function Dialog({
  title,
  description,
  children,
  actions,
  onClose,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  actions: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();
  useFocusTrap(ref, true, onClose);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-navy-deep/45 p-4 animate-fade-in motion-reduce:animate-none sm:items-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl bg-surface p-6 shadow-lift ring-1 ring-line animate-dialog-in motion-reduce:animate-none"
      >
        <h2 id={titleId} className="text-lg font-semibold tracking-tight text-navy">
          {title}
        </h2>
        {description ? (
          <>
            <p id={bodyId} className="mt-2 text-sm leading-relaxed text-ink-2">{description}</p>
            <div className="mt-5 text-sm leading-relaxed text-ink-2">{children}</div>
          </>
        ) : (
          <div id={bodyId} className="mt-2 text-sm leading-relaxed text-ink-2">
            {children}
          </div>
        )}
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {actions}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Places a fixed-position panel next to its anchor: below by default (or
 * above with `prefer="top"`), flipping when there isn't room and staying
 * inside the viewport.
 */
function placePanel(anchor: HTMLElement, panel: HTMLElement, prefer: "top" | "bottom") {
  const a = anchor.getBoundingClientRect();
  const gap = 8;
  const margin = 12;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const h = panel.offsetHeight;
  const w = panel.offsetWidth;
  const below = a.bottom + gap;
  const above = a.top - gap - h;
  const fitsBelow = below + h <= vh - margin;
  const fitsAbove = above >= margin;
  const top =
    prefer === "top"
      ? fitsAbove || !fitsBelow
        ? above
        : below
      : fitsBelow || !fitsAbove
        ? below
        : above;
  panel.style.top = `${Math.round(top)}px`;
  panel.style.left = `${Math.round(Math.max(margin, Math.min(a.left, vw - w - margin)))}px`;
  panel.style.visibility = "visible";
}

/** Keeps an open panel placed beside its anchor through scrolling and resizing. */
export function useAnchoredPanel(
  anchor: RefObject<HTMLElement | null>,
  panel: RefObject<HTMLElement | null>,
  open: boolean,
  prefer: "top" | "bottom" = "bottom",
) {
  useLayoutEffect(() => {
    if (!open) return;
    let raf = 0;
    const place = () => {
      if (anchor.current && panel.current) {
        placePanel(anchor.current, panel.current, prefer);
      }
    };
    place();
    const onMove = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(place);
    };
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, prefer, anchor, panel]);
}

/** Closes an open panel on Escape or on a press outside it and its anchor. */
function useDismiss(
  open: boolean,
  close: (returnFocus: boolean) => void,
  refs: RefObject<HTMLElement | null>[],
) {
  const closeRef = useRef(close);
  const refsRef = useRef(refs);
  useEffect(() => {
    closeRef.current = close;
    refsRef.current = refs;
  });
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current(true);
    };
    const onDown = (e: PointerEvent) => {
      const inside = refsRef.current.some((r) =>
        r.current?.contains(e.target as Node),
      );
      if (!inside) closeRef.current(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);
}

const panelStyle = { top: 0, left: 0, visibility: "hidden" } as const;

/**
 * Small (i) button that explains a term on hover, focus, or tap. The text
 * is also inside the button for screen readers.
 */
export function InfoTip({
  label,
  text,
  className = "",
}: {
  /** What the term is, e.g. "dated declined value". */
  label: string;
  text: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  useAnchoredPanel(button, tip, open, "top");
  useDismiss(open, () => setOpen(false), [button, tip]);

  return (
    <>
      <button
        ref={button}
        type="button"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen(true)}
        className={`relative -my-1 inline-grid h-5 w-5 shrink-0 place-items-center rounded-full align-middle text-ink-3 transition-colors hover:text-navy focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-navy print:hidden ${className}`}
      >
        <svg
          aria-hidden
          viewBox="0 0 16 16"
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <circle cx="8" cy="8" r="6.25" />
          <path d="M8 7.25v3.5M8 5.1h.01" />
        </svg>
        <span className="sr-only">
          About {label}: {text}
        </span>
      </button>
      {open &&
        createPortal(
          <span
            ref={tip}
            aria-hidden
            style={panelStyle}
            className="pointer-events-none fixed z-[70] w-max max-w-64 rounded-lg bg-navy-deep px-3 py-2 text-xs leading-snug font-normal normal-case tracking-normal text-white shadow-lg animate-fade-in motion-reduce:animate-none"
          >
            {text}
          </span>,
          document.body,
        )}
    </>
  );
}

/**
 * A button that toggles an anchored, non-modal panel. Escape or a press
 * outside closes it; Escape returns focus to the button.
 */
export function Popover({
  trigger,
  triggerClassName,
  title,
  prefer = "bottom",
  children,
}: {
  trigger: ReactNode;
  triggerClassName: string;
  /** Heading shown at the top of the panel; also names it. */
  title: string;
  prefer?: "top" | "bottom";
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const titleId = useId();
  useAnchoredPanel(button, panel, open, prefer);
  useDismiss(
    open,
    (returnFocus) => {
      setOpen(false);
      if (returnFocus) button.current?.focus();
    },
    [button, panel],
  );

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            id={panelId}
            role="region"
            aria-labelledby={titleId}
            style={panelStyle}
            className="fixed z-[70] w-[min(20rem,calc(100vw-1.5rem))] rounded-xl bg-surface p-4 text-left shadow-lift ring-1 ring-line animate-fade-in motion-reduce:animate-none"
          >
            <p id={titleId} className="text-sm font-semibold text-navy">
              {title}
            </p>
            <div className="mt-1.5 space-y-1.5 text-sm leading-relaxed text-ink-2">
              {children}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
