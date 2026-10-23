# M2 scanner purchases

Latest assessment: [M2 release verification](M2_RELEASE_VERIFICATION.md) — local
checks pass; public paid release remains **NO-GO** until real Stripe-hosted
test-mode verification is completed with the missing local account configuration.

The approved offering is a meaningful free preview and **one $49 USD purchase
per complete report**, including the existing PDF/CSV downloads and summary copy.
Subscriptions are outside this implementation. The amount is not a client-side
price authority: Stripe's configured one-time USD Price supplies the displayed
amount, Checkout line item and immutable purchase snapshot.
Checkout is card-only, with adaptive currency conversion disabled so the paid
amount must match that USD snapshot exactly.

## Customer flow

1. Open CSV/XLSX and confirm any mapping, using the existing scanner pipeline.
   Preview total reported declined value, opportunity count and highest-value job.
   These are potential work represented in the export, not recovered revenue.
2. Optionally choose an encrypted recovery copy and a password of at least 12
   characters. It is stored only after this explicit action, using AES-256-GCM
   with fresh salt/IV and PBKDF2-SHA256 (250,000 iterations). The password is not
   saved or transmitted. Otherwise keep the original file: refresh/close clears
   in-memory analysis, with a browser warning before leaving an unsaved report.
3. Review the current one-time price and open Stripe Checkout in another tab.
   The analysis remains in the scanner tab through cancellation or payment failure.
   Reopening an unexpired Checkout uses the same purchase and Stripe session.
4. Signed server reconciliation verifies payment; a return URL or success flag
   grants nothing. The scanner checks on focus, return-tab notification and a
   bounded pending-payment poll. The paid report and exports then load locally.
5. After refresh, choose the previous report reference, restore with the recovery
   password or reopen its original file. The same device's paid access remains.
   Earlier opaque references are retained when another report is analyzed.

Purchases are bound to this browser's nonextractable device key. There is no
customer account, cross-device login or automatic lost-key recovery in M2.
Explain this before Checkout. Clearing site data removes the key; retain the
Stripe receipt and contact `hello@reclaimbay.com` for support. **A receipt or
session ID alone must never authorize reassignment**: any future recovery process
must independently verify the payer, revoke the old credential and audit the
transfer. Do not manually grant access merely because someone presents a receipt.

## Trust and privacy boundary

- The static public application contains the preview and existing local analysis
  pipeline. Full report rendering/export code is built separately as
  `backend/private/report.js`, outside `out/`, with no public source map. A
  proof-authenticated, non-cacheable POST serves it only for a paid entitlement.
  There is no client boolean or query parameter that bypasses that endpoint.
- Browser-only processing necessarily leaves source data and calculations in
  the customer's control. Authenticated asset delivery is an access boundary,
  not DRM: delivered code and downloaded reports can be copied by their recipient.
  Opaque report IDs are not server-side attestations of dataset identity. The
  server never receives even a repair-file hash; resuming the same file is a
  customer action. This does not provide a server-side dataset licensing system.
- The server receives only a public device key, opaque IDs, one-use signed
  challenges, Stripe evidence and the report purchase price. It never receives
  repair rows, customer repair contacts, filenames, totals, mappings, report
  contents, encrypted recovery copies or recovery passwords. Stripe receives
  one server-generated purchase UUID and a configured Price; payment/contact
  information is collected directly by hosted Checkout.
- ECDSA P-256 proofs bind route, challenge and payload. The challenge expires
  after two minutes and is atomically consumed. Another browser, report ID,
  copied session ID or replay cannot obtain an entitlement. Device registration
  cannot replace an existing key. Exact-origin CORS, strict request schemas and
  rate limits apply; request bodies and Stripe errors are excluded from logs.
- Stripe raw-body signatures and five-minute timestamp tolerance protect
  webhooks. Reconciliation retrieves the session and expanded line item/payment
  intent/latest charge from Stripe. It verifies purchase identity, mode, product,
  snapshotted Price, quantity, currency, amount and succeeded payment evidence.
  Duplicate events and concurrent fulfillment use transactions/unique records.
  Refunds, partial refunds and disputes revoke future fulfillment; older completion
  events cannot undo revocation. Already downloaded files cannot be recalled.
- Creation retries use a persisted purchase UUID as Stripe's idempotency key.
  Ambiguous creation older than 23 hours stops for review; it is never recreated
  after Stripe might forget the key. A new attempt requires confirmed expiry.

