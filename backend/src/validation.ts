/*
 * The analytics contract. The allowlist is the privacy guarantee: a payload
 * with any field not listed here is rejected, so report rows, customer data,
 * amounts, or filenames have nowhere to go.
 */

export const EVENT_TYPES = [
  "landing_view",
  "upload_started",
  "scan_completed",
  "tour_completed",
  "report_exported",
  "contact_clicked",
] as const;

export const EXPORT_TYPES = ["pdf", "csv", "copied_summary"] as const;

export type EventName = (typeof EVENT_TYPES)[number];
export type ExportKind = (typeof EXPORT_TYPES)[number];

/** crypto.randomUUID() output: lowercase v4 UUID. */
export const SESSION_ID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
/** Opaque referral code, e.g. rb_k3v9x0q2m7ta. */
export const REF_PATTERN = "^rb_[a-z0-9]{8,32}$";
/** Campaign tag, e.g. launch-v1. */
export const CAMPAIGN_PATTERN = "^[a-z0-9][a-z0-9._-]{0,63}$";

export interface EventBody {
  sessionId: string;
  event: EventName;
  ref?: string | null;
  campaign?: string | null;
  isSample?: boolean;
  exportType?: ExportKind | null;
}

export const eventBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["sessionId", "event"],
  properties: {
    sessionId: { type: "string", pattern: SESSION_ID_PATTERN },
    event: { type: "string", enum: EVENT_TYPES },
    ref: { anyOf: [{ type: "null" }, { type: "string", pattern: REF_PATTERN }] },
    campaign: { anyOf: [{ type: "null" }, { type: "string", pattern: CAMPAIGN_PATTERN }] },
    isSample: { type: "boolean" },
    exportType: { anyOf: [{ type: "null" }, { type: "string", enum: EXPORT_TYPES }] },
  },
} as const;

/** Cross-field rule: exportType is required for exports and forbidden otherwise. */
export function exportTypeError(body: EventBody): string | null {
  const hasExport = body.exportType != null;
  if (body.event === "report_exported" && !hasExport) return "exportType is required for report_exported";
  if (body.event !== "report_exported" && hasExport) return "exportType is only allowed for report_exported";
  return null;
}
