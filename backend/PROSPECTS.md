# Prospects: model, scoring, and workflow

Prospects are auto-repair shops that might benefit from ReclaimBay. This
milestone covers recording, scoring, and managing them by hand in the admin.
There is no scraping, automated discovery, email sending, or outreach
automation.

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

## Scoring (v1)

Scoring produces two separate results from the same observations:
**qualification** (does the shop meet the required business criteria?) and an
**opportunity score** (0–100, for ranking). A high score never qualifies a
shop, and disqualification never lowers the score.

The score is a sum. Each signal observed as **yes** adds its weight; **no**
and **unknown** add nothing. Weights total 100. Unknown is shown separately
("6 of 9 signals known"), so missing research never looks like a negative.

Subjective ideas are replaced with things anyone can check. "The website looks
dated" becomes two facts: no HTTPS, and no date from the last two years. The
admin form shows each signal's rules next to its radio buttons.

| Key | Label | Weight | Yes | No | Unknown |
| --- | ----- | -----: | --- | -- | ------- |
| `independent_shop` | Independent shop | 25 | Website and primary listing show no franchise brand (Midas, Meineke, Firestone, Jiffy Lube, Pep Boys, Christian Brothers…), not a new-car dealer's service department, and the name operates 5 or fewer locations | A franchise location, dealer service department, or brand with more than 5 locations. **Required criterion: disqualifies.** | Not checked, or sources conflict |
| `general_repair_services` | Offers general repair | 20 | Website or listing names at least 2 of: brakes, suspension/steering, engine diagnostics, maintenance/oil service, A/C, electrical, transmission, cooling, exhaust | Every service is a non-mechanical specialty: collision/body, glass, tint, detailing, audio, towing, or tires only. **Required criterion: disqualifies.** | No services list found |
| `multiple_bays_or_staff` | 3+ bays or technicians | 15 | A public source shows or states 3 or more bays, or 3 or more technicians | A source states 1–2 bays or a single-mechanic operation | No source gives a count |
| `digital_inspections` | Mentions digital inspections | 10 | Website mentions digital or photo/video inspections, reports sent by text or email, or names a DVI product | Homepage and services pages reviewed, no mention | No website, or not reviewed |
| `public_business_contact` | Public business contact | 10 | *Automatic:* a phone or email is stored with its source URL | Website and primary listing searched, neither listed | Not searched, nothing stored |
| `has_website` | Has a website | 5 | *Automatic:* a website URL is stored | Search for name + city found no site of its own (directories don't count) | Not searched, nothing stored |
| `no_online_booking` | No online booking | 5 | Website reviewed, no scheduling form, widget, or booking link ("call to schedule" or a general contact form counts as none) | Has an appointment request form, widget, or booking link | No website, or not reviewed |
| `website_not_https` | Website not on HTTPS | 5 | `https://<domain>` fails, redirects to http, or shows a certificate warning | Loads over https with no warning | No website, or not checked |
| `website_no_recent_date` | No recent date on website | 5 | The newest date anywhere on the site (copyright, post, "updated") is 2+ calendar years before the observation | A date in the current or previous calendar year | No website, not checked, or no dates at all |

**Why these weights.**
- **Fit (45 points):** ReclaimBay helps independent general-repair shops recover
  declined work, so `independent_shop` (25) and `general_repair_services` (20)
  carry the most. They are also the two required criteria (see Qualification):
  a "no" on either disqualifies, because franchises and dealers
  use mandated corporate systems and specialty shops produce little declined work.
- **Size of the opportunity (15):** `multiple_bays_or_staff`, since more bays
  mean more inspections and more declined work.
- **Data readiness (10):** `digital_inspections`. It indicates itemized
  recommendations and shop software that can export them, which is ReclaimBay's input.
- **Actionability (15):** `public_business_contact` (10) and `has_website` (5).
- **Room to improve (15):** `no_online_booking`, `website_not_https`, and
  `website_no_recent_date` at 5 each. They are weak proxies, so they stay small.

**Consistency rules** (enforced on save):
- "yes" can't be recorded by hand for the derived signals.
- A recorded "no" can't contradict a stored website or contact.
- The four website-only signals need a stored website.

### Qualification

Qualification is a separate verdict from the required criteria only:
`independent_shop` and `general_repair_services`. No other signal, and no
score, affects it.

| Qualification | Rule |
| ------------- | ---- |
| `meets_criteria` | Both required criteria are "yes" |
| `unverified` | Neither is "no", but at least one is still unknown |
| `disqualified` | Either required criterion is "no" |

### Opportunity score and band

The 0–100 score and its band describe the size of the opportunity, never
fitness. The band is a label for the score alone:

- **High:** 60 or more.
- **Medium:** 35–59.
- **Low:** below 35.

**The two are independent.**
- A disqualified shop keeps its full score. A franchise with every other signal "yes" scores 75 and is in the High band.
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
| `qualified` | Verified to meet both required criteria | Business name; Qualification = `meets_criteria` (both required criteria "yes") |
| `ready_to_contact` | Qualified, and reachable through published business contact | Same as qualified, **plus** a public business phone or email with its source URL |
| `contacted` | Reached out to at least once | — |
| `engaged` | Replied, visited via referral link, or in conversation | — |
| `customer` | Using ReclaimBay | — |
| `not_a_fit` | Researched and ruled out (reason required) | — |
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
| contacted | engaged, not_a_fit, do_not_contact, archived |
| engaged | customer, contacted, not_a_fit, do_not_contact, archived |
| customer | engaged, do_not_contact, archived |
| not_a_fit | new, do_not_contact, archived |
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
4. Later milestones pick up outreach from there.

## For future outreach (not built)

These records already give an outreach feature what it needs:
- **Who is eligible:** `ready_to_contact` only (`OUTREACH_ELIGIBLE` in
  `src/prospectStatus.ts`).
- **Who is excluded:** `do_not_contact` permanently, and every other status.
- **Where to send:** a published business email or phone, with proof of where
  it was found.
- **What happened:** a status history, a score with its reasons, and a
  referral code to attribute replies and visits.

Anything that sends messages, schedules follow-ups, or discovers prospects
automatically belongs to a later milestone.

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
