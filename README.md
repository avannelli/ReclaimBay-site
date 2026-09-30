# AutoRev Scanner

Validation prototype: upload a declined/deferred-work export (CSV or XLSX) from an independent auto repair shop and see how much declined work it contains, organized by value and age.

Files are parsed in the browser and held only in React state. Nothing is uploaded, stored, or sent anywhere.

## Run locally

```bash
npm install
npm run dev      # http://localhost:3000
```

Checks: `npm run lint`, `npx tsc --noEmit`, `npm run build`.

## Structure

- `lib/parseFile.ts`: CSV (papaparse) and XLSX (read-excel-file) to a raw table; finds the header row.
- `lib/normalize.ts`: header alias matching, content checks, column detection, and row normalization.
- `lib/sampleData.ts`: synthetic data for the "Try a sample report" option.
- `lib/categorize.ts`: keyword-based service categories.
- `lib/analyze.ts`: totals, top 10, age buckets, category breakdown, recent-vs-older split.
- `components/`: upload, column mapper, dashboard UI.
