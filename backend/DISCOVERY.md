# Discovery and research (Milestones 3 to 6)

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

Large open-data providers (Overture Maps Places, since Milestone 5) feed the
same path through a background pipeline, so no web request ever processes a
dataset:

```
PROVIDER RELEASE  -> discovery:import (background job) -> staging (ProviderImport + ProviderPlace)
                  -> queued DiscoveryRun -> worker processes it in batches
                  -> clean + normalize -> deduplicate -> CANDIDATES -> (same path as above)
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
| Provider category codes and tiers (incl. the Overture classifier) | `src/discovery/categories.ts` |
| Overture Places: release lookup, record mapping, importer | `src/discovery/overture.ts` |
| Overture Places: reading the release (DuckDB, background only) | `src/discovery/overtureSource.ts` |
| County boundaries for scoped imports (US Census TIGERweb) | `src/discovery/boundaries.ts` |
| Provider registry (Overture, fixtures), fixture importer | `src/discovery/providers.ts` |
| Release import, staging, and the staged (background) provider | `src/discovery/staging.ts` |
| Persistence, runs (sync and queued), research, approval | `src/discovery/service.ts` |
| Background job entry points | `src/scripts/importProvider.ts`, `src/scripts/processDiscoveryRuns.ts`, `src/scripts/researchCandidates.ts` |
| Automated research: polite fetching, robots.txt, HTML reading | `src/research/fetcher.ts`, `robots.ts`, `html.ts` |
| Automated research: verification rules (pure) | `src/research/analyze.ts` |
| Automated research: one candidate, page selection | `src/research/researcher.ts` |
| Automated research: runs, queue, reconciliation into signals | `src/research/service.ts` |
| Admin pages and routes | `src/admin/discoveryViews.ts`, `src/routes/adminDiscovery.ts` |

## Data model

| Table | Holds |
| ----- | ----- |
| `DiscoveryRun` | One provider execution: provider, region, city, business type, category tiers, status (`queued`, `running`, `completed`, `failed`), counters (found, created, skipped duplicates, flagged, invalid), the provider release, the staging import, and started / heartbeat / finished times |
| `DiscoveryCandidate` | The business (name, website, street address, city, state, postal code, country, latitude and longitude), **verified** phone and email each with a source URL, the **unverified provider phone**, normalized match keys, provenance (provider, provider ID such as the Overture GERS ID, release, source URL, category and tier, brand, provider confidence, provider operating status, retrieval time, upstream sources and licenses, search, discovered time), review status, research and decision timestamps, duplicate flags, related-location links, and the `prospectId` once approved |
| `ProviderImport` | One release loaded into staging: provider, release, scope (`US-CA` for a state, `US-CA/ventura` for one county), area label, status, record count, importer counters (`stats`: read, outside the area, excluded categories, malformed, ...), redacted error, times |
| `ProviderPlace` | A minimized staged record of one import: provider ID, name, website, phone, street, city, county, state, postal code, country, coordinates, category and tier, brand, confidence, operating status, source URL, upstream sources. No raw payloads |
| `CandidateSignal` | One recorded yes/no observation per signal key, and who recorded it (`origin`: `manual` or `research`). **No row means unknown.** |
| `CandidateEvidence` | Signal key, public source URL, excerpt of at most 280 characters, time, `origin`, and the research run that recorded it |
| `CandidateResearch` | One automated research run: status (`queued`, `running`, `completed`, `failed`), rule version, trigger, outcome, pages read, warnings, error, times |
| `ResearchSource` | One URL a run requested: kind (`website`, `robots`, `https_check`), final URL, HTTP status, ok, content type, bytes, note. **Never the page body** |
| `ResearchFact` | One researched fact: field, value, state (`verified`, `unverified`, `uncertain`, `not_found`), confidence, source, a quote of at most 280 characters, note |
| `CandidateNote` | Append-only notes (at most 2,000 characters) |

**Score and qualification are never stored on a candidate.** They are computed
by `scoreProspect()` in `src/scoring.ts` whenever a page or list needs them
(`scoreCandidate()` in `approval.ts` is a thin adapter, not a second
implementation), so a candidate can't disagree with scoring or drift from it.
Only a Prospect keeps a cached score, as before.

**Provenance fields are provider facts, not verdicts.** Category tier, brand,
confidence, and operating status are what the provider reported. None of them
feeds qualification or the score.

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

Deterministic only: no AI matching. Every record is checked against all stored
candidates and all prospects, plus the other records in the same run. A large
run uses an in-memory index (`MatchIndex`) that compares each record only with
records sharing a key or a nearby map cell, with results identical to a full scan.

A **place** is compared by coordinates when both records have them (within 75 m
is the same place, 250 m or more is a different place, in between is unknown),
otherwise by street address, otherwise a different city counts as a different
place. Coordinates within 75 m whose street addresses **differ** are not proof
of one place (neighbours on a strip, units in a complex): that counts as
unconfirmed. Names are **similar** when their distinctive words overlap
(generic words like "auto" and "repair" don't count, one typo is allowed).
Names match **strongly** when they are identical after normalization, or their
shared distinctive words cover at least half of *each* name, not counting words
that name the city ("Santa Paula Auto Center" does not strongly match "Santa
Paula Automotive Machine Shop").

| Rule | When | Outcome |
| ---- | ---- | ------- |
| A | Same provider and provider ID | Confident duplicate: skipped |
| B | Same website, same place, similar name | Confident duplicate: skipped |
| B | Same website, same place, different name | Review: stored, flagged |
| C | Same website, different place | **Related**: stored as its own candidate and linked ("other location") |
| D | Same website and city, similar name, no street or coordinates to compare | Confident duplicate: skipped |
| D | Same website, location can't be confirmed | Review |
| E | Strongly matching name at the same place (coordinates or street), nothing else in common | Confident duplicate |
| E | Similar (not strong) name at the same place | Review |
| E | Similar name within 150 m | Review |
| F | Same phone, same place, similar name | Confident duplicate |
| F | Same phone otherwise | Review |
| G | Same name and city, different place | Related |
| G | Same name and city, place unknown | Review |

| Outcome | What happens |
| ------- | ------------ |
| `CONFIDENT_DUPLICATE` | The record is skipped and counted. Nothing is created, updated, or merged. |
| `REVIEW_REQUIRED` | The record **is stored**, enters `needs_review`, and carries the reason and a link to the match. |
| Related (with `NO_MATCH`) | Stored as `discovered`, linked to the other location with the reason. A related link is not a duplicate flag and is not evidence about independence. |
| `NO_MATCH` | Stored as `discovered`. |

- **Multi-location businesses and chains are kept.** A shared website is not
  enough to skip a record: each location is stored, and the link shows they
  belong together. Whether that means a chain is decided during research.
- **Weak evidence is never auto-skipped.** A shared name or phone can be a second
  location, a relocated shop, or a shared switchboard. Rule E was tightened in
  Milestone 5 after the first real Overture import showed ten neighbouring
  businesses skipped as "duplicates" on one shared word (e.g. "Daves' Motor
  Works" at 679 E Easy St and "Dave's Garage" at 649). They are now kept and
  flagged; only the two genuine duplicates in that county were skipped.
- **Existing prospects are authoritative.** Discovery only reads them. A
  confident match skips the record; a weak match is flagged; another location is
  linked. A prospect is never modified by discovery. At approval, a confident
  match with an existing prospect blocks the approval ("mark this candidate as a
  duplicate instead"); a related or review-level match does not.
- **Normalization:**
  - Domains: lowercase, `www.` removed. Listing and social hosts (Facebook,
    Yelp, Google, Instagram, hub.biz, WhatsApp, Superpages, and similar),
    webmail hosts given as a "website" (gmail.com, yahoo.com, ...), and **shared
    infrastructure** (store-locator subdomains such as `locations.`/`stores.`,
    and parts-program or manufacturer sites such as acdelco.com, autovalue.com,
    napaautocare.com, carquest.com) never identify a business. They are dropped
    as websites, so they can't count as "has a website" or link two shops.
  - Names: lowercase, accents and punctuation removed, `&` becomes `and`, and
    trailing legal suffixes (`Inc`, `LLC`, `Corp`, …) are removed. Words like
    "auto" and "repair" are kept, so `Smith Auto` and `Smith Auto Body` differ.
  - Streets: lowercase, common words abbreviated (`East` to `e`, `Boulevard` to
    `blvd`), units removed; a street with no house number is not a key.
  - Phones: ten digits, with a leading `1` removed. The unverified provider phone
    is used as a match key only.
- **Flags are set when a record is stored.** They are not recomputed after
  later edits.
- **Concurrency:** a unique index on (provider, provider ID) stops two
  simultaneous runs from storing the same provider record twice. Other matches
  are checked in application code, so two different runs processed at the same
  time could both store a domain duplicate. Each run is claimed by exactly one
  worker.

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
- **Contact details** need the public URL where they are listed, or they are
  refused.
- **A provider phone is unverified.** A discovery provider's phone is stored
  only as `providerPhone`, shown as "Unverified", and used only to find
  duplicates. It never fills the business phone, never satisfies "public
  business contact" or Ready to contact, and is never copied to a prospect at
  approval. It becomes the business phone only when it is confirmed on the
  business's own website: by a person (entering it with that page as the
  source) or by research.
- **Research may verify contact only from the business's own website** (its
  domain or a subdomain). A directory, listing, locator, or social page is
  refused, as is any contact for a candidate with no website stored.
- **Evidence** is a known signal, a public http(s) URL, and an excerpt of at most
  280 characters. It is not a place to paste a page.
- **Unknown stays unknown.** Employee count, bay count, technician count, booking
  availability, website age, and digital inspection use are recorded only when a
  public source shows them. Research findings can't set a yes/no without
  evidence, and "yes" can't be set by hand on the two derived signals.

## Automated research (Milestone 6)

Automated research turns a candidate into an evidence-backed one by reading
**the business's own website**, and feeds what it verifies into the EXISTING
signals, evidence, and contact, so the existing qualification and opportunity
score (`src/scoring.ts`, unchanged) consume it. It never approves anything,
never creates a prospect, and never contacts anyone.

```
candidate (website from the provider: unverified)
  -> queue a research run (admin button, admin batch, or CLI)
  -> fetch: robots.txt, the stored website page, up to 4 linked pages
     (contact, about, services, team), and an HTTPS check
  -> verify ownership: is this the business's own website?
  -> extract facts and signal values, each with its page and a short quote
  -> store the run, its sources, and its facts
  -> reconcile into the candidate's signals, evidence, and contact
  -> existing qualification + opportunity score (computed on read)
  -> a person reviews and decides (approval unchanged)
