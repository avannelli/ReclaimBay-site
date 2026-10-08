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

export function hasRequiredHeaderLabels(headers: string[]): boolean {
  const matches = (field: "service" | "amount", header: string) => {
    const key = verifiedHeaderLabel(header);
    const def = FIELD_DEFS[field];
    return key !== null && [...def.strong, ...(def.weak ?? [])].includes(key);
  };
  return headers.some((header, service) => matches("service", header) &&
    headers.some((other, amount) => amount !== service && matches("amount", other)));
}
