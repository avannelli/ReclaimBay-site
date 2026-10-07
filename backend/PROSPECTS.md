# Prospects: model, scoring, and workflow

Prospects are businesses that perform automotive repair/service work (general,
mechanical, specialist, or collision/body repair) and may benefit from
ReclaimBay. This document defines their product-fit qualification,
separate prioritization score, and lifecycle. Discovery and source verification
are documented in DISCOVERY.md; outreach safety is documented in OUTREACH.md.

## What is stored

| Table | Holds |
| ----- | ----- |
| `Prospect` | Business name, website, city, state, postal code, country (ISO-2, default `US`), public business phone and email **each with the URL where it was found**, status, the cached score, and the opaque referral code from Milestone 1 |
| `ProspectSignal` | One row per recorded observation: signal key, `yes` or `no`, and when it was observed. **No row means unknown.** |
| `ProspectEvidence` | A public source URL and a short excerpt (at most 280 characters) supporting one signal |
| `ProspectNote` | Append-only admin notes (at most 2,000 characters) |
| `ProspectStatusChange` | Every status change: from, to, optional reason, time |

Signal keys are validated against [`src/scoring.ts`](src/scoring.ts) rather
than a database enum, so adding a signal needs no migration. Rows for a
signal removed in a later scoring version are kept, never scored, and left
untouched by edits.

### Derived, not stored as truth

- **Qualification, score, band, and breakdown** are always computed by `scoreProspect()` in
  `src/scoring.ts`, the single source of truth. `Prospect.score`,
  `scoreVersion`, and `scoredAt` are only a cache for sorting and filtering.
- **"Has a website" and "public business contact"** turn to yes from the
  stored website, phone, and email fields. They are never recorded as yes by hand.
- **Referral activity** (visits, scans, exports) is read live from the
  Milestone 1 analytics tables.

### Intentionally not collected

