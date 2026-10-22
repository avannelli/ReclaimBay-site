"use client";
import { useEffect, useRef, useState } from "react";
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
    [consent, setConsent] = useState(false),
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
      if (consent && !saved) {
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
      }
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
  return (
    <div className="mx-auto max-w-5xl space-y-6 py-8">
      <div className="rounded-2xl border border-line bg-white p-6">
        <p className="eyebrow">
          {paid
            ? "Complete report unlocked"
            : isSample
              ? "Fictional sample preview"
              : "Free scanner preview"}
        </p>
        {!paid && (
          <>
            <h1 className="mt-3 text-3xl">Your declined-work preview</h1>
            <p className="mt-4 text-3xl font-semibold">{money(a.total)}</p>
            <p>
              {a.count} opportunities in this report. This is reported declined
              value, not recovered revenue.
            </p>
            <p className="mt-4">
              Highest-value opportunity: {a.highest.service} —{" "}
              {money(a.highest.amount)}
            </p>
            <p className="mt-3 text-sm">
              Report checks: {a.quality.skippedRows} invalid/zero-value rows
              excluded; {a.quality.confirmedDuplicateRows} confirmed duplicate
              rows removed; {a.quality.possibleDuplicateRows} possible repeated
              rows remain in the total.
            </p>
            <p className="mt-4">
              Free: total reported value, opportunity count and the
              highest-value job. Purchase: the complete opportunity list,
              available age and service breakdowns, report checks, and existing
              PDF/CSV exports and summary copy for this report.
            </p>
          </>
        )}
        {!isSample && (
          <>
            <p className="mt-4">
              {paid
                ? "Payment verified. Your complete report and exports are available below."
                : offer.available
                  ? `${offerPrice(offer)} USD one-time for this report. No subscription.`
                  : "One-time complete-report purchases are not available yet. Your free preview still works."}
            </p>
            <p className="mt-3 text-sm">
              {!paid &&
                "Checkout opens in a separate tab. This analysis stays here. "}
              Without a recovery copy, refreshing or closing this tab clears the
              report; reopen the original file to resume. Your payment is kept
              for this browser. Clearing browser site data removes the device
              key; keep your Stripe receipt and contact us if access is lost.
            </p>
            {!saved && (
              <>
                <label className="mt-4 flex gap-2">
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                  />
                  Save an encrypted recovery copy on this device (optional)
                </label>
                {consent && (
                  <div className="mt-3">
                    <label>
                      Recovery password (12+ characters)
                      <input
                        type="password"
                        autoComplete="new-password"
                        minLength={12}
                        className="ml-3 border p-2"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                      />
                    </label>
                    <p className="text-sm">
                      Only encrypted report data is saved, with your consent. We
                      do not store the password; you will need it after refresh.
                    </p>
                    <button
                      type="button"
                      onClick={save}
                      className="mt-2 rounded border p-2"
                    >
                      Save recovery copy
                    </button>
                  </div>
                )}
              </>
            )}
            {saved && (
              <p className="mt-3">
                Encrypted copy saved on this device.{" "}
                <button
                  type="button"
                  className="underline"
                  onClick={() => {
                    clearRecovery(reportId)
                      .then(() => setSaved(false))
                      .catch((e) => setError(e.message));
                  }}
                >
                  Delete recovery copy
                </button>
              </p>
            )}
            {!paid && (
              <button
                type="button"
                className="mt-5 rounded bg-navy px-5 py-3 text-white disabled:opacity-50"
                disabled={
                  !offer.available ||
                  (consent && !saved && password.length < 12)
                }
                onClick={buy}
              >
                {pending
                  ? "Reopen secure Checkout"
                  : `Unlock complete report${offerPrice(offer) ? " — " + offerPrice(offer) : ""}`}
              </button>
            )}
            {pending && !paid && (
              <p role="status" className="mt-3">
                Payment is verified with Stripe on the server. A success page
                alone never unlocks access. If you cancelled, your preview is
                unchanged; reopen Checkout when ready.
              </p>
            )}
          </>
        )}
        {isSample && (
          <p className="mt-4">
            This example is fictional and cannot be purchased. Open your own
            report to purchase a complete report.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-4 text-red-700">
            {error}
          </p>
        )}
        {!paid && (
          <button
            type="button"
            className="ml-4 mt-4 underline"
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
            Analyze another report
          </button>
        )}
      </div>
      {paid && <PaidReport props={props} />}
    </div>
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
