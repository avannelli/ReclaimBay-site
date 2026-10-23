"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Analysis } from "@/lib/types";
import { moneyFormat } from "@/lib/format";
import {
  BILLING_API,
  offerPrice,
  reportOffer,
  purchaseRequest,
  localStore,
  rememberReport,
  type Offer,
  type ReportReference,
} from "@/lib/reportPurchase";
import {
  saveRecovery,
  clearRecovery,
  hasRecovery,
  type ReportSnapshot,
} from "@/lib/reportRecovery";
import type { Root } from "react-dom/client";
import { buildFollowUps } from "@/lib/followUps";
import ResultsOverview from "./ResultsOverview";
import { button, size } from "./ui";

type Props = {
  reportId: string;
  fileName: string;
  analysis: Analysis;
  isSample: boolean;
  analyzedAt: Date;
  onReset: () => void;
};
declare global {
  interface Window {
    ReclaimBayPaid?: { mount: (element: HTMLElement, props: Props) => Root };
  }
}
function PaidReport({ props }: { props: Props }) {
  const ref = useRef<HTMLDivElement>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    let root: Root | undefined;
    let script: HTMLScriptElement | undefined;
    (async () => {
      const r = await purchaseRequest("fulfillment", {
        reportId: props.reportId,
      });
      const url = URL.createObjectURL(
        new Blob([await r.text()], { type: "text/javascript" }),
      );
      try {
        await new Promise<void>((resolve, reject) => {
          script = document.createElement("script");
          script.src = url;
          script.onload = () => resolve();
          script.onerror = () =>
            reject(Error("Unable to load the paid report."));
          document.head.append(script);
        });
      } finally {
        URL.revokeObjectURL(url);
        script?.remove();
      }
      if (!disposed && ref.current && window.ReclaimBayPaid)
        root = window.ReclaimBayPaid.mount(ref.current, props);
    })().catch((e) => {
      if (!disposed) setError(e.message);
    });
    return () => {
      disposed = true;
      if (root) queueMicrotask(() => root?.unmount());
    };
  }, [props]);
  return (
    <div>
      {error && (
        <p role="alert">
          {error} Reloading requires your recovery copy or original file; your
          payment is preserved.
        </p>
      )}
      <div ref={ref} />
    </div>
  );
}
export default function ReportAccess(props: Props) {
  const { analysis: a, reportId, isSample } = props,
    money = moneyFormat(a.showCents);
  const [offer, setOffer] = useState<Offer>({ available: false }),
    [paid, setPaid] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false),
    [password, setPassword] = useState("");
  useEffect(() => {
    reportOffer()
      .then(setOffer)
      .catch((e) => setError(e.message));
    if (!isSample) {
      rememberReport(reportId).catch(() =>
        setError(
          "Device storage is unavailable; purchasing is disabled until it works.",
        ),
      );
      hasRecovery(reportId)
        .then(setSaved)
        .catch(() => {});
    }
  }, [reportId, isSample]);
  useEffect(() => {
    if (isSample) return;
    const warn = (e: BeforeUnloadEvent) => {
      if (!saved) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saved, isSample]);
  useEffect(() => {
    if (isSample || !BILLING_API) return;
    let stopped = false,
      checking = false;
    const started = Date.now();
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const s = await (await purchaseRequest("status", { reportId })).json();
        if (!stopped) {
          setPaid(s.paid);
          if (s.paid || s.revoked) setPending(false);
          if (s.revoked)
            setError(
              "This purchase was refunded or needs review. Contact ReclaimBay.",
            );
        }
      } catch (e) {
        if (pending && !stopped)
          setError(e instanceof Error ? e.message : "Unable to check payment.");
      } finally {
        checking = false;
      }
    };
    void check();
    const timer = window.setInterval(() => {
      if (pending && Date.now() - started < 15 * 60 * 1000) void check();
    }, 5000);
    window.addEventListener("focus", check);
    const channel =
      typeof BroadcastChannel === "undefined"
        ? null
        : new BroadcastChannel("reclaimbay-purchase");
    if (channel) channel.onmessage = () => void check();
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("focus", check);
      channel?.close();
    };
  }, [reportId, isSample, pending]);
  const buy = async () => {
    setError("");
    const tab = window.open("about:blank", "_blank");
    if (!tab) {
      setError(
        "Allow a new tab for Stripe Checkout. Your report remains here.",
      );
      return;
    }
    tab.opener = null;
    tab.document.body.textContent =
      "Preparing secure Stripe Checkout. Your analysis remains in the original tab.";
    setPending(true);
    try {
      const s = await (
        await purchaseRequest("checkout", { reportId, priceId: offer.priceId! })
      ).json();
      if (s.paid) {
        setPaid(true);
        tab.close();
        return;
      }
      if (s.revoked || !/^https:\/\/checkout\.stripe\.com\//.test(s.url ?? ""))
        throw Error("Checkout is unavailable. Your preview remains here.");
      tab.location.replace(s.url);
    } catch (e) {
      tab.close();
      setPending(false);
      setError(e instanceof Error ? e.message : "Unable to open Checkout.");
      reportOffer()
        .then(setOffer)
        .catch(() => {});
    }
  };
  const save = async () => {
    try {
      await saveRecovery(
        {
          reportId,
          fileName: props.fileName,
          analysis: a,
          analyzedAt: props.analyzedAt,
        },
        password,
      );
      setSaved(true);
      setPassword("");
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const plan = useMemo(() => buildFollowUps(a.ranked), [a]);
  const price = offerPrice(offer);
  const access = (
    <AccessOptions
      paid={paid}
      saved={saved}
      password={password}
      onPassword={setPassword}
      onSave={save}
      onDelete={() => {
        clearRecovery(reportId)
          .then(() => setSaved(false))
          .catch((e) => setError(e.message));
      }}
    />
  );
  const alert = error && (
    <p role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">
      {error}
    </p>
  );
  const resetLink = (
    <button
      type="button"
      className="text-sm font-medium text-navy underline decoration-navy/30 underline-offset-4 hover:decoration-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy"
      onClick={() => {
        if (
          isSample ||
          confirm(
            "Replace this report? Save a recovery copy first if you want to keep it. Your payment, if any, remains recorded.",
          )
        )
          props.onReset();
      }}
    >
      {isSample ? "Analyze your own report" : "Analyze another report"}
    </button>
  );
  const termsLink = (
    // A new tab, so following the link never clears this report.
    <a href="/terms" target="_blank" rel="noopener noreferrer" className="font-medium text-navy underline decoration-navy/30 underline-offset-2 hover:decoration-navy">
      Purchase terms and refunds
    </a>
  );
  const n = plan.followUps.length,
    count = n === 1 ? "the 1" : `all ${n.toLocaleString("en-US")}`;
  const included = [
    plan.basis === "customer"
      ? `The complete call list: ${count} ${n === 1 ? "follow-up" : "follow-ups"} with customer, vehicle, phone or email and declined jobs, in call order`
      : `The complete call list: ${count} declined ${n === 1 ? "job" : "jobs"} with the details in your export, in call order`,
    "A printable call sheet with Reached, Booked and Notes columns",
    "A follow-up spreadsheet (CSV) for your texting or email tool, plus every declined line",
    "Every service category and age breakdown, report checks and a PDF summary",
  ];

  if (paid)
    return (
      <div className="report-layout space-y-6 py-8">
        <section className="flex flex-col gap-3 rounded-2xl border border-positive/25 bg-positive-soft/60 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div>
            <p className="eyebrow text-positive-ink">Complete report unlocked</p>
            <p className="mt-1 text-sm text-ink-2">
              Payment verified with Stripe. Your call list and exports are below. {termsLink}
            </p>
          </div>
          {access}
        </section>
        {alert}
        <PaidReport props={props} />
      </div>
    );

  return (
    <div className="report-layout space-y-6 py-8">
      <ResultsOverview
        analysis={a}
        plan={plan}
        isSample={isSample}
        fileName={props.fileName}
        analyzedAt={props.analyzedAt}
        money={money}
      />
      {isSample ? (
        <section className="flex flex-col gap-4 rounded-2xl border border-navy/10 bg-navy/[0.03] px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="max-w-2xl">
            <h2 className="text-lg font-semibold tracking-tight text-navy">See your own call list</h2>
            <p className="mt-1 text-sm text-ink-2">
              This example is fictional and cannot be purchased. Open your shop&rsquo;s declined-work export to get a free preview of your numbers.
            </p>
          </div>
          <button type="button" onClick={props.onReset} className={`${button.primary} ${size.lg} shrink-0`}>
            Analyze your own report
          </button>
        </section>
      ) : (
        <section aria-labelledby="offer-heading" className="grid gap-6 rounded-2xl border border-line bg-surface px-5 py-6 shadow-sm sm:px-7 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] lg:gap-10">
          <div>
            <h2 id="offer-heading" className="text-xl font-semibold tracking-tight text-navy">
              Get the complete call list
            </h2>
            <ul className="mt-4 space-y-2.5 text-sm text-ink-2">
              {included.map((item) => (
                <li key={item} className="flex gap-2.5">
                  <svg aria-hidden viewBox="0 0 16 16" className="mt-0.5 h-4 w-4 shrink-0 text-positive-ink" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m3.5 8.5 3 3 6-7" />
                  </svg>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-xs text-ink-3">
              Built in this browser from your export. Your report&rsquo;s contents are never sent to ReclaimBay or Stripe.
            </p>
          </div>
          <div className="flex flex-col justify-center gap-3 border-t border-line pt-5 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
            {offer.available ? (
              <p>
                <span className="text-4xl font-semibold tracking-tight tabular-nums text-ink">{price}</span>{" "}
                <span className="ml-1 text-sm text-ink-2">USD one-time for this report. No subscription.</span>
              </p>
            ) : (
              <p className="text-sm text-ink-2">
                One-time complete-report purchases are not available yet. Your free preview still works.
              </p>
            )}
            <button
              type="button"
              className={`${button.primary} ${size.lg} w-full`}
              disabled={!offer.available}
              onClick={buy}
            >
              {pending ? "Reopen secure Checkout" : `Unlock complete report${price ? " — " + price : ""}`}
            </button>
            {pending ? (
              <p role="status" className="text-sm text-ink-2">
                Waiting for Stripe. Payment is verified on the server; a success page alone never unlocks access. If you cancelled, your preview is unchanged.
              </p>
            ) : (
              <p className="text-xs text-ink-3">
                Secure checkout by Stripe opens in a new tab. Keep this tab open; your report unlocks here after payment.
              </p>
            )}
            <p className="text-xs text-ink-3">{termsLink} (opens in a new tab)</p>
          </div>
        </section>
      )}
      {alert}
      {/* The sample's own call to action already offers "Analyze your own report". */}
      {!isSample && (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          {access}
          {resetLink}
        </div>
      )}
    </div>
  );
}

/**
 * Optional, explicit and secondary: keeping access is automatic (the device
 * key stays in this browser and the original file reopens the report), so the
 * password copy only matters when the original file won't be at hand.
 */
function AccessOptions({
  paid,
  saved,
  password,
  onPassword,
  onSave,
  onDelete,
}: {
  paid: boolean;
  saved: boolean;
  password: string;
  onPassword: (v: string) => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  return (
    <details className="group max-w-xl rounded-xl border border-line bg-surface/80 text-sm text-ink-2">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-4 py-3 font-medium text-ink hover:bg-canvas focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-navy [&::-webkit-details-marker]:hidden">
        <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4 text-ink-3 transition-transform group-open:rotate-90 motion-reduce:transition-none" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 4 4 4-4 4" />
        </svg>
        {saved ? "Encrypted copy saved on this device" : paid ? "Keep access to this report" : "If you close this tab"}
      </summary>
      <div className="space-y-3 border-t border-line px-4 py-4">
        <p>
          {paid ? "Your purchase is kept for this browser." : "A purchase is kept for this browser."} To come back, open ReclaimBay here, choose <em>Resume your previous report</em> and reopen the same file. Clearing this browser&rsquo;s site data removes that access; keep your Stripe receipt and contact us if it happens.
        </p>
        {saved ? (
          <button type="button" className="font-medium text-navy underline underline-offset-2" onClick={onDelete}>
            Delete recovery copy
          </button>
        ) : (
          <div>
            <p>
              Won&rsquo;t have the file? Save an encrypted copy of this report on this device. Only you know the password; it isn&rsquo;t stored or sent anywhere.
            </p>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end">
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium text-ink-2">
                Recovery password (12+ characters)
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  className="h-10 rounded-lg border border-slate-300 px-3 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-navy"
                  value={password}
                  onChange={(e) => onPassword(e.target.value)}
                />
              </label>
              <button type="button" onClick={onSave} disabled={password.length < 12} className={`${button.secondary} ${size.md}`}>
                Save encrypted copy
              </button>
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

export function ResumeReport({
  onRestore,
  onFile,
}: {
  onRestore: (r: ReportSnapshot) => void;
  onFile: (file: File, reportId: string) => void;
}) {
  const [id, setId] = useState(""),
    [reports, setReports] = useState<ReportReference[]>([]),
    [password, setPassword] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    localStore<string | undefined>("metadata", "readonly", (s) =>
      s.get("lastReport"),
    )
      .then((id) => setId(id ?? ""))
      .catch(() => {});
    localStore<ReportReference[] | undefined>("metadata", "readonly", (s) =>
      s.get("reports"),
    )
      .then((r) => setReports(r ?? []))
      .catch(() => {});
  }, []);
  if (!id) return null;
  return (
    <section className="mx-auto my-6 max-w-3xl rounded border p-5">
      <h2 className="text-xl">Resume your previous report</h2>
      <p>
        Purchases stay bound to this browser. Restore an explicitly saved
        encrypted copy, or reopen the same original report file. We never
        received your report, so we cannot restore it from a server.
      </p>
      {reports.length > 1 && (
        <label className="my-3 block">
          Report reference{" "}
          <select
            className="border p-2"
            value={id}
            onChange={(e) => {
              setId(e.target.value);
              setPassword("");
              setError("");
            }}
          >
            {reports.map((r) => (
              <option key={r.id} value={r.id}>
                {new Date(r.createdAt).toLocaleString()} — {r.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Recovery password
        <input
          type="password"
          className="m-2 border p-2"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <button
        type="button"
        className="rounded border p-2"
        onClick={() => {
          import("@/lib/reportRecovery")
            .then((m) => m.restoreRecovery(id, password))
            .then(onRestore)
            .catch((e) => setError(e.message));
        }}
      >
        Restore encrypted report
      </button>
      <label className="mt-3 block">
        Or reopen the original file
        <input
          type="file"
          accept=".csv,.xlsx"
          onChange={(e) => {
            if (e.target.files?.[0]) onFile(e.target.files[0], id);
          }}
        />
      </label>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
