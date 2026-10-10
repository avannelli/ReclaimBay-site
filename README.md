# ReclaimBay

ReclaimBay: declined-work intelligence for repair shops. Upload a declined/deferred-work export (CSV or XLSX) from an independent auto repair shop and see how much declined work it contains, organized by value and age.

Files are parsed in the browser and held only in React state. The file and its contents are never uploaded, stored, or sent anywhere.

Optional anonymous analytics (event names, a random browser ID, and referral codes only; never report data) go to the separate service in [`backend/`](backend/README.md). Set `NEXT_PUBLIC_ANALYTICS_API_URL` at build time to turn them on (see `.env.example`). With it unset, the site sends nothing.

## Contact form

"Talk to ReclaimBay" opens an in-site form (`components/ContactDialog.tsx`) that posts only its own fields (name, shop name, email, shop software, message) to `POST /api/contact`, a Cloudflare Pages Function in [`functions/api/contact.js`](functions/api/contact.js). The function checks everything again, ignores a filled honeypot, rate-limits by hashed IP, and sends a plain-text email through Resend to `hello@reclaimbay.com`, from `ReclaimBay Website <contact@reclaimbay.com>`, with Reply-To set to the visitor. It has nothing to do with the Railway backend, Gmail, outreach, or any database, and nothing from a report can be sent through it.

Keep `functions/` at the repository root; Cloudflare Pages deploys it alongside the static `out/` export. In the Pages project (**Settings → Variables and Secrets**), add `RESEND_API_KEY` as a **Secret** (Production, and Preview to test there), and under **Settings → Bindings** bind a Workers KV namespace as `CONTACT_RATE_LIMIT`. Without either, the endpoint answers 503 and sends nothing; the form then shows its error and the visible address still works. The sender's domain, `reclaimbay.com`, must be verified in Resend.

Before promoting, deploy a Preview with the secret and binding, send a real message, and check delivery and Reply-To. KV is eventually consistent, so the five-per-ten-minutes limit is approximate; add a Cloudflare WAF rate-limiting rule for `POST /api/contact` if strict enforcement is needed. Locally: `npx wrangler pages dev out --kv CONTACT_RATE_LIMIT` with a gitignored `.dev.vars` holding `RESEND_API_KEY` (`npm run dev` alone cannot serve the function).

## Local development

### Which thing am I looking at?

| You see | It is | Its data |
| ------- | ----- | -------- |
| http://localhost:3000 | The customer-facing site, on your computer (`npm run dev`) | None: reports stay in the browser |
| http://localhost:8080/admin | The admin panel, on your computer (`npm run dev:admin`) | Your local `reclaimbay_dev` database: test data only, never production |
| https://reclaimbay.com | The production site (Cloudflare Pages) | None: reports stay in the browser |
| The Railway backend's `/admin` | The production admin | The production database |

Nothing on localhost is production data, and nothing you do on localhost
changes production.

### Two terminals, both from the repository root

| | Terminal 1: public site | Terminal 2: local admin |
| - | ----------------------- | ----------------------- |
| Start | `npm run dev` | `npm run dev:admin` |
| Open | http://localhost:3000 | http://localhost:8080/admin |
| What it runs | The Next.js site | The backend, which serves the admin |
| Stop | `Ctrl+C` | `Ctrl+C` |

Each runs on its own; start only the one you need. In Windows PowerShell, if
`npm` is blocked by the script execution policy, type `npm.cmd` instead (for
example `npm.cmd run dev:admin`). Example repository root on Windows:
`E:\VSCode-Sites\Projects\ReclaimBay-site`.

### Local admin commands

| Command | What it does | When |
| ------- | ------------ | ---- |
| `npm run dev:admin:setup` | Creates `backend/.env` with a newly generated `ADMIN_SECRET` (your local admin password). Never overwrites an existing file | Once, on a new computer. Then set `DATABASE_URL` in `backend/.env` to your local `reclaimbay_dev` database |
| `npm run dev:admin:reset` | Drops and recreates the local database, then applies every migration. **Deletes all local data** | Once to create `reclaimbay_dev`; again whenever you want a clean slate |
| `npm run dev:admin:seed` | Adds example prospects (example.com data); repeating it is harmless | After a reset, for something to look at |
| `npm run dev:admin` | Applies any new migrations, then starts the admin at http://localhost:8080/admin | Every time you work on the admin |

Sign in with the `ADMIN_SECRET` in `backend/.env`. That file holds local-only
credentials and is git-ignored: **never commit it**. Production's secrets live
only in Railway.

The local admin refuses to start, reset, or seed against any database that
isn't on your computer, refuses production and Railway environments, and
listens on your computer only.

### Integration tests use their own database

`npm run test:integration` (in `backend/`) runs against `TEST_DATABASE_URL`, a
separate throwaway database that the tests empty on every run. It is never
`reclaimbay_dev`: the tests refuse to run while `backend/.env` points
`DATABASE_URL` at the test database. Unit tests (`npm test` in `backend/`)
need no database.

### Checks

Site: `npm test`, `npm run lint`, `npx tsc --noEmit`, `npm run build`. Backend: see
[backend/README.md](backend/README.md#local-development).

Report imports automatically accept a single row in the first ten nonblank
rows containing recognized service and amount labels in distinct columns.
A label may carry currency marks, dots, `#` or a plural ("Amount ($)",
"Est. Total", "Declined Services"), but never digits. Blank header cells
become numbered columns. A service column is matched automatically only when
its values read as descriptions, so a dollar column such as "Labor" never is. Competing or unknown
headers, and numeric rows above a candidate header, require a header choice;
every nonblank row stays in memory until that choice. Users can choose no
header to retain all rows, then map columns manually.

Remembered mappings require established headers and exact recognized header
labels. Unknown custom labels remain manually mappable but are not persisted.
The old v1 mapping preference is removed because its provenance cannot be
trusted; safe confirmed mappings use v2. Report contents remain browser-only.

## Structure

- `lib/parseFile.ts`: CSV (papaparse) and XLSX (read-excel-file) to a raw table; finds the header row.
- `lib/normalize.ts`: header alias matching, content checks, column detection, and row normalization.
- `lib/sampleData.ts`: synthetic data for the "Try a sample report" option.
- `lib/categorize.ts`: keyword-based service categories.
- `lib/analyze.ts`: totals, top 10, age buckets, category breakdown, recent-vs-older split.
- `lib/analytics.ts`: best-effort anonymous events and referral attribution (no-op without an API URL).
- `components/`: upload, column mapper, dashboard UI.
