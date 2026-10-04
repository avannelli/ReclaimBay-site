import type { Db } from "../db.js";

/*
 * Funnel numbers for the admin. Sample activity (isSample = true) is never
 * counted as a real upload, scan, tour, or export; it only appears in the
 * "sample" figures.
 */

export interface Summary {
  attributedProspects: number;
  uniqueVisitors: number;
  uploadSessions: number;
  uploadEvents: number;
  realScanSessions: number;
  realScanEvents: number;
  realExportSessions: number;
  realExportEvents: number;
  /** Real (not sample) "Talk to ReclaimBay" clicks and contact-address copies. */
  contactClickSessions: number;
  contactClickEvents: number;
  sampleScanEvents: number;
  scanConversionRate: number | null;
}

export interface ProspectRow {
  id: string | null;
  businessName: string | null;
  website: string | null;
  referralCode: string | null;
  status: string | null;
  visitors: number;
  visits: number;
  uploads: number;
  scans: number;
  tours: number;
  exports: number;
  contacts: number;
  exportTypes: string[];
  sampleEvents: number;
  lastActivity: Date | null;
  highIntent: boolean;
}

interface EventCountRow {
  eventType: string;
  isSample: boolean;
  events: number;
  sessions: number;
}

/*
 * Internal outreach tests (Prospect.internalTest) are left out of every number
 * here: their sessions and events are ReclaimBay's own, not a business's. A
 * test's activity shows only on its own prospect page.
 */
export async function loadSummary(db: Db): Promise<Summary> {
  const [counts, visitors, attributed] = await Promise.all([
    db.$queryRaw<EventCountRow[]>`
      SELECT e."eventType"::text AS "eventType", e."isSample",
             COUNT(*)::int AS events, COUNT(DISTINCT e."sessionId")::int AS sessions
      FROM "ProductEvent" e
      LEFT JOIN "Prospect" p ON p.id = e."prospectId"
      WHERE p."internalTest" IS NOT TRUE
      GROUP BY 1, 2`,
    db.analyticsSession.count({ where: { OR: [{ prospectId: null }, { prospect: { internalTest: false } }] } }),
    db.$queryRaw<{ n: number }[]>`
      SELECT COUNT(DISTINCT s."prospectId")::int AS n
      FROM "AnalyticsSession" s JOIN "Prospect" p ON p.id = s."prospectId"
      WHERE NOT p."internalTest"`,
  ]);

  const pick = (eventType: string, isSample: boolean) =>
    counts.find((c) => c.eventType === eventType && c.isSample === isSample) ?? { events: 0, sessions: 0 };

  const uploads = pick("upload_started", false);
  const scans = pick("scan_completed", false);
  const exportsReal = pick("report_exported", false);
  const contacts = pick("contact_clicked", false);

  return {
    attributedProspects: attributed[0]?.n ?? 0,
    uniqueVisitors: visitors,
    uploadSessions: uploads.sessions,
    uploadEvents: uploads.events,
    realScanSessions: scans.sessions,
    realScanEvents: scans.events,
    realExportSessions: exportsReal.sessions,
    realExportEvents: exportsReal.events,
    contactClickSessions: contacts.sessions,
    contactClickEvents: contacts.events,
    sampleScanEvents: pick("scan_completed", true).events,
    scanConversionRate: visitors > 0 ? scans.sessions / visitors : null,
  };
}

interface RawProspectRow extends Omit<ProspectRow, "highIntent" | "exportTypes"> {
  exportTypes: string[] | null;
}

export async function loadProspectRows(db: Db): Promise<ProspectRow[]> {
  const [prospects, unattributed] = await Promise.all([
    db.$queryRaw<RawProspectRow[]>`
      SELECT p.id::text AS id, p."businessName", p.website, p."referralCode", p.status::text AS status,
             (SELECT COUNT(*) FROM "AnalyticsSession" s WHERE s."prospectId" = p.id)::int AS visitors,
             COUNT(e.id) FILTER (WHERE e."eventType" = 'landing_view')::int AS visits,
             COUNT(e.id) FILTER (WHERE e."eventType" = 'upload_started' AND NOT e."isSample")::int AS uploads,
             COUNT(e.id) FILTER (WHERE e."eventType" = 'scan_completed' AND NOT e."isSample")::int AS scans,
             COUNT(e.id) FILTER (WHERE e."eventType" = 'tour_completed' AND NOT e."isSample")::int AS tours,
             COUNT(e.id) FILTER (WHERE e."eventType" = 'report_exported' AND NOT e."isSample")::int AS exports,
             COUNT(e.id) FILTER (WHERE e."eventType" = 'contact_clicked' AND NOT e."isSample")::int AS contacts,
             array_agg(DISTINCT e."exportType"::text)
               FILTER (WHERE e."eventType" = 'report_exported' AND NOT e."isSample") AS "exportTypes",
             COUNT(e.id) FILTER (WHERE e."isSample")::int AS "sampleEvents",
             MAX(e."createdAt") AS "lastActivity"
      FROM "Prospect" p
      LEFT JOIN "ProductEvent" e ON e."prospectId" = p.id
      WHERE NOT p."internalTest"
      GROUP BY p.id
      ORDER BY "lastActivity" DESC NULLS LAST, p."createdAt" DESC`,
    db.$queryRaw<RawProspectRow[]>`
      SELECT NULL AS id, NULL AS "businessName", NULL AS website, NULL AS "referralCode", NULL AS status,
             (SELECT COUNT(*) FROM "AnalyticsSession" s WHERE s."prospectId" IS NULL)::int AS visitors,
             COUNT(e.id) FILTER (WHERE e."eventType" = 'landing_view')::int AS visits,
             COUNT(e.id) FILTER (WHERE e."eventType" = 'upload_started' AND NOT e."isSample")::int AS uploads,
             COUNT(e.id) FILTER (WHERE e."eventType" = 'scan_completed' AND NOT e."isSample")::int AS scans,
             COUNT(e.id) FILTER (WHERE e."eventType" = 'tour_completed' AND NOT e."isSample")::int AS tours,
             COUNT(e.id) FILTER (WHERE e."eventType" = 'report_exported' AND NOT e."isSample")::int AS exports,
             COUNT(e.id) FILTER (WHERE e."eventType" = 'contact_clicked' AND NOT e."isSample")::int AS contacts,
             array_agg(DISTINCT e."exportType"::text)
               FILTER (WHERE e."eventType" = 'report_exported' AND NOT e."isSample") AS "exportTypes",
             COUNT(e.id) FILTER (WHERE e."isSample")::int AS "sampleEvents",
             MAX(e."createdAt") AS "lastActivity"
      FROM "ProductEvent" e
      WHERE e."prospectId" IS NULL`,
  ]);

  const rows = [...prospects];
  const direct = unattributed[0];
  if (direct && (direct.visitors > 0 || direct.lastActivity)) rows.push(direct);

  return rows.map((r) => ({
    ...r,
    exportTypes: (r.exportTypes ?? []).filter(Boolean).sort(),
    // High intent = a real scan AND a real export, or asking to talk. Nothing more elaborate.
    highIntent: (r.scans > 0 && r.exports > 0) || r.contacts > 0,
  }));
}
