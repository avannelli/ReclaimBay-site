# M2 first-use clarity polish

October 18, 2026. Scope: three small customer-facing improvements within the
existing design. Findings come from source inspection and local synthetic browser
checks, not customer interviews or measured conversion uplift.

1. **Explain the product and preview at first glance.** The previous headline,
   “Find the value in work left undone,” did not name declined repairs. It now
   says “Find potential revenue in declined repair work.” The description explains
   the export, free preview and one-time paid report boundary, while stating that
   reported value is not guaranteed revenue. “Preview my report” still links to
   the existing scanner section. Pricing remains server-configured; no promise
   that Checkout is available was added.
2. **Help shops bring the right export.** Upload guidance now asks for declined,
   deferred or unapproved jobs only, each with a service description and declined
   amount, leaving out approved/completed work. Dates are explicitly optional.
   Evidence: normalization uses positive mapped amounts; it does not filter a
   mixed export by approval status. CSV/XLSX and the existing 15 MB limit remain.
   The column hint now says confirmation happens “if needed,” because confident
   matches proceed directly to results in the existing workflow.
3. **Clarify which amount to map.** The amount selector now has linked explanatory
   text directing shops to the declined-job amount rather than a whole invoice
   total that includes approved work. Evidence: exports can contain several total
   columns, and the mapper previously supplied header examples without this
   distinction. This changes guidance only, not detection or calculations.

Verification: 73 existing frontend tests passed; focused lint passed; root build
and its public-artifact gate passed (72 public-source/export files). The build
also ran TypeScript checks. Headless Chrome checks passed at 1280px, 390px and
320px, with no horizontal overflow or runtime errors, a working hero-to-scanner
link, touch-sized upload control, and the amount guidance on a synthetic mapping
screen. Existing touch guidance and layout needed no redesign. Initial browser
harness issues (header confirmation and a stale debugging-port file) were fixed
in the local verification harness; the successful run is recorded separately.

Logs, screenshots and the responsive check are in
`review/m2-conversion-polish/`; these are local evidence, not release assets.
The local build retains loopback verification API origins and must not be deployed.
Only the copy/guidance changes, corresponding existing-test adjustments, and this
record belong in the scoped commit. Earlier uncommitted purchase/recovery changes
remain outside it. No dependencies, payment logic, scanner calculations, privacy
architecture, acquisition infrastructure, production or parked stash were changed.

M2 remains open. Next owner action tomorrow: create the Stripe account/test
sandbox, create the active one-time USD 49.00 report Price, authenticate the CLI,
and enter test settings locally using [the purchase guide](SCANNER_PURCHASES.md).
Then resume actual hosted Checkout/webhook success, cancellation, failure,
authentication, replay/refund and recovery verification. Owner merchant setup and
separately authorized release checks remain before any paid deployment. No
payment release is authorized by this polish task.