- Anything from a shop's uploaded report: customer names or contact details,
  vehicles, repair descriptions, amounts, or declined-work data. The report
  never leaves the browser (see [README](README.md#privacy-guarantee)).
- Personal information about owners or staff: names, personal phone numbers
  or emails, home addresses, individual social profiles. There are no fields
  for them, and the form says so.
- Contact details that the business does not publish itself. A phone or email
  can't be saved without the public URL where it appears.
- Copied web pages or reviews. Evidence is a short excerpt only.
- Sensitive inferences (ethnicity, religion, health, finances), and
  geographic targeting in the score.

## Scoring (v3)

Scoring produces two separate results from the same observations:
**qualification** (does the shop meet the required business criteria?) and an
**opportunity score** (0–100, for ranking). A high score never qualifies a
shop, and disqualification never lowers the score.

The score is a sum. Each signal observed as **yes** adds its weight; **no**
and **unknown** add nothing. Weights total 100. Unknown is shown separately
("6 of 11 signals known"), so missing research never looks like a negative.

Subjective ideas are replaced with things anyone can check. "The website looks
dated" becomes two facts: no HTTPS, and no date from the last two years. The
admin form shows each signal's rules next to its radio buttons.

| Key | Label | Weight | Yes | No | Unknown |
| --- | ----- | -----: | --- | -- | ------- |
| `independent_shop` | Independent shop | 15 | Website and primary listing show no franchise brand (Midas, Meineke, Firestone, Jiffy Lube, Pep Boys, Christian Brothers…), not a new-car dealer's service department, and the name operates 5 or fewer locations | A franchise location, dealer service department, or brand with more than 5 locations. **Prioritization only; does not disqualify.** | Not checked, or sources conflict |
| `general_repair_services` | Offers general repair | 10 | Website or listing names at least 2 of: brakes, suspension/steering, engine diagnostics, maintenance/oil service, A/C, electrical, transmission, cooling, exhaust | Every service is a non-mechanical specialty: collision/body, glass, tint, detailing, audio, towing, or tires only. **Prioritization only; does not disqualify.** | No services list found |
| `automotive_repair_services` | Verified automotive repair | 20 | Verified identity and sourced, quoted public evidence that the business itself performs automotive repair/service work (general, mechanical, engine, transmission/drivetrain, brakes, diagnostics, electrical, diesel, suspension/steering, A/C, exhaust, collision/body…); a collision/body Yes also counts; no unresolved contradiction. **The required criterion.** | Explicit sourced statement that the business performs no automotive repair (e.g. "we do not perform repairs", test-only inspection) | Missing/ambiguous evidence, or a dealership, fleet, maintenance-only or cosmetic-only case needing human verification |
| `collision_repair_services` | Verified collision/body repair | 0 | Verified identity and sourced, quoted public evidence of automotive collision/body repair; no unresolved contradiction. **Also establishes verified automotive repair.** | Explicit sourced statement that the business does not perform collision/body repair. **Segment only; never disqualifies.** | Missing/ambiguous evidence or dealership/specialty case needing human verification |
| `multiple_bays_or_staff` | 3+ bays or technicians | 15 | A public source shows or states 3 or more bays, or 3 or more technicians | A source states 1–2 bays or a single-mechanic operation | No source gives a count |
| `digital_inspections` | Mentions digital inspections | 10 | Website mentions digital or photo/video inspections, reports sent by text or email, or names a DVI product | Homepage and services pages reviewed, no mention | No website, or not reviewed |
| `public_business_contact` | Public business contact | 10 | *Automatic:* a phone or email is stored with its source URL | Website and primary listing searched, neither listed | Not searched, nothing stored |
| `has_website` | Has a website | 5 | *Automatic:* a website URL is stored | Search for name + city found no site of its own (directories don't count) | Not searched, nothing stored |
| `no_online_booking` | No online booking | 5 | Website reviewed, no scheduling form, widget, or booking link ("call to schedule" or a general contact form counts as none) | Has an appointment request form, widget, or booking link | No website, or not reviewed |
| `website_not_https` | Website not on HTTPS | 5 | `https://<domain>` fails, redirects to http, or shows a certificate warning | Loads over https with no warning | No website, or not checked |
| `website_no_recent_date` | No recent date on website | 5 | The newest date anywhere on the site (copyright, post, "updated") is 2+ calendar years before the observation | A date in the current or previous calendar year | No website, not checked, or no dates at all |

**Why these weights.** Verified automotive repair contributes 20 points and is the sole required criterion. Collision/body repair is a segment marker with weight 0: a verified collision/body Yes establishes automotive repair, so a body shop scores exactly as it did under v2, and a mechanical shop with verified repair scores the same 20 points. The score never favours one repair segment. Independence (15) and mechanical services (10) remain optional prioritization observations. Size (15), digital inspections (10), public contact (10), website (5), and the three website-condition signals (5 each) retain their weights. Total: 100. No score can establish product fit.

**Consistency rules** (enforced on save):
- "yes" can't be recorded by hand for the derived signals.
- A recorded "no" can't contradict a stored website or contact.
- The four website-only signals need a stored website.
- Verified automotive repair can't be recorded "no" while collision/body repair is "yes" (collision/body repair is automotive repair). If stored data ever disagrees this way, the criterion is Unknown until a person resolves it.

### Qualification

Product fit is based only on `automotive_repair_services`: Yes means Meets criteria, No means Disqualified, and absent/Unknown means Unverified. A verified `collision_repair_services` Yes is also a Yes: collision/body repair is one segment of automotive repair, not a requirement. A collision/body No never disqualifies. Identity and repair evidence must be checked before recording Yes. Names, provider categories, the opportunity score, and historical `general_repair_services` observations (two service words anywhere on a site) are never converted into verified automotive repair.

In operator terms (Discovery shows this as **Target fit**): Qualified (verified repair with a source), Not qualified (outside the target category, or sourced evidence of no repair work), Needs verification (everything else). Each comes with the business type and a one-sentence reason (src/discovery/targetFit.ts).

Dealership service departments, fleet operations, maintenance-only or cosmetic-only (dent/paint) businesses, and businesses whose name says another trade (tires, glass, towing…) with only one repair service on the website require human verification. Automation leaves their fit Unknown, retaining sourced findings for review.

Manual prospects may be created and corrected in New before research is complete. Recording Yes alone does not authorize Qualified or Ready to contact: those transitions and edits while in either status require stored public URL/excerpt evidence for the basis of fit: `automotive_repair_services` evidence recognized by the repair classifier (src/research/repairFit.ts), or, for a body shop qualified by collision/body Yes, collision-specific evidence recognized by the unchanged collision classifier. The source must belong to the recorded business's own website, using the existing business-site checks; without an own website, the excerpt must identify the business. Shared listing hosts alone do not establish identity. Contradictory excerpts or linked completed research block the transition; collision/body contradictions block only when fit rests on collision/body evidence. Evidence cannot be removed or made contradictory while either status still requires it; move back to New to revise unresolved findings. Unknown and No remain unchanged, and evidence alone never changes a signal to Yes.

### Opportunity score and band

The 0–100 score and its band describe the size of the opportunity, never
fitness. The band is a label for the score alone:

- **High:** 60 or more.
- **Medium:** 35–59.
- **Low:** below 35.

**The two are independent.**
- A disqualified shop keeps its full score. A business with verified automotive repair No and every other signal Yes scores 80 and remains Disqualified.
- A shop that meets the criteria can still score Low.
- The admin shows qualification and score side by side, and filters them separately.
- To rank prospects, filter to **Meets criteria** and sort by score.

### Changing the scoring

1. Edit `SIGNALS` or the bands in `src/scoring.ts`, bump `SCORING_VERSION`,
   and update this table and the tests.
2. Deploy, then run `npm run prospects:rescore`.

The rescore command only rewrites rows scored by another version. `--all`
rewrites every row. It touches nothing but `score`, `scoreVersion`, and
`scoredAt`, so it is safe to repeat. Until it runs, the admin marks affected
rows "cache stale", and the detail page always shows the live score.

## Statuses

| Status | Meaning | Requirements while in it |
| ------ | ------- | ------------------------ |
| `new` | Added, not yet researched | — |
| `qualified` | Verified automotive repair fit | Business name; Qualification = `meets_criteria` (verified automotive repair "yes", directly or through verified collision/body repair), with its sourced evidence |
| `ready_to_contact` | Qualified, and reachable through published business contact | Same as qualified, **plus** a public business phone or email with its source URL |
| `contacted` | Reached out to at least once | — |
| `engaged` | Replied, visited via referral link, or in conversation | — |
| `meeting` | A call or meeting is scheduled or has taken place | — |
| `proposal` | An offer has been made and is awaiting a decision | — |
| `customer` | Using ReclaimBay | — |
| `not_a_fit` | Researched and ruled out (reason required) | — |
| `lost` | Declined after being contacted (reason required) | — |
| `do_not_contact` | Must never be contacted (reason required). **Permanent.** | — |
| `archived` | Set aside without a decision | — |

**Qualification gates, not the score.**
- An `unverified` prospect (a required criterion still unknown) can't enter
  `qualified` or `ready_to_contact`, and neither can a `disqualified` one.
- The opportunity score plays no part in any status rule. The status rules
  never receive it.

**Allowed moves** (anything else is refused):

| From | To |
| ---- | -- |
| new | qualified, not_a_fit, do_not_contact, archived |
| qualified | ready_to_contact, new, not_a_fit, do_not_contact, archived |
| ready_to_contact | contacted, qualified, not_a_fit, do_not_contact, archived |
| contacted | engaged, lost, not_a_fit, do_not_contact, archived |
| engaged | meeting, proposal, customer, contacted, lost, not_a_fit, do_not_contact, archived |
| meeting | proposal, customer, engaged, lost, do_not_contact, archived |
| proposal | customer, meeting, engaged, lost, do_not_contact, archived |
| customer | engaged, do_not_contact, archived |
| not_a_fit | new, do_not_contact, archived |
| lost | engaged, do_not_contact, archived |
| archived | new, do_not_contact |
| do_not_contact | *(none)* |

**What the rules guarantee:**
- **Requirements are re-checked on every edit.** For example, a ready-to-contact
  prospect can't have its only contact detail removed. Move it back to qualified first.
- **Status changes are compare-and-set.** Two simultaneous changes can't both apply.
- **Every change is written to the history.**
- **`do_not_contact` is a compliance flag.** Nothing in the app can move a
  prospect out of it.
- **Prospects can't be deleted, only archived.** That way a do-not-contact
  record can't be lost and then re-added. Reversing it on purpose would take a
  deliberate database change.

### Migration from Milestone 1

Migration `20261001120000_prospect_model` keeps every existing prospect and
its analytics:

| Milestone 1 status | Milestone 2 status |
| ------------------ | ------------------ |
| `new` | `new` |
| `contacted` | `contacted` |
| `active` | `engaged` |
| `archived` | `archived` |

**Also done by the migration:**
- Each existing prospect gets one history row ("Migrated from Milestone 1 status").
- `statusChangedAt` is set to the prospect's last update.
- Existing prospects keep score 0 with no score version until
  `npm run prospects:rescore` runs.

## Admin workflow

| Page | What it does |
| ---- | ------------ |
| `/admin/prospects` | List with status counts, search (name, website, city, email, phone, referral code), separate filters for status, qualification, score band, state, and city, and sorting by score, updated, added, or name |
| `/admin/prospects/new` | Create: business, location, public contact (with sources), and the signal checklist with each signal's rules |
| `/admin/prospects/:id` | Detail: qualification (and which criteria decided it) shown separately from the opportunity score and band, fields, referral link and activity, the score breakdown with the reason for every signal, status with allowed moves, history, evidence, notes |
| `/admin/prospects/:id/edit` | Edit everything on the create form. Saving recomputes the score |

A typical flow:
1. Add a shop as **new**.
2. Research it and record signals, adding evidence for the important ones. Move it to **qualified**.
3. Record a public phone or email with its source. Move it to **ready to contact**.
4. Prepare an outreach draft from the prospect's page (see [OUTREACH.md](OUTREACH.md)).
   Replies and outcomes then move the status: engaged, meeting, proposal,
   customer, or lost.

## Where prospects come from

Prospects are added by hand, or by **approving a discovery candidate** (see
[DISCOVERY.md](DISCOVERY.md)). Approval creates a prospect at status `new`
through the same path and validators as adding one by hand, and never sets
Qualified or Ready to contact. The qualification and status rules on this page
still apply to it unchanged.

## Outreach

Outreach is described in [OUTREACH.md](OUTREACH.md). Its links to this page:
- **Who gets a draft:** qualified prospects with a valid published business
  email, in New, Qualified, or Ready to contact, whose address isn't
  suppressed. Queueing a first message moves the prospect to **Ready to
  contact** through the normal rules; only Ready to contact is ever sent a
  first message (`OUTREACH_ELIGIBLE` in `src/prospectStatus.ts`).
- **Who is excluded:** `do_not_contact` permanently, and any suppressed
  address (bounced, complained, unsubscribed, invalid). Entering Do not
  contact, Not a fit, Lost, Archived, or Customer cancels any unsent message.
- **What happened:** each message has its own record and event log; the
  commercial outcome (engaged, meeting, proposal, customer, lost) is this
  status, with its history.

## Tests

```bash
npm test                    # pure scoring and status rules, no database
npm run typecheck           # src and tests

# Integration tests (service + admin HTTP). They migrate and TRUNCATE the
# database, so use a disposable local one:
npx prisma dev              # prints a postgres:// URL
TEST_DATABASE_URL=<that url> npm run test:integration
```

**Safety guards on the integration tests:**
- Without `TEST_DATABASE_URL` they are skipped with a message.
- They refuse any non-local host unless `ALLOW_REMOTE_TEST_DB=1`.
- They refuse a URL equal to `DATABASE_URL`, and refuse to run in production
  or on Railway.

## Automotive repair ICP (scoring v3)

The ICP broadened from collision/body repair to automotive repair generally. No data is migrated or rescored by this code change. Existing collision/body Yes records keep their qualification and their score (collision/body Yes establishes automotive repair; the 20 points moved with it). Candidates researched before r13 have no `automotive_repair_services` signal: mechanical shops need research to run again (r13) before they can qualify. Cached scores show "cache stale" until an explicitly authorized `npm run prospects:rescore`; the values themselves don't change for existing records. Mechanical businesses excluded at import time under collision@c2 need a reviewed fresh/forced import.

## Historical ICP recovery (separate milestone)

No data recovery is performed by this code change. Old mechanical signals/evidence remain stored. Existing prospects without a new sourced collision signal become Unverified under v2; cached scores are stale until an explicitly authorized rescore. Do not infer collision fit from old approval, categories, mechanical or ownership values. Previously excluded businesses require a reviewed fresh/forced import because they were never staged; same-release imports are otherwise reused. Preserve human decisions, suppression, invitations and send history. Production discovery, recovery and rescore are separate future work.
