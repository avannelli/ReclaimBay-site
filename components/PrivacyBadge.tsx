/** Concise privacy badge shown alongside results. */
export default function PrivacyBadge({
  className = "",
  onDark = false,
}: {
  className?: string;
  /** Styling for placement on the navy hero. */
  onDark?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${
        onDark
          ? "bg-white/5 text-slate-300 ring-white/10"
          : "bg-positive-soft text-positive-ink ring-positive/20"
      } ${className}`}
    >
      <LockIcon className="h-3.5 w-3.5 shrink-0" />
      Private scan · Processed locally
    </span>
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