```

**Sources.** Only the business's own website, fetched directly. No search or
maps API is used: Bing's Search APIs were retired in August 2025, Google's
Places data can't be stored under its terms (see Provider requirements), and
scraping Google Maps or Yelp is not allowed. So **finding a website for a
candidate that has none is not automated**; research says so and a person
searches. A listing, social, locator, or webmail address is never researched
as a website.

**Is this the business's own website?** The site is *verified* only when the
business name appears **and** either the phone (provider or stored) or the
street address does. Name only, or phone/address only, is *uncertain*; none
of them is a *mismatch* (the stored website probably belongs to someone
else, shown as a warning; provider data is never deleted automatically).
Nothing from a site that isn't verified becomes contact or a signal.

**Facts and their states.** Each run records facts with an explicit state:

| State | Meaning |
| ----- | ------- |
| Verified | Confirmed on the business's own (verified) website; the page is the source |
| Provider-reported · unverified | From the discovery provider and not confirmed (e.g. the provider phone when the site lists no phone, operating status) |
| Uncertain | Sources disagree (e.g. the site lists a different phone), the site isn't confirmed, or the evidence is too weak |
| Not found | Looked for on the pages read and not found |

Fields: website, business name, address, phone (on the website), provider
phone, email, services, performs repair, business type (independent, chain,
dealership), operating status.

**Contact (provider vs. verified).**
- A phone becomes the candidate's verified phone only when it is on a verified
  website; the page is its source. The provider phone is "verified" only when
  that same number is on the verified website; otherwise it stays unverified,
  or uncertain when the site lists a different number (a warning names both).
- Many sites list several numbers (a central toll-free line, other
  locations). The phone chosen is **this location's**, in order: the
  provider's number when the site lists it; the number in the site's
  structured business data whose street address is this location's; the one
  number (or the one local, non-toll-free number) within about 250 characters
  of the matched street address, or among several there (side-by-side
  location cards) the one in the provider phone's area code; the only local
  number in the provider phone's area code; the site's only number; the only non-toll-free number.
  Otherwise the phone is **uncertain** (the numbers are listed, a warning
  asks for a manual check) and none is set: the first number is never taken.
- An email is kept only when it is on the business's own domain. An address on
  a free or third-party mail service is never recorded (it may be personal);
  the fact says one was seen.
- Research fills contact only where none is stored, and never removes or
  overwrites contact a person entered (a different number is reported).
- A provider website stays unverified until research confirms it
  (`websiteVerifiedAt`); editing the website clears that.

**Signals** (each follows its published rule in `src/scoring.ts`, only from a
verified website, always with the page and a quote as evidence):

| Signal | Research sets it when |
| ------ | --------------------- |
| Independent shop | **no**: a franchise/chain brand in the site's title or headings (the rule's list, e.g. Midas, Jiffy Lube, Firestone), or dealership **activity**: new-vehicle inventory or sales, certified pre-owned, test drives, trade-in appraisal, or the business calling itself a dealer ("authorized Toyota dealer", "we are your local Chevrolet dealer"). The bare word "dealership" is not evidence, nor is a comparison ("better than the dealership", "without the dealership price"), nor a vehicle make in the title (the make only labels real dealer evidence). **yes**: the site states it ("family owned", "locally owned", "independent repair shop", "Independent Porsche Service Center", "independent BMW repair") and shows no chain or dealer sign. Dealer activity and an independence statement together leave it unknown (business type uncertain). Otherwise unknown: independence is never assumed |
| Offers general repair | **yes**: 2+ of brakes, suspension/steering, diagnostics, maintenance/oil, A/C, electrical, transmission, cooling, exhaust. **no**: 2+ specialty services (collision, glass, tint, detailing, audio, towing) and no general ones |
| Mentions digital inspections | **yes**: digital/photo/video inspection wording, or a DVI product. **no**: the homepage and a services page were read with no mention |
| No online booking | **no**: a service-booking link ("Book an appointment", a booking URL path) or a scheduling widget. **yes**: 2+ pages read with none (a test-drive, quote, or FAQ link is not booking) |
| Website not on HTTPS | From the HTTPS check: loads with a valid certificate = no; fails, redirects to http, or a certificate error = yes |
| No recent date on website | The newest copyright/updated/full date on the pages read: current or previous year = no; 2+ years old = yes; none = unknown |
| 3+ bays or technicians | A stated count ("6 service bays", "4 ASE-certified technicians"): 3+ = yes, 1-2 = no. A zero-padded number ("03") or an item of a numbered feature list ("1 Locally Owned 2 Premium Parts 3 ASE Certified Technicians") is not a count; a later real count on the page still is |
| Has a website, Public business contact | Unchanged: derived from the stored website and verified contact |

**Reconciliation and idempotency.** A run replaces the previous run's
research signals and evidence (origin `research`) instead of adding to them;
a signal or evidence item a person recorded (origin `manual`) is never
changed, and a disagreement is reported as a warning. Runs are kept as history
(the newest 5 per candidate). One run can be queued or running per candidate.
The lifecycle follows the existing rule: a candidate moves to Researched only
when its signals are all evidence-backed; a Discovered candidate whose run
yields no evidence returns to Discovered; Needs review stays Needs review;
approved, rejected, and duplicate candidates are not researched.

**Failure, retries, and safety controls.**
- Per request: 10-second timeout, at most 1.5 MB read, HTML only.
- One retry, only for transient failures (5xx, 429, network); never for 4xx,
  DNS, or certificate errors. No retry loops.
- robots.txt is read once per site and honoured (our agent's group, else `*`);
  a server error on robots.txt means the site is skipped.
- **Blocked vs. unreachable.** HTTP 401 or 403, a robots.txt disallow, or a
  robots.txt server error mean the site **blocks automated access**: outcome
  `access_blocked`, run completed, warning "Website blocks automated access;
  verify manually." It is not treated as dead and not as a mismatch, and the
  site root is not tried after a block. DNS failure, connection failure, or a
  timeout (after its one retry) mean **unreachable**: the run fails. Only an
  ordinary HTTP error on a deep link (e.g. 404) falls back to the site root.
- At least 1 second between requests to the same host; at most 5 pages per
  run; 1 second between candidates in a batch; batches of at most 10 (admin)
  or 25 (CLI). Only same-site contact/about/services/team pages are followed.
- User agent: `ReclaimBayResearch/1.0 (+https://reclaimbay.com)`.
- A site that can't be reached makes the run **failed** (earlier research is
  kept); a site that blocks automated access is **completed** with outcome
  `access_blocked` (runs from rules r1 recorded a robots.txt block as
  `robots_disallowed`). A run
  whose worker died is marked failed after 10 minutes and is never retried
  automatically: run it again.

