import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { BRAND } from "@/lib/brand";

export const metadata: Metadata = {
  title: `Internal test contact · ${BRAND.name}`,
  robots: { index: false, follow: false },
};

export default function InternalTestContactPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main id="main" className="flex flex-1 items-center bg-canvas px-4 py-12 sm:px-6 sm:py-20">
        <section className="mx-auto w-full max-w-2xl rounded-2xl border border-line bg-surface p-6 shadow-card sm:p-10">
          <p className="eyebrow text-ink-3">Internal testing</p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
            ReclaimBay internal test contact
          </h1>
          <p className="mt-5 text-base leading-7 text-ink-2">
            <strong className="text-ink">reclaimbay.test@gmail.com</strong> is a controlled ReclaimBay
            internal testing address used exclusively for ReclaimBay system testing. It is not a customer-support address.
          </p>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
