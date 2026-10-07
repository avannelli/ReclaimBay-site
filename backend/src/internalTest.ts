/*
 * The internal outreach test identity: ReclaimBay's own controlled stand-in,
 * never a business. A prospect marked internalTest (set once, at creation,
 * by createInternalTestProspect) carries exactly this identity, and nothing
 * else: no website, phone, location, signals, or evidence.
 *
 * Because it claims to be no business, business qualification (sourced
 * automotive repair evidence, Meets criteria) doesn't apply to it. In its place,
 * Qualified and Ready to contact require the identity below, checked by the
 * same status rules at every step (prospectStatus.ts), so preparing,
 * queueing, and sending decide it alike. Every sending control (the arm, the
 * switch, the provider, the daily limit, recipient ownership, suppression,
 * the send gate) applies unchanged.
 *
 * The recipient is a mailbox ReclaimBay controls, and the public page at
 * emailSourceUrl says so. No other prospect may use the address or the name.
 */

export const INTERNAL_TEST_IDENTITY = {
  businessName: "ReclaimBay Internal Test",
  email: "reclaimbay.test@gmail.com",
  emailSourceUrl: "https://reclaimbay.com/internal-test-contact",
} as const;

const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();

/** Whether an address is the internal test's controlled mailbox. */
export const isInternalTestEmail = (email: string | null | undefined) => norm(email) === INTERNAL_TEST_IDENTITY.email;

/** Whether a name is the internal test's identity name. */
export const isInternalTestName = (name: string | null | undefined) => norm(name).replace(/\s+/g, " ") === norm(INTERNAL_TEST_IDENTITY.businessName);

export interface InternalTestRecord {
  internalTest: boolean;
  businessName: string | null;
  website: string | null;
  phone: string | null;
  email: string | null;
  emailSourceUrl: string | null;
}

/** Why a record isn't exactly the controlled internal-test identity (empty when it is). */
export function internalTestIdentityErrors(p: Omit<InternalTestRecord, "internalTest">): string[] {
  const { businessName, email, emailSourceUrl } = INTERNAL_TEST_IDENTITY;
  const errors: string[] = [];
  if (p.businessName !== businessName) errors.push(`An internal test must be named "${businessName}".`);
  if (!isInternalTestEmail(p.email)) errors.push(`An internal test's recipient must be ${email}.`);
  if (p.emailSourceUrl !== emailSourceUrl) errors.push(`An internal test's recipient must be documented at ${emailSourceUrl}.`);
  if (p.website || p.phone) errors.push("An internal test isn't a business: it carries no website or phone.");
  return errors;
}

/**
 * The status rules' view of the mark: null for a business (its qualification
 * applies), otherwise why the record isn't the controlled identity.
 */
export const internalTestIdentity = (p: InternalTestRecord): string[] | null =>
  p.internalTest ? internalTestIdentityErrors(p) : null;
