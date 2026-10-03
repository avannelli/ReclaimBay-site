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

/** The most drafts one preparation prepares (the CLI's default, and the admin's hard limit). */
export const PREPARE_LIMIT = 50;

export async function prepareEligibleOutreach(db: Db, opts: PrepareOptions): Promise<PrepareReport> {
  const limit = opts.limit ?? PREPARE_LIMIT;
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

/** What happened to one prospect in a selected preparation. */
export type PrepareOutcome =
  /** A draft and its invitation were made. */
  | "prepared"
  /** It already had an open message: nothing new was made. */
  | "existing"
  /** It isn't eligible now (it may have changed since the page was shown), or doesn't exist. */
  | "ineligible"
  /** It passed the check, then drafting refused it: it changed in between. Nothing was made. */
  | "refused"
  /** Something unexpected went wrong for this one: nothing was made for it. */
  | "failed";
export const PREPARE_OUTCOMES: readonly PrepareOutcome[] = ["prepared", "existing", "ineligible", "refused", "failed"];

export interface PrepareResult {
  prospectId: string;
  outcome: PrepareOutcome;
  outreachId: string | null;
  reasons: string[];
}

/**
 * Drafts first messages for the prospects a person chose (at most
 * PREPARE_LIMIT), one at a time, each in its own drafting transaction
 * (createOutreachDraft, which makes the invitation with it). Every prospect is
 * checked again here, whatever the page showed, by the same preview drafting
 * uses; one prospect's problem never stops the rest. Never queues, never sends.
 * `createDraft` is the drafting service, replaceable only by tests.
 */
export async function prepareSelectedOutreach(
  db: Db,
  prospectIds: readonly string[],
  opts: { draft: DraftOptions; createDraft?: typeof createOutreachDraft; onError?: (prospectId: string, err: unknown) => void },
): Promise<PrepareResult[]> {
  const ids = [...new Set(prospectIds)];
  if (ids.length > PREPARE_LIMIT) throw new ProspectError([`Choose at most ${PREPARE_LIMIT} prospects at a time.`]);
  const createDraft = opts.createDraft ?? createOutreachDraft;
  const results: PrepareResult[] = [];
  for (const prospectId of ids) {
    const result = (outcome: PrepareOutcome, reasons: string[] = [], outreachId: string | null = null) => results.push({ prospectId, outcome, outreachId, reasons });
    let preview: Awaited<ReturnType<typeof previewOutreachDraft>>;
    try {
      preview = await previewOutreachDraft(db, prospectId, opts.draft);
    } catch (err) {
      if (err instanceof ProspectError) result("ineligible", err.messages);
      else {
        opts.onError?.(prospectId, err);
        result("failed");
      }
      continue;
    }
    if (preview.open) {
      result("existing", [], preview.open.id);
      continue;
    }
    if (preview.errors.length || !preview.message) {
      result("ineligible", preview.errors);
      continue;
    }
    try {
      const { outreach, created } = await createDraft(db, prospectId, opts.draft);
      result(created ? "prepared" : "existing", [], outreach.id);
    } catch (err) {
      if (err instanceof ProspectError) result("refused", err.messages);
      else {
        opts.onError?.(prospectId, err);
        result("failed");
      }
    }
  }
  return results;
}
