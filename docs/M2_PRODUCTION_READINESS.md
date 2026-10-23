# M2 production release readiness

Latest: [bounded production release plan](M2_RELEASE_PLAN.md). The owner confirmed
live Price `price_1UTXAvAibfYd2OeIPdjWbigl` and live Product
`prod_VUSTxrnO622OG7` directly in the live Dashboard. Merchant approval remains
unconfirmed after submission. These values were not copied into local billing
configuration.

Assessment: October 22, 2026, America/Los_Angeles.

**NO-GO for immediate live activation. The scoped engineering blockers are
resolved locally; owner live-account setup and an authorized rollout remain.**
Nothing was pushed, deployed, configured in production or charged in live mode.
M2 remains current until release acceptance; M3 still requires a real shop's
successful scanner use and verified payment. Pricing remains USD 49 once/report.

## Acceptance evidence

Retain the [original sandbox results](../review/m2-stripe-sandbox/RESULTS.md).
This pass covers only remaining gaps and regressions justified by the build fix.

| Requirement | Result |
| --- | --- |
| Hosted 3D Secure | PASS: Stripe test card ending 3155 opened the actual Stripe test-bank challenge. Completed COMPLETE; Stripe charge reports challenge/authenticated, 3DS 2.1.0. |
| Before authentication | PASS: device-signed fulfillment returned 403 paid_report_required. |
| Delayed webhook | PASS: froze the original scanner tab to prevent status reconciliation; loopback proxy held the genuine CLI-signed completion in memory. Stripe reported paid/complete while ledger remained open with zero entitlements. Released event to backend within signature tolerance: HTTP 200 and report unlocked. Proxy acknowledgement and backend delivery are distinct in the evidence. |
| Out-of-order | PASS: genuine refund delivered with HTTP 200, then older real completion event replayed with fresh local signature: HTTP 200, purchase/entitlement remained revoked. The replay was local, not Stripe-side redelivery. Existing PostgreSQL tests additionally exercise late distinct events/refund/dispute ordering. |
| Other device boundary | PASS in an independent Chrome profile with its own storage/key and a mobile viewport: no original recovery copy, same file stays preview, copied paid report reference returns 403. It opened its own $49 hosted Checkout and cancelled. This is a browser/device isolation test, not physical handset testing or cross-device recovery support. |
| Development recovery observation | Production impact not reproduced: three consecutive encrypted recovery cycles on static production output mounted the full report, with no alerts and HTTP 200 billing requests. Earlier development-server error remains unclassified; no customer-flow code change was warranted. |
| Backend private packaging | FIXED locally: root build creates private renderer, compiles backend, then fails the build if required asset is absent, invalid, secret-bearing or source-mapped. Dedicated Railway config starts backend rather than Next. |
| Production mode | PASS: compiled server exited before listening with dummy test credentials under both NODE_ENV=production and RAILWAY_ENVIRONMENT. Existing tests cover mismatched keys, non-HTTPS return origins, and wrong-mode Prices/events. |
| Artifact/data boundary | PASS: 250 compiled/static/private files scanned against actual configured secrets and synthetic report/password markers: no matches. Private GET paths returned 404 on frontend/backend; malformed fulfillment POST returned 400. Public artifact gate checked 72 files. |

Logs and JSON evidence: `review/m2-final-readiness/`,
`review/m2-stripe-sandbox/remaining-before-release.json`,
`remaining-runtime-evidence.json`, `device-evidence.json`.
Raw webhook bodies/signatures were held only in memory, never written to evidence.
3DS sandbox payment was refunded. Second profile's cancelled session remains unpaid.

