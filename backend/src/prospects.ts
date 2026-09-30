import { randomInt } from "node:crypto";
import type { Db } from "./db.js";

const CODE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const CODE_LENGTH = 12;

/** Opaque, unguessable code; never derived from the business name. */
export function generateReferralCode(): string {
  let id = "";
  for (let i = 0; i < CODE_LENGTH; i++) id += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `rb_${id}`;
}

export function referralUrl(siteUrl: string, code: string, campaign?: string | null): string {
  const url = new URL(siteUrl);
  url.searchParams.set("ref", code);
  if (campaign) url.searchParams.set("campaign", campaign);
  return url.toString();
}

export interface ProspectInput {
  businessName?: string | null;
  website?: string | null;
}

/** Returns a cleaned input, or an error message. */
export function cleanProspectInput(input: ProspectInput): ProspectInput | string {
  const businessName = input.businessName?.trim() || null;
  if (businessName && businessName.length > 120) return "Business name is too long (max 120).";

  let website = input.website?.trim() || null;
  if (website) {
    if (!/^https?:\/\//i.test(website)) website = `https://${website}`;
    try {
      const url = new URL(website);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
      website = url.toString();
    } catch {
      return "Website must be a valid http(s) URL.";
    }
    if (website.length > 200) return "Website is too long (max 200).";
  }
  return { businessName, website };
}

export async function createProspect(db: Db, input: ProspectInput) {
  // A collision is astronomically unlikely, but retry rather than fail.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await db.prospect.create({
        data: { ...input, referralCode: generateReferralCode() },
      });
    } catch (err) {
      if ((err as { code?: string }).code !== "P2002" || attempt === 2) throw err;
    }
  }
  throw new Error("unreachable");
}
