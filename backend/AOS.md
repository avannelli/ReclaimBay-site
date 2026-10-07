# Acquisition Command Center — D.10.6.9 Phase 1

Local implementation for visual review. Nothing in this milestone authorizes a commit, deployment, production access, or sending.

## Inherited state and scope

The working tree already contained the shell, a partly replaced Overview data layer, secondary workspace views and filters, and the four unrelated public-site/development changes. The resume began with eight backend type errors: the views/routes still referenced the removed `CommandSnapshot` and `commandSnapshot`, and navigation keys disagreed.

This phase completes the design tokens, shared primitives, grouped shell, sending strip, and Overview. Existing secondary workspace changes remain in the tree. Research and Health required data-shape/navigation compatibility; their separate design review is deferred. No additional redesign of Prospects, Discovery, Sending, Prepare, Messages, Replies, reviews, Campaigns, Funnel, or Activity is included in this resume.

## Architecture and safety

The admin is Fastify-rendered HTML, separate from the public Next.js static site. It retains its signed session, same-origin POST check, login/write rate limits, escaping, privacy logging, and original CSP. No scripts, external styles, web fonts, dependencies, schema, migrations, or tracking events were added.

Every existing mutation handler remains intact. Qualification, sourced collision evidence, readiness, queueing, dispatch, Gmail, Inbox attribution, suppression, reconciliation, and invitation services remain authoritative.

The original Funnel is available at `/admin/analytics`; `/admin` now serves Overview. Navigation groups Command center, Acquisition, Outreach, Insights, and System. Research remains associated with Discovery. Sending and Prepare point to the existing workflows. No Campaign Diagnostic navigation item is exposed.

## Design system

Warm `#F7F8F6` canvas, white surfaces, `#F1F3F1` wells, `#10263C` ink, `#0B2238` sidebar and primary actions, teal links/focus, and restrained `#F2A51A` navigation/next-action accents. Positive, attention, danger, neutral and unknown states combine words and glyphs with color. Unknown status has a dashed treatment.

System typography uses a 14px body and 12–30px scale. Surfaces have three elevation levels. The 248px grouped sidebar becomes a native details drawer at mobile widths. Sending remains visible in the shared top bar. Reduced-motion preferences are respected; there is no simulated asynchronous loading or fake skeleton.

## Definitions

| Presentation | Authoritative source |
| --- | --- |
| Sending mode and blockers | `sendingStatus()` plus existing readiness and Sending page live provider check |
| Queue | Existing queued Outreach records |
| Capacity | `dailyCapacity()` — attempts started in the rolling 24-hour window |
| Unresolved | `stuckMessages()` — active attempts are excluded |
| Queue stall warning | `queueLooksStale()` and existing stale interval |
| Provider authorization | Live check only on Sending; its app-instance result is remembered with a timestamp; Overview never polls Gmail |
| Research activity | `automaticResearchStatus()`; activity is not deployment health |
| Discovery decisions | `reviewQueue()` and its existing lane definitions |
| Prepare eligibility | `prepareEligibleOutreach({ apply: false })`, then exclude internal test prospects |
| Reply attention | `outreachAttention()` — individual unclassified replies |
| Acquisition reach and invitation activation | `outreachMetrics()` and `invitationActivations()` |
| Product funnel | `loadSummary()` — distinct sessions; real events exclude samples and internal tests |
| Current inventory | Current business prospect states |
| Ever reached | Distinct business prospects with actual current/history records for each stage; skipped stages are never inferred |
| Seven-day snapshot | Recorded sent/reply/opt-out/refusal/open/activation times, excluding internal tests |
| Activity | Existing events only, fixed labels, UTC day groups; no free-text provider details or invitation tokens |

Operational controls and work counts include internal tests explicitly because those records require operator handling. Business metrics exclude them. Prepare eligibility is bounded by the existing dry-run limit. Engagement attention examines the latest 500 invitation activity records and says so. Some ages are not recorded, and incomplete lane listings cannot establish an oldest age.

Each Overview source settles independently. A failed query displays unavailable and marks attention incomplete; it never substitutes zero. The top bar and Overview reuse one snapshot, including its unavailable state.

Worker records cannot establish Railway deployment status. Inbox has no heartbeat; Sender/Dispatcher show configuration, switch, queue and recorded activity only. No production monitoring API is called. Ratios below 20 observations say “Too few to compare”; historical status rates are omitted because records may skip stages.

## Local visual preview

From the repository root:

```powershell
cd backend
$env:AOS_PREVIEW_PORT = '8082'
node --import tsx src/scripts/previewCommandCenter.ts
```

Open `http://127.0.0.1:8082/admin` and sign in with `local-preview-only-operator-2026`.

The script accepts only localhost PostgreSQL and a dedicated `reclaimbay_aos_preview` database. It uses the local development database credentials to create that separate database and applies only existing migrations locally. It refuses production/Railway environments, configures no provider, keeps sending disabled, and blocks all POST actions except login/logout. Fictional fixture records are explicitly marked by a banner; they are separate from real application data and are never dispatched.

For an empty-state preview, use a separate dedicated database and `--empty`:

```powershell
$env:AOS_PREVIEW_DATABASE_URL = 'postgresql://LOCAL_CREDENTIALS@localhost:5432/reclaimbay_aos_preview_empty'
$env:AOS_PREVIEW_PORT = '8083'
node --import tsx src/scripts/previewCommandCenter.ts --empty
```

The script does not erase existing data. `--empty` skips fixture insertion; use a fresh database name for an empty workspace. Preview commands above are local only.

