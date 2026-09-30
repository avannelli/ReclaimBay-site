import { categorize } from "./categorize";
import type {
  ColumnMapping,
  DetectionResult,
  FieldKey,
  NormalizedData,
  Opportunity,
  ParsedTable,
  RawCell,
} from "./types";

interface FieldDef {
  label: string;
  required: boolean;
  /** Shown in the manual mapping UI. Vehicle parts are detected silently. */
  ui: boolean;
  /** Full-confidence header phrases. */
  strong: string[];
  /** Ambiguous single words; matched with lower confidence. */
  weak?: string[];
  /** Headers containing any of these tokens are never a match. */
  exclude?: string[];
  /** Content check: the column's values must parse as this kind of data. */
  check?: "amount" | "date" | "unique";
}

export const FIELD_DEFS: Record<FieldKey, FieldDef> = {
  amount: {
    label: "Declined amount",
    required: true,
    ui: true,
    check: "amount",
    strong: [
      "declined amount", "declined total", "declined value", "declined estimate",
      "deferred amount", "deferred total", "estimate amount", "estimate total",
      "estimated total", "estimated amount", "recommended amount", "line total",
      "grand total", "total price", "total amount", "est total", "quoted amount",
      "dollar amount", "declined price", "declined cost", "estimate price",
    ],
    weak: ["amount", "total", "price", "cost", "value", "estimate", "quote", "declined", "deferred", "dollars", "charge", "revenue", "sales"],
    exclude: ["date", "number", "no", "num", "id", "tax", "qty", "quantity", "hours", "hrs", "phone", "year", "mileage", "odometer", "miles"],
  },
  service: {
    label: "Service / repair",
    required: true,
    ui: true,
    strong: [
      "service description", "job description", "repair description", "work description",
      "declined service", "declined work", "declined repair", "deferred service",
      "deferred work", "recommended service", "recommended work", "recommended repair",
      "line description", "labor description", "operation description", "service",
      "services", "job", "repair", "work", "recommendation", "concern", "complaint",
      "operation", "line item", "item description", "task", "labor", "declined item", "work requested",
    ],
    weak: ["description", "item", "desc", "notes"],
    exclude: ["date", "id", "number", "no", "advisor", "writer", "technician", "tech", "vehicle"],
  },
  customer: {
    label: "Customer name",
    required: false,
    ui: true,
    strong: ["customer name", "customer", "client name", "client", "owner name", "owner", "full name", "cust name", "contact name", "contact"],
    weak: ["name"],
    exclude: ["id", "number", "no", "phone", "email", "vehicle", "service", "advisor", "technician", "tech", "type", "since"],
  },
  vehicle: {
    label: "Vehicle",
    required: false,
    ui: true,
    strong: ["vehicle description", "vehicle info", "vehicle name", "year make model", "ymm", "vehicle", "car", "auto"],
    weak: ["unit"],
    exclude: ["id", "number", "no", "vin", "plate", "license", "mileage", "odometer", "miles"],
  },
  date: {
    label: "Decline date",
    required: false,
    ui: true,
    check: "date",
    strong: [
      "declined date", "decline date", "date declined", "declined on", "deferred date",
      "estimate date", "recommended date", "recommendation date", "service date", "ro date",
      "invoice date", "created date", "created on", "date created", "open date",
      "date opened", "opened", "visit date", "appointment date", "repair order date",
    ],
    weak: ["date", "created"],
    exclude: ["next", "due", "follow", "birth", "expire", "expiration", "modified", "updated"],
  },
  phone: {
    label: "Phone",
    required: false,
    ui: true,
    strong: ["phone number", "phone", "mobile", "cell", "cell phone", "mobile phone", "telephone", "tel", "contact phone"],
    exclude: ["fax", "work", "type"],
  },
  email: {
    label: "Email",
    required: false,
    ui: true,
    strong: ["email address", "email", "e mail", "customer email", "contact email"],
  },
  recordId: {
    label: "Unique record ID",
    required: false,
    ui: true,
    check: "unique",
    strong: [
      "record id", "line id", "line item id", "job id", "declined item id",
      "unique id", "row id", "recommendation id", "declined id", "declined line id",
    ],
  },
  year: { label: "Year", required: false, ui: false, strong: ["vehicle year", "model year", "year", "yr"], exclude: ["date"] },
  make: { label: "Make", required: false, ui: false, strong: ["vehicle make", "make", "manufacturer"] },
  model: { label: "Model", required: false, ui: false, strong: ["vehicle model", "model"], exclude: ["year", "number"] },
};

