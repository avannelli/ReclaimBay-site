# Discovery and research (Milestone 3)

Discovery helps find independent repair shops that may fit ReclaimBay. It
never decides who is a good lead. Every business moves through the same
human-controlled path before it becomes a prospect:

```
discovery provider / manual entry
        -> clean + normalize
        -> deduplicate
        -> CANDIDATE            (kept out of the prospect pipeline)
        -> research             (public facts, each with a source URL)
        -> qualification + opportunity score   (existing scoring.ts, unchanged)
        -> HUMAN APPROVAL
        -> PROSPECT at status New               (existing Prospect model)
```

A discovered business is never a prospect until a person approves it. The
Prospect model, its statuses, scoring weights, qualification rules, referral
codes, and analytics attribution are unchanged; discovery only feeds them.

## Where things live

| Piece | File |
| ----- | ---- |
| Provider and research contracts | `src/discovery/types.ts` |
| Cleaning and match keys | `src/discovery/normalize.ts` |
| Duplicate detection (pure) | `src/discovery/dedupe.ts` |
| Candidate lifecycle (pure) | `src/discovery/candidateStatus.ts` |
| Candidate to Prospect mapping (pure) | `src/discovery/approval.ts` |
| Provider registry and the fixture provider | `src/discovery/providers.ts` |
| Persistence, runs, research, approval | `src/discovery/service.ts` |
| Admin pages and routes | `src/admin/discoveryViews.ts`, `src/routes/adminDiscovery.ts` |

## Data model

| Table | Holds |
| ----- | ----- |
| `DiscoveryRun` | One provider execution: provider, region, city, business type, status, and counters (found, created, skipped duplicates, flagged, invalid) |
| `DiscoveryCandidate` | The business (name, website, city, state, postal code, country), public phone and email **each with a source URL**, normalized match keys, provenance (provider, provider ID, source URL, search, discovered time), review status, research and decision timestamps, duplicate flags, and the `prospectId` once approved |
| `CandidateSignal` | One recorded yes/no observation per signal key. **No row means unknown.** |
| `CandidateEvidence` | Signal key, public source URL, excerpt of at most 280 characters, time |
| `CandidateNote` | Append-only notes (at most 2,000 characters) |

**Score and qualification are never stored on a candidate.** They are computed
by `scoreProspect()` in `src/scoring.ts` whenever a page or list needs them
(`scoreCandidate()` in `approval.ts` is a thin adapter, not a second
implementation), so a candidate can't disagree with scoring or drift from it.
Only a Prospect keeps a cached score, as before.

The candidate's research source URLs are its evidence, phone, and email source
URLs plus the discovery record URL. The detail page lists them together under
"Where each fact came from".

## Candidate lifecycle

| Status | Meaning |
| ------ | ------- |
| `discovered` | Found by a provider or added by hand. Nothing researched yet. |
| `researching` | Being researched. |
| `researched` | Research recorded, and every recorded fact has a public source. |
| `needs_review` | Waiting for a human look. Every possible duplicate enters here. |
| `approved` | A human approved it. It is now a Prospect (status New). Terminal. |
| `rejected` | A human decided it should not enter the pipeline (reason required). |
| `duplicate` | The same business as another candidate or prospect (reason required). |

**Allowed manual moves** (anything else is refused):

| From | To |
| ---- | -- |
| discovered | researching, needs_review, rejected, duplicate |
| researching | researched, discovered, needs_review, rejected, duplicate |
| researched | researching, needs_review, rejected, duplicate |
| needs_review | researching, researched, rejected, duplicate |
| rejected | discovered |
| duplicate | discovered |
| approved | *(none)* |

- **`approved` is never a status you set.** It is entered only by **Approve**,
  which creates the Prospect. Approved candidates are frozen.
- **"Researched" means evidence-backed.** It needs at least one evidence item,
  and **every recorded yes/no signal needs its own evidence**. A signal with no
  evidence should be left Unknown. Edits that would break this are refused
  while a candidate is Researched. The same check runs again at approval.
- **Rejected and duplicate candidates can't be approved.** They can be reopened
  to `discovered`, which clears the earlier decision.
- **A rejected candidate is not resurrected by a later run.** Reruns see it as
  already known.

## Deduplication

Deterministic only: no fuzzy or AI matching. Every record is checked against
all stored candidates and all prospects, plus the other records in the same run.

| Outcome | When | What happens |
| ------- | ---- | ------------ |
| `CONFIDENT_DUPLICATE` | The same provider **and** provider ID, **or** the same website domain (business-owned domains only) | The record is skipped and counted. Nothing is created, updated, or merged. |
| `REVIEW_REQUIRED` | The same normalized name in the same city and state, **or** the same ten-digit phone number | The record **is stored**, enters `needs_review`, and carries the reason and a link to the match. |
| `NO_MATCH` | Nothing overlaps | Stored as `discovered`. |

