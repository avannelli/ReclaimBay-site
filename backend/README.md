# ReclaimBay backend

A small Fastify + Prisma (PostgreSQL) service for anonymous product analytics,
referral attribution, a private admin funnel, and manual prospect research
with transparent scoring (see [PROSPECTS.md](PROSPECTS.md)), and an evidence-backed
discovery and research workflow that feeds it (see [DISCOVERY.md](DISCOVERY.md)), and
outreach with a measurable lifecycle, sent through Google Workspace when configured and switched on (see [OUTREACH.md](OUTREACH.md); off by default). The public site stays a
static export on Cloudflare Pages. This service runs separately on Railway.

## Privacy guarantee

Reports are analyzed only in the visitor's browser. This service never
receives files, report rows, customer names, phones, emails, vehicle data,
repair descriptions, amounts or totals, or filenames.

`POST /api/events` accepts exactly six fields and rejects any request with an
extra field, a wrong type, or a value outside the allowlist:

| Field        | Allowed values                                                    |
| ------------ | ----------------------------------------------------------------- |
| `sessionId`  | Lowercase v4 UUID from `crypto.randomUUID()` (required)           |
| `event`      | `landing_view`, `upload_started`, `scan_completed`, `tour_completed`, `report_exported` (required) |
| `ref`        | `null` or `rb_` + 8 to 32 lowercase letters/digits                |
| `campaign`   | `null` or 1 to 64 chars of `a-z 0-9 . _ -`                        |
| `isSample`   | boolean                                                           |
| `exportType` | `pdf`, `csv`, `copied_summary`; required for `report_exported`, `null` otherwise |

The frontend side lives in `lib/analytics.ts`. Its exported functions take
only an event name, a sample flag, and an export type, so report data has no
path into a request.

## Analytics events

| Event             | Sent when                                                    |
| ----------------- | ------------------------------------------------------------ |
| `landing_view`    | Once per browser tab session                                 |
| `upload_started`  | A real uploaded file starts processing                       |
| `scan_completed`  | Analysis succeeds (`isSample: true` for the sample report)   |
| `tour_completed`  | The guided tour is finished with **Done** (not dismissed)    |
| `report_exported` | After a successful PDF download, CSV download, or summary copy |

The browser ID is stored in `localStorage` as `reclaimbay_analytics_session_v1`
and reused across visits. There is no fingerprinting and there are no cookies.
Calls are fire and forget with a 4-second timeout. If
`NEXT_PUBLIC_ANALYTICS_API_URL` is unset or the backend is down, nothing in
the product changes.

Sample-report activity is stored with `isSample = true`. The admin never counts
it as a real scan, tour, or export; it only shows up in the Sample column.

## Referral links

```
https://reclaimbay.com/?ref=rb_k3v9x0q2m7ta
https://reclaimbay.com/?ref=rb_k3v9x0q2m7ta&campaign=launch-v1
```

Codes are random (`rb_` + 12 characters) and never contain business names or
emails. The browser keeps a valid `ref`/`campaign` in `localStorage`
(`reclaimbay_attribution_v1`), so later events stay attributed after the query
string is gone. Attribution is first touch: once a browser is linked to a
prospect, it stays with that prospect. An unknown code is accepted but not
attributed, and the response is the same either way so codes can't be probed.

## Local setup

Needs Node 22.12+ and a PostgreSQL database.

```bash
cd backend
npm ci
cp .env.example .env           # then fill in DATABASE_URL and ADMIN_SECRET
npm run db:migrate             # applies prisma/migrations
npm run dev                    # http://localhost:8080
```

For a throwaway local database without installing Postgres, run
`npx prisma dev` and use the `postgres://…` URL it prints.

Point the frontend at it by adding this to `.env.local` in the repo root, then
run `npm run dev` there:

```
NEXT_PUBLIC_ANALYTICS_API_URL=http://localhost:8080
```

Set `ALLOWED_ORIGIN=http://localhost:3000` in `backend/.env` so CORS lets the
local site through.

### Scripts

