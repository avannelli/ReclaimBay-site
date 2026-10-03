/*
 * Anonymous, behavioral-only product analytics.
 *
 * The only things ever sent are: a random browser ID, an opaque referral
 * code and campaign tag from the link the visitor arrived on, the event
 * name, whether the report was the built-in sample, and (for exports) the
 * export format. No file contents, report rows, customer details, amounts,
 * or filenames: the functions below can't accept them.
 *
 * Everything here is best effort. With no API URL configured, blocked
 * storage, or the backend offline, calls silently do nothing, so scanning,
 * the tour, and exports never depend on analytics.
 */

type ProductEvent = "landing_view" | "upload_started" | "scan_completed" | "tour_completed";
export type ExportType = "pdf" | "csv" | "copied_summary";

const API_URL = (process.env.NEXT_PUBLIC_ANALYTICS_API_URL ?? "").trim().replace(/\/+$/, "");
const TIMEOUT_MS = 4000;

const SESSION_KEY = "reclaimbay_analytics_session_v1";
const ATTRIBUTION_KEY = "reclaimbay_attribution_v1";
const LANDING_KEY = "reclaimbay_landing_sent_v1";

// Must match the backend's validation exactly; anything else is dropped.
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REF_RE = /^rb_[a-z0-9]{8,32}$/;
const CAMPAIGN_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

interface Attribution {
  ref: string | null;
  campaign: string | null;
}

// Fallbacks for when storage is blocked: kept for this page load only.
let memorySessionId: string | null = null;
let memoryLandingSent = false;

function storageGet(storage: "local" | "session", key: string): string | null {
  try {
    return (storage === "local" ? window.localStorage : window.sessionStorage).getItem(key);
  } catch {
    return null;
  }
}

function storageSet(storage: "local" | "session", key: string, value: string): boolean {
  try {
    (storage === "local" ? window.localStorage : window.sessionStorage).setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Random per-browser ID, reused across visits. No fingerprinting. */
function sessionId(): string | null {
  const stored = storageGet("local", SESSION_KEY);
  if (stored && SESSION_RE.test(stored)) return stored;
  if (memorySessionId) return memorySessionId;
  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") return null;
  const id = crypto.randomUUID();
  if (!storageSet("local", SESSION_KEY, id)) memorySessionId = id;
  return id;
}

/**
 * The same anonymous browser ID the events carry, for the invitation page
 * (lib/invitation.ts): one session, so a visitor's later scans stay
 * attributed to the invitation they arrived through.
 */
export function analyticsSessionId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return sessionId();
  } catch {
    return null;
  }
}

function readAttribution(): Attribution {
  try {
    const parsed: unknown = JSON.parse(storageGet("local", ATTRIBUTION_KEY) ?? "null");
    if (parsed && typeof parsed === "object") {
      const { ref, campaign } = parsed as Record<string, unknown>;
      return {
        ref: typeof ref === "string" && REF_RE.test(ref) ? ref : null,
        campaign: typeof campaign === "string" && CAMPAIGN_RE.test(campaign) ? campaign : null,
      };
    }
  } catch {
    // Unreadable: treat as unattributed.
  }
  return { ref: null, campaign: null };
}

/**
 * Remembers ?ref=rb_xxx (and optional &campaign=) from the landing URL, so
 * later events stay attributed after the parameter is gone. Invalid values
 * are ignored rather than stored.
 */
function captureAttribution() {
  const params = new URLSearchParams(window.location.search);
  const ref = params.get("ref")?.trim() ?? "";
  if (!REF_RE.test(ref)) return;
  const campaign = params.get("campaign")?.trim().toLowerCase() ?? "";
  storageSet(
    "local",
    ATTRIBUTION_KEY,
    JSON.stringify({ ref, campaign: CAMPAIGN_RE.test(campaign) ? campaign : null }),
  );
}

function send(event: ProductEvent | "report_exported", isSample: boolean, exportType: ExportType | null) {
  if (!API_URL || typeof window === "undefined") return;
  try {
    const id = sessionId();
    if (!id) return;
    const { ref, campaign } = readAttribution();
    const body = JSON.stringify({ sessionId: id, ref, event, campaign, isSample, exportType });
    const signal =
      typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
        ? AbortSignal.timeout(TIMEOUT_MS)
        : undefined;
    // Fire and forget: never awaited, and every failure is swallowed.
    fetch(`${API_URL}/api/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
      credentials: "omit",
      signal,
    }).catch(() => {});
  } catch {
    // Analytics must never affect the product.
  }
}

/** Captures referral attribution and records one landing view per tab session. */
export function trackLandingView() {
  if (typeof window === "undefined") return;
  try {
    captureAttribution();
    if (memoryLandingSent || storageGet("session", LANDING_KEY)) return;
    memoryLandingSent = true;
    storageSet("session", LANDING_KEY, "1");
  } catch {
    return;
  }
  send("landing_view", false, null);
}

export function trackEvent(event: Exclude<ProductEvent, "landing_view">, isSample = false) {
  send(event, isSample, null);
}

export function trackExport(exportType: ExportType, isSample: boolean) {
  send("report_exported", isSample, exportType);
}
