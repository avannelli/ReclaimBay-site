import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { BRAND } from "@/lib/brand";

/*
 * /terms: purchase terms and refund policy for the one-time complete-report
 * purchase. Static content only; the price itself comes from Stripe and is
 * shown before Checkout. Privacy wording lives in the landing page's
 * #privacy section and is linked, not repeated.
 */
export const metadata: Metadata = {
  title: `Purchase terms and refunds · ${BRAND.name}`,
  description: "Terms for ReclaimBay's one-time complete-report purchase, including refunds.",
};

export default function TermsPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main id="main" className="flex-1 bg-canvas px-4 py-12 sm:px-6 sm:py-16">
        <article className="mx-auto max-w-2xl space-y-8 leading-relaxed text-pretty">
          <header>
            <h1 className="text-3xl">Purchase terms and refunds</h1>
            <p className="mt-2 text-sm">Last updated October 23, 2026</p>
          </header>

          <section aria-labelledby="buying">
            <h2 id="buying" className="text-xl">What you&rsquo;re buying</h2>
            <p className="mt-3">
              A complete-report purchase is a one-time payment, currently $49 USD, shown before
              Checkout. It unlocks the complete report for one report you analyze in the {BRAND.name}{" "}
              scanner. It is not a subscription and there are no recurring charges.
            </p>
            <p className="mt-3">
              The complete report includes the call list (each customer and vehicle with its
              declined jobs and the contact details in your export, in call order), a printable call
              sheet, the full declined-job list, available age and service breakdowns, report checks,
              and the PDF/CSV exports and summary copy for that report.
              Access is kept for the browser on the device you purchased with. Clearing that
              browser&rsquo;s site data removes its device key, so keep your Stripe receipt.
            </p>
          </section>

          <section aria-labelledby="report">
            <h2 id="report" className="text-xl">What the report shows</h2>
            <p className="mt-3">
              The report summarizes the export you supply. Declined amounts are the values recorded
              in your data. They are not a promise of recovered revenue, sales or profit, and results
              depend on the accuracy and completeness of your export.
            </p>
          </section>

          <section aria-labelledby="payment">
            <h2 id="payment" className="text-xl">Payment and delivery</h2>
            <p className="mt-3">
              Payments are processed by Stripe. {BRAND.name} does not receive or store your card
              details. Stripe emails a receipt to the address you enter at Checkout.
            </p>
            <p className="mt-3">
              The complete report unlocks in your browser after {BRAND.name} verifies the payment
              with Stripe. Your report&rsquo;s contents stay in your browser and are not sent to{" "}
              {BRAND.name} or Stripe.{" "}
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- plain link to the landing section */}
              <a href="/#privacy" className="underline">What happens to your report</a>.
            </p>
          </section>

          <section aria-labelledby="refunds">
            <h2 id="refunds" className="text-xl">Refunds</h2>
            <p className="mt-3">We refund a purchase when:</p>
            <ul className="mt-2 list-disc space-y-1 pl-6">
              <li>you were charged more than once for the same report;</li>
              <li>
                payment was confirmed but the complete report could not be delivered because of a
                technical problem we cannot resolve; or
              </li>
              <li>
                {BRAND.name} cannot produce a valid report from a supported export: a CSV or Excel
                (.xlsx) file up to 15 MB with a service description and an amount for each job.
              </li>
            </ul>
            <p className="mt-3">
              Other refund requests are reviewed individually. Nothing in these terms limits any
              rights you have under applicable law.
            </p>
            <p className="mt-3">
              Approved refunds go back to the original payment method through Stripe. A refunded
              purchase no longer unlocks the complete report.
            </p>
          </section>

          <section aria-labelledby="help">
            <h2 id="help" className="text-xl">Requesting a refund or help</h2>
            <p className="mt-3">
              Email <a href="mailto:hello@reclaimbay.com" className="underline">hello@reclaimbay.com</a>{" "}
              or use &ldquo;Talk to {BRAND.name}&rdquo; on this site. Include the email address you
              used at Checkout and your receipt number or purchase date. Please do not send your
              report file or any customer information; we do not need them.
            </p>
          </section>
        </article>
      </main>
      <SiteFooter />
    </div>
  );
}
