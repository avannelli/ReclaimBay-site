import { FIELD_DEFS, normalizeHeader } from "./normalize";

// Exact known labels only. Substring matching would accept row contents such
// as customer names or service descriptions containing a header word.
const labels = new Set(
  Object.values(FIELD_DEFS).flatMap((def) => [...def.strong, ...(def.weak ?? [])]),
);

export function verifiedHeaderLabel(value: string): string | null {
  const key = normalizeHeader(value);
  // Reject values before normalization can erase digits, currency or punctuation.
  if (!/^[a-zA-Z\s_/-]+$/.test(value.trim()) || !labels.has(key)) return null;
  return key;
}

/**
 * The known label a header-row cell spells, allowing what export headers add
 * to a label without changing it: currency and unit marks ("Amount ($)",
 * "Total $"), abbreviation dots ("Est. Total"), "#", and a plural. Digits are
 * never allowed, so dates, amounts, and "Printed 09/18/2026" titles can't
 * pass, and a cell must still be a whole known label, never prose around one.
 * Used only to find the header row; what may be remembered between uploads
 * stays limited to verifiedHeaderLabel.
 */
function headerRowLabel(value: string): string | null {
  if (!/^[a-zA-Z\s_/$().#-]+$/.test(value.trim())) return null;
  const key = normalizeHeader(value);
  if (labels.has(key)) return key;
  return key.endsWith("s") && labels.has(key.slice(0, -1)) ? key.slice(0, -1) : null;
}

export function hasRequiredHeaderLabels(headers: string[]): boolean {
  const matches = (field: "service" | "amount", header: string) => {
    const key = headerRowLabel(header);
    const def = FIELD_DEFS[field];
    return key !== null && [...def.strong, ...(def.weak ?? [])].includes(key);
  };
  return headers.some((header, service) => matches("service", header) &&
    headers.some((other, amount) => amount !== service && matches("amount", other)));
}
