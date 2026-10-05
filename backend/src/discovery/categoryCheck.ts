/*
 * Category check: is a business the kind the target serves?
 *
 * A small deterministic rules engine, separate from qualification and the
 * opportunity score (src/scoring.ts) and from the candidate's status. It
 * answers one of three verdicts from evidence it can quote:
 *
 *   in_target       nothing points outside the target, or the business's
 *                   own website confirms it
 *   wrong_category  positive evidence of a business outside the target
 *   unclear         mixed or too little evidence: a person should look
 *
 * The engine knows nothing about any industry. Each vertical supplies a
 * CategoryRules object (this deployment's are CATEGORY_RULES in
 * categories.ts). Missing evidence never makes a business wrong-category:
 * that always takes a term the rules name as outside the target.
 */

export const CATEGORY_VERDICTS = ["in_target", "wrong_category", "unclear"] as const;
export type CategoryVerdict = (typeof CATEGORY_VERDICTS)[number];
export type CategorySource = "provider" | "name" | "website" | "manual";

export const isCategoryVerdict = (v: string): v is CategoryVerdict => (CATEGORY_VERDICTS as readonly string[]).includes(v);

export const CATEGORY_VERDICT_LABELS: Record<CategoryVerdict, string> = {
  in_target: "In target category",
  wrong_category: "Wrong category",
  unclear: "Category unclear",
};

export const CATEGORY_SOURCE_LABELS: Record<CategorySource, string> = {
  provider: "provider category",
  name: "business name",
  website: "business's own website",
  manual: "a person",
};

/** A labelled pattern, matched case-insensitively. */
export interface Term {
  label: string;
  pattern: RegExp;
}

/**
 * A name term that points outside the target:
 *   exclusive  outside the target even next to an in-scope term
 *   strong     outside the target unless an in-scope term is also present
 *   weak       not enough on its own: unclear unless an in-scope term is present
 */
export interface OutOfScopeTerm extends Term {
  strength: "exclusive" | "strong" | "weak";
}

export interface CategoryRules {
  /** Rule set and version, stored with every verdict, e.g. "<vertical>@c1". */
  id: string;
  /** What the target is, as reasons name it ("… outside <target>"). */
  target: string;
  name: {
    /** Terms that show the business does what the target needs. */
    inScope: readonly Term[];
    outOfScope: readonly OutOfScopeTerm[];
    /** Discovery names/categories remain provisional until sourced services are confirmed. */
    provisional?: boolean;
  };
  website: {
    /** One word for the target's vocabulary in reasons ("no <noun> services or vocabulary"). */
    targetNoun: string;
    /** Words a target business's site uses (any language the rules cover). */
    vocabulary: readonly Term[];
    /** Words that describe other trades. */
    otherTrades: readonly Term[];
    /** Distinct other-trade terms needed, with no target vocabulary, for wrong_category. */
    minOtherTrades: number;
    /** Readable text (all pages) below which a site says nothing either way. */
    minReadableChars: number;
  };
}

export interface CategoryResult {
  verdict: CategoryVerdict;
  source: CategorySource;
  reason: string;
  sourceUrl: string | null;
  rules: string;
}

