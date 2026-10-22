import type { Analysis } from "./types";
import { localStore } from "./reportPurchase";
export interface ReportSnapshot {
  reportId: string;
  fileName: string;
  analysis: Analysis;
  analyzedAt: Date;
}
interface EncryptedCopy {
  version: 1;
  salt: Uint8Array;
  iv: Uint8Array;
  data: ArrayBuffer;
}
async function key(password: string, salt: Uint8Array<ArrayBuffer>) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 250000 },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function saveRecovery(report: ReportSnapshot, password: string) {
  if (password.length < 12)
    throw Error("Use a recovery password with at least 12 characters.");
  const salt = crypto.getRandomValues(new Uint8Array(16)),
    iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await key(password, salt),
    new TextEncoder().encode(JSON.stringify(report)),
  );
  await localStore("recovery", "readwrite", (s) =>
    s.put(
      { version: 1, salt, iv, data } satisfies EncryptedCopy,
      report.reportId,
    ),
  );
}
export async function hasRecovery(id: string) {
  return !!(await localStore("recovery", "readonly", (s) => s.getKey(id)));
}
export async function clearRecovery(id: string) {
  await localStore("recovery", "readwrite", (s) => s.delete(id));
}
export async function restoreRecovery(
  id: string,
  password: string,
): Promise<ReportSnapshot> {
  const encrypted = await localStore<EncryptedCopy | undefined>(
    "recovery",
    "readonly",
    (s) => s.get(id),
  );
  if (!encrypted || encrypted.version !== 1)
    throw Error(
      "No encrypted recovery copy was saved. Reopen your original file.",
    );
  try {
    const salt = new Uint8Array(encrypted.salt),
      iv = new Uint8Array(encrypted.iv);
    const text = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      await key(password, salt),
      encrypted.data,
    );
    const r = JSON.parse(new TextDecoder().decode(text), (k, v) =>
      ["date", "analyzedAt"].includes(k) && typeof v === "string"
        ? new Date(v)
        : v,
    ) as ReportSnapshot;
    if (
      r.reportId !== id ||
      !r.analysis?.ranked?.length ||
      !(r.analyzedAt instanceof Date) ||
      !Number.isFinite(r.analysis.total) ||
      r.analysis.ranked.some((o) => !Number.isFinite(o.amount) || o.amount <= 0)
    )
      throw Error();
    return r;
  } catch {
    throw Error("Unable to restore the copy. Check your recovery password.");
  }
}
