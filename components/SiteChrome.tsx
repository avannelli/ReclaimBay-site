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
          className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-navy"
        >
          <BrandLogo variant="lockup" className="h-9 sm:h-10" eager />
        </a>
        <nav aria-label="Main navigation">
          {/* A full navigation establishes a fresh homepage, clearing report state. */}
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
        <div className="flex flex-col items-center gap-2 sm:flex-row sm:gap-3">
          <BrandLogo variant="lockup" className="h-6" />
          <p>{BRAND.tagline}</p>
        </div>
        <p>
          Browser-only report analysis. © {new Date().getFullYear()}{" "}
          {BRAND.name}
        </p>
      </div>
    </footer>
  );
}
