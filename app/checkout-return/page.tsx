"use client";
import { useEffect } from "react";
import Link from "next/link";
export default function CheckoutReturn() {
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const c = new BroadcastChannel("reclaimbay-purchase");
    c.postMessage("check-payment");
    c.close();
  }, []);
  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="text-3xl">Return to your scanner tab</h1>
      <p className="mt-5">
        Your analysis stayed in the original tab. If you completed payment,
        ReclaimBay verifies it directly with Stripe before unlocking the report.
        If you cancelled, the free preview remains available.
      </p>
      <p className="mt-4">
        This return page does not prove payment or grant access.
      </p>
      <button
        type="button"
        className="mt-5 rounded border p-3"
        onClick={() => window.close()}
      >
        Close this Checkout tab
      </button>
      <Link href="/" className="mt-4 block underline">
        Reopen the scanner and restore your report
      </Link>
    </main>
  );
}
