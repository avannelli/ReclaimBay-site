"use client";

import { trackEvent } from "@/lib/analytics";
import { contactMailto } from "@/lib/contact";

/**
 * The quiet "Questions? Talk to ReclaimBay" link: the fixed contact mailto
 * (nothing from the report or invitation in it), recorded as contact_clicked.
 * The caller sets the colors for its background.
 */
export default function ContactLink({ isSample = false, className = "" }: { isSample?: boolean; className?: string }) {
  return (
    <a
      href={contactMailto()}
      onClick={() => trackEvent("contact_clicked", isSample)}
      className={`rounded-md text-sm underline decoration-1 underline-offset-4 transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 print:hidden ${className}`}
    >
      Questions? Talk to ReclaimBay
    </a>
  );
}