**Admin workflow.** On a candidate, **Run research** (or Run research again)
queues a run; it is processed in the background (about 10 seconds per site).
The Automated research section shows the status, time, rule version, pages
read, warnings, the facts grouped as Verified / Provider-reported · unverified
/ Uncertain / Not found with their quotes and sources, every URL requested
with its result, and the run history. Signals and evidence set by research are
labelled. On the overview, **Research up to 10 in this view** queues the first
10 not-yet-researched candidates matching the current filters, and each row
shows its research outcome.

```bash
npm run discovery:research -- --candidate <id> [--candidate <id> ...]
npm run discovery:research -- --limit 5 [--tier core] [--city Oxnard]
npm run discovery:research -- --process          # only process what is queued
```

**Real-data validation (Ventura County, 2026-10-01, rules r1).** Ten
deliberately chosen candidates, 45 requests per pass (robots.txt included), under a minute:

| Candidate | Chosen as | Result |
| --------- | --------- | ------ |
| Bill's Quality Auto Care | independent shop | Website verified; phone verified (matches the provider's); general repair, digital inspections, HTTPS recorded; independence not stated on the site, so it stays unknown (Unverified, score 45) |
| Dependable Car Care (Simi Valley) | legitimate website, multi-location | Verified; phone and business email verified; scheduling widget found |
| Aris Garage | independent shop | Failed: the domain no longer resolves |
| Midas (Simi Valley) | chain | Website not confirmed: the provider's link is a regional locator page with a national 800 number; nothing verified |
| Jiffy Lube (E Thompson Blvd) | chain | Verified location page; Independent shop = no (franchise brand) |
| Swickard Chevrolet of Thousand Oaks Service | dealer | Verified; Independent shop = no (dealership); digital inspections = yes |
| Mayer Automotive Repair | no website, provider phone only | No website; the provider phone stays unverified; nothing set |
| Derrico Automotive | conflicting information | Mismatch: the stored website is Swensen Automotive's; warnings name the different phone |
| Angie's Collision Center | likely false positive | Mismatch: the domain no longer shows the business |
| Simi Valley Auto Glass | likely false positive | Verified; only glass services, so "general repair" is left unknown (too little to set "no") |

