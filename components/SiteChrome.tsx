import { BRAND } from "@/lib/brand";
import { BrandLogo } from "./Brand";
import ContactLink from "./ContactLink";

export function SiteHeader() {
  return (
    <header className="site-header">
      <a href="#main" className="skip-link">Skip to content</a>
      <div className="site-header-inner">
        {/*
         * A full page load on purpose: a report lives in this page's state,
         * so returning home must reset it (a client-side Link to "/" would not).
         */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- needs a full reload, see above */}
        <a
          href="/"
          className="site-brand rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-navy"
        >
          <BrandLogo variant="header" className="h-8" eager />
        </a>
        <nav aria-label="Main navigation">
          {/* From a report, these return to the landing section in place (components/useReportHistory.ts); Back returns to the report. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/#how-it-works" className="home-nav">How it works</a>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/#privacy" className="home-nav">Privacy</a>
          <ContactLink className="nav-contact" label="Talk to ReclaimBay" />
        </nav>
      </div>
    </header>
  );
}

/** Rendered at build time (static export), so the year is the build year. */
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div>
          <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3">
            <BrandLogo variant="lockup" className="h-6" />
            <p>{BRAND.tagline}</p>
          </div>
          <div className="mt-3 max-w-md leading-relaxed text-pretty">
            <p>Built independently by Alessandro Vannelli.</p>
            <p>ReclaimBay was built to help independent repair shops take a second look at declined work.</p>
          </div>
        </div>
        <p>
          Browser-only report analysis. © {new Date().getFullYear()}{" "}
          {BRAND.name}
        </p>
      </div>
    </footer>
  );
}
