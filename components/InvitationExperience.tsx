"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { openInvitation, tokenFromHash, type InvitationState } from "@/lib/invitation";
import { button, size } from "./ui";

/*
 * The page a contacted business lands on from its invitation link
 * (/invite#<token>). It shows a deliberate loading state until the backend
 * has answered, then exactly one of: the invitation, "no longer available"
 * (for a missing, unknown, revoked, or opted-out link alike, never saying
 * which), or "couldn't open" (the backend unreachable: never shown as a valid
 * invitation). Every action leads only to ReclaimBay's own home page.
 */

// Links (not buttons) never match :enabled, so their hover is set here.
const primaryLink = `${button.primary} ${size.lg} hover:bg-opportunity-hover active:brightness-95`;
const secondaryLink = `${button.secondary} ${size.lg} hover:border-slate-400 hover:bg-canvas`;

const BENEFITS: { title: string; text: string }[] = [
  { title: "See what’s waiting", text: "The value of the work your customers haven’t approved yet, and which jobs are worth a call first." },
  { title: "Private by design", text: "Your file is analyzed in your browser. It’s never uploaded." },
  { title: "No account required", text: "Nothing to sign up for or install." },
];

function Check() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className="mt-0.5 h-5 w-5 flex-none text-positive" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10" cy="10" r="8.25" strokeWidth="1.5" />
      <path d="m6.5 10.2 2.3 2.3 4.7-4.9" />
    </svg>
  );
}

function Card({ children, busy = false }: { children: React.ReactNode; busy?: boolean }) {
  return (
    <section
      aria-live="polite"
      aria-busy={busy}
      className="mx-auto w-full max-w-xl rounded-3xl border border-line bg-surface px-6 py-10 text-center shadow-lift sm:px-10 sm:py-12"
    >
      {children}
    </section>
  );
}

export default function InvitationExperience() {
  const [state, setState] = useState<InvitationState>({ kind: "loading" });
  // React may run effects twice in development; one open per page view.
  const started = useRef(false);

  const load = useCallback(async () => {
    const token = tokenFromHash(window.location.hash);
    const next = token ? await openInvitation(token) : ({ kind: "unavailable" } as const);
    setState(next);
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void load();
  }, [load]);

  const retry = () => {
    setState({ kind: "loading" });
    void load();
  };

  if (state.kind === "loading") {
    return (
      <Card busy>
        <div className="flex min-h-[14rem] flex-col items-center justify-center gap-4">
          <span aria-hidden className="h-8 w-8 animate-spin rounded-full border-[3px] border-line border-t-navy motion-reduce:animate-none" />
          <p className="text-sm text-ink-3">Opening your invitation…</p>
        </div>
      </Card>
    );
  }

  if (state.kind === "unavailable") {
    return (
      <Card>
        <h1 className="text-2xl font-semibold tracking-tight text-balance text-navy sm:text-3xl">This invitation is no longer available</h1>
        <p className="mx-auto mt-4 max-w-md text-base leading-relaxed text-pretty text-ink-2">
          You can still see what ReclaimBay does for independent repair shops.
        </p>
        <div className="mt-8">
          <Link href="/" className={primaryLink}>
            Go to ReclaimBay
          </Link>
        </div>
      </Card>
    );
  }

  if (state.kind === "error") {
    return (
      <Card>
        <h1 className="text-2xl font-semibold tracking-tight text-balance text-navy sm:text-3xl">We couldn&rsquo;t open your invitation</h1>
        <p className="mx-auto mt-4 max-w-md text-base leading-relaxed text-pretty text-ink-2">
          Something went wrong on our side. Please try again in a moment.
        </p>
        <div className="mt-8 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
          <button type="button" onClick={retry} className={`${button.primary} ${size.lg}`}>
            Try again
          </button>
          <Link href="/" className={secondaryLink}>
            Go to ReclaimBay
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <p className="eyebrow text-ink-2">Invitation</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-balance text-navy sm:text-4xl">You&rsquo;re invited to ReclaimBay</h1>
      {state.businessName && (
        <p className="mx-auto mt-4 inline-block max-w-full rounded-2xl bg-canvas px-3.5 py-1 text-sm text-balance break-words text-ink-2 ring-1 ring-inset ring-line">
          Prepared for <span className="font-semibold text-navy">{state.businessName}</span>
        </p>
      )}
      <p className="mx-auto mt-5 max-w-md text-lg leading-relaxed text-pretty text-ink-2">
        ReclaimBay shows independent repair shops the work their customers have put off, what it&rsquo;s worth, and where to start.
      </p>
      <ul className="mx-auto mt-7 max-w-md space-y-4 text-left">
        {BENEFITS.map((b) => (
          <li key={b.title} className="flex gap-3">
            <Check />
            <span>
              <span className="block font-semibold text-ink">{b.title}</span>
              <span className="block text-sm leading-relaxed text-ink-2">{b.text}</span>
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-9">
        <Link href="/" className={`${primaryLink} w-full sm:w-auto sm:min-w-56`}>
          Get started free
        </Link>
      </div>
    </Card>
  );
}
