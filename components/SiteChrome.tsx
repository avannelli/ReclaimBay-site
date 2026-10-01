import { BRAND } from "@/lib/brand";
import { BrandLogo } from "./Brand";

export function SiteHeader() {
  return (
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex h-20 max-w-300 items-center px-4 sm:h-24 sm:px-6 lg:px-8">
        {/*
         * A full page load on purpose: a report lives in this page's state,
         * so returning home must reset it (a client-side Link to "/" would not).
         */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- needs a full reload, see above */}
        <a
          href="/"
          className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-navy"
        >
          <BrandLogo variant="full" className="h-14 sm:h-16" eager />
        </a>
      </div>
    </header>
  );
}

/** Rendered at build time (static export), so the year is the build year. */
export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-surface">
      <div className="mx-auto flex max-w-300 flex-col items-center gap-3 px-4 py-6 text-center text-xs text-ink-3 sm:flex-row sm:justify-between sm:px-6 sm:text-left lg:px-8">
        <div className="flex flex-col items-center gap-2 sm:flex-row sm:gap-3">
          <BrandLogo variant="lockup" className="h-6" />
          <p>{BRAND.tagline}</p>
        </div>
        <p>
          Reports are analyzed in your browser and never uploaded. © {new Date().getFullYear()}{" "}
          {BRAND.name}
        </p>
      </div>
    </footer>
  );
}
