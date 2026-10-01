/*
 * Pure mapping between a candidate and the existing Prospect/scoring code.
 * Nothing here scores anything itself: scoring always goes through
 * scoreProspect() in scoring.ts, and prospect validation through
 * parseProspectInput() in prospects.ts.
 */
import { parseProspectInput, signalFieldName, type ProspectInput } from "../prospects.js";
import { SIGNAL_KEYS, isSignalKey, scoreProspect, type ScoreResult, type ScoringInput, type StoredSignalValue } from "../scoring.js";
import { researchedErrors } from "./candidateStatus.js";

/** The candidate fields scoring and approval read. */
export interface CandidateFacts {
  businessName: string;
  website: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string;
  phone: string | null;
  phoneSourceUrl: string | null;
  email: string | null;
  emailSourceUrl: string | null;
  signals: readonly { key: string; value: StoredSignalValue }[];
}

export function candidateScoringInput(c: CandidateFacts): ScoringInput {
  const signals: Partial<Record<string, StoredSignalValue>> = {};
  for (const s of c.signals) signals[s.key] = s.value;
  return {
    website: c.website,
    phone: c.phone,
    phoneSourceUrl: c.phoneSourceUrl,
    email: c.email,
    emailSourceUrl: c.emailSourceUrl,
    signals,
  };
}

/** Qualification, score, band, and unknowns: the existing scoring, unchanged. */
export const scoreCandidate = (c: CandidateFacts): ScoreResult => scoreProspect(candidateScoringInput(c));

/** Recorded yes/no signals (known keys only) that have no evidence item. */
export function unevidencedSignals(
  signals: readonly { key: string }[],
  evidence: readonly { signalKey: string }[],
): string[] {
  const covered = new Set(evidence.map((e) => e.signalKey));
  return signals.filter((s) => isSignalKey(s.key) && !covered.has(s.key)).map((s) => s.key);
}

/** Why a candidate can't be called "researched" yet (empty when it can). */
export function researchGateErrors(
  signals: readonly { key: string }[],
  evidence: readonly { signalKey: string }[],
): string[] {
  return researchedErrors({ unevidencedSignals: unevidencedSignals(signals, evidence), evidenceCount: evidence.length });
}

/**
 * The form the Prospect validators expect, built from a candidate. Going
 * through parseProspectInput means approval is held to exactly the same
 * rules as creating a prospect by hand.
 */
export function candidateToProspectInput(c: CandidateFacts): { input: ProspectInput; errors: string[] } {
  const raw: Record<string, string> = {
    businessName: c.businessName,
    website: c.website ?? "",
    city: c.city ?? "",
    state: c.state ?? "",
    postalCode: c.postalCode ?? "",
    country: c.country,
    phone: c.phone ?? "",
    phoneSourceUrl: c.phoneSourceUrl ?? "",
    email: c.email ?? "",
    emailSourceUrl: c.emailSourceUrl ?? "",
  };
  const recorded = new Map(c.signals.map((s) => [s.key, s.value]));
  for (const key of SIGNAL_KEYS) raw[signalFieldName(key)] = recorded.get(key) ?? "unknown";
  return parseProspectInput(raw);
}

export interface Provenance {
  provider: string;
  externalId: string | null;
  sourceUrl: string | null;
  query: string | null;
  discoveredAt: Date;
  candidateId: string;
  runId: string | null;
  release?: string | null;
}

/** The note written on the new Prospect so its origin is never lost. */
export function provenanceNote(p: Provenance): string {
  const parts = [
    "Approved by a human from a discovery candidate.",
    `Provider: ${p.provider}.`,
    p.externalId && `Provider ID: ${p.externalId}.`,
    p.sourceUrl && `Discovery source: ${p.sourceUrl}.`,
    p.query && `Search: ${p.query}.`,
    p.release && `Release: ${p.release}.`,
    `Discovered: ${p.discoveredAt.toISOString().slice(0, 10)}.`,
    `Candidate: ${p.candidateId}.`,
    p.runId && `Run: ${p.runId}.`,
  ].filter(Boolean);
  return parts.join(" ").slice(0, 2000);
}
