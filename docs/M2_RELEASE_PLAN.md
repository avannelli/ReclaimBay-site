# M2 production release plan — October 22, 2026

**GO for release preparation; NO-GO for live activation until merchant status and
the rollout preconditions below are verified. No deployment is authorized.**
The fixed company charter/roadmap remain authoritative. Use the tested one-time
USD 49 report implementation. No new payment functionality is required.

## Verified inputs and local readiness

The owner explicitly verified these values in the **live Stripe Dashboard**:

| Input | Value | Evidence boundary |
| --- | --- | --- |
| Product | `prod_VUSTxrnO622OG7` | Owner confirms live-account source and Product Active |
| Price | `price_1UTXAvAibfYd2OeIPdjWbigl` | Owner confirms live account, USD 49.00, one-time |
| Merchant onboarding | Submitted | Owner has not verified approval; opening the live Dashboard does not establish approval |

Product provenance is the owner's explicit live-Dashboard confirmation, not an
inference from the sandbox ID. No live API request was made: only sandbox
credentials exist locally. Reconfirm Price active status, Product association,
livemode and amount through a read-only live lookup immediately before activation.
Do not create another Product/Price or alter this Price.

Current code base HEAD: `c94efda`. The tested packaging changes and documentation
are still uncommitted; review a bounded commit before requesting a release.
Include `package.json`, `railway.backend.toml`, `scripts/verifyBackendBuild.mjs`,
`test/backendBuild.test.ts` and the release documentation. Keep `.env*`, generated
assets, browser profiles, review runtime material and unrelated `review/` files
out of commits and release inputs. The parked replenishment stash remains present
and unapplied; no active replenishment source is included.

Fresh checks, without rebuilding completed functionality:

- Private backend artifact gate PASS: renderer 1,125,184 bytes, outside static output.
- Public artifact gate PASS: 72 files; actual configured private values and secrets
  absent from 250 compiled/public/private artifact files.
- Free scanner continuity PASS with billing deliberately unavailable: synthetic
  total $1,000/two opportunities remains available; purchase disabled and paid
  renderer absent.
- Existing evidence retained: 74 frontend, 1,234 backend unit, 26 PostgreSQL
  payment/privacy tests, builds/typechecks/lint, hosted sandbox/3DS, recovery,
  ordering, refund and production-mode guards. These suites were not repeated.
- `out/` currently embeds localhost API URLs: it is local evidence, not the
  production upload. Build fresh from the approved commit with HTTPS origins.

Fresh evidence: `review/m2-production-preparation/preflight.json` and
`free-continuity.json`. Full acceptance and runbook:
[M2 production readiness](M2_PRODUCTION_READINESS.md).

## Stage A — payment-disabled production deployment

Requires separate explicit approval to commit/push, change hosting settings,
deploy code and apply migrations. Before doing so, confirm the exact Railway
project/web-service/environment, Cloudflare Pages project/production branch and
existing backend HTTPS origin. These target identities were not established by
this local preparation; `api.reclaimbay.com` in older docs is an example, not a
verified target. Capture the current deployment/version IDs and rollback settings.
Check Git autodeploy behavior before pushing so that a push does not bypass this stage.

Railway web backend only:

- Repository root `/`; settings from `/railway.backend.toml` (applied as service
  settings, not a config-file selection); Railpack, Node 24 via
  `RAILPACK_NODE_VERSION=24`.
- Build: `npm ci --include=dev && npm --prefix backend ci --include=dev && npm run build:backend-release`.
  This builds the renderer, compiles backend and checks the private artifact.
- Start: `npm --prefix backend start`; `/health`, timeout 120 seconds.
  Keep `NODE_ENV=production`, existing DATABASE_URL/ADMIN_SECRET, proxy/domain
  settings and unrelated runtime/sending safeguards intact.
- Build-time `NEXT_PUBLIC_ANALYTICS_API_URL=https://<verified-backend-domain>`.
  Keep all billing Stripe settings unset for this first deployment.
- Verify the actual Linux build/runtime contains `backend/private/report.js`,
  compiled backend, backend dependencies/generated Prisma runtime and migration
  files. Local success does not establish successful Railway packaging.

Migration requirements:

1. Capture the production database backup/restore reference and run read-only
   migration status as part of the authorized rollout preflight. Production
   migration status was not queried in this task.
2. Expected scanner migration is `20261020120000_report_purchases`, adding
   ReportBuyer, BuyerChallenge, ReportPurchase, ReportEntitlement and StripePaymentEvent
   plus constraints/indexes. It contains no report rows or destructive SQL.
3. `npm --prefix backend run db:migrate` uses `prisma migrate deploy`, which applies
   **all** pending migrations, not just that one. Stop for review if unexpected
   pending migrations or failed migrations exist. Do not reset or run migrate dev.