const matched = (terms: readonly Term[], text: string) => terms.filter((t) => new RegExp(t.pattern.source, "i").test(text));
const labels = (terms: readonly Term[]) => [...new Set(terms.map((t) => t.label))];
const list = (items: readonly string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const clip = (s: string) => (s.length > 300 ? `${s.slice(0, 299)}…` : s);

export interface NameEvidence {
  name: string;
  /** The provider's category code and its tier, when a provider supplied it. */
  providerCategory?: string | null;
  providerTier?: string | null;
}

/**
 * The name-stage check, run when a candidate is created (and by the
 * backfill). A name is wrong-category only with strong out-of-scope evidence
 * and no in-scope term, or an exclusive term.
 */
export function checkName(rules: CategoryRules, ev: NameEvidence): CategoryResult {
  const result = (verdict: CategoryVerdict, source: CategorySource, reason: string): CategoryResult => ({
    verdict,
    source,
    reason: clip(reason),
    sourceUrl: null,
    rules: rules.id,
  });
  const inScope = labels(matched(rules.name.inScope, ev.name));
  const out = matched(rules.name.outOfScope, ev.name) as OutOfScopeTerm[];
  const exclusive = labels(out.filter((t) => t.strength === "exclusive"));
  const strong = labels(out.filter((t) => t.strength === "strong"));
  const weak = labels(out.filter((t) => t.strength === "weak"));

  if (exclusive.length) return result("wrong_category", "name", `The name indicates ${list(exclusive)}, outside ${rules.target}.`);
  if (strong.length && !inScope.length) {
    return result("wrong_category", "name", `The name indicates ${list(strong)}, outside ${rules.target}, and names no in-scope service.`);
  }
  if (strong.length) {
    return result("unclear", "name", `The name indicates ${list(strong)} (outside ${rules.target}) but also ${list(inScope)}. Check by hand.`);
  }
  if (weak.length && !inScope.length) {
    return result("unclear", "name", `The name points to ${list(weak)} and names no in-scope service; check by hand whether it offers ${rules.target}.`);
  }
  if (inScope.length) return result(rules.name.provisional ? "unclear" : "in_target", "name", `The name indicates ${list(inScope)}.${rules.name.provisional ? " Verify the business's actual services." : ""}`);
  if (ev.providerCategory) {
    const tier = ev.providerTier ? ` (${ev.providerTier})` : "";
    return result(rules.name.provisional ? "unclear" : "in_target", "provider", `The provider lists it as ${ev.providerCategory}${tier}, and nothing in the name is outside ${rules.target}.${rules.name.provisional ? " Provider categories are leads, not verified product fit." : ""}`);
  }
  return result(rules.name.provisional ? "unclear" : "in_target", "name", `Nothing in the name establishes ${rules.target}.${rules.name.provisional ? " Verify its services." : ""}`);
}

export interface WebsitePage {
  url: string;
  text: string;
}

/**
 * The website-stage check, run by research ONLY on a website confirmed as
 * the business's own. `confirmed` is the caller's positive target evidence
 * (e.g. the general services research found). Returns null when the site
 * says nothing either way, so the earlier verdict stands.
 */
export function checkWebsite(
  rules: CategoryRules,
  pages: readonly WebsitePage[],
  confirmed: { url: string; what: string } | null,
): CategoryResult | null {
  const result = (verdict: CategoryVerdict, reason: string, sourceUrl: string | null): CategoryResult => ({
    verdict,
    source: "website",
    reason: clip(reason),
    sourceUrl,
    rules: rules.id,
  });
  if (!pages.length) return null;
  if (confirmed) return result("in_target", `The website names ${confirmed.what}.`, confirmed.url);

  const w = rules.website;
  const vocabulary = pages.some((p) => matched(w.vocabulary, p.text).length > 0);
  const trades = new Map<string, string>();
  for (const p of pages) for (const t of matched(w.otherTrades, p.text)) if (!trades.has(t.label)) trades.set(t.label, p.url);
  const readable = pages.reduce((n, p) => n + p.text.trim().length, 0);
  const n = pages.length;
  const pagesRead = `${n} page${n === 1 ? "" : "s"} read`;

  if (trades.size >= w.minOtherTrades && !vocabulary) {
    return result(
      "wrong_category",
      `Website describes ${list([...trades.keys()])}; no ${w.targetNoun} services or vocabulary on the ${pagesRead}.`,
      [...trades.values()][0]!,
    );
  }
  if (trades.size >= w.minOtherTrades) {
    return result("unclear", `Website describes ${list([...trades.keys()])} as well as ${w.targetNoun} work. Check by hand.`, [...trades.values()][0]!);
  }
  if (!vocabulary && readable >= w.minReadableChars) {
    return result("unclear", `The website names neither ${rules.target} nor another trade on the ${pagesRead}. Check by hand.`, pages[0]!.url);
  }
  // Target vocabulary without confirmed services (e.g. a specialty shop),
  // or too little readable text: nothing new about the category.
  return null;
}

/**
 * Whether an automated result may replace the stored verdict:
 *   - never a person's decision;
 *   - name or provider evidence never replaces website evidence;
 *   - a website "unclear" never clears positive name evidence of wrong_category.
 */
export function automatedMayReplace(current: { verdict: CategoryVerdict | null; source: CategorySource | null }, next: CategoryResult): boolean {
  if (current.source === "manual") return false;
  if (next.source !== "website") return current.source !== "website";
  if (next.verdict === "unclear" && current.verdict === "wrong_category" && current.source !== "website") return false;
  return true;
}

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
