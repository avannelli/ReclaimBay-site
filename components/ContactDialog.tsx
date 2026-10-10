"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { CONTACT_EMAIL, contactMailto } from "@/lib/contact";
import { CONTACT_LIMITS, contactPayload, emailProblem, emptyDraft, HONEYPOT_FIELD, sendContact, type ContactDraft, type ContactField } from "@/lib/contactForm";
import { Dialog, dialogPrimary, dialogSecondary } from "./overlay";

/*
 * The one "Talk to ReclaimBay" form, opened from every contact link on the
 * site and the report. It sends only its own fields (lib/contactForm.ts).
 *
 * An unsent draft is kept in memory while the page is open, so closing the
 * dialog by accident (Escape, the backdrop) loses nothing; it is never
 * stored, and a sent message clears it.
 */
const unsent: { draft: ContactDraft | null } = { draft: null };
const keepDraft = (draft: ContactDraft | null) => { unsent.draft = draft; };

const control = "w-full rounded-lg border border-slate-300 bg-surface px-3 text-base text-ink transition-colors hover:border-slate-400 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-navy sm:text-sm aria-invalid:border-danger";

const FIELDS: { field: ContactField; label: string; autoComplete: string; type?: string }[] = [
  { field: "name", label: "Name", autoComplete: "name" },
  { field: "shopName", label: "Shop name", autoComplete: "organization" },
  { field: "email", label: "Email", autoComplete: "email", type: "email" },
  { field: "shopSoftware", label: "Shop software", autoComplete: "off" },
];

export default function ContactDialog({ onClose }: { onClose: () => void }) {
  const id = useId();
  const [draft, setDraft] = useState<ContactDraft>(() => unsent.draft ?? emptyDraft());
  const [state, setState] = useState<"editing" | "sending" | "sent" | "failed">("editing");
  const [emailError, setEmailError] = useState<string | null>(null);
  const honeypot = useRef<HTMLInputElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const sending = useRef(false);

  const update = (field: ContactField, value: string) => {
    const next = { ...draft, [field]: value };
    setDraft(next);
    keepDraft(next);
    if (field === "email" && emailError) setEmailError(emailProblem(value));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (sending.current) return;
    const problem = emailProblem(draft.email);
    if (problem) {
      setEmailError(problem);
      emailInput.current?.focus();
      return;
    }
    sending.current = true;
    setState("sending");
    const result = await sendContact(contactPayload(draft, honeypot.current?.value ?? ""));
    sending.current = false;
    if (result === "sent") {
      keepDraft(null);
      setState("sent");
      // The form is gone; its close button takes focus.
      requestAnimationFrame(() => closeButton.current?.focus());
    } else {
      setState("failed");
    }
  };

  if (state === "sent") {
    return (
      <Dialog
        title="Talk to ReclaimBay"
        onClose={onClose}
        actions={<button ref={closeButton} type="button" onClick={onClose} className={dialogPrimary}>Close</button>}
      >
        <p role="status" className="text-base text-navy">Thanks — we&apos;ll reply by email.</p>
      </Dialog>
    );
  }

  const formId = `${id}-form`;
  return (
    <Dialog
      title="Talk to ReclaimBay"
      description="Have a question or want to tell us what you're working on?"
      onClose={onClose}
      actions={
        <>
          <button type="button" onClick={onClose} className={dialogSecondary}>Cancel</button>
          <button type="submit" form={formId} disabled={state === "sending"} aria-disabled={state === "sending"} className={dialogPrimary}>
            {state === "sending" ? "Sending…" : "Send message"}
          </button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={submit} aria-busy={state === "sending"} className="grid gap-4">
        {FIELDS.map(({ field, label, autoComplete, type }) => {
          const required = field === "email";
          const inputId = `${id}-${field}`;
          const errorId = `${inputId}-error`;
          return (
            <div key={field} className="grid gap-1.5">
              <label htmlFor={inputId} className="text-sm font-medium text-navy">
                {label}
                {required && <span className="ml-1.5 text-xs font-normal text-ink-3">Required</span>}
              </label>
              <input
                id={inputId}
                ref={required ? emailInput : undefined}
                data-autofocus={field === "name" ? true : undefined}
                type={type ?? "text"}
                inputMode={type === "email" ? "email" : undefined}
                autoComplete={autoComplete}
                maxLength={CONTACT_LIMITS[field]}
                value={draft[field]}
                onChange={(e) => update(field, e.target.value)}
                onBlur={required && draft.email ? () => setEmailError(emailProblem(draft.email)) : undefined}
                required={required}
                aria-required={required || undefined}
                aria-invalid={required && emailError ? true : undefined}
                aria-describedby={required && emailError ? errorId : undefined}
                className={`${control} h-11`}
              />
              {required && emailError && <p id={errorId} className="text-xs text-danger">{emailError}</p>}
            </div>
          );
        })}
        <div className="grid gap-1.5">
          <label htmlFor={`${id}-message`} className="text-sm font-medium text-navy">Message</label>
          <textarea
            id={`${id}-message`}
            rows={4}
            maxLength={CONTACT_LIMITS.message}
            value={draft.message}
            onChange={(e) => update("message", e.target.value)}
            className={`${control} resize-y py-2.5 leading-relaxed`}
          />
        </div>
        {/* People never see or reach this field; bots that fill it in are ignored by the server. */}
        <div aria-hidden className="absolute -left-[9999px] h-px w-px overflow-hidden">
          <label htmlFor={`${id}-${HONEYPOT_FIELD}`}>Website</label>
          <input id={`${id}-${HONEYPOT_FIELD}`} ref={honeypot} type="text" name={HONEYPOT_FIELD} tabIndex={-1} autoComplete="off" defaultValue="" />
        </div>
        {state === "failed" && (
          <p role="alert" className="rounded-lg border-l-2 border-danger bg-danger-soft px-3 py-2.5 text-sm text-ink">
            Something went wrong. Please try again.
          </p>
        )}
        <p className="text-xs text-ink-3">
          Prefer email? <a href={contactMailto()} className="underline decoration-1 underline-offset-2 hover:text-navy">{CONTACT_EMAIL}</a>
        </p>
      </form>
    </Dialog>
  );
}