4. The rollout preflight verified that the production web pre-deploy hook is
   migration-only (`npm run db:migrate`). The prepared Railway config preserves
   that behavior as `npm --prefix backend run db:migrate`; it does not introduce
   `prospects:rescore`, the acquisition score maintenance command.

Cloudflare Pages:

- Use the verified production Pages project and repository root. Ensure both
  root/backend dependencies are installed; build `npm run build`, output **only `out/`**.
- Set build-time `NEXT_PUBLIC_BILLING_API_URL` and
  `NEXT_PUBLIC_ANALYTICS_API_URL` to `https://<verified-backend-domain>`, without
  trailing slash. Preserve existing Pages Functions/contact variables and routing.
- Never set Stripe secret values in public variables or publish `backend/`,
  `private/`, `.next/`, `review/` or the repository root. The private paid bundle
  must ship only in the backend runtime.
- While backend payments are disabled, confirm landing page, sample, CSV/XLSX
  analysis and free preview still work; offer returns `{available:false}`.
  Verify `/health`, existing admin, correct CORS and private URL GETs returning 404.

## Stage B — separately authorized live activation

This stage is **not** included in Stage A. First obtain owner/Stripe confirmation
that `charges_enabled=true` and card payments are active. Inspect outstanding/
past-due/pending-verification requirements and disabled reasons; `details_submitted`
alone is insufficient. Record `payouts_enabled` and any outstanding payout/bank
requirements as a separate commercial-readiness check. Resolve blockers with Stripe;
do not infer approval from onboarding submission. Configure receipts, support and
statement details and complete the owner's refund/tax policy review.

After explicit activation approval, use secure hosting secret entry for:

| Backend variable | Required value |
| --- | --- |
| STRIPE_MODE | `live` |
| STRIPE_SECRET_KEY | Verified live secret/restricted key permitting required Checkout creation and Price/Session/PaymentIntent/Charge reads; never pasted in chat |
| STRIPE_WEBHOOK_SECRET | The live Dashboard endpoint's signing secret, not CLI/sandbox secret |
| STRIPE_REPORT_PRODUCT_ID | `prod_VUSTxrnO622OG7` (owner-verified live Product) |
| STRIPE_REPORT_PRICE_ID | `price_1UTXAvAibfYd2OeIPdjWbigl` (recheck active, one-time, USD 4900, live Product association) |
| PUBLIC_SITE_URL | `https://reclaimbay.com` |
| ALLOWED_ORIGIN | `https://reclaimbay.com`; add www only if actually serving the scanner |

Live webhook: `https://<verified-backend-domain>/api/billing/webhook`, SDK API version
`2026-09-30.endive`, six events: `checkout.session.completed`,
`checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
`checkout.session.expired`, `charge.refunded`, `charge.dispute.created`.
Create/configure it only after separate production-configuration authorization;
do not point it at localhost. The webhook endpoint and keys must belong to the
same verified live account as the Price. No publishable key/Stripe.js configuration
is used by this implementation.

Read-only acceptance before any charge: offer 4900/usd/oneTime, HTTPS/CORS/return
URLs, correct secret-free static origins, health, disabled test-mode startup,
private file isolation and webhook reachability. A real payment/charge needs its
own explicit amount/count/refund authorization; it is not implied by deployment
or activation approval. A sandbox result does not satisfy M3.

## Rollback and exact authorization

Capture known-good backend and Pages release IDs before rollout. Stop new sales
by unsetting **only STRIPE_REPORT_PRICE_ID**, preserving existing status,
fulfillment and refund/webhook processing. Expire open live sessions only if
explicitly included in rollback authorization. Unsetting the API key also disables
existing buyer re-access and webhook handling; reserve for a credential incident.
Revert code/Pages versions as required, but retain purchase tables and records.
Never drop/truncate ledgers or delete historical Stripe Products/Prices. Do not
enable sales on a reverted backend that lacks the private renderer.

Suggested bounded Stage A authorization (after targets are confirmed):

> Authorize the reviewed M2 commit and push, the documented Railway web-backend
> root/build/start/health settings and Cloudflare Pages build/origin settings,
> production migration preflight and expected additive purchase migration, and
> payment-disabled deployment to the confirmed targets. Preserve the existing
> migration-only hook. Permit
> health/free-preview/private-artifact checks and code/Pages rollback if they fail.
> Keep Stripe payment settings unset. No live activation or charges are authorized.

Stage B later needs explicit permission to create/configure the live webhook and
install the verified live Stripe variables, enabling live Checkout. Any real
transaction remains a separate authorization.

Sources: [Stripe Price retrieval](https://docs.stripe.com/api/prices/retrieve),
[Stripe account status](https://docs.stripe.com/api/accounts/object),
[Railway configuration](https://docs.railway.com/config-as-code/reference),
[Cloudflare build settings](https://developers.cloudflare.com/pages/configuration/build-configuration/).
