/*
 * An invitation's status, in a person's words. Pure: the one place that
 * turns the stored timestamps (and activation, from invitationActivations()
 * in service.ts) into a status, so the admin never decides it itself.
 *
 *   Not opened -> Opened -> Activated;   Revoked ends it, whatever came before.
 */
export const INVITATION_STATUSES = ["not_opened", "opened", "activated", "revoked"] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export const INVITATION_STATUS_LABELS: Record<InvitationStatus, string> = {
  not_opened: "Not opened",
  opened: "Opened",
  activated: "Activated",
  revoked: "Revoked",
};

export const INVITATION_STATUS_MEANINGS: Record<InvitationStatus, string> = {
  not_opened: "Nobody has opened the invitation link yet.",
  opened: "The invitation link was opened. No real scan yet.",
  activated: "A visitor who arrived through the link ran a real scan.",
  revoked: "The link no longer works. Everything it recorded is kept.",
};

export function invitationStatus(i: { revokedAt: Date | null; firstOpenedAt: Date | null }, activatedAt: Date | null): InvitationStatus {
  if (i.revokedAt) return "revoked";
  if (activatedAt) return "activated";
  if (i.firstOpenedAt) return "opened";
  return "not_opened";
}