- **Weak evidence is never auto-skipped.** A shared name or phone can be a second
  location, a relocated shop, or a shared switchboard.
- **Existing prospects are authoritative.** Discovery only reads them. A
  confident match skips the record; a weak match is flagged. A prospect is never
  modified by discovery. At approval, a confident match with an existing prospect
  blocks the approval ("mark this candidate as a duplicate instead").
- **Normalization:**
  - Domains: lowercase, `www.` removed. Listing and social hosts (Facebook,
    Yelp, Google, Instagram, and similar) never identify a business and are
    dropped as websites, so they can't count as "has a website".
  - Names: lowercase, accents and punctuation removed, `&` becomes `and`, and
    trailing legal suffixes (`Inc`, `LLC`, `Corp`, …) are removed. Words like
    "auto" and "repair" are kept, so `Smith Auto` and `Smith Auto Body` differ.
  - Phones: ten digits, with a leading `1` removed.
- **Flags are set when a record is stored.** They are not recomputed after
  later edits.
- **Concurrency:** a unique index on (provider, provider ID) stops two
  simultaneous runs from storing the same provider record twice. Domain and
  weak matches are checked in application code, so two simultaneous runs could
  both store a domain duplicate. Runs are started by hand, one at a time.

## Research rules

Research records **public business facts only**, each with a source URL.

**Allowed sources:** the business's own website, its public contact page, a
public business listing or directory, and other public business sources.

**Never collected:** owner or staff personal information, personal emails or
phone numbers, home addresses, individual owners' social profiles, sensitive
personal information, customer report data, declined-work amounts, customer
information, scraped review text, or copied page bodies.

The data model enforces this rather than relying on discipline:
- There are no fields for any of the above. A provider record is reduced to the
  allowed business fields; anything else it sends is discarded. A test checks
  that the discovery tables have no such columns.
- **Contact details** need the public URL where they are listed. Without one,
  the value is dropped (discovery) or refused (entry).
- **Evidence** is a known signal, a public http(s) URL, and an excerpt of at most
  280 characters. It is not a place to paste a page.
- **Unknown stays unknown.** Employee count, bay count, technician count, booking
  availability, website age, and digital inspection use are recorded only when a
  public source shows them. Research findings can't set a yes/no without
  evidence, and "yes" can't be set by hand on the two derived signals.

## Approval

Approval is an explicit human POST from the candidate page. It:

1. Checks the candidate is `researched` or `needs_review`, every recorded signal
   has evidence, the facts pass the **same validators as creating a prospect by
   hand**, and no existing prospect has the same domain.
2. Creates the **existing Prospect** through the same insert path, at status
   **New**, with a new opaque referral code and the cached score from
   `scoring.ts`.
3. Copies the business facts, public contact with sources, signals (with their
   observation times), and evidence (with their timestamps).
4. Writes a note on the prospect recording the provider, provider ID, source URL,
   search, discovery date, candidate, and run.
5. Marks the candidate `approved` and links it to the prospect. The candidate
   stays, as the discovery record.

All of this happens in one transaction, and a claim step means two simultaneous
approvals create exactly one prospect.

**Approval does not qualify anything.** The prospect starts as New. Qualified
and Ready to contact still require Qualification = Meets criteria (and, for
Ready to contact, a public phone or email with its source), exactly as before.
A disqualified or unverified candidate can be approved into the pipeline and
still can never be qualified until its facts change. Candidate notes are not
copied; they stay on the candidate.

## Scoring and qualification

Unchanged. `src/scoring.ts` defines the nine signals, weights, required criteria,
qualification, score, and bands. Discovery adds no signals and changes no
weights. **Qualification** (Independent shop and Offers general repair) and the
**opportunity score** stay separate, in the list and on the detail page.
Discovery confidence never becomes qualification: a freshly discovered record has
no signals and is Unverified.

## Providers

### Discovery providers

A provider implements `DiscoveryProvider`:

```ts
interface DiscoveryProvider {
  readonly name: string;   // stored on every candidate, e.g. "google-places"
  readonly label: string;  // shown in the admin
  discover(target: { region: string; city: string | null; businessType: string }): Promise<DiscoveredBusiness[]>;
}
```

`DiscoveredBusiness` holds only `externalId`, `businessName`, `website`, `city`,
`state`, `postalCode`, `country`, `phone`, and `sourceUrl`. To add a provider,
implement the interface and register it in `discoveryProviders()`
(`src/discovery/providers.ts`). Nothing else changes: cleaning, deduplication,
candidates, research, scoring, and approval are provider-independent. Runs are
synchronous within the request, limited to 200 records and 30 seconds; a provider
failure is recorded on the run (with URLs redacted) instead of breaking the page.

