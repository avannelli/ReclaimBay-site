/** Reviews are append-only annotations; original run warnings remain unchanged. */
import { createHash } from "node:crypto";
export const WARNING_REVIEW_PREFIX = "Research warnings reviewed by a person: ";
type Subject = { businessName: string; website: string | null; city: string | null; state: string | null; postalCode: string | null; country: string; phone: string | null; email: string | null };
export const warningReviewSignature = (subject: Subject) => createHash("sha256").update(JSON.stringify([subject.businessName, subject.website, subject.city, subject.state, subject.postalCode, subject.country, subject.phone, subject.email])).digest("hex");
export function unreviewedWarnings(run: { id: string; warnings: unknown } | undefined, notes: readonly { body: string }[], subject: Subject) {
  if (!run) return [];
  const reviewed = notes.some(note => {
    if (!note.body.startsWith(WARNING_REVIEW_PREFIX)) return false;
    try {
      const review = JSON.parse(note.body.slice(WARNING_REVIEW_PREFIX.length));
      return review.researchId === run.id && review.warnings === JSON.stringify(run.warnings) && review.subjectSignature === warningReviewSignature(subject) && typeof review.sourceUrl === "string" && typeof review.reason === "string";
    } catch { return false; }
  });
  return reviewed ? [] : run.warnings;
}