const ALL_FIELDS = Object.keys(FIELD_DEFS) as FieldKey[];
export const MAPPER_FIELDS = ALL_FIELDS.filter((k) => FIELD_DEFS[k].ui);
export const REQUIRED_FIELDS = MAPPER_FIELDS.filter((k) => FIELD_DEFS[k].required);

const CONFIDENT_SCORE = 70;
const SUGGEST_SCORE = 50;
const SAMPLE_SIZE = 50;
const MS_PER_DAY = 86_400_000;

const normalizeHeader = (h: string) =>
  h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function scoreHeader(header: string, def: FieldDef): number {
  const h = normalizeHeader(header);
  if (!h) return 0;
  const tokens = h.split(" ");
  if (def.exclude?.some((x) => tokens.includes(x))) return 0;
  const padded = ` ${h} `;
  let best = 0;
  for (const alias of def.strong) {
    if (h === alias) return 100;
    if (padded.includes(` ${alias} `)) best = Math.max(best, 75);
  }
  for (const alias of def.weak ?? []) {
    if (h === alias) best = Math.max(best, CONFIDENT_SCORE);
    else if (padded.includes(` ${alias} `)) best = Math.max(best, 55);
  }
  return best;
}

// ---------- value parsing ----------

export function parseAmount(cell: RawCell): number | null {
  if (typeof cell === "number") return Number.isFinite(cell) ? cell : null;
  if (typeof cell !== "string") return null;
  const s = cell.trim();
  // Accept only clean money strings ("$1,240.50", "(50.00)", "-75", "300 USD").
  // Anything else ("N/A", "2 x $50", "TBD") is unreadable rather than guessed at.
  const m = s.match(
    /^(\()?\s*(-)?\s*[$£€]?\s*(-)?\s*(\d[\d,]*(?:\.\d+)?|\.\d+)\s*(\))?(?:\s*(?:usd|dollars?))?$/i,
  );
  if (!m) return null;
  const n = Number(m[4].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return m[1] || m[2] || m[3] ? -n : n;
}

const validDate = (y: number, m: number, d: number): Date | null => {
  const date = new Date(y, m - 1, d);
  const ok =
    date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
  return ok && y >= 1990 && y <= 2100 ? date : null;
};

export function parseDate(cell: RawCell): Date | null {
  // Excel dates arrive as UTC midnight; rebuild them as the same calendar day
  // locally so they don't display a day early in US time zones.
  const fromExcel = (utc: Date) =>
    validDate(utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate());
  if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? null : fromExcel(cell);
  if (typeof cell === "number") {
    // Excel serial date (roughly 1954-2064).
    if (cell > 20000 && cell < 60000) {
      return fromExcel(new Date(Date.UTC(1899, 11, 30) + Math.floor(cell) * MS_PER_DAY));
    }
    return null;
  }
  if (typeof cell !== "string") return null;
  const s = cell.trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  // US-style M/D/YYYY or M/D/YY, which is what shop systems export.
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?!\d)/);
  if (m) {
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return validDate(year, +m[1], +m[2]);
  }
  if (/[a-z]{3}/i.test(s)) {
    const t = Date.parse(s);
    if (!Number.isNaN(t)) return new Date(t);
  }
  return null;
}

const cellText = (cell: RawCell | undefined): string | undefined => {
  if (cell === null || cell === undefined || cell instanceof Date) return undefined;
  const s = String(cell).trim();
  return s || undefined;
};

// ---------- detection ----------

/** Share of non-empty sampled cells in a column that parse as the given kind. */
function contentMatchRatio(
  table: ParsedTable,
  col: number,
  kind: "amount" | "date" | "unique",
): number {
  if (kind === "unique") {
    // Trusted as a unique ID only if nearly every row has a value and most
    // values are distinct. Some repeats are expected: they are the duplicates
    // this column exists to confirm.
    const values = table.rows
      .map((r) => cellText(r[col])?.toLowerCase())
      .filter((v): v is string => v !== undefined);
    if (values.length < table.rows.length * 0.9) return 0;
    return new Set(values).size / values.length >= 0.75 ? 1 : 0;
  }
  const parse = kind === "amount" ? parseAmount : parseDate;
  let filled = 0;
  let ok = 0;
  for (const row of table.rows.slice(0, SAMPLE_SIZE)) {
    const cell = row[col];
    if (cell === null || cell === undefined || cellText(cell) === undefined && !(cell instanceof Date)) continue;
    filled++;
    if (parse(cell) !== null) ok++;
  }
  return filled === 0 ? 0 : ok / filled;
}

