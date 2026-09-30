import { BRAND } from "@/lib/brand";
import { BrandLockup, BrandMark, BrandWordmark } from "./Brand";

export function SiteHeader() {
  return (
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex h-[4.5rem] max-w-300 items-center px-4 sm:h-20 sm:px-6 lg:px-8">
        <BrandLockup />
      </div>
    </header>
  );
}

/** Rendered at build time (static export), so the year is the build year. */
export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-surface">
      <div className="mx-auto flex max-w-300 flex-col items-center gap-3 px-4 py-6 text-center text-xs text-ink-3 sm:flex-row sm:justify-between sm:px-6 sm:text-left lg:px-8">
        <div className="flex items-center gap-2.5">
          <BrandMark className="h-5 w-6 shrink-0" />
          <p>
            <BrandWordmark className="text-[13px]" />
            <span aria-hidden> · </span>
            {BRAND.tagline}
          </p>
        </div>
        <p>
          Reports are analyzed in your browser and never uploaded. © {new Date().getFullYear()}{" "}
          {BRAND.name}
        </p>
      </div>
    </footer>
  );
}