**What exists now:**
- **`fixture`**: a deterministic set of clearly synthetic businesses (example.com
  data) covering clean records, a domain duplicate, a name-and-city match, a
  social-page "website", and an unsourced phone. It is **offered only outside
  production**. Set `ENABLE_FIXTURE_DISCOVERY=1` to opt in on a server that
  treats itself as production; don't, on the real database.
- **Manual entry** ("Add candidate"): provider `manual`, with the same cleaning
  and duplicate rules. In production this is the only way candidates enter until
  a provider is chosen.

### Research providers

```ts
interface ResearchProvider {
  readonly name: string;
  research(subject: { businessName; website; city; state }): Promise<ResearchFindings>;
}
```

The provider sees only the name, website, city, and state, never notes, contact
details, or anything from a customer report. `applyResearchFindings()` accepts its
findings under the same rules as a person: known signals only, yes/no only with
evidence, contact only with a source, nothing overwrites contact a person already
entered, and the candidate lands at `researched` for a human decision. Invalid
findings are refused as a whole. **No research provider is configured and the
admin has no "run research" button.** Research is done by hand today.

## Provider requirements (decision needed)

Nothing below is wired in. No dependency, credential, or external service was
added. Choosing one is a product and legal decision.

### Discovery: a business-listing source is required

**Why:** finding shops in a region needs a directory of businesses. The app has
none. Research can't start until candidates exist.

**What every option provides:** business name, address or city, phone, website,
and a listing URL. **What none of them provides:** whether a shop is independent
or a franchise, what services it really does, bay or technician counts, digital
inspections, online booking, or website freshness. Those come from research.

| Option | Credential | Cost | Main caveat |
| ------ | ---------- | ---- | ----------- |
| Google Places API (Text Search) | API key and a billing account | Pay per request. Text Search at the tier that returns website and phone was listed at about $32 per 1,000 requests; verify current pricing | Google's terms allow storing the place ID indefinitely but give no caching allowance for names, phones, or websites. Storing them as candidates may not be permitted. Confirm the current terms before building |
| OpenStreetMap (Overpass API, `shop=car_repair`) | None | Free | Data is under the ODbL, which has attribution and share-alike obligations for derived databases. Coverage of phone and website varies a lot by area |
| Yelp Fusion API | API key | Paid plans were listed at about $8 to $15 per 1,000 calls; verify | Terms restrict how results may be stored and displayed |
| A licensed business-data file or vendor | Varies | Varies | Terms and freshness depend on the vendor |

Prices and terms change. The figures above come from public pricing pages
checked during this milestone and must be verified before committing to a
source. Whichever is chosen, the storage terms decide whether candidate rows may
keep provider-supplied fields, so check that first.

### Research: website reading is required for automation

Automating signals means fetching a shop's own public pages and reading them.
That needs a fetcher (respecting robots.txt and rate limits) and either an LLM
API key or rule-based extraction, with output limited to `ResearchFindings`.
Expected cost is usage-based and depends on the model and pages per shop. The
validation path, evidence rules, and human gate already exist; the provider does
not. Until one is chosen, research stays manual.

## Admin

| Page | What it does |
| ---- | ------------ |
| `/admin/discovery` | Run discovery, add a candidate, status counts, search and filters (status, qualification, score band, state, city, possible duplicate), sorting by score, recency, or name, and recent runs with their counters |
| `/admin/discovery/candidates/new` | Add a candidate by hand |
| `/admin/discovery/candidates/:id` | What we know, what we don't know, and where each fact came from. Qualification and score shown separately. Possible-duplicate explanation with links. Status moves, evidence, notes, and Approve |
| `/admin/discovery/candidates/:id/edit` | Edit facts and record signals with each signal's rules |

Discovery pages are registered inside the admin scope, so they share its
session check, same-origin check on every POST, rate limits, and security
headers (CSP with no scripts, `no-store`, `noindex`). Nothing here is public.
Discovery sends nothing to analytics, and no customer report data is involved.

## Not automated yet

- Choosing or calling a real discovery provider, or any network fetch.
- Reading websites or filling in signals automatically.
- Contacting anyone. No email, calls, outreach, follow-ups, or campaigns.
- Scheduled or recurring discovery runs.
- Re-checking duplicates after edits, or merging candidates.
- Copying candidate notes onto the prospect.

## Known limits

- The list computes scores in memory for up to 2,000 matching candidates and shows
  the first 200. Fine for hundreds of candidates; a cached score would be needed
  for many thousands.
- Runs are synchronous inside the request. A slow provider holds the page until it
  finishes or times out at 30 seconds.

## Tests

```bash
npm test                    # unit: normalization, dedupe, lifecycle, scoring reuse, approval mapping, privacy
TEST_DATABASE_URL=<local url> npm run test:integration
                            # runs, dedupe against candidates and prospects, research, lifecycle,
                            # approval, provenance, and the admin pages over HTTP
```

See [PROSPECTS.md](PROSPECTS.md#tests) for the disposable-database setup and safety guards.
