export type RawCell = string | number | boolean | Date | null;

/** A parsed spreadsheet: one header label per column and raw cell rows. */
export interface ParsedTable {
  fileName: string;
  headers: string[];
  rows: RawCell[][];
}

export type FieldKey =
  | "customer"
  | "vehicle"
  | "service"
  | "amount"
  | "date"
  | "phone"
  | "email"
  | "recordId"
  | "year"
  | "make"
  | "model";

/** Maps a field to the index of the source column that holds it. */
export type ColumnMapping = Partial<Record<FieldKey, number>>;

export interface DetectionResult {
  mapping: ColumnMapping;
  /** True when every required field was matched with high confidence. */
  confident: boolean;
}

export interface Opportunity {
  id: number;
  customer?: string;
  vehicle?: string;
  service: string;
  category: string;
  amount: number;
  date?: Date;
  ageDays?: number;
  phone?: string;
  email?: string;
  /** Matches another row exactly, with no unique ID to confirm. Still counted. */
  possibleDuplicate?: boolean;
}

/** Counts of rows that were left out, so the results can say so plainly. */
export interface DataQuality {
  /** Rows with a missing, unreadable, zero, or negative dollar amount. */
  skippedRows: number;
  /**
   * Rows removed because a unique record-ID column repeated with otherwise
   * identical details. Never inferred from matching content alone.
   */
  confirmedDuplicateRows: number;
  /**
   * Extra rows that match another row on every field we read but have no
   * unique ID to prove they are the same record. These stay in the totals.
   */
  possibleDuplicateRows: number;
  /** Dollar value of those extra rows. */
  possibleDuplicateValue: number;
}

export interface NormalizedData {
  opportunities: Opportunity[];
  quality: DataQuality;
}

export interface Bucket {
  label: string;
  count: number;
  value: number;
}

export interface Analysis {
  total: number;
  count: number;
  average: number;
  highest: Opportunity;
  /** Every opportunity, largest first. */
  ranked: Opportunity[];
  hasDates: boolean;
  undatedCount: number;
  ageBuckets: Bucket[];
  categories: Bucket[];
  recency: {
    thresholdDays: number;
    recent: Bucket;
    older: Bucket;
    /** Share of dated declined value that is recent (0-1). */
    recentShare: number;
  };
  quality: DataQuality;
}