Review desktop 1280/1024 and mobile 768/480 widths, the sending strip, native navigation drawer, attention priority, empty/unavailable states, separate funnels, and exact safe workflow links. Other pages retain their existing actions for the next phase; the visual preview blocks their execution.

## Overview visual polish

The Overview now emphasizes exceptions and decisions: one unified System Status rail, work grouped in the existing priority order, and a “Start here” recommendation using the unchanged deterministic selection. Safety explanations remain visible. Secondary context, evidence timestamps, session comparisons, and the full acquisition picture remain available in native disclosures and through the existing detailed-page links.

The acquisition summary separates current pipeline inventory from historical business outreach. Product use remains a separate card. Activity retains the same events, UTC grouping, chronology, and ten-event window; key outcomes receive more emphasis while routine events use quieter inline rows. All polish styles are scoped to the Overview; the Health and Activity pages keep the shared components' original default presentation.

This polish does not change loaders, metric definitions, recommendation selection, routes, authentication, POST handlers, sending behavior, email composition, or any individual workspace page. No dependencies, schema, migrations, or production configuration changes are included.

## Workspace redesign and Acquisition resume

The subsequent full-workspace pass extended the shared shell, tables, forms, disclosures and empty states. It also changed the presentation of outreach, Funnel, Campaigns, Health and Activity, and placed the Overview guardrail and work queue before the detailed system rail. That pass was interrupted during final validation and preview refresh. Its broader work remains uncommitted and preserved; it is not discarded or treated as visual approval.

The resumed milestone is **Discovery + Prospects**. It uses the existing server-rendered architecture and the Overview design direction. No further Overview, outreach, insights or system redesign is included in this resume.

- Discovery puts the existing decision, approval, verification and research lanes first. Stale automatic-research warnings stay visible. Automation totals and secondary context use native disclosures. Candidate rows retain the authoritative next action and reason, qualification, opportunity ranking, evidence count and links, plus the recorded research state. Queued research is distinguished from running research; no run is shown as “Not researched yet.”
- Prospects presents a compact current inventory summary, existing status navigation, search, disclosed filters and a seven-column pipeline table. Business identity, location, lifecycle, qualification, collision evidence, outreach and opportunity score stay distinct. Contact metadata and update timestamps remain available under Record details. Current inventory includes internal test records and is independent of list filters; it does not represent historical reach or email eligibility.
- At small widths, records stack with field labels, filters remain usable, and status tabs scroll within their own container. All actions retain their form destinations and fields. No client scripts, fake loading states or new dependencies are introduced.

Only the Acquisition views, their scoped presentation styles and this documentation were changed during the resume. The earlier unrelated README, development seed and public-site component changes remain intact. No business service, route handler, email composer, configuration, schema or migration is changed by this milestone.

Visual review uses the dedicated fictional localhost preview described above. Operational POSTs remain blocked there, sending stays disabled and no email provider is configured. Product decisions and production actions require their existing workflows; visual approval does not enable them.

Resume validation: 659/659 unit tests and 618/618 integration tests passed, with no skips. Backend and frontend typechecks, frontend lint, production build and tracked/untracked whitespace checks passed. Browser review covered 1280, 1024, 768 and 480px, including Acquisition details/edit forms, expanded disclosures and empty searches; no page overflow, visible text below 12px or broken dossier anchors was found. The 97 POST forms captured across 27 fixture pages retained their destinations and control fields. Nothing was staged, committed, pushed or deployed; production was not accessed.

## Full workspace completion and approval

The later presentation pass completed the remaining approved workspaces: Sending, Prepare, Messages, Replies, Unsubscribe reviews, Funnel, Campaigns, Health and Activity. Together with Overview, Discovery and Prospects, the full Acquisition Command Center presentation is now complete and visually approved. The chronological notes above describe the state at each earlier checkpoint and remain part of the implementation record.

The completed presentation preserves the existing evidence-first acquisition workflow and every operational boundary. Collision/body evidence, qualification, drafting, queueing, sending, uncertain-send handling, suppression, unsubscribe review, inbox attribution and reporting definitions remain authoritative in their existing services. No schema, migration, dependency, production configuration or new client-side runtime was introduced.

Final validation passed 662/662 unit tests across 115 suites and 618/618 integration tests across 74 suites, with no skips. The 32 focused presentation tests, backend test and production typechecks, frontend typecheck, frontend lint and production build also passed. Visual review covered populated, empty, warning, expanded and long-content states at 1280, 1024, 768 and 480px. The approved dark ReclaimBay Command Center remained responsive; the Funnel table uses contained horizontal scrolling at 1024px. Tracked and untracked whitespace checks passed. Nothing was staged, committed, pushed or deployed, and production was not accessed.

The final audit found no launch blocker in the Command Center workflow or safety model. Scale work for the Discovery source cap, Prospect browsing, Funnel detail loading and historical Outreach/Campaign aggregation is intentionally deferred to a separate milestone.

## Automotive repair ICP

The acquisition target broadened from collision/body repair to automotive repair generally (policy in DISCOVERY.md and PROSPECTS.md). Discovery rows and the candidate page now lead with the operator's questions: **Business type** (from sourced repair evidence, or marked as a lead from the name or provider category), **Target fit** (Qualified, Needs verification, Not qualified) with one sentence of **Why**, then the next step and its action. Evidence count, research state and the opportunity score (ranking only) stay on the meta line. Target fit is derived on render from the existing category check, qualification and evidence (`src/discovery/targetFit.ts`); nothing new is stored. Prospects shows "Repair evidence" instead of "Collision evidence". Approval, queueing, sending, suppression, unsubscribe and Gmail behavior are unchanged; drafting and queueing remain operator actions.