Re-running all ten replaced their research signals and evidence (25 before
and after) and created no prospects. The first run found three rule defects,
fixed before the second: missed "Digital Technician Video Inspection" wording,
a test-drive and an FAQ link counted as booking, and an unresolvable domain
reported as "disallowed".

**Rules r2 (2026-10-01).** A second controlled batch of ten found three more
defects, fixed in r2: an independent Porsche specialist ("genuine parts of a
dealership, without the dealership price") classified as a dealership; a
multi-location site's central toll-free number taken as the location's phone
because it came first; and a site answering HTTP 403 reported as unreachable.
Dealership now needs dealer activity, the phone follows the location rules
above, and 401/403 is `access_blocked`.

**Rules r3 (2026-10-01).** A third controlled batch of ten found one more
defect: Ojai Valley Imports' numbered feature list ("01 Locally Owned … 02
Premium Quality Automotive Parts … 03 ASE Certified Technicians") was read as
three technicians, setting "3+ bays or technicians" to yes (score 85). In r3 a
count has no leading zero, and a number in a run of three or more consecutive
numbered headings is a list item, not a count; real count statements ("3
service bays", "we have 4 technicians") still count. Re-researched, Ojai has
the signal unknown, its evidence removed, and a score of 70.

**Rules r4 (2026-10-01).** Address matching treats an ordinal street name
written as a word as its numeric form, first through twentieth ("2180 First
St" = "2180 1st St"), in either direction, on the page text and in structured
data. Found on Perry's Quality Auto Repair (provider "2180 1st St", website
"2180 First St, Suite C-10"). Duplicate detection's street key is unchanged.

## Approval

Approval is an explicit human POST from the candidate page. It:

1. Checks the candidate is `researched` or `needs_review`, every recorded signal
   has evidence, the facts pass the **same validators as creating a prospect by
   hand**, and no existing prospect is a confident duplicate (see the rules above).
2. Creates the **existing Prospect** through the same insert path, at status
   **New**, with a new opaque referral code and the cached score from
   `scoring.ts`.
3. Copies the business facts, verified public contact with sources, signals
   (with their observation times), and evidence (with their timestamps). The
   unverified provider phone and the provider metadata are not copied.
4. Writes a note on the prospect recording the provider, provider ID, source URL,
   search, provider release, discovery date, candidate, and run.
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
no signals and is Unverified. Neither do the provider's category tier, brand,
confidence, or operating status.

### Category tiers

Provider categories are grouped in `categories.ts` into **core** (general and
specialist mechanical repair, e.g. Overture `automotive_repair`,
`brake_service_and_repair`, `transmission_repair`; OSM `shop=car_repair`) and
**adjacent** (tires, oil change, inspection, truck repair, general automotive
service). Unlisted categories have no tier and are not discovered. A run picks
"Core" (the default) or "Core + adjacent". **The tier is a discovery filter
only**: it decides which staged records a run reads, and the list can filter by
it. It is never a qualification input or a score signal.

## Providers

### Discovery providers

A provider implements `DiscoveryProvider`:

```ts
interface DiscoveryProvider {
  readonly name: string;   // stored on every candidate, e.g. "overture"
  readonly label: string;  // shown in the admin
  readonly mode?: "sync" | "background";
  discover?(target: DiscoveryTarget): Promise<DiscoveredBusiness[]>;                // small, synchronous
  discoverBatches?(target: DiscoveryTarget): AsyncIterable<DiscoveredBusiness[]>;   // large, background
}
// DiscoveryTarget: region, city, businessType, tiers
```

`DiscoveredBusiness` holds only the allowed business fields: `externalId`,
`businessName`, `website`, `streetAddress`, `city`, `state`, `postalCode`,
`country`, `latitude`, `longitude`, `phone` (unverified), `sourceUrl`, and the
provenance fields `category`, `categoryTier`, `brand`, `confidence`,
`operatingStatus`, `retrievedAt`, `release`. Anything else is discarded by
cleaning. To add a provider, implement the interface and register it in
`discoveryProviders()` (`src/discovery/providers.ts`). Nothing else changes:
cleaning, deduplication, candidates, research, scoring, and approval are
provider-independent.

- **Sync providers** run within the request, limited to 200 records and 30
  seconds. A provider failure is recorded on the run (with URLs redacted)
  instead of breaking the page.
- **Background providers** are never run in a request. Submitting the form only
  creates a `queued` run and returns. The run is processed after the response
  (in the web process) or by the `discovery:process` job: the worker claims it
  (only one worker can), reads the provider in batches, deduplicates with one
  shared index, and saves counters and a heartbeat after every batch. A run
  whose heartbeat is more than 10 minutes old is reclaimed and processed again;
  reprocessing is safe because provider IDs and dedupe make ingest idempotent.

### Release import and staging (background)

A large open-data provider is loaded per release and per scope, then read by
runs:

```bash
npm run build
npm run discovery:import -- --provider <importer> --release <release id> --scope US-CA
npm run discovery:process      # process queued runs once (e.g. from a scheduler)
```

- An importer (`ProviderImporter`) yields batches of minimized `StagedPlace`
  rows; `runImport()` stores them in `ProviderPlace` under one `ProviderImport`.
  Rows without an ID or name are skipped and repeated IDs are stored once.
- A failed import is marked failed with a redacted error, and its rows are
  never read. After each successful import only the **two newest completed
  imports** per provider and scope keep their rows; older and failed ones are
  pruned.
- `createStagedProvider()` turns the latest completed import for the target's
  state into a background provider. It filters by county (from the region, e.g.
  "Ventura County, CA"), city, category tiers, provider operating status (places
  the provider reports permanently closed are skipped), and a minimum provider
  confidence of 0.5. Runs record the release they read.
- Nothing in the import path creates candidates or prospects.

**What exists now:**
- **`fixture`**: a deterministic set of clearly synthetic businesses (example.com
  data) covering clean records, a domain duplicate, a name-and-city match, a
  social-page "website", and an unsourced phone. It is **offered only outside
  production**. Set `ENABLE_FIXTURE_DISCOVERY=1` to opt in on a server that
  treats itself as production; don't, on the real database.
- **`fixture-staged`**: a background provider over the synthetic fixture
  importer, reproducing the multi-location cases found in the Ventura County
  provider evaluation: one shop with two locations on one website, a true
  duplicate a few metres away, a three-location chain, two shops on a
  parts-program locator domain, a shared phone, and records excluded by tier,
  closure, confidence, and county. Also offered only outside production.
- **Manual entry** ("Add candidate"): provider `manual`, with the same cleaning
  and duplicate rules. A phone a person enters here, with the page where it is
  listed, is verified contact. In production this is the only way candidates
  enter until a provider is connected.

### Overture Maps Places (Milestone 5)

The first real discovery provider. Everything below was checked against
Overture's documentation and the data itself on 2026-09-30.

**Source and release.** Overture publishes Places as GeoParquet on a public S3
bucket (`s3://overturemaps-us-west-2/release/<release>/theme=places/type=place/`,
mirrored on Azure). Releases are monthly; Overture keeps about two months of
them. The importer resolves `--release latest` through Overture's STAC release
catalog (`https://stac.overturemaps.org/catalog.json`, field `latest`) and
refuses a release the catalog doesn't list. Validated with release
**2026-09-23.1** (Overture schema v2.0: categories are `taxonomy` and
`basic_category`; the old `categories` property no longer exists).

**How it is read.** `overtureSource.ts` queries the bucket with DuckDB (the
access method Overture documents), selecting only the needed columns, inside
the county's bounding box, and only places under the `automotive_service`
branch of the taxonomy (or with a repair category as an alternate, so those
can be counted). DuckDB uses Parquet row-group statistics to skip everything
outside the box, so a county reads a few megabytes of a release of more than
10 GB. Nothing is downloaded to disk. DuckDB is loaded only by the import job,
never by the web server. Anonymous access; **no credentials**.

**Geographic scope (deliberately small).** One county per import; a statewide
or national import is refused. Validated on **Ventura County, CA** (the
project's test region since Milestone 3). The bounding box is only a prefilter:
each place is kept only if its point lies inside the county boundary, fetched
from the US Census Bureau's TIGERweb service (public domain). Overture's own
`divisions` boundaries are not used: they contain OpenStreetMap data (ODbL),
and joining them to places would bring share-alike obligations.

**Record mapping** (`mapOvertureRow`):

| Overture | ReclaimBay | Notes |
| -------- | ---------- | ----- |
| `id` (GERS ID) | `externalId` | Stable place identity, used for re-import and dedupe rule A. **Identifies the place; says nothing about ownership, independence, or fit.** |
| `names.primary` | `businessName` | A branch named only by its street with a `brand` (e.g. AllThePlaces' Jiffy Lube "E Thompson Blvd") becomes "Jiffy Lube (E Thompson Blvd)". Never applied without a brand |
| `geometry` (point; read from `bbox`) | `latitude`, `longitude` | (0, 0) and out-of-range values are rejected |
| `addresses[]` (first US address) | street (`freeform`), city (`locality`), postal code | The state comes from the boundary. Overture documents `region` as ISO 3166-2 (`US-CA`); the data uses `CA`. Both are accepted |
| `taxonomy.primary`, `taxonomy.hierarchy` | category and tier | See the mapping below |
| `websites[]` | `website` | The first that is the business's own (not social, listing, locator, webmail); query strings (utm tracking) removed. **Provider data, unverified**: shown as "Reported by overture, unverified" |
| `phones[0]` | `providerPhone` | **Unverified.** See below |
| `operating_status` | operating status | `open` / `temporarily_closed` / `permanently_closed`; runs skip permanently closed |
| `confidence` | provider confidence | Overture: confidence that the place exists, not that it is open. Runs skip below 0.5 |
| `brand.names.primary` | brand | As reported. A brand suggests a chain; it never decides qualification |
| `sources[]` | upstream sources | e.g. "meta (CDLA-Permissive-2.0); Foursquare (Apache-2.0)". Overture's own derived entries are left out |
| emails, socials, other fields | (dropped) | Never selected |

There is no per-place public page in Overture, so `sourceUrl` is empty; the
GERS ID and release are the reference. Overture has **no related-location
field**; other locations of a business are found by ReclaimBay's own dedupe
(shared website at a different place, rule C).

**Category mapping** (`categories.ts`, `overtureTier`). Only the **primary**
category decides, and it must sit under
`travel_and_transportation > vehicle_service > automotive_service`:

| Tier | Overture categories |
| ---- | ------------------- |
| Core | `automotive_repair`, `brake_service_and_repair`, `engine_repair_service`, `transmission_repair`, `exhaust_and_muffler_repair`, `auto_electrical_repair` |
| Adjacent | `automotive_service` (generic), `tire_dealer_and_repair`, `oil_change_station`, `emissions_inspection`, `truck_repair`, `car_inspection` |
| Excluded (counted on the import) | `auto_body_shop`, `auto_detailing`, `car_wash`, `towing_service`, `auto_customization`, `auto_glass_service`, `windshield_installation_and_repair`, `car_window_tinting`, `tire_shop`, `auto_restoration_service`, `auto_security`, `auto_upholstery`, `automotive_consultant`, `trailer_repair`, `wheel_and_rim_repair`, `vehicle_wrap`, `car_buyer`, `car_stereo_installation`, `automobile_registration_service`, and any automotive category not yet listed |
| Not discovered | Places whose repair category is only an **alternate** (e.g. a gas station listing `automotive_repair`), counted as `alternate_only` |

Ambiguous categories are excluded rather than assumed to be repair shops. The
tier remains a discovery filter only (see Category tiers).

**Provider phone.** Overture's phone is stored only as `providerPhone`: shown as
Unverified, used only as a dedupe key, never the business phone, never "public
business contact", never enough for Ready to contact, and never copied to a
prospect at approval. Only research that finds it on the business's own website
(or a person entering it with that page as the source) verifies it.

**Attribution and license.** Places is CDLA-Permissive-2.0, with some records
Apache-2.0 (Foursquare) or CC0 (AllThePlaces), as listed per record in
`sources`; it contains no OpenStreetMap data. Overture asks for the attribution
"Overture Maps Foundation, overturemaps.org"; the candidate page shows it with
each record's upstream sources. Apache-2.0 records also carry Foursquare's
notice (opensource.foursquare.com/places-notice-txt). Candidates are internal
(admin only); publishing derived data would need these attributions.

**Commands** (background jobs; run against the intended database):

```bash
npm run build
npm run discovery:import -- --provider overture --release latest --scope US-CA --county "Ventura County"
#   rerunning the same release is a no-op; --force imports it again
npm run discovery:process      # or queue a run from /admin/discovery (provider: Overture Maps Places)
```

Then a run with provider **Overture Maps Places** and region **Ventura County,
CA** reads the newest completed import for that county (its own import, or a
statewide one if one ever exists) and records which import and release it read.

**Real-data validation (Ventura County, release 2026-09-23.1, 2026-09-30):**

| Step | Result |
| ---- | ------ |
| Import (about 10 s) | 1,431 automotive rows read in the bounding box; 139 outside the county boundary; 515 in excluded categories (body shops 120, detailing 59, car washes 56, customization 49, towing 41, auto glass/windshield/tint 107, tire shops 33, others); 3 with repair only as an alternate; 0 malformed; **774 staged** (571 core, 203 adjacent) |
| Core run (`discovery:process`) | 525 eligible (40 below confidence 0.5 and 6 permanently closed left out): **523 candidates**, 2 skipped as confident duplicates (both genuine), 38 flagged for review, 27 linked as other locations |
| Core + adjacent run (admin) | 711 found: 178 more candidates, 533 skipped (the 525 already stored, plus 8 adjacent records of the same places), 29 flagged |
| Rerun of the same release | Import: no-op. Processing: 0 new, 525 skipped |
| Contact | 0 verified phones; 675 of 701 candidates carry only the unverified provider phone |

A random sample of 40 core candidates held about 31 genuine general or
mechanical repair shops. About one in five were category false positives that
Overture itself labels `automotive_repair` (collision and glass shops, a
smog-only station, a wrecker, a machine shop, an RV service center), along with
dealerships and chain locations (Tesla, Chevrolet, Jiffy Lube, Caliber). They
are not filtered by name: research and qualification (Independent shop, Offers
general repair) are what decide.

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
evidence, contact only with a source on the business's own website, nothing
overwrites contact a person already entered, and the candidate lands at `researched` for a human decision. Invalid
findings are refused as a whole. This interface remains for future providers;
the website researcher of Milestone 6 (above) is wired in directly through
`src/research/service.ts`, which applies the same rules plus origin tracking.

## Provider requirements (decision needed)

**Status:** Overture Maps Places was chosen after the Milestone 4 evaluation and
is connected (Milestone 5, above): no credential, monthly releases, one county
at a time. OpenStreetMap remains an optional supplement for later (ODbL;
internal use only). The comparison below is kept as the record of that
decision.

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

**Status:** done in Milestone 6 with rule-based extraction from the business's
own website (no LLM, no paid API, no credentials). An LLM-assisted extractor or
a website-finding search API could be added later behind the same boundary
(`src/research/researcher.ts`), configured by environment variables.

## Admin

| Page | What it does |
| ---- | ------------ |
| `/admin/discovery` | Run discovery (provider, e.g. Overture Maps Places; a category choice: core, or core + adjacent), add a candidate, status counts, search and filters (status, qualification, score band, state, city, possible duplicate, category tier), sorting by score, recency, or name, recent runs with their provider, the import they read, status (including Queued), release, tiers, and counters, and **provider imports** (area, release, records staged, what was read and left out, status, errors, and whether retention has pruned their rows). List rows tag the tier, "Other location shares this website", "Provider says closed", and the research outcome. **Research up to 10 in this view** queues automated research for the first 10 not-yet-researched candidates matching the filters, with queue counts |
| `/admin/discovery/candidates/new` | Add a candidate by hand |
| `/admin/discovery/candidates/:id` | What we know (including street and position; a provider website is marked unverified), what we don't know, and where each fact came from (provider, GERS ID for Overture, release, category and tier, brand, provider confidence, operating status, retrieval time, upstream sources with attribution). The verified phone and the **unverified provider phone** are shown separately. Qualification and score shown separately. Possible-duplicate explanation and other-location links. **Automated research**: Run research, status, facts as Verified / Provider-reported · unverified / Uncertain / Not found with quotes and sources, URLs requested, warnings, and history; research-set signals and evidence are labelled. Status moves, evidence, notes, and Approve |
| `/admin/discovery/candidates/:id/edit` | Edit facts and record signals with each signal's rules. A provider phone is shown as a reminder to verify it on the business's own website before entering it |

Discovery pages are registered inside the admin scope, so they share its
session check, same-origin check on every POST, rate limits, and security
headers (CSP with no scripts, `no-store`, `noindex`). Nothing here is public.
Discovery sends nothing to analytics, and no customer report data is involved.

## Not automated yet

- Imports beyond one county at a time, or of other providers (OpenStreetMap).
- Finding a website for a candidate that has none (no free, terms-compatible
  search API), and reading sources other than the business's own website
  (maps, directories, social pages, state registries).
- Researching all candidates at once, or on a schedule: research runs on
  request, for one candidate or a batch of at most 10 (admin) / 25 (CLI).
- Removing a provider website research found to be wrong: it is flagged; a
  person removes it.
- Contacting anyone. No email, calls, outreach, follow-ups, or campaigns.
- Scheduled or recurring imports and runs. The `discovery:import` and
  `discovery:process` jobs exist; no scheduler is configured.
- Re-checking duplicates after edits, or merging candidates.
- Copying candidate notes onto the prospect.

## Known limits

- The list computes scores in memory for up to 2,000 matching candidates and shows
  the first 200. Fine for hundreds of candidates; a cached score would be needed
  for many thousands.
- Sync runs are synchronous inside the request. A slow provider holds the page
  until it finishes or times out at 30 seconds. Large providers must be
  background providers.
- A background run loads the match keys of all candidates and prospects into
  memory once. That is small per record and fine for tens of thousands.
- A run processed in the web process stops if the process restarts. It is
  reclaimed after 10 minutes without a heartbeat, but only when
  `discovery:process` next runs.
- Overture: one county per import; a county's places are only as current as the
  latest import (rerun monthly). Category labels are Overture's and include
  false positives (about one in five in the Ventura sample). "Similar name
  nearby" flags are noisy in dense corridors (14 of the 38 core flags in
  Ventura County). A provider website can be wrong (seen: a car-rental page,
  another business's site); research must confirm it. The importer needs
  network access to Overture's bucket, its STAC catalog, and the Census
  TIGERweb service, and DuckDB downloads its `httpfs` extension on first use.
- An import interrupted mid-way stays `running` until the next import of the
  same scope, which marks it failed and prunes its rows (after 1 hour).
- Research reads static HTML only: content drawn by JavaScript (some booking
  buttons, some copyright years) is not seen. Absence-based values ("no online
  booking", "no digital inspections") are therefore weaker than presence-based
  ones and are worded as what was reviewed.
- Independence is set to "yes" only when the site says so; most independent
  shops don't, so it often stays unknown and needs a person.
- A chain's location page (e.g. jiffylube.com) can verify as the location's
  website; the chain brand then sets Independent shop to "no".
- The in-process research worker stops if the web process restarts; queued
  runs are picked up by the next action or `npm run discovery:research -- --process`.

## Tests

```bash
npm test                    # unit: normalization, dedupe rules A-G and the match index (incl. the
                            # real-data regression pairs), lifecycle, scoring reuse, approval mapping
                            # (no provider phone), privacy, and Overture: releases, category tiers,
                            # record mapping, boundaries, importer stats, query safety; automated research:
                            # robots.txt, HTML reading, ownership verification, every signal rule,
                            # contact rules, conflicts, retries and failures (fixture websites only)
TEST_DATABASE_URL=<local url> npm run test:integration
                            # runs, dedupe against candidates and prospects, research, lifecycle,
                            # approval, provenance, the admin pages over HTTP, the pipeline
                            # (import/staging/pruning, queued runs, reclaim, tiers, provider phone),
                            # Overture end to end with the network source replaced, and automated
                            # research (queue, reconciliation, idempotency, failures, admin pages)
                            # against fixture websites (no live sites)
```

See [PROSPECTS.md](PROSPECTS.md#tests) for the disposable-database setup and safety guards.
