# Supply replenishment

Keeps Discovery supplied with new, prescreened automotive repair businesses, so outreach never runs out
of eligible candidates. Code: `src/replenishment/`. It **only adds businesses to Discovery**. Research,
qualification, eligibility, protection, suppression and every outreach rule are unchanged: an added
business is researched and judged exactly like any other candidate. It never creates prospects, drafts,
campaigns or messages, and never touches the sending controls.

It automates what Targeted Outreach 03 did by hand (100 West SFV businesses screened, 19 added, 6 became
eligible): same sourcing filters, same prescreen rules, same intake path.

## What one batch does

1. **Supply check.** Supply = autonomous-eligible candidates + businesses replenishment added that research
   hasn't finished. Below `lowSupply` (default 10) a batch may start; otherwise nothing happens.
2. **Limits.** No batch within `cooldownMinutes` (60) of the last one; at most `batchesPerDay` (4) and
   `fetchesPerDay` (1,500 requests) in any rolling 24 hours.
3. **Area rotation.** The next configured area: one never sourced first (in order), then the least
   recently sourced. An area whose sourcing pass read the whole county and found too little is
   *exhausted* for that Overture release and skipped until a new release.
4. **Sourcing** (the registered Overture importer, one county): core repair category, in the area's cities
   or ZIP codes, a website, open, provider confidence at least 0.5, no chain or franchise dealer
   (`UNSUITABLE_SOURCE`), and nothing already known: no existing candidate or prospect (by provider ID, by
   the identity matcher, or by domain), and **no record screened before**: `ScreeningEntry` is unique on
   provider and ID, across batches and releases. At most `businesses` (60) per batch.
5. **Prescreen** each business's official website through the research crawler (robots.txt, per-host
   pacing, public-address checks) and analyzer, with Targeted Outreach 03's rules: verified website
   identity, verified location, strong positive repair evidence, independent/regional/unknown ownership,
   no conflicting evidence, and a published email that isn't suppressed, opted out or already someone's.
   `requirePublishedEmail` (default **true**) also keeps out sites that publish no email; this is stricter
   than Targeted Outreach 03, since a business without one can never become eligible.
6. **Intake.** Accepted businesses are rechecked against what exists now and added through the existing
   Discovery run pipeline (`runDiscovery` + `processDiscoveryRun`), which deduplicates again. The next
   research run picks them up.

Every business screened is recorded (`ScreeningEntry`: status, reasons, compact evidence: pages read,
the facts that decided it, short repair quotes, no page bodies), and every batch (`ReplenishmentBatch`:
trigger, area, release, limits, counts, requests and bytes).

## Budgets

The request meter sits below the research transport, at the physical HTTP boundary: every redirect hop,
robots.txt read and retry counts, and bytes are counted as they stream. Before a business is screened its
full cap (`perBusinessFetches` 25, `perBusinessBytes` 8 MB) is reserved on the batch row under a row lock,
against the batch caps (`fetches` 600, `bytes` 60 MB) and the rolling daily request budget; afterwards the
actual use is settled. A crash leaves the reservation charged, never refunded. A business that hits its
cap is an **error**, never accepted on a partial read. Once a reservation would exceed a budget, the rest
of the batch is marked `budget` and never screened.

Every limit has a hard ceiling (`LIMIT_BOUNDS` in `policy.ts`) that a stored configuration can't exceed.

## Controls (all default OFF)

Replenishment acts only when **both** are on:

- the service arm `REPLENISHMENT_ENABLED=1` (Railway variable on the Research service), and
- the persisted control, enabled and not paused.

```sh
npm run discovery:replenish -- --status                                   # control, supply, recent batches
npm run discovery:replenish -- --dry-run [--area la-east-sfv] [--limit 20] [--out report.json]
npm run discovery:replenish -- --enable --reason "..."                    # also --disable, --pause, --resume
npm run discovery:replenish -- --configure '{"lowSupply":10}' --reason "..."   # {} = defaults
npm run discovery:replenish -- --show-config
npm run discovery:replenish -- --import-screened prior.json --reason "..."     # an earlier prescreen's rejections
npm run discovery:replenish -- --run                                      # one live run, on demand
```

Every control change is appended to `ReplenishmentControlChange` with its reason. A **dry run** sources
and prescreens for real (provider and website reads, the same budgets) but writes nothing to the
database, whatever the controls say.

