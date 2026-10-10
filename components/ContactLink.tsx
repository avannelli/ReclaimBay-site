"use client";

import { useState } from "react";
import { trackEvent } from "@/lib/analytics";
import ContactDialog from "./ContactDialog";

/**
 * "Talk to ReclaimBay": opens the contact form (ContactDialog) in place, with
 * nothing from the report or invitation in it, recorded as contact_clicked.
 * By default it looks like the quiet "Questions? Talk to ReclaimBay" link and
 * the caller sets its colors; `unstyled` leaves all styling to `className`.
 */
export default function ContactLink({ isSample = false, className = "", label = "Questions? Talk to ReclaimBay", unstyled = false }: { isSample?: boolean; className?: string; label?: string; unstyled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => {
          trackEvent("contact_clicked", isSample);
          setOpen(true);
        }}
        className={unstyled ? className : `cursor-pointer rounded-md text-sm underline decoration-1 underline-offset-4 transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 print:hidden ${className}`}
      >
        {label}
      </button>
      {open && <ContactDialog onClose={() => setOpen(false)} />}
    </>
  );
}
