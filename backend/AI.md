# AI shadow layer: collision/body fit verification

ReclaimBay's acquisition pipeline is deterministic: discovery, research,
qualification, scoring, approval, outreach, and sending are rules and people.
The AI layer adds interpretation in small, measured steps. Its principle:

- **AI** interprets and judges.
- **Deterministic code** enforces policy and safety.
- **The database** remembers, and is the audit trail.
- **People** handle exceptions and keep final authority.

The first AI decision is **collision/body fit verification**, and it runs in
**shadow mode only**: every answer is recorded for evaluation, and nothing
acts on it. The system is not autonomous, and no accuracy is claimed until it
has been measured against people's decisions.

## Why shadow mode

Automated research recognizes collision/body repair from fixed wording on a
business's own website (`src/research/collisionFit.ts`). When the wording is
unusual, ambiguous, or describes a dealership or specialty, research leaves
the fit unknown and the candidate waits for a person ("Needs verification").
The AI shadow layer judges those same candidates so its answers can be
compared with the rules and with people before it is ever trusted with
anything.

## What it judges, and on what

`npm run ai:shadow` (`src/ai/shadow.ts`) selects candidates the rules leave
for a person: Researched or Needs review, not yet a prospect, not outside the
target category, with a website research verified as the business's own, a
completed research run that confirmed it, and **no** collision/body signal
recorded. `npm run ai:shadow -- --labeled` instead judges candidates a person
already decided (a manual collision/body Yes or No), so agreement can be
measured; the AI is never shown that decision.

For each candidate it re-reads the website with the research fetcher (robots.txt,
politeness delays, the same page picker, at most five pages) and builds the
input (`src/ai/collisionFitJudge.ts`):