**Fail-closed.** An unexpected error, an invalid stored configuration or a batch interrupted during intake
pauses the control with its reason (`auto_pause`); nothing more happens until a person resumes it. A
budget, a cooldown or the run's deadline only defers: a batch resumes across runs, and a business
interrupted mid-screen is recorded as an error with its reservation charged. Intake waits while another
Discovery run is active or once the control is off.

## Scheduling

The research worker (`discovery:research --auto`, Railway Cron every 15 minutes) runs one replenishment
step after research and the autonomous-campaign step, in the same locked run and within the rest of its
10-minute budget. No screening chunk starts with less than a minute left. A service without
`REPLENISHMENT_ENABLED=1` skips the step entirely: no control read and no request.

## Areas

The default rotation (`DEFAULT_AREAS`): West San Fernando Valley / Agoura Hills / Calabasas (Targeted
Outreach 03), Thousand Oaks / Newbury Park / Westlake Village, Simi Valley / Moorpark, Camarillo / Oxnard /
Port Hueneme, Ventura / Ojai / Santa Paula / Fillmore, Santa Clarita Valley, East San Fernando Valley. A
stored configuration may reorder, narrow or replace it (1 to 20 areas, each one county with cities and/or
ZIP codes).

## Dry run, 2026-10-24 (temporary local restore of backup m2-1792823886011, release 2026-10-21.0)

| Area | Read | Sourced | Accepted | Main rejections | Requests / data |
| --- | --- | --- | --- | --- | --- |
| la-east-sfv (never sourced) | 6,036 | 60 | **7** (11.7%) | no email 27, unreadable 21, weak repair evidence 21 | 291 / 20.6 MB |
| ventura-conejo | 902 | 13 | 1 | 67 already candidates; exhausted for the release | 66 / 8.0 MB |
| la-west-sfv | 5,605 | 60 | 0 | the 60 were Targeted Outreach 03's own rejections, screened again | 251 / 14.8 MB |

The West SFV result confirms the rules reproduce Targeted Outreach 03's decisions; recording its 81
rejections (`review/replenishment/prior-targeted-outreach-03.json`, `--import-screened`) keeps the rotation
from paying for them twice. In fresh territory a 60-business batch yields about 7 accepted businesses in
under three minutes and about 300 requests.

## Autonomous outreach: minimum orchestration (design, not built)

The aim: send at most **10 first emails a day** to autonomous-eligible businesses, **no follow-ups**,
pausing itself on any sign of harm, with clear ON/OFF controls. Most of it exists:

| Need | Existing | To do |
| --- | --- | --- |
| ON, atomically with a bounded authorization | One-click autonomous launch: campaign + switch ON under the send gate, after a fail-closed preflight (`launchAutonomousCampaign`) | none |
| OFF | Emergency stop: switch OFF and every autonomous campaign stopped for good (`emergencyStop`) | none |
| 10 a day | Persisted daily limit (admin, default 25), 60 s pacing | Set it to 10 (an admin action) |
| Bounded total | Campaign `prospectCap`, `messageCap` (every membership counts), `expiresAt` (at most 30 days) | e.g. 70 messages over 7 days, renewed by a person |
| No follow-ups | The autonomous campaign prepares and commits first messages only | Keep a test asserting it |
| Creating prospects and drafts | `runAutonomousCampaign` in the research worker, after research | none |
| Supply | This module, with `lowSupply` ≥ the daily send limit | `lowSupply` 10 |
| **Safety pauses** | Per-message send-time checks; provider errors stop a run | **New: a send-health guard** |

**The send-health guard** (the one new piece): before every send the dispatcher evaluates the active
autonomous campaign's recent record and, on any trigger, calls `emergencyStop` with the reason (switch OFF,
campaign stopped; a person reviews and relaunches):

- any hard bounce among its last 20 sends, or 2 in 7 days;
- any spam complaint;
- 2 or more unsubscribes among its last 20 sends;
- a Gmail authorization or Send As failure, or 2 consecutive failed or uncertain sends;
- an inbound reply classified as hostile or a legal/opt-out demand (if the classifier flags it).

It would live next to dispatch (it must hold the send gate), with integration tests for each trigger and
for "sending stays OFF after a trigger until a person relaunches". Until it exists, autonomous sending
stays OFF; person-selected campaigns (as for Targeted Outreach 03) remain the way to send.
