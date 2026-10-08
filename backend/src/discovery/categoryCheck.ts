/*
 * ReclaimBay's storage helpers for category check results.
 *
 * The category engine itself (checkName, checkWebsite, automatedMayReplace,
 * verdicts and labels) is the generic, fail-closed @avannelli/aos/categories;
 * this deployment's rules are CATEGORY_RULES in categories.ts. What stays here
 * is specific to ReclaimBay's DiscoveryCandidate columns.
 */
import type { CategoryResult } from "@avannelli/aos/categories";

/** Stored fields for a result (a person's decision has no rule set). */
export const categoryFields = (r: CategoryResult, at: Date) => ({
  categoryVerdict: r.verdict,
  categoryReason: r.reason,
  categorySource: r.source,
  categorySourceUrl: r.sourceUrl,
  categoryRules: r.source === "manual" ? null : r.rules,
  categoryCheckedAt: at,
});

/** Outside the target: not ranked by score, not approvable, skipped by automatic research. */
export const isOutsideTarget = (c: { categoryVerdict?: string | null }) => c.categoryVerdict === "wrong_category";