| Script                    | What it does                                               |
| ------------------------- | ---------------------------------------------------------- |
| `npm run dev`             | Watch mode with `tsx`, loads `backend/.env`                |
| `npm run build`           | `prisma generate` + TypeScript compile to `dist/`          |
| `npm start`               | Runs `dist/server.js`                                      |
| `npm run db:migrate`      | `prisma migrate deploy` (applies committed migrations)     |
| `npm run db:migrate:dev`  | `prisma migrate dev` (creates a new migration while developing) |
| `npm run prospect:create` | Creates one prospect (after `npm run build`)               |
| `npm run prospects:rescore` | Recomputes cached scores for rows from an older scoring version (`-- --all` for every row) |
| `npm run seed:dev`        | Seeds three example prospects. Refuses to run in production or on Railway |
| `npm test`                | Unit tests for scoring and status rules (no database)      |
| `npm run test:integration`| Service and admin tests against `TEST_DATABASE_URL` (see [PROSPECTS.md](PROSPECTS.md#tests)) |
| `npm run typecheck`       | Type-checks `src` and `test`                               |

## Environment variables

| Variable           | Required | Purpose                                                                 |
| ------------------ | -------- | ----------------------------------------------------------------------- |
| `DATABASE_URL`     | yes      | Postgres connection string                                              |
| `ALLOWED_ORIGIN`   | yes      | Exact origin(s) allowed to POST events, comma-separated, e.g. `https://reclaimbay.com` |
| `ADMIN_SECRET`     | yes      | Admin password. At least 24 characters; `/admin` returns 503 without it |
| `PORT`             | no       | Set automatically by Railway (defaults to 8080)                         |
| `PUBLIC_SITE_URL`  | no       | Base for referral links in the admin (default `https://reclaimbay.com`) |
| `TRUST_PROXY_HOPS` | no       | Reverse proxies in front of the app (default `1`, right for Railway). Use `0` when exposed directly |
| `HOST`             | no       | Bind address (default `::`)                                             |
| `LOG_LEVEL`        | no       | Fastify log level (default `info`)                                      |
| `ENABLE_FIXTURE_DISCOVERY` | no | `1` offers the synthetic fixture discovery provider. On by default outside production, off in production. Leave it off on the real database |
| `OUTREACH_SENDER_NAME`, `OUTREACH_SENDER_EMAIL`, `OUTREACH_POSTAL_ADDRESS` | no | Who outreach is signed by, and the postal address it ends with. All three are required before anything can be sent |
| `PUBLIC_API_URL`   | no       | This backend's public base URL, for one-click unsubscribe links. Required before anything can be sent |
| `OUTREACH_SENDING_ENABLED` | no | `1` arms outreach sending for this deployment. Sending also needs the admin's global switch on and an email provider |
| `OUTREACH_PROVIDER` | no | `gmail` to send through Google Workspace; unset (default) disables sending |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | with gmail | The Google OAuth client (Web application) used to authorize the outreach mailbox. The secret goes in the host's secret store |
| `GMAIL_TOKEN_ENCRYPTION_KEY` | with gmail | 32 random bytes, base64: seals the mailbox's refresh token. A secret |
| `GMAIL_REFRESH_TOKEN_SEALED` | with gmail | The sealed refresh token from the admin's Gmail authorization (see [OUTREACH.md](OUTREACH.md#google-workspace-gmail)). A secret |
| `OUTREACH_DAILY_LIMIT` | no | New outreach sends per rolling 24 hours (default 20, at most 500) |

Generate an admin secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Frontend (Cloudflare Pages build variable, inlined at build time):

| Variable                        | Purpose                                                  |
| ------------------------------- | -------------------------------------------------------- |
| `NEXT_PUBLIC_ANALYTICS_API_URL` | Backend base URL, no trailing slash. Unset = analytics off |

## Endpoints

| Method | Path              | Notes                                                        |
| ------ | ----------------- | ------------------------------------------------------------ |
| GET    | `/health`         | `{"ok":true,"database":true}`, or 503 with `false`s if the DB is unreachable |
| POST   | `/api/events`     | Analytics intake. CORS limited to `ALLOWED_ORIGIN`, 120 req/min per IP, 2 KB body limit, `204` on success |
| GET    | `/admin`          | Funnel dashboard (signed in)                                 |
| GET    | `/admin/login`    | Sign-in form                                                 |
| POST   | `/admin/login`    | Rate limited to 10 attempts per 15 min per IP                |
| POST   | `/admin/logout`   | Clears the session                                           |
| GET    | `/admin/prospects`| Prospect list with search, filters, and sorting              |
| GET    | `/admin/prospects/new` | Create form                                             |
| POST   | `/admin/prospects`| Creates a prospect                                           |
| GET    | `/admin/prospects/:id` | Detail: score breakdown, status, evidence, notes        |
| GET/POST | `/admin/prospects/:id/edit`, `/admin/prospects/:id` | Edit form / save (recomputes the score) |
| POST   | `/admin/prospects/:id/status` | Status change, checked against the lifecycle rules |
| POST   | `/admin/prospects/:id/notes` | Adds a note                                        |
| POST   | `/admin/prospects/:id/evidence` | Adds evidence; `…/evidence/:evidenceId/delete` removes it |

Discovery (`/admin/discovery…`, see [DISCOVERY.md](DISCOVERY.md)) adds: `GET /admin/discovery`,
`POST /admin/discovery/runs`, `GET|POST /admin/discovery/candidates(/new)`,
`GET|POST /admin/discovery/candidates/:id(/edit)`, and POSTs to `…/:id/status`, `…/notes`,
`…/evidence`, `…/evidence/:evidenceId/delete`, and `…/:id/approve` (the only route that
creates a prospect from a candidate).

Outreach (see [OUTREACH.md](OUTREACH.md)) adds: `GET /admin/outreach` (the sending switch,
automatic preparation, and the funnel), `POST /admin/outreach/switch`, `POST /admin/outreach/prepare`,
`POST /admin/prospects/:id/outreach` (prepares a draft, or returns the open one), `GET /admin/outreach/:id`,
and POSTs to `…/:id/queue`, `…/discard`, `…/reply`, `…/classify`, `…/follow-up`, and `…/confirm-sent`.
No route sends: the dispatcher job does (`npm run outreach:send`).

`GET /admin/outreach/gmail/authorize` starts Google authorization of the outreach mailbox.

Public: `GET|POST /u/:token`, one-click unsubscribe for outreach email (rate limited; same answer for any token).
`GET /oauth/gmail/callback`, Google's return from mailbox authorization (accepted only with the
signed state cookie from the admin's own authorize step; never logged).

Every `/admin` route except login and logout requires a session, and every
admin POST must be same-origin. Admin write routes allow 60 requests per minute.

## Admin access

Open `https://<backend-domain>/admin` and sign in with `ADMIN_SECRET`. A
successful sign-in sets an HttpOnly, `SameSite=Strict`, `Secure` cookie scoped
to `/admin` that holds an HMAC-signed expiry (12 hours). Changing
`ADMIN_SECRET` signs everyone out. Admin pages send `no-store`, `noindex`, and
a script-free Content Security Policy. The secret exists only as a Railway
variable and never appears in the static frontend.

The dashboard shows:

- **Tiles:** attributed prospects, unique visitors, uploads started, real scans
  completed, exports, and scan conversion (visitors with a real scan ÷ unique
  visitors). Tiles count unique browser sessions.
- **Table:** per prospect, with visit, upload, scan, tour, and export counts,
  sample activity, last activity, and intent, plus a "No referral (direct)"
  row. **High intent** means a real scan and a real export.

## Prospects

Prospects are managed at `/admin/prospects`. [PROSPECTS.md](PROSPECTS.md)
documents the data model, each scoring signal's exact rules and weight, the
status lifecycle (including the Milestone 1 status mapping), and what is
deliberately not collected.

From the command line, against whichever database `DATABASE_URL` points to:

```bash
npm run build
npm run prospect:create -- --name "Smith Auto" --website smithauto.com --city Springfield --state IL --campaign launch-v1
```

`npm run seed:dev` creates Smith Auto, Ace Automotive, and Valley Motors
(example.com data) for local testing. It exits with an error when
`NODE_ENV=production` or on Railway, and nothing seeds automatically.

## Deploying to Railway

In the ReclaimBay project, open the app service's **Settings**:

| Setting            | Value                 |
| ------------------ | --------------------- |
| Root Directory     | `backend`             |
| Build Command      | `npm run build`       |
| Pre-deploy Command | `npm run db:migrate && npm run prospects:rescore` |
| Start Command      | `npm start`           |
| Healthcheck Path   | `/health`             |
| Watch Paths        | `/backend/**`         |

Railway installs dependencies itself (`npm ci`) using `backend/package-lock.json`.
Node comes from `engines.node` (`>=22.12`). `prisma` is a runtime dependency so
the pre-deploy migration can run in the deployed image.

**Variables** tab:

```
DATABASE_URL=${{Postgres.DATABASE_URL}}    # reference to the ReclaimBay Postgres service
ALLOWED_ORIGIN=https://reclaimbay.com
ADMIN_SECRET=<generated, 24+ chars>
NODE_ENV=production
```

Don't set `PORT`; Railway provides it. If the site is also served from
`www.reclaimbay.com`, use `ALLOWED_ORIGIN=https://reclaimbay.com,https://www.reclaimbay.com`.

**Public domain:** Settings → Networking → **Generate Domain**. That gives a
`https://<name>.up.railway.app` URL. You can add a custom domain such as
`api.reclaimbay.com` there instead (add the CNAME record Railway shows in
Cloudflare DNS).

**Frontend:** in Cloudflare Pages → Settings → Variables and Secrets
(Production), set `NEXT_PUBLIC_ANALYTICS_API_URL` to that backend URL with no
trailing slash, then redeploy the site. The value is inlined at build time, so
changing it always needs a new Pages build.

**Check it:**

```bash
curl https://<backend-domain>/health        # {"ok":true,"database":true}
```

Then open `https://<backend-domain>/admin`, create a prospect, visit its
referral link, and refresh the dashboard.
