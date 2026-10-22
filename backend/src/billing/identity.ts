import { createPublicKey, verify } from "node:crypto";
import type { Db } from "../db.js";

export class BillingError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function buyerKey(raw: unknown) {
  const k = raw as Record<string, unknown>;
  if (
    !k ||
    Object.keys(k).some(
      (x) => !["kty", "crv", "x", "y", "ext", "key_ops"].includes(x),
    ) ||
    k.kty !== "EC" ||
    k.crv !== "P-256" ||
    typeof k.x !== "string" ||
    typeof k.y !== "string" ||
    !/^[-_A-Za-z0-9]{43}$/.test(k.x) ||
    !/^[-_A-Za-z0-9]{43}$/.test(k.y)
  )
    throw new BillingError(400, "invalid_public_key");
  const clean = { kty: "EC", crv: "P-256", x: k.x, y: k.y };
  try {
    createPublicKey({ key: clean, format: "jwk" });
  } catch {
    throw new BillingError(400, "invalid_public_key");
  }
  return clean;
}
export function proofMessage(
  route: string,
  challenge: string,
  payload: Record<string, string>,
) {
  return `ReclaimBay purchase v1\n${route}\n${challenge}\n${JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b))))}`;
}
export async function authenticateBuyer(
  db: Db,
  route: string,
  body: {
    buyerId: string;
    challenge: string;
    signature: string;
    payload: Record<string, string>;
  },
) {
  const c = await db.buyerChallenge.findUnique({
    where: { id: body.challenge },
    include: { buyer: true },
  });
  if (!c || c.buyerId !== body.buyerId || c.usedAt || c.expiresAt <= new Date())
    throw new BillingError(401, "proof_expired_or_replayed");
  let valid = false;
  try {
    valid = verify(
      "sha256",
      Buffer.from(proofMessage(route, body.challenge, body.payload)),
      {
        key: createPublicKey({
          key: buyerKey(c.buyer.publicKey),
          format: "jwk",
        }),
        dsaEncoding: "ieee-p1363",
      },
      Buffer.from(body.signature, "base64url"),
    );
  } catch {
    /* fail closed */
  }
  if (!valid) throw new BillingError(401, "invalid_buyer_proof");
  const used = await db.buyerChallenge.updateMany({
    where: { id: c.id, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  if (used.count !== 1)
    throw new BillingError(401, "proof_expired_or_replayed");
  return c.buyerId;
}
