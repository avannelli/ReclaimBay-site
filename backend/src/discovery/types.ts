/*
 * Provider contracts. The candidate/research layer only ever sees these
 * shapes, so a real discovery or research vendor can be added later by
 * implementing one interface, with no change to the candidate model, the
 * scoring, or the admin.
 */
import type { SignalKey, StoredSignalValue } from "../scoring.js";

/** Provider-neutral discovery filter. Never a qualification verdict. */
export type CategoryTier = "core" | "adjacent";
export const CATEGORY_TIERS: readonly CategoryTier[] = ["core", "adjacent"];

/** A provider's own claim about whether a place operates. Unverified. */
export type ProviderOperatingStatus = "open" | "temporarily_closed" | "permanently_closed";

export interface DiscoveryTarget {
  /** e.g. "Ventura County, CA". */
  region: string;
  /** Optional narrowing, e.g. "Thousand Oaks". */
  city: string | null;
  /** e.g. "Independent automotive repair". */
  businessType: string;
  /** Category tiers to include. Empty means the provider's default (core). */
  tiers?: readonly CategoryTier[];
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
  streetAddress?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  /**
   * The phone the provider reports. Always stored as UNVERIFIED provider
   * contact: it never becomes the business's public phone until research
   * confirms it on the business's own website.
   */
  phone?: string | null;
  /** Public page this record came from, if the provider has one. Provenance only. */
  sourceUrl?: string | null;
  /** The provider's raw category code, e.g. "automotive_repair" or "car_repair". */
  category?: string | null;
  categoryTier?: CategoryTier | null;
  brand?: string | null;
  /** 0..1, as the provider states it. */
  confidence?: number | null;
  operatingStatus?: ProviderOperatingStatus | string | null;
  /** When the provider record was retrieved (e.g. the import time). */
  retrievedAt?: Date | null;
  /** The provider release the record came from, if versioned. */
  release?: string | null;
  /** Upstream datasets and licenses behind the record, e.g. "meta (CDLA-Permissive-2.0)". Provenance only. */
  sources?: string | null;
}

export interface DiscoveryProvider {
  /** Stable identifier stored on every candidate, e.g. "fixture". */
  readonly name: string;
  /** Shown in the admin. */
  readonly label: string;
  /**
   * "sync": small live lookups run inside the request (capped).
   * "background": the run is queued and read in batches by a worker, for
   * providers backed by large staged releases.
   */
  readonly mode?: "sync" | "background";
  /** Required for sync providers. */
  discover?(target: DiscoveryTarget): Promise<DiscoveredBusiness[]>;
  /** Required for background providers: batches until exhausted. */
  discoverBatches?(target: DiscoveryTarget): AsyncIterable<DiscoveredBusiness[]>;
  /**
   * Background providers backed by staging: the import a run for this
   * target would read, so the run can record it before reading. Throws
   * with a readable message when there is none.
   */
  resolveImport?(target: DiscoveryTarget): Promise<{ id: string; release: string }>;
}

/**
 * A geographic scope for an import: a state ({ region: "US-CA" }), or one
 * county in it ({ region: "US-CA", county: "Ventura County" }).
 */
export interface ImportScope {
  region: string;
  county?: string | null;
}

/** Counters an importer reports about what it read; stored on the import. */
export type ImportStats = Record<string, number | string>;

/**
 * A minimized staged record. The importer maps the provider's own record to
 * this shape and must drop everything else (raw payloads, emails, socials).
 */
export interface StagedPlace {
  externalId: string;
  businessName: string;
  website?: string | null;
  phone?: string | null;
  streetAddress?: string | null;
  city?: string | null;
  county?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  category?: string | null;
  categoryTier?: CategoryTier | null;
  brand?: string | null;
  confidence?: number | null;
  operatingStatus?: ProviderOperatingStatus | null;
  sourceUrl?: string | null;
  /** Upstream datasets and licenses behind the record. */
  sources?: string | null;
}

/**
 * Loads one provider release into staging. Runs outside the web process
 * (a CLI or scheduled job); never inside a request.
 */
export interface ProviderImporter {
  readonly provider: string;
  readonly label: string;
  /**
   * Turns a requested release (e.g. "latest") into the exact release that
   * will be imported, or throws when it isn't available. Optional: without
   * it, the requested release is used as given.
   */
  resolveRelease?(requested: string): Promise<string>;
  /** Refuses scopes the importer won't load (e.g. a whole state), with a reason. */
  checkScope?(scope: ImportScope): string | null;
  /**
   * Yields batches of minimized records. `stats` is filled in as it goes
   * and saved on the import, so an operator can see what was read and why
   * records were left out.
   */
  fetch(release: string, scope: ImportScope, stats?: ImportStats): AsyncIterable<StagedPlace[]>;
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
 * the default. A yes/no signal is only accepted together with evidence, and
 * contact only with a source page on the business's own website.
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
