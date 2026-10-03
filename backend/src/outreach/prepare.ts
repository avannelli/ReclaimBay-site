/*
 * Automatic outreach preparation: finds every prospect a first message may
 * be prepared for and drafts it, without anyone opening the prospect.
 * Optionally queues the drafts too. Never sends: sending is dispatch.ts,
 * behind the global switch.
 *
 * Who is eligible is decided only by eligibility.ts, the same decision that
 * queueing and sending re-check: New, Qualified, or Ready to contact; Meets
 * criteria; a valid published email; no open or already-sent first message;
 * no bounce; not suppressed; and, to be queued, a complete sender identity
 * and a compliant message. The query below only narrows who to ask.
 */
import type { Db } from "../db.js";
import { ProspectError } from "../prospects.js";
import type { ComplianceConfig } from "./compliance.js";
import { ATTEMPTED_STATUSES, INITIAL_DRAFT_STATUSES, OPEN_STATUSES } from "./lifecycle.js";
import { createOutreachDraft, previewOutreachDraft, queueOutreach, type DraftOptions } from "./service.js";

export interface PrepareOptions {
  draft: DraftOptions;
  compliance: ComplianceConfig;
  /** Store drafts (otherwise only report what would happen). */
  apply: boolean;
  /** Also queue each draft for sending. */
  queue?: boolean;
  /** At most this many new drafts per run. */
  limit?: number;
}

export interface PrepareReport {
  checked: number;
  drafted: { prospectId: string; businessName: string | null; outreachId: string | null }[];
  queued: string[];
  notQueued: { outreachId: string; reasons: string[] }[];
  skipped: { prospectId: string; businessName: string | null; reasons: string[] }[];
}

export async function prepareEligibleOutreach(db: Db, opts: PrepareOptions): Promise<PrepareReport> {
  const limit = opts.limit ?? 50;
  const prospects = await db.prospect.findMany({
    where: {
      status: { in: [...INITIAL_DRAFT_STATUSES] },
      email: { not: null },
      emailSourceUrl: { not: null },
      outreach: { none: { status: { in: [...OPEN_STATUSES, ...ATTEMPTED_STATUSES] } } },
    },
    orderBy: [{ score: "desc" }, { createdAt: "asc" }],
    select: { id: true, businessName: true },
  });
  const report: PrepareReport = { checked: 0, drafted: [], queued: [], notQueued: [], skipped: [] };
  for (const p of prospects) {
    if (report.drafted.length >= limit) break;
    report.checked++;
    const preview = await previewOutreachDraft(db, p.id, opts.draft);
    if (preview.open || preview.errors.length || !preview.message) {
      report.skipped.push({ prospectId: p.id, businessName: p.businessName, reasons: preview.open ? ["Already has an open message."] : preview.errors });
      continue;
    }
    if (!opts.apply) {
      report.drafted.push({ prospectId: p.id, businessName: p.businessName, outreachId: null });
      continue;
    }
    const { outreach, created } = await createOutreachDraft(db, p.id, opts.draft);
    if (!created) {
      report.skipped.push({ prospectId: p.id, businessName: p.businessName, reasons: ["Already has an open message."] });
      continue;
    }
    report.drafted.push({ prospectId: p.id, businessName: p.businessName, outreachId: outreach.id });
    if (opts.queue) {
      try {
        await queueOutreach(db, outreach.id, opts.compliance);
        report.queued.push(outreach.id);
      } catch (err) {
        if (!(err instanceof ProspectError)) throw err;
        report.notQueued.push({ outreachId: outreach.id, reasons: err.messages });
      }
    }
  }
  return report;
}