/** Guesses which source column holds each field. */
export function detectColumns(table: ParsedTable): DetectionResult {
  const candidates: { field: FieldKey; col: number; score: number }[] = [];
  for (const field of ALL_FIELDS) {
    const def = FIELD_DEFS[field];
    table.headers.forEach((header, col) => {
      let score = scoreHeader(header, def);
      if (score === 0) return;
      // A header that looks right but holds the wrong kind of data isn't trusted.
      if (def.check && contentMatchRatio(table, col, def.check) < 0.6) score *= 0.4;
      candidates.push({ field, col, score });
    });
  }

  // Greedy best-first assignment: each field and each column is used once.
  candidates.sort((a, b) => b.score - a.score);
  const mapping: ColumnMapping = {};
  const scores: Partial<Record<FieldKey, number>> = {};
  const usedCols = new Set<number>();
  for (const { field, col, score } of candidates) {
    if (mapping[field] !== undefined || usedCols.has(col) || score < SUGGEST_SCORE) {
      continue;
    }
    mapping[field] = col;
    scores[field] = score;
    usedCols.add(col);
  }

  const confident = REQUIRED_FIELDS.every(
    (f) => (scores[f] ?? 0) >= CONFIDENT_SCORE,
  );
  return { mapping, confident };
}

// ---------- normalization ----------

export function normalizeRows(
  table: ParsedTable,
  mapping: ColumnMapping,
  now: Date = new Date(),
): NormalizedData {
  const get = (row: RawCell[], f: FieldKey): RawCell | undefined =>
    mapping[f] === undefined ? undefined : row[mapping[f]];

  const opportunities: Opportunity[] = [];
  const seenIds = new Set<string>();
  const contentGroups = new Map<string, Opportunity[]>();
  let skippedRows = 0;
  let confirmedDuplicateRows = 0;

  for (const row of table.rows) {
    const amount = parseAmount(get(row, "amount") ?? null);
    if (amount === null || amount <= 0) {
      skippedRows++;
      continue;
    }

    let vehicle = cellText(get(row, "vehicle"));
    if (!vehicle) {
      const parts = (["year", "make", "model"] as const)
        .map((f) => cellText(get(row, f)))
        .filter(Boolean);
      vehicle = parts.length ? parts.join(" ") : undefined;
    }

    const service = cellText(get(row, "service")) ?? "Unspecified service";
    const dateCell = get(row, "date");
    const date = dateCell === undefined ? null : parseDate(dateCell);
    const ageDays = date
      ? Math.max(0, Math.floor((now.getTime() - date.getTime()) / MS_PER_DAY))
      : undefined;

    const contentKey = [
      cellText(get(row, "customer")),
      vehicle,
      service,
      amount,
      date?.getTime(),
      cellText(get(row, "phone")),
      cellText(get(row, "email")),
    ]
      .map((v) => String(v ?? "").toLowerCase())
      .join("|");
    // Only a repeated unique ID with identical details proves a duplicate.
    const recordId = cellText(get(row, "recordId"));
    if (recordId) {
      const idKey = `${recordId.toLowerCase()}|${contentKey}`;
      if (seenIds.has(idKey)) {
        confirmedDuplicateRows++;
        continue;
      }
      seenIds.add(idKey);
    }

    const opportunity: Opportunity = {
      id: opportunities.length,
      customer: cellText(get(row, "customer")),
      vehicle,
      service,
      category: categorize(service),
      amount,
      date: date ?? undefined,
      ageDays,
      phone: cellText(get(row, "phone")),
      email: cellText(get(row, "email")),
    };
    opportunities.push(opportunity);

    // Rows with distinct IDs are distinct records; without an ID, flag look-alikes.
    if (!recordId) {
      contentGroups.set(contentKey, [
        ...(contentGroups.get(contentKey) ?? []),
        opportunity,
      ]);
    }
  }

  let possibleDuplicateRows = 0;
  let possibleDuplicateValue = 0;
  for (const group of contentGroups.values()) {
    if (group.length < 2) continue;
    group.forEach((o, i) => {
      o.possibleDuplicate = true;
      if (i > 0) {
        possibleDuplicateRows++;
        possibleDuplicateValue += o.amount;
      }
    });
  }

  return {
    opportunities,
    quality: {
      skippedRows,
      confirmedDuplicateRows,
      possibleDuplicateRows,
      possibleDuplicateValue,
    },
  };
}
