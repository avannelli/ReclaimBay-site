/*
 * Provider contracts. The candidate/research layer only ever sees these
 * shapes, so a real discovery or research vendor can be added later by
 * implementing one interface, with no change to the candidate model, the
 * scoring, or the admin.
 */
import type { SignalKey, StoredSignalValue } from "../scoring.js";

export interface DiscoveryTarget {
  /** e.g. "Ventura County, CA". */
  region: string;
  /** Optional narrowing, e.g. "Thousand Oaks". */
  city: string | null;
  /** e.g. "Independent automotive repair". */
  businessType: string;
}

/**
 * One business as a provider reports it. Only these public business facts
 * exist in the shape: there is nowhere to put owner details, reviews, or
 * customer data. Everything is untrusted and cleaned before it is stored.
 */
export interface DiscoveredBusiness {
  /** The provider's own stable ID for the business, when it has one. */
  externalId?: string | null;
  businessName: string;
  website?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  phone?: string | null;
  /** Public page this record came from (also the source for the phone). */
  sourceUrl?: string | null;
}

export interface DiscoveryProvider {
  /** Stable identifier stored on every candidate, e.g. "fixture". */
  readonly name: string;
  /** Shown in the admin. */
  readonly label: string;
  discover(target: DiscoveryTarget): Promise<DiscoveredBusiness[]>;
}

/** What a research provider is allowed to see about a candidate. */
export interface ResearchSubject {
  businessName: string;
  website: string | null;
  city: string | null;
  state: string | null;
}

export interface ResearchEvidence {
  signalKey: SignalKey;
  sourceUrl: string;
  /** At most 280 characters. */
  excerpt: string;
}

/**
 * What research found. Anything not established must be left out: unknown is
 * the default. A yes/no signal is only accepted together with evidence.
 */
export interface ResearchFindings {
  signals: Partial<Record<SignalKey, StoredSignalValue>>;
  evidence: ResearchEvidence[];
  contact?: {
    phone?: string | null;
    phoneSourceUrl?: string | null;
    email?: string | null;
    emailSourceUrl?: string | null;
  };
}

export interface ResearchProvider {
  readonly name: string;
  research(subject: ResearchSubject): Promise<ResearchFindings>;
}