Checks: **74 frontend tests, 1,234 backend unit tests, 26 PostgreSQL payment/privacy
integration tests**; root static/private build, backend release build, frontend and
backend typechecks, scoped lint and diff checks pass. The new release-gate test
proves missing assets, leaked secret patterns and source maps fail closed.
No dependency changes; the prior advisory triage remains in
[M2 release verification](M2_RELEASE_VERIFICATION.md#dependency-advisory-triage).

## Exact backend build contract

Source: [railway.backend.toml](../railway.backend.toml), applied only to the web
backend. Railway rejects config-as-code file selection as deprecated, so its exact
values are set as the web service's settings. It does not alter scheduled Acquisition OS services.

| Railway setting | Value for a separately authorized deployment |
| --- | --- |
| Root Directory | `/` (repository root; remove the current `backend` restriction) |
| Config File | None (values from `/railway.backend.toml` set as service settings) |
| Builder | RAILPACK |
| Build Command | `npm ci --include=dev && npm --prefix backend ci --include=dev && npm run build:backend-release` |
| Start Command | `npm --prefix backend start` |
| Pre-deploy | `npm --prefix backend run db:migrate` (preserves the verified migration-only production hook) |
| Healthcheck | `/health`, 120 seconds |
| Node version | Set `RAILPACK_NODE_VERSION=24`; local verification used Node 24.19.0. |
| Build-time public analytics origin | `NEXT_PUBLIC_ANALYTICS_API_URL=https://<backend-domain>` (inlined into private renderer) |

`build:backend-release` runs paid-renderer build, backend build and
`verify:backend-release`. Runtime must retain `backend/dist/`,
`backend/private/report.js`, backend dependencies/generated Prisma runtime,
`backend/prisma/`, `backend/prisma.config.ts` and package manifests/lockfile.
Keep Prisma CLI installed for migrations. Do not publish any of these as static files.
No out-directory build is required for the backend. Never use root `npm start`
for this service; that command belongs to Next, not the backend.

Railway's actual Linux builder/runtime was not invoked. First authorized rollout
must verify the build log/gate and runtime artifact; a passing local build is not
a claim of a completed Railway deployment. The config location and root behavior
follow [Railway's monorepo documentation](https://docs.railway.com/deployments/monorepo)
and [configuration reference](https://docs.railway.com/config-as-code/reference).

## Owner live configuration

Complete merchant/business onboarding and review support, receipts, refund policy
and applicable tax requirements. Confirm physical phone/browser usability if
hardware-specific acceptance is required; only independent mobile-sized Chrome
was available in this environment.

Use the existing owner-verified live Product `prod_VUSTxrnO622OG7` and Price
`price_1UTXAvAibfYd2OeIPdjWbigl`; do not create duplicates. Their evidence source
is the owner?s explicit live-Dashboard confirmation, not sandbox interchangeability.
Recheck active/live/one-time/USD 49.00 association before activation. No subscription,
adaptive conversion, coupon or pricing change is needed. Merchant submission is
complete but approval remains unconfirmed.

| Backend runtime variable | Required live value |
| --- | --- |
| NODE_ENV | `production` |
| DATABASE_URL | Existing production PostgreSQL secret reference; never the disposable local database |
| ADMIN_SECRET | Existing production admin secret; preserve |
| STRIPE_MODE | `live` |
| STRIPE_SECRET_KEY | Live `sk_live_...`, or verified restricted live key permitting Checkout creation and Price/Session/PaymentIntent/Charge reads |
| STRIPE_WEBHOOK_SECRET | Signing secret for the live HTTPS Dashboard endpoint below, not the CLI listener secret |
| STRIPE_REPORT_PRODUCT_ID | Selected live report Product ID |
| STRIPE_REPORT_PRICE_ID | Its active one-time USD 49.00 live Price ID |
| PUBLIC_SITE_URL | `https://reclaimbay.com` |
| ALLOWED_ORIGIN | `https://reclaimbay.com` (include `https://www.reclaimbay.com` only if actually serving the scanner there) |

Stripe live webhook URL: `https://<backend-domain>/api/billing/webhook`, API version
`2026-09-30.endive`. Subscribe to exactly:
`checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, `checkout.session.expired`,
`charge.refunded`, `charge.dispute.created`.
Set business/support information and receipts to the intended owner details,
including `hello@reclaimbay.com`. Hosted return URLs derive solely from PUBLIC_SITE_URL:
`/checkout-return?result=complete` and `?result=cancelled`; neither grants access.

Cloudflare Pages: build from repository root with both dependency sets available,
`npm run build`, publish **only `out/`**. Set build-time
`NEXT_PUBLIC_BILLING_API_URL=https://<backend-domain>` and
`NEXT_PUBLIC_ANALYTICS_API_URL=https://<backend-domain>` without trailing slashes.
Preserve the existing Pages Function/contact configuration. No Stripe private
value belongs in NEXT_PUBLIC variables, Git, build artifacts or chat.

## Authorized rollout and rollback

Owner actions, in order; none performed by this task:

1. Review/commit the bounded changes and authorize push/deployment separately.
   Keep review runtime files, env files and parked replenishment work out of release inputs.
2. Apply the web-backend root/config settings above. Deploy with Stripe variables
   unset first. Verify migrations, existing admin, `/health`, offer unavailable,
   private renderer present and no public private-file route. Preserve scheduled
   service settings and sending safeguards.
3. After explicit live-payment authorization, configure the live values and live
   webhook endpoint. Confirm offer amount 4900/usd/oneTime, HTTPS/CORS and runtime
   asset gate. Rebuild Pages with public HTTPS API origins; local out currently
   contains localhost origins and must not be deployed.
4. Under separately authorized live validation/M3 scope, verify actual hosted
   payment, signed delivery, access and receipt. Do not claim M3 from sandbox results.

Rollback: unset only STRIPE_REPORT_PRICE_ID to stop new sales while preserving
existing fulfillment/webhooks. Expire open sessions if in-flight sales must stop.
For compromised credentials, unset/rotate STRIPE_SECRET_KEY, accepting that all
paid re-access and webhook processing stop until restored. Keep fulfillment and
webhook secrets for orderly operation whenever possible. Revert Pages/code to the
last known working release when needed, preserving the backend private asset
contract and all additive purchase tables. Do not drop/truncate purchase,
entitlement, buyer or event ledgers; do not delete historical Stripe Products/Prices.
Do not roll back to a backend-root image missing the renderer while sales are enabled.
