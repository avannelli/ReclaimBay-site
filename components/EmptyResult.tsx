import PrivacyBadge from "./PrivacyBadge";
import { button, size } from "./ui";

/**
 * Shown instead of a zero-filled report when a readable file yields no
 * included opportunities.
 */
export default function EmptyResult({
  fileName,
  rowCount,
  amountHeader,
  onReset,
  onRemap,
}: {
  fileName: string;
  rowCount: number;
  /** The column read as the declined amount. */
  amountHeader?: string;
  onReset: () => void;
  onRemap: () => void;
}) {
  return (
    <div className="mapping-sheet mx-auto max-w-2xl">
      <PrivacyBadge />
      <div className="mt-6 rounded-md border border-line bg-surface p-6 sm:p-8">
        <span
          aria-hidden
          className="grid h-11 w-11 place-items-center rounded-xl bg-canvas text-ink-2 ring-1 ring-inset ring-line"
        >
          <svg
            viewBox="0 0 20 20"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3.5 4.5h13v11h-13zM3.5 8.5h13M8 11l4 4M12 11l-4 4" />
          </svg>
        </span>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight text-navy sm:text-3xl">
          No declined-work opportunities found
        </h1>
        <p className="mt-3 text-ink-2">
          We could read{" "}
          <span className="wrap-anywhere font-medium text-ink">{fileName}</span>,
          but none of the rows contained a positive declined amount that could
          be included.
        </p>

        <div className="mt-6 rounded-xl border border-line bg-canvas/70 px-4 py-3.5 text-sm text-ink-2">
          <p className="font-medium text-ink">File notes</p>
          <ul className="mt-1.5 list-disc space-y-1 pl-5">
            <li>
              {rowCount.toLocaleString("en-US")} {rowCount === 1 ? "row was" : "rows were"} read
              {amountHeader ? (
                <>
                  , using <span className="font-medium text-ink">{amountHeader}</span> as
                  the declined amount.
                </>
              ) : (
                "."
              )}
            </li>
            <li>
              Rows are left out when the amount is blank, zero, negative, or not
              a readable dollar value (for example &ldquo;N/A&rdquo; or
              &ldquo;TBD&rdquo;).
            </li>
          </ul>
        </div>

        <div className="mt-7 flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={onReset}
            className={`${button.primary} ${size.lg}`}
          >
            Upload another report
          </button>
          <button
            type="button"
            onClick={onRemap}
            className={`${button.secondaryStrong} ${size.lg}`}
          >
            Choose a different amount column
          </button>
        </div>
      </div>
    </div>
  );
}
