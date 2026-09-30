import { CONFIDENT_SCORE, FIELD_DEFS, normalizeHeader } from "./normalize";
import type { ColumnMapping, DetectionResult, FieldKey } from "./types";

/*
 * Browser-only preferences. Only UI state and column-header patterns are
 * kept here, never report contents (no names, phone numbers, emails, or
 * amounts). Keys are versioned so a future format can start fresh instead
 * of misreading old data. Nothing here is sent anywhere.
 */

const TOUR_KEY = "reclaimbay_report_tour_v1";
const MAPPINGS_KEY = "reclaimbay_column_mappings_v1";
/** Oldest remembered headers are dropped past this many. */
const MAX_REMEMBERED = 200;

function read(key: string): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(key, value);
  } catch {
    // Storage blocked or full: the preference simply isn't kept.
  }
}

// ---------- report tour ----------

export type TourState = "completed" | "dismissed";

export function readTourState(): TourState | null {
  const v = read(TOUR_KEY);
  return v === "completed" || v === "dismissed" ? v : null;
}

export const saveTourState = (state: TourState) => write(TOUR_KEY, state);

// ---------- remembered column mappings ----------

/** Normalized header -> field, oldest first. Malformed data reads as empty. */
function loadRemembered(): Map<string, FieldKey> {
  const out = new Map<string, FieldKey>();
  const raw = read(MAPPINGS_KEY);
  if (!raw) return out;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
    for (const [header, field] of Object.entries(parsed)) {
      if (
        typeof field === "string" &&
        Object.hasOwn(FIELD_DEFS, field) &&
        header.length > 0 &&
        header.length <= 200
      ) {
        out.set(header, field as FieldKey);
      }
    }
  } catch {
    // Unreadable JSON: start over.
  }
  return out;
}

/** Placeholder names for blank headers say nothing about the column. */
const rememberable = (key: string) => key !== "" && !/^column \d+$/.test(key);

/**
 * Prefills fields from headers the user matched by hand before. A strong
 * built-in match always wins, for the field and for the column.
 */
export function applyRememberedMappings(
  headers: string[],
  detection: DetectionResult,
): { mapping: ColumnMapping; applied: number } {
  const remembered = loadRemembered();
  const mapping: ColumnMapping = { ...detection.mapping };
  const strong = (f: FieldKey) => (detection.scores[f] ?? 0) >= CONFIDENT_SCORE;
  const filled = new Set<FieldKey>();
  let applied = 0;

  headers.forEach((header, col) => {
    const field = remembered.get(normalizeHeader(header));
    if (!field || filled.has(field) || mapping[field] === col || strong(field)) return;
    const holder = (Object.keys(mapping) as FieldKey[]).find((f) => mapping[f] === col);
    if (holder && strong(holder)) return;
    if (holder) delete mapping[holder];
    mapping[field] = col;
    filled.add(field);
    applied++;
  });
  return { mapping, applied };
}

/**
 * Remembers the header behind each field the user confirmed, so the same
 * export prefills next time. Headers that were strongly matched anyway are
 * skipped, and a remembered header the user left unmapped is forgotten.
 */
export function rememberConfirmedMappings(
  headers: string[],
  confirmed: ColumnMapping,
  detection: DetectionResult,
) {
  const remembered = loadRemembered();
  const fields = Object.keys(confirmed) as FieldKey[];
  headers.forEach((header, col) => {
    const key = normalizeHeader(header);
    if (!rememberable(key)) return;
    const field = fields.find((f) => confirmed[f] === col);
    if (!field) {
      remembered.delete(key);
      return;
    }
    const builtIn =
      detection.mapping[field] === col &&
      (detection.scores[field] ?? 0) >= CONFIDENT_SCORE;
    if (builtIn) return;
    remembered.delete(key); // re-insert as the most recent
    remembered.set(key, field);
  });
  const entries = [...remembered].slice(-MAX_REMEMBERED);
  write(MAPPINGS_KEY, JSON.stringify(Object.fromEntries(entries)));
}
