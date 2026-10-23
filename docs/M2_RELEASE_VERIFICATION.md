# M2 purchase release verification

Current assessment: [M2 production readiness](M2_PRODUCTION_READINESS.md).
The remaining hosted/ordering/device checks and local backend packaging fix are
recorded there. Historical setup/packaging blockers below are superseded; owner
live configuration and an authorized rollout remain.

October 22 update: [real hosted sandbox results](../review/m2-stripe-sandbox/RESULTS.md)
verify the core purchase flow. The October 18 missing-account blocker below is
historical. Remaining hosted checks and backend release packaging keep M2 open;
no public paid release is authorized.

Assessment date: **October 18, 2026 (America/Los_Angeles)**.

**NO-GO for a public paid release. Local application/artifact verification passes;
real Stripe-hosted test-mode verification is blocked by missing local setup.**
The offering remains a free preview and a configurable $49 USD one-time complete
report. No pricing, roadmap, acquisition, scanner calculation or production changes
were made by this verification task.

## Release preparation without Stripe credentials, October 22

Reviewed the uncommitted purchase implementation against production configuration,
fallbacks, disabled-state and rollback behavior. Two release-blocking defects were
confirmed and fixed. Nothing else changed in pricing, the scanner or acquisition:

1. **Test mode could run in production.** `STRIPE_MODE` defaults to `test`, so
   a deployed backend given test keys would have let Stripe test cards unlock real
   reports. It also accepted a non-HTTPS `PUBLIC_SITE_URL`, which sets the Checkout
   return URLs. Production (`NODE_ENV=production` or Railway) now refuses to start
   with Stripe keys unless `STRIPE_MODE=live` and the site URL is HTTPS. Local test
   mode is unchanged. Covered by `backend/test/unit/billing.stripe.test.ts`.
2. **No clean way to stop new sales.** Removing the secret key also cut off paid
   re-access and refund/dispute webhooks for existing buyers, and removing the Price
   ID made the offer fail with 503. With no Price configured, the offer now returns
   `{"available":false}`, while status, fulfillment and webhooks keep working. Covered
   by the price-rotation integration test.

