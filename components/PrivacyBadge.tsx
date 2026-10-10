"use client";

import { Popover } from "./overlay";

/**
 * Concise privacy badge shown alongside results. Clicking it explains what
 * "processed locally" means, including that a refresh clears the report.
 */
export default function PrivacyBadge({
  className = "",
  onDark = false,
}: {
  className?: string;
  /** Styling for placement on the navy hero. */
  onDark?: boolean;
}) {
  return (
    <Popover
      prefer={onDark ? "top" : "bottom"}
      title="Your file stays in this browser"
      triggerClassName={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 ${
        onDark
          ? "bg-white/5 text-slate-300 ring-white/10 hover:bg-white/10 hover:text-white focus-visible:outline-opportunity"
          : "bg-navy/[0.05] text-navy ring-navy/10 hover:bg-navy/[0.08] focus-visible:outline-navy"
      } ${className}`}
      trigger={
        <>
          <LockIcon className="h-3.5 w-3.5 shrink-0" />
          Private review · On this device
        </>
      }
    >
      <p>
        ReclaimBay analyzes the selected report locally on your device.
        Customer data is not uploaded to ReclaimBay or stored on a server.
      </p>
      <p className="text-ink-3">
        Refreshing or closing the page clears the current report.
      </p>
      <p className="text-ink-3">
        ReclaimBay records limited product-usage events, such as visits,
        completed reviews, and exports, to understand how the product is used.
        Your uploaded report, customer information, and declined-work data are
        never sent to ReclaimBay.
      </p>
    </Popover>
  );
}

export function LockIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="7" width="10" height="6.5" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}