- the business's name, website, city, and state;
- automated research's rule version, outcome, business type, and warnings
  (leaving out any warning that mentions a person's decision);
- **excerpts**: research's own stored collision/body evidence and facts, then
  each page's title, and headings and sentences that mention body-shop
  wording, each at most 280 characters (the existing evidence limit), at most
  8 per page and 24 in all, and only from the business's own site.

It never sends or stores a page body. Nothing a person recorded (signals,
evidence, statuses, notes) is part of the input. Website text is untrusted: it
goes to the model as data inside an `<excerpts>` block (with angle brackets
made inert), and the prompt tells the model never to follow it.

## What the model returns

One request to the provider (`src/ai/provider.ts`, the Anthropic Messages API
over `fetch`; no SDK, no tools, no browsing), with the answer constrained to a
JSON schema:

| Field | Values |
| ----- | ------ |
| `decision` | `collision_primary`, `specialty_body`, `dealership_body_dept`, `not_collision`, `insufficient_evidence` |
| `confidence` | 0 to 1 |
| `evidence[]` | `{ sourceUrl, quote }`: a word-for-word quote from one supplied excerpt |
| `reasons[]`, `concerns[]` | short sentences |
| `recommendedNextAction` | `record_collision_yes`, `record_collision_no`, `human_verification`, `find_more_evidence` (a suggestion; nothing is done) |

## Validation: the answer is never trusted for parsing

`validateCollisionFit` checks every answer deterministically. It is **invalid**
(recorded, unusable) when:

- it isn't JSON, isn't an object, or has an unexpected field;
- the decision or next action isn't an allowed value, or confidence isn't a
  number from 0 to 1;
- reasons or concerns aren't short lists of strings;
- any evidence item isn't `{ sourceUrl, quote }`, its URL isn't on the
  business's own website or wasn't part of the input, or its quote (12 to 280
  characters) doesn't appear word for word in a supplied excerpt **for that
  URL** (spacing and typographic quotes are normalized; words, spelling, and
  case are not, and an ellipsis doesn't match);
- a decision other than `insufficient_evidence` has no evidence;
- a positive decision's evidence wouldn't pass the existing qualification
  evidence gate (`collisionEvidenceErrors`): the same check a person's
  evidence must pass before Qualified or Ready to contact. Text that merely
  tells the model what to answer never passes it.

A provider failure (timeout, network, HTTP error, a refusal, an answer cut off
at the token limit, an unreadable response) is recorded as an **error**.

## What it stores

One append-only `AiDecision` row per judgment: the kind (`collision_fit`), the
subject (the candidate), the research run, the input hash, the mode
(`shadow`), the model and prompt version, the status (`valid`, `invalid`,
`error`), the decision, confidence, evidence, reasons, concerns, next action,
validation errors, the rules' verdict on the same pages (`collisionFit`) and
whether the AI agrees, a person's decision when one existed (labeled mode),
tokens, estimated cost, latency, and any error. Nothing updates or deletes a
row.

## Versioning and idempotency

- The **input hash** is SHA-256 over the decision kind, prompt version, model,
  and the exact input.
- A candidate already judged for its current research run, prompt version, and
  model is skipped without re-reading its website. A failed attempt isn't
  retried for 24 hours.
- A new research run whose input hashes the same as an earlier decision
  reuses that decision: a new row records it for the run, with no provider call
  and no cost.
- Changing the prompt (`COLLISION_FIT_PROMPT_VERSION`) or the model makes a new
  decision; earlier rows stay as they are.

## What it can't change

The shadow layer has no authority. By construction:

- The runner's database handle (`ShadowDb`) can read candidates and cohort
  cases and read and append `AiDecision` rows, and nothing else; the gold-set
  handle (`GoldDb`) can read candidates and append cohorts and labels, and
  can't read AI decisions at all. Type tests fail if either ever grows more.
- Architecture tests (`test/unit/ai.architecture.test.ts`) fail if AI code
  imports anything beyond the database client, the shared URL/name normalizer,
  and the research fetcher, HTML reader, page picker, and collision
  classifier; if the sending, Gmail, outreach, eligibility, unsubscribe,
  reconciliation, invitation, discovery-service, or research-service modules
  become reachable from it; if it names a state-changing function; if any file
  writes anything but its own append-only records (the runner `AiDecision`,
  the gold set `AiEvalCohort` and `AiLabel`); or if anything that decides
  (discovery, research, prospects, outreach) imports it. Only the admin views,
  the evaluation routes, and the two scripts do.
- So it can't touch suppression, unsubscribes, recipient validity, duplicate
  protection, the qualification evidence gate, the sending switch, the
  deployment arm, the daily limit, queueing, dispatch, provider-uncertainty
  handling, inbox attribution, compliance, the internal-test identity, or
  business metrics.

## Running it

Off unless all of these are set (see the [README](README.md#environment-variables)):

| Variable | Meaning |
| -------- | ------- |
| `AI_SHADOW_ENABLED=1` | Arms the job; otherwise it exits at once |
| `AI_PROVIDER=anthropic`, `AI_API_KEY` | The provider and its key (a secret: never logged or shown) |
| `AI_MODEL` | Default `claude-opus-5-5`. Only models with a known price run, so the budget can be enforced |
| `AI_SHADOW_DAILY_BUDGET` | US dollars per rolling 24 hours (default 0: nothing runs; at most 100) |
| `AI_SHADOW_BATCH_LIMIT` | Provider calls per run (default 5, at most 25) |

Before each call the job checks the last 24 hours' estimated spend plus the
call's worst case (a conservative input estimate and the full output limit)
against the budget; a failed call is charged its worst case. One run at a time
(a PostgreSQL advisory lock); a run starts no new candidate after 10 minutes,
and finishes the one in progress on SIGTERM. It prints one summary line.

## Evaluation

There are two kinds of comparison, and they answer different questions.

- **Recorded shadow decisions** (`/admin/ai`, and the candidate page's **AI
  shadow verdict (evaluation only)** section, labeled as not a decision, with no
  action): every decision, its validation, agreement with the rules on the
  same pages, cost, latency, and versions; and agreement with people's
  **existing** collision/body decisions (not blind: those people may have seen
  anything). Useful for monitoring, not proof of accuracy.
- **Blind gold sets** (below): the trustworthy answer to "is the AI accurate
  enough, and better than the rules?".

Agreement with the rules is never accuracy, and the model's confidence is
never treated as accuracy. A rate is shown only from 20 observations; below
that the page says "Unavailable" with the counts, and with no labels it says
"Not enough labeled cases yet." It never shows 0% for an unknown.

## Blind gold sets

A **gold set** (cohort) is a frozen sample of candidates that a person labels
blind, so the AI and the rules can be scored against the same human answers
(`src/ai/goldSet.ts`, `src/ai/evaluation.ts`).

### Building one

`/admin/ai` (Create a gold set: a name and a seed) or
`npm run ai:cohort -- --seed <seed>` (a dry run that prints the plan; add
`--name <name> --apply` to create it). Eligible candidates have a website
research confirmed as the business's own and a completed research run that
read it (so the AI can judge them too). They are sorted into strata, in this
order, from the candidate and its research only, never from AI output:

| Stratum | Quota | Meaning |
| ------- | ----: | ------- |
| `person_decided` | 15 | A person recorded collision/body fit (a check of the labeler against earlier decisions; few, so the set isn't mostly known answers) |
| `specialty_or_uncertain` | 25 | Research flagged a dealership/specialty case or contradictory evidence |
| `auto_approved` | 30 | Approved automatically |
| `auto_rejected` | 20 | Rejected automatically |
| `verify` | 60 | Researched or held, with no collision/body signal: left for a person |

Within a stratum, a seeded hash orders the candidates and the quota is taken;
a stratum short of its quota is reported, never filled from another. The
cases are then shuffled (seeded) into one labeling order, so strata are
interleaved. The same seed and data always give the same cohort; the cohort
records its seed, its sampling version (`stratified@s1`), and each stratum's
quota, availability, and count. Once created, a cohort's cases never change.
An explicit list (`--candidates ids.txt`, sampling version `manual`) is the
path for an authorized, hand-made or imported cohort; every id must exist.

To judge a cohort's candidates, including approved and rejected ones the
verification queue never reaches: `npm run ai:shadow -- --cohort <id>`
(the same runner, validator, budget, and limits).

### Blind labeling

`/admin/ai/cohorts/<id>/next` opens the next unlabeled case. The labeler sees
the business, its website and address, the pages research read, research's
quoted excerpts with their source URLs, and research warnings that don't reveal
a decision, and answers with the same taxonomy as the AI (performs
collision/body repair; body specialty only; dealership body department; does
not; can't tell from the evidence), with an optional note and name (the admin
session has no personal identity).

The labeling page never shows the AI's decision, confidence, reasons, concerns,
recommended action, model, or prompt; nor the case's stratum, the candidate's
status, qualification or signal values, decision reasons, notes, or a person's
own evidence. By construction: the gold-set module's database handle has no
access to AI decisions, and the labeling views import nothing from the AI
layer (architecture tests). Until a case's blind label is saved, its AI output
is also hidden on the candidate page, in the recorded-decisions list, and on
the case review page (which redirects to the label form).

### Integrity

- **One blind label per case.** Revision 1 is the blind label, accepted only
  while the case has no label; two submissions at once yield one. It never
  changes.
- **Adjudication is separate.** After the blind label, the case review page
  shows the AI's answers, and a person may record an adjudication: a new
  revision with a required reason. Adjudications are counted (how many, how
  many differ from the blind label) but never replace the blind label in the
  metrics, because they are made after seeing the AI.
- **The database enforces it:** a unique (case, revision); revision 1 must be
  `blind`, later revisions `adjudicated` with a note; labels are one of the five
  answers; a candidate appears once per cohort.
- **Nothing is labeled automatically**, and no label is derived from AI output
  or from an existing decision.
- **Versions never mix.** Each evaluation names the decision kind, the AI model
  and prompt version, and the gold set with its sampling version and seed. It
  scores one model and prompt version at a time (by default the one with the
  most decisions in the set), using its newest decision per candidate; other
  versions are listed and evaluated separately.

### Metrics

`/admin/ai/cohorts/<id>` (read-only) evaluates one AI version (decision kind,
model, prompt version) on one gold set.

**The evaluation population.** The unit is the cohort case, and the
population is every case with a blind label. The AI and the rules are scored
on exactly these cases, each case once; nothing is dropped because the AI
failed. Cases still waiting for a label are outside it, and contribute
nothing AI-derived to the page (outcomes, confidence bands, average
confidence, AI-vs-rules counts, cost), only the cohort's case count.

**What each side contributed for a case.**

| | Meaning | How it is scored |
| - | ------- | ---------------- |
| AI valid decision | The newest decision of this version for the candidate, valid | Its answer |
| AI abstention | A valid "insufficient evidence" | An answer: a deliberate abstention |
| AI invalid, error, or missing | It failed validation, the call failed, or this version never judged the case | **No usable answer**: kept in the population, never a positive call |
| Rules verdict | The collision classifier on the same pages, recorded with the AI row (primary, possible, negative) | Its answer (possible counts as specialty or dealership) |
| Rules abstention | Unknown or contradictory | An abstention |
| Rules without a verdict | No AI row for this version, so the site was never read for it | **No usable answer** |
| Human definite label | Collision primary, specialty, dealership, or not collision | Gold |
| Human "can't tell" | The evidence didn't settle it | Gold for agreement only; never in precision or recall |

An invalid answer's recorded decision is never used, and an AI decision from
another model or prompt version is never borrowed: a case that version didn't
judge is "no usable answer" for it.

**Denominators.**

| Metric | Denominator |
| ------ | ----------- |
| Agreement | Every case in the population (no usable answer never agrees; a human "can't tell" is matched only by an abstention) |
| Abstention, no usable answer | Every case in the population |
| Invalid decisions, invalid evidence or quotes | Every case in the population |
| Collision-primary precision | The classifier's collision-primary calls on cases with a definite human label |
| Collision-primary recall | Every case a person labeled collision primary, answered or not (so a failed or missing AI answer is a miss) |
| Any-fit precision and recall | The same, with primary, specialty, and dealership as one positive class |
| Confidence bands | The AI's valid decisions on labeled cases in the band |
| Cost and latency | Provider calls for labeled cases (reused decisions cost nothing and are excluded) |

Each false-negative count also says how many of the misses had no usable
answer. Any rate needs 20 observations; below that it is "Unavailable" with
its counts, and no confidence interval is invented.

The page shows **AI vs human** and **rules vs human** as separate blocks over
the same population (each with a confusion matrix that includes a "no usable
answer" column), and **AI vs rules** separately, labeled as not accuracy.
Exact agreement for the rules treats specialty and dealership as one class,
because the classifier can't tell them apart; precision and recall are
scored identically for both.

**By stratum.** The gold set is deliberately stratified: each stratum's
share was chosen (for example, 30 automatically approved cases), not
observed, so the overall figures describe this sample, not all candidates,
and must not be read as population estimates. The **Evaluation by stratum**
table shows, for each stratum: cases, labeled cases, the AI's valid answers,
abstentions, and cases without a usable answer, and AI-vs-human and
rules-vs-human agreement, collision-primary precision, and recall, with the
same denominators and the same 20-observation rule (most per-stratum rates
will be unavailable in a 150-case set: read the counts). A cohort built from
an explicit list has a single `manual` stratum.

Adjudications are counted separately (how many, how many differ from the
blind label) and never enter the metrics.

### Confidence calibration

Valid AI decisions on labeled cases are grouped by confidence (below 0.50, 0.50–0.59,
0.60–0.69, 0.70–0.79, 0.80–0.89, 0.90–0.94, 0.95–1.00), with accuracy against
the blind label per band, shown only from 20 labeled cases in the band. The
model's confidence is not assumed to mean anything until these bands are
measured: a threshold could be considered only where the bands above it are
both measured and accurate.

### Disagreements

`/admin/ai/cohorts/<id>/disagreements` lists, for labeled cases only, each
case where the blind label and the AI's valid decision differ: the candidate,
both answers, the AI's confidence, quoted evidence with source URLs, reasons
and concerns, and the rules' verdict, with a link to review and adjudicate.

### Production labels

Nothing here reads production. Labels are meant to be given in the production
admin itself, against production candidates, once deployed. If labels must be
prepared elsewhere, the read-only export needed is, for the cohort's
candidates only: `DiscoveryCandidate` (id, business name, website, street,
city, state, postal code, status, decision reason, website verified time),
their `CandidateSignal` rows for `collision_repair_services`, their newest
`CandidateResearch` run (status, outcome, version, warnings) with its
`ResearchSource` (website kind) and `ResearchFact` rows (excerpt and source),
and research-origin `CandidateEvidence`. An exported id list can become a
cohort with `npm run ai:cohort -- --candidates <file>`.

## Before any autonomy

Autonomy is a separate, later decision; nothing here enables it, and nothing
here claims the AI is accurate. Moving beyond shadow mode would be considered
only when a blind gold set (and a fresh one for any new prompt or model)
shows, with enough labels for every rate to be measured:

- no accepted fabricated or misattributed evidence;
- collision-primary precision high enough that a wrong Yes is rare, and better
  than the rules' on the same labels;
- recall and abstention better than the rules', so the AI actually reduces the
  cases left for a person;
- confidence bands that are measured and accurate above any threshold used;
- disagreements reviewed, with no systematic failure (dealerships,
  specialties, contradictory sites).

Even then it would start narrow (for example, recording a collision/body Yes
only for high-confidence, gate-passing evidence), act only through the existing
services and every existing gate, keep sampled human audits, and keep an off
switch.