Production variables, the webhook endpoint, return URLs, release order and rollback
are now documented in [SCANNER_PURCHASES.md](SCANNER_PURCHASES.md#production-configuration-for-a-separately-authorized-live-release).
One live-release blocker remains for authorized deployment work: Railway's `backend`-root
build does not produce the private renderer, so a live offer would fail closed (503)
until the release pipeline ships it.

Rerun after these changes: frontend 73/73, backend unit 1,234/1,234, selected
PostgreSQL integration 41/41 (on a temporary local cluster, since removed), backend
typecheck/build and root typecheck passed. No push, deployment, production change,
real payment or Acquisition OS change. Stash `b8fa3f1` remains unapplied.

## Fresh-session verification, October 18

Re-read the agent instructions, charter, fixed roadmap, readiness assessment and
purchase guide, and inspected the existing implementation before verification.
The purchase implementation was already present as uncommitted work. It was
preserved; this session made no application, calculation, pricing, dependency or
production configuration changes. No release-blocking implementation defect was
found. Documentation and local verification evidence were refreshed.

All checks below were rerun successfully on the existing working tree:

| Check | Fresh result |
| --- | --- |
| Frontend tests | 73 passed, no failures/skips |
| Backend unit tests | 1,229 passed, no failures/skips |
| PostgreSQL payment/admin/logging integration | 41 passed, including 20 payment tests, no failures/skips |
| Root static/private build and public artifact gate | PASS; 72 public-source/export files checked |
| Backend build and source/test typecheck | PASS |
| Standalone frontend typecheck | PASS |
| Application lint, excluding operational `review/` | PASS; separate explicit application-source lint also passed |
| Chrome fixture purchase/recovery/export/privacy/mobile simulation | PASS; 196 captured requests, zero runtime errors, one purchase/session/entitlement |
| Compiled-backend private-file/missing-file probe | PASS; public GETs 404, invalid POST 400, missing renderer offer 503, zero Checkout creations |
| Actual configured secret values in browser artifacts | PASS; 67 export/private-JS artifacts scanned against two configured private values; no matches or synthetic runtime report data |
| Fresh npm advisory requests | 7 root / 4 backend package alerts; same advisory set as triage below |
| Stripe-hosted test Checkout | NOT VERIFIED; account/configuration unavailable |

The dependency graph was regenerated: none of `braces`, `source-map-js`,
`deepmerge-ts` or `mysql2` appears in the private renderer's 237 build inputs.
The advisory disposition below still applies to this static frontend / Fastify /
PostgreSQL release architecture. No upgrades, overrides or suppressions were made.

New logs, audit reports, the secret-boundary check and isolated local test harness
are in `review/m2-resume-verification/`. The existing packaging/environment/graph
probes refreshed their JSON in `review/m2-release-verification/`; Chrome refreshed
synthetic artifacts in `review/m2-purchase-verification/`.
The installed PostgreSQL service was stopped and could not be started with this
process's Windows privileges. Verification instead created a fresh temporary
cluster on **127.0.0.1:54983**, ran the existing isolated database runners, stopped
it, and removed its data directory. The installed service remains stopped and its
data was untouched. Initial sandbox failures were environment restrictions, not
application failures; successful reruns are the results above.

The checked environment contains no Stripe settings, CLI executable or CLI
authentication configuration. The owner confirms no Stripe account or banking
setup exists. No account state or hosted payment was inferred from fixtures.
Stash `b8fa3f11c29799dc91c700c96c64fd735a52c169` remains preserved and unapplied.

### Responsibility and stop boundary

- **Codex completed independently:** local code/security and package review,
  dependency reachability triage, tests, builds, lint/typechecks, synthetic browser
  flow, recovery/privacy checks, and exact test setup instructions.
- **Owner next:** create the Stripe account, select its test sandbox, create an
  active one-time USD **49.00** Price for the report Product, authenticate the CLI,
  and enter test credentials only in gitignored local configuration using
  [the exact setup](SCANNER_PURCHASES.md#exact-local-stripe-test-mode-setup).
  Do not send keys, webhook secrets or banking information in chat.
- **Codex after that setup:** run and record actual hosted Checkout, card failure /
  authentication / cancellation, signed real test webhooks, replay/refund,
  entitlement, export and recovery checks. Fixture success is insufficient.
- **Before a live release:** owner merchant/banking activation and applicable
  business requirements, separately authorized live configuration/deployment,
  and verification of the actual public/backend package boundary remain. The
  current `out/` uses fixture loopback URLs and must not be deployed.

**Decision: GO to owner test-account setup; NO-GO to deploying the paid scanner.**
M2 remains open until hosted test evidence and the authorized release checks are
complete. There was no push, deployment, production change, outreach or real charge.

## Verified release boundaries

- The root build now ends with `npm run verify:public-build`. It fails if the
  Next export did not succeed into `out/`, if the private report artifact is
  missing/empty, or if public source/export trees contain private paths, browser
  storage/profile artifacts, disallowed report/archive/source-map file types,
  symlinks, a copy of the private bundle, paid renderer labels, recognized secret
  values or serialized private-key/recovery material. Diagnostics never print
  matched content. Five regression cases deliberately introduce these leaks.
- **72 files** were checked across `public/` and `out/`. The paid renderer remains
  exclusively in `backend/private/report.js`. No repair files, recovery copies,
  browser profiles, private asset or secrets were found in public output.
- The compiled backend was checked using its real private-file path. Public GETs
  for `/private/report.js`, `/backend/private/report.js` and
  `/api/billing/fulfillment` return 404; an unauthenticated malformed fulfillment
  POST is rejected. Temporarily removing the local artifact makes the offer fail
  with 503 `fulfillment_unavailable`, before any Checkout creation. The artifact
  was restored and its SHA-256 matched. Payment integration tests separately
  verify valid proofs without a paid entitlement cannot fulfill.
- Recovery is runtime browser IndexedDB data, never a build input or backend
  record. Browser verification opted into encryption **before** Checkout, opened
  an unpaid session, reloaded the original scanner tab, restored the correct
  report with the password, and resumed the same Checkout session. It stayed
  unpaid until signed fixture payment evidence arrived. Later paid refresh,
  wrong-password rejection, copy deletion and original-file recovery also passed.
- Captured browser requests contained no repair rows, report contents, filenames,
  totals or recovery password. The recovery store contained ciphertext; no report
  data was silently persisted. These checks use synthetic data and a local Stripe
  simulation, not Stripe's actual hosted page.

The gate protects the documented build/publish contract, not arbitrary manual
uploads or deliberately disguised data. A future authorized deployment must
publish **only `out/`** as static assets, separately compile the existing Pages
Function, and include the private artifact in the backend runtime outside every
static root. Do not publish the repository, `.next/`, `review/` or browser profiles.
Hosting settings were not inspected or changed remotely. The current `out/` is
a **local verification build with loopback API URLs**, not a publishable live build.
The authorized release pipeline must rebuild with the public HTTPS API origins.

## Dependency advisory triage

Fresh `npm audit` reports **7 root and 4 backend package alerts**. These include
transitive package alerts for the same underlying advisories. None was
demonstrated reachable by the verified static frontend / Fastify / PostgreSQL
purchase deployment. **No dependency versions, overrides or advisory suppressions
were changed.** This conclusion is scoped to the architecture below, not a
general claim that the installed versions are patched or safe in every usage.

| Advisory / package | Evidence and release disposition |
| --- | --- |
| Next cache/Draft Mode leakage, [GHSA-3w37-wq28-93x7](https://github.com/vercel/next.js/security/advisories/GHSA-3w37-wq28-93x7) | No `use cache` or Draft Mode in the application. The release is a completed anonymous static export; customer reports are not server-rendered or cached. No demonstrated path; no upgrade in this scope. |
| Next SSG/ISR cache poisoning, [GHSA-4jqv-mc3x-m676](https://github.com/vercel/next.js/security/advisories/GHSA-4jqv-mc3x-m676), [GHSA-mcj8-r9mp-w47p](https://github.com/vercel/next.js/security/advisories/GHSA-mcj8-r9mp-w47p) | No hosted Next request-time renderer/ISR/cache, and no Pages Router. The site serves `out/`; the backend runs Fastify. Reassess if moving to a Next server. |
| Next metadata image routing, [GHSA-f87g-xv8r-7p7x](https://github.com/vercel/next.js/security/advisories/GHSA-f87g-xv8r-7p7x) | Static local icons; no dynamic metadata-image parameter routes or hosted Next router. No demonstrated path in this export. |
| Next image optimization SSRF, [GHSA-cjq9-62q9-8jv4](https://github.com/vercel/next.js/security/advisories/GHSA-cjq9-62q9-8jv4) | Brand images are local SVGs. No remote image allowlist or hosted image optimizer; the maintainer identifies no `remotePatterns` as unaffected. |
| Next dev MCP disclosure, [GHSA-39w2-rjm5-chcv](https://github.com/vercel/next.js/security/advisories/GHSA-39w2-rjm5-chcv) | Development-only exposure remains relevant to maintenance. This release verification used a static loopback server, not `next dev`; production does not serve the dev MCP endpoint. Do not infer that localhost alone fixes the development advisory. |
| `braces` via ESLint/glob tooling, [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | Needs attacker-controlled nested glob patterns. Repository lint patterns are trusted; repair files never enter Node lint/glob processing. Not a demonstrated release path. The audit suggestion to downgrade ESLint's Next config is not an appropriate targeted fix. |
| `source-map-js` via PostCSS, [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) | Needs processing of hostile indexed source maps. Build styles/maps are trusted; the server does not accept CSS/maps. No affected package in the private browser bundle's 237-input dependency graph. Public source maps are rejected by the artifact gate. |
| `deepmerge-ts` via `@prisma/config`, [GHSA-ggr8-5vv4-36mx](https://github.com/RebeccaStevens/deepmerge-ts/security/advisories/GHSA-ggr8-5vv4-36mx) | Needs recursive object graphs; plain JSON alone cannot produce them. Prisma config is trusted repository code containing simple paths and a datasource string, not customer/webhook input. No generated-client or application use of that merge API. |
| `mysql2` via Prisma CLI, [GHSA-3f6p-5ww8-9rcr](https://github.com/advisories/GHSA-3f6p-5ww8-9rcr), [GHSA-rgwj-5xj2-c3m3](https://github.com/advisories/GHSA-rgwj-5xj2-c3m3) | MySQL authentication/compression code is not used: the datasource is `postgresql` and `createDb` exclusively constructs `PrismaPg`. No MySQL connections or driver use in the application. |

Audit JSON and dependency-graph evidence are in `review/m2-release-verification/`.
Do not suppress these alerts globally. Reassess on dependency, hosting, driver or
untrusted build-input changes; routine security maintenance remains separate work.

## Final local checks

| Check | Result |
| --- | --- |
| Root scanner, purchase/recovery and public-package tests | **73 passed**, no failures/skips |
| Backend unit suite | **1,229 passed**, no failures/skips |
| Selected PostgreSQL integration suites | **41 passed**, including 20 purchase tests; no failures/skips |
| Root build including public artifact gate | **PASS**; all application routes static |
| Backend build and full test/source typecheck | **PASS** |
| Root `tsc --noEmit` | **PASS** |
| `npm run lint -- --ignore-pattern 'review/**'` | **PASS**, no warnings/errors; operational review artifacts are not release inputs |
| Chrome purchase/recovery/export/privacy/mobile flow | **PASS**, zero runtime errors; one fixture session/purchase/entitlement |
| Compiled-backend private-file/missing-file probe | **PASS** |
| Real Stripe-hosted Checkout/webhook path | **NOT RUN — required local configuration absent** |

Evidence: `review/m2-release-verification/{frontend-tests,frontend-build,backend-checks,integration-tests,lint,browser}.log`,
`environment.json`, `packaging-probe.json`, `dependency-graph.json` and
`browser-summary.json`. Browser screenshots/captured synthetic requests are in
`review/m2-purchase-verification/`. Each database test run created and removed
its own guarded local database; production customer data was not accessed.

## Exact blockers and owner actions

1. **Configure the local Stripe test integration.** No nonempty Stripe variables
   were found in repository environment files or process environment; no Stripe
   CLI executable/auth config was found in the checked Windows config locations.
   The account's existing Product/Price configuration cannot be determined without
   access. In the intended Stripe test account/sandbox, select or create an active
   one-time **USD 49.00** Price under the report Product; enable card payments.
2. Install/authenticate the official Stripe CLI in test mode and start the six-event
   listener from [the purchase setup guide](SCANNER_PURCHASES.md#exact-local-stripe-test-mode-setup).
   Set **only local** `backend/.env`: `STRIPE_MODE=test`, `STRIPE_SECRET_KEY`,
   `STRIPE_REPORT_PRODUCT_ID`, `STRIPE_REPORT_PRICE_ID`, and the listener's
   `STRIPE_WEBHOOK_SECRET`. Set matching localhost `PUBLIC_SITE_URL`,
   `ALLOWED_ORIGIN` and public frontend API origins as documented. Never put
   secret values in chat, source control or `NEXT_PUBLIC_*`.
3. **Complete and record real hosted test-mode evidence.** Use a synthetic repair
   file, the real Checkout tab and Stripe's current test-card cases. Verify
   successful card payment, forwarded signed webhook, exactly one fulfillment,
   cancellation, card failure/authentication, duplicate actual event handling,
   interrupted-tab encrypted recovery, paid export totals and request privacy.
   The local signed fixture tests above do not substitute for this evidence.
4. Before any separately authorized live release, review the two-artifact packaging,
   public HTTPS build origins, purchase migrations, runtime secrets/webhook, Stripe
   receipts/support information and applicable merchant requirements. Device-bound
   access/lost-site-data limitations must remain disclosed. No hosting, production
   settings, deployment, real charge or outreach is authorized by this assessment.

The shortest next action is **local Stripe test Product/Price/key/listener setup**,
then resume the actual hosted test checklist. M2 remains current; this assessment
does not alter the fixed roadmap or claim a paying customer.