The implementation follows Stripe's [fulfillment guidance](https://docs.stripe.com/checkout/fulfillment),
[webhook verification](https://docs.stripe.com/webhooks/signature) and
[Price management](https://docs.stripe.com/products-prices/manage-prices).

## Exact local Stripe test-mode setup

The owner has created the Stripe sandbox and its existing **$49 USD one-time
Revenue Opportunity Report**. Use Product `prod_VUSTxrnO622OG7` and Price
`price_1UTTYWAihvfhVDvfqIlLOgOE`; do not create replacements or duplicates.
The owner entered the sandbox key securely and the local CLI listener is configured.
See the hosted verification record above. Banking/merchant
activation for a future live release is separate from these local test steps.
This implementation does not use a Stripe publishable key or Stripe.js: the
backend creates hosted Checkout and the browser opens its returned URL.

The October 22 continuation installed Stripe CLI 1.55.1 in a Git-ignored local
tools directory, configured these IDs and localhost origins, and prepared an
isolated PostgreSQL database. See the [local setup record](../review/m2-stripe-sandbox/README.md).
The secret key and authenticated listener are now configured locally. Automated
fixtures are not real Stripe test-mode evidence. Complete these steps before
calling hosted Checkout verified:

1. Use the **existing sandbox Product and Price above**. Verify through Stripe
   that the Price is active, one-time, USD 49.00 and belongs to that Product.
   Do not create another Product/Price, a subscription, live Price or real charge.
2. Follow the [official Stripe CLI installation](https://docs.stripe.com/stripe-cli),
   run `stripe login` for the intended test account/sandbox, and use test mode
   throughout (never `--live`). Start:

   ```text
   stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired,charge.refunded,charge.dispute.created --forward-to http://localhost:8080/api/billing/webhook
   ```

3. Fill the following **local-only** variables in gitignored `backend/.env`:

   ```dotenv
   STRIPE_MODE=test
   STRIPE_SECRET_KEY=<test secret key from Stripe>
   STRIPE_WEBHOOK_SECRET=<whsec from this CLI listener>
   STRIPE_REPORT_PRICE_ID=<one-time test Price ID>
   STRIPE_REPORT_PRODUCT_ID=<test Product ID>
   PUBLIC_SITE_URL=http://localhost:3000
   ALLOWED_ORIGIN=http://localhost:3000
   ```

   Use a disposable local PostgreSQL database for `DATABASE_URL`; do not point at
   production. The CLI listener secret differs from a Dashboard webhook secret.
   Never put keys or webhook secrets in `NEXT_PUBLIC_*` or chat/log output.
4. Set `.env.local` public origins:

   ```dotenv
   NEXT_PUBLIC_BILLING_API_URL=http://localhost:8080
   NEXT_PUBLIC_ANALYTICS_API_URL=http://localhost:8080
   ```

5. Install dependencies at both repo root and `backend/` with `npm ci`.
   Run `npm run build:paid-report` at root. Apply migrations only to the chosen
   disposable/local database (`npm run db:migrate` in `backend/`, with that local
   `DATABASE_URL` provided). Run `npm run dev:admin` and `npm run dev` in separate
   terminals. The local backend startup checks reject production targets.
   On Windows PowerShell with script execution disabled, use `npm.cmd` in place
   of `npm`; no execution-policy change is needed. PostgreSQL must be running
   locally before applying migrations or starting the backend.
6. Open a synthetic report and verify preview restrictions. Purchase using
   Stripe test card `4242 4242 4242 4242`, a future expiry and test CVC. Verify
   Checkout, signed forwarded webhook, one paid purchase/entitlement, local
   report and PDF/CSV/summary totals. Check Stripe test Dashboard evidence.
7. Repeat with cancellation, a declined test card, authentication-required card,
   popup blocking, refresh with/without explicit recovery, lost return tab,
   webhook replay/delay and a test refund. Never use a real card. Confirm the
   paid renderer stays inaccessible to another browser/device and another report.
   Use [Stripe's test cases](https://docs.stripe.com/testing) for current cards.

   Record the sandbox, SDK API version, test Price amount/currency, synthetic
   report totals, Checkout/payment/event IDs, webhook HTTP results and final
   purchase/entitlement counts. Exclude keys, passwords, payer details, raw
   webhook bodies and repair contents from the verification record. For the CLI,
   [Stripe documents](https://docs.stripe.com/cli/listen) sandbox mode as the
   default and the listener's own signing secret for forwarded events. A
   Dashboard webhook endpoint is not needed for this local listener.

Do not run `stripe trigger` alone as proof of a purchase: unrelated fixture events
do not match the durable purchase created through this scanner's Checkout flow.

## Price replacement and release packaging

Create a new one-time USD Price under the same report Product, then change only
the server's `STRIPE_REPORT_PRICE_ID` during a separately authorized configuration
change. The UI fetches the current offer. Each existing attempt keeps its own
Price/product/amount/mode, and historical entitlements do not depend on an active
current offer. Changing the price does not rewrite or erase purchases. Do not
delete historical ledgers or manually modify old snapshots.

`npm run build` at repo root builds both the private paid artifact and Next's
static `out/`, then runs the fail-closed `verify:public-build` artifact gate.
It rejects private/report/recovery paths, inappropriate file types, symlinks,
paid renderer code, recognizable secrets and serialized recovery/key material
in public output. The backend TypeScript build alone does **not** contain the paid
artifact: a future authorized backend release must include `backend/private/report.js`
from the root build in its runtime image. Build from the repository root with
both dependency sets installed. Keep the asset private; never put it in a static
directory, CDN/public bucket or `out/`. Missing fulfillment asset fails closed
before Checkout creation. CORS must allow exactly the public origin, production
origins must use HTTPS, and any future CSP must permit the authenticated Blob
script loader (no `eval`). Review the separate backend/static-site packaging
before any deployment. No deployment configuration was changed or activated here.

For a future Stripe webhook endpoint, use the SDK API version
`2026-09-30.endive` (Stripe Node 23.0.0), the six events above, HTTPS and that
endpoint's own signing secret. Configure Stripe customer receipts/support
information and review applicable tax/refund requirements before a live sale.

## Production configuration (for a separately authorized live release)

Nothing here is configured or authorized yet. These are the exact values a live
release needs; placeholders in angle brackets come from the owner's accounts.

**Railway backend variables**, in addition to the existing `DATABASE_URL`,
`ADMIN_SECRET` and `NODE_ENV=production`:

| Variable | Production value |
| --- | --- |
| `STRIPE_MODE` | `live`. Required: a deployed backend (`NODE_ENV=production` or Railway) refuses to start with Stripe keys in test mode, because test cards would unlock real reports |
| `STRIPE_SECRET_KEY` | `sk_live_…`, or a restricted `rk_live_…` key that can create Checkout Sessions and read Prices, PaymentIntents and Charges (confirm the restricted key in test mode first). A Railway secret only |
| `STRIPE_WEBHOOK_SECRET` | The `whsec_…` of the Dashboard webhook endpoint below, not a CLI listener secret |
| `STRIPE_REPORT_PRICE_ID` | The live, active, one-time **USD 49.00** `price_…` |
| `STRIPE_REPORT_PRODUCT_ID` | That Price's `prod_…` report Product |
| `PUBLIC_SITE_URL` | `https://reclaimbay.com`. Must be HTTPS in production; the backend refuses to start otherwise |
| `ALLOWED_ORIGIN` | `https://reclaimbay.com` (add `,https://www.reclaimbay.com` if that host serves the site) |

A key whose prefix disagrees with `STRIPE_MODE`, test mode in production or a
non-HTTPS `PUBLIC_SITE_URL` stops the web service at startup. Railway's `/health`
healthcheck then keeps the previous deployment serving; scheduled jobs never load
the payment gateway. With `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET` unset,
purchasing is off (`/api/billing/offer` returns `{"available":false}`) and nothing
else changes.

**Return URLs.** The backend builds both Checkout return URLs from
`PUBLIC_SITE_URL` alone: `https://reclaimbay.com/checkout-return?result=complete`
and `…?result=cancelled`. The browser cannot supply or change them, and a return
grants nothing: only signed, reconciled Stripe evidence does. Stripe needs no
separate return-URL allowlist.

**Stripe Dashboard (live mode, future authorized setup).** Use the owner-verified
existing live Product `prod_VUSTxrnO622OG7` and Price
`price_1UTXAvAibfYd2OeIPdjWbigl`; recheck active/one-time/USD 49.00/live association
and merchant card-payment approval. Do not create duplicates. Add one webhook endpoint at
`https://<backend-domain>/api/billing/webhook`, API version `2026-09-30.endive`,
with exactly these events: `checkout.session.completed`,
`checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
`checkout.session.expired`, `charge.refunded` and `charge.dispute.created`. Set the
business name, receipts and support email (`hello@reclaimbay.com`).

**Cloudflare Pages (Production variables, inlined at build time).** Set
`NEXT_PUBLIC_BILLING_API_URL=https://<backend-domain>`, with no trailing slash, next to
the existing `NEXT_PUBLIC_ANALYTICS_API_URL`, then rebuild. The build command is still
`npm run build` with output `out`. It now also builds the private renderer, which
Pages does not publish, and runs the public-artifact gate. A production build never
falls back to a localhost API: without the variable, purchasing shows as unavailable
and the free preview works. Never put a Stripe value in a `NEXT_PUBLIC_*` variable.

**Backend packaging fix prepared and locally verified.** The root command
`npm run build:backend-release` builds the private renderer, compiles the backend
and runs a fail-closed private-asset gate. The web backend must use repository
root `/` and `/railway.backend.toml`; the current backend-only build context must
be changed during a separately authorized rollout. See [the exact production
configuration, acceptance evidence and rollback runbook](M2_PRODUCTION_READINESS.md).
No production settings were changed.

## Release order and rollback

Future live release, each step separately authorized:

1. Complete and record hosted Stripe test-mode verification (above).
2. Deploy the backend with the Stripe variables **unset**. The pre-deploy
   `npm run db:migrate` applies `20261020120000_report_purchases`, which only adds five
   tables. Confirm `/health`, the admin and `{"available":false}` from the offer.
3. Add the live Stripe variables and the private renderer, then confirm the offer
   reports `amount: 4900`, `currency: "usd"`.
4. Rebuild Pages with `NEXT_PUBLIC_BILLING_API_URL`, and verify the free preview and one
   real purchase under the M3 authorization.

Rollback, from least to most disruptive. None touches purchase records:

- **Stop new sales (preferred):** unset `STRIPE_REPORT_PRICE_ID` on Railway. The offer
  returns `{"available":false}` and checkout refuses before creating a Stripe session.
  Status, paid-report fulfillment for existing buyers, and webhooks (payments completing
  in already-open Checkouts, refunds, disputes) keep working. To stop in-flight attempts
  as well, expire their open Checkout Sessions in Stripe. Restore by setting the Price
  ID again.
- **Payments fully off** (for example, a key compromise): unset `STRIPE_SECRET_KEY` and
  roll the key in Stripe. Purchasing shows as unavailable, but existing buyers also lose
  paid re-access and refund/dispute events are not processed. Stripe retries undelivered
  webhooks for up to three days, so restore promptly.
- **Frontend:** roll back to the previous Pages deployment, or rebuild without
  `NEXT_PUBLIC_BILLING_API_URL`. The free scanner keeps working, but past buyers cannot
  open paid reports from that build.
- **Backend code rollback:** the purchase tables stay in place. Do not write a down
  migration, drop or truncate `ReportBuyer`, `ReportPurchase`, `ReportEntitlement`
  or `StripePaymentEvent`, or delete the Stripe Product/Price (archive it instead).

## Reproducible automated verification

- Root `npm test`: scanner/import/calculation/duplicate/export regressions, limited
  preview, device proof transport, nonextractable credential storage, encrypted
  recovery, wrong passwords/tampering and non-sensitive report references.
- Backend `npm test` and `npm run typecheck`; purchase integration tests in
  `backend/test/integration/billing.test.ts`, with `TEST_DATABASE_URL` set to a
  disposable local database, use real PostgreSQL and signed Stripe fixtures.
- Existing local runner (creates/drops only its own fresh database):
  `node review/contact-c2/integration.mjs test/integration/billing.test.ts`.
- Browser simulation: set `NEXT_PUBLIC_BILLING_API_URL=http://127.0.0.1:47892`,
  `NEXT_PUBLIC_ANALYTICS_API_URL=http://127.0.0.1:47891` and disable Next telemetry
  for a local `npm run build`, then run `node test/e2e/purchase.mjs`. It uses
  `backend/.env` only to obtain a guarded local PostgreSQL connection, creates a
  fresh database, starts a fixture server bound to loopback, blocks external DNS
  in Chrome, and deletes its database afterward. Override `CHROME_PATH` if needed.
  Artifacts go to `review/m2-purchase-verification/`. This verifies application
  flow, not Stripe's actual hosted UI, card authentication or live integration.

No production data, sending controls or replenishment stash are used. Before
release, real Stripe test-mode verification and deployment/package review remain.
M2 is not declared complete by local fixture tests; M3 requires an actual shop's
successful use and verified real payment under separate authorization.

## Verification status and release limits

Local verification passed: 73 frontend/packaging tests, 1,234 backend unit tests
(including the production Stripe-mode guard) and 41 selected PostgreSQL integration
tests (20 payment-specific, plus existing admin and log privacy tests). Both builds and scoped application lint/type checks passed.
The Chrome simulation verified synthetic CSV/XLSX preview isolation, signed
fulfillment through the actual private-file route, local PDF/CSV/summary outputs,
cancel/forged return handling, refresh recovery, earlier purchase references,
mobile layout and absence of repair data in captured requests.

Core hosted sandbox Checkout and payment/webhook/recovery checks passed on October 22;
see the linked verification record for remaining checks. No real-money payment,
live configuration, deployment or outreach occurred.
The existing `npm audit` advisories (7 root, 4 backend package alerts) have now
been [triaged against the release architecture](M2_RELEASE_VERIFICATION.md#dependency-advisory-triage).
None was demonstrated reachable in this static/Pg purchase deployment; versions
and advisory checks were not changed or suppressed. The new Stripe, esbuild and
fake-indexeddb packages were not reported as vulnerable. These findings are scoped
to this release architecture, not an all-dependencies security certification.
Historical entitlement and lost-key support constraints above remain part of
release review.
