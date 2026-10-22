/** Purchase transport accepts opaque IDs only, never a report, filename or totals. */
export const BILLING_API =
  (process.env.NEXT_PUBLIC_BILLING_API_URL ?? "").trim().replace(/\/+$/, "") ||
  (process.env.NODE_ENV === "development" ? "http://localhost:8080" : "");
export interface Buyer {
  id: string;
  privateKey: CryptoKey;
  publicKey: JsonWebKey;
}
export interface Offer {
  available: boolean;
  priceId?: string;
  amount?: number;
  currency?: string;
  oneTime?: boolean;
}
let buyerPromise: Promise<Buyer> | null = null;
export function localStore<T>(
  store: string,
  mode: IDBTransactionMode,
  operation: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("reclaimbay-purchases-v1", 1);
    open.onupgradeneeded = () => {
      for (const name of ["identity", "recovery", "metadata"])
        open.result.createObjectStore(name);
    };
    open.onerror = () =>
      reject(
        Error("Device storage is unavailable. Enable it before purchasing."),
      );
    open.onblocked = () =>
      reject(Error("Close other ReclaimBay tabs and try again."));
    open.onsuccess = () => {
      const db = open.result;
      try {
        const tx = db.transaction(store, mode);
        const r = operation(tx.objectStore(store));
        tx.oncomplete = () => {
          const value = r.result;
          db.close();
          resolve(value);
        };
        tx.onerror = tx.onabort = () => {
          db.close();
          reject(Error("Device storage could not be saved."));
        };
      } catch {
        db.close();
        reject(Error("Device storage is unavailable."));
      }
    };
  });
}
export interface ReportReference {
  id: string;
  createdAt: string;
}
export async function rememberReport(id: string) {
  await localStore("metadata", "readwrite", (s) => {
    const r = s.get("reports");
    r.onsuccess = () => {
      const reports: ReportReference[] = r.result ?? [];
      if (!reports.some((x) => x.id === id))
        s.put(
          [...reports, { id, createdAt: new Date().toISOString() }],
          "reports",
        );
      s.put(id, "lastReport");
    };
    return r;
  });
}
async function json(path: string, body: unknown) {
  if (!BILLING_API)
    throw Error(
      "Purchases are not available yet. Your preview is still available.",
    );
  const r = await fetch(BILLING_API + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "omit",
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) {
    const result = await r.json().catch(() => ({}));
    throw Error(
      result.error === "price_changed"
        ? "The price changed. Refresh the offer before continuing."
        : result.error === "checkout_needs_review"
          ? "This checkout needs review. Contact ReclaimBay with your Stripe receipt; do not pay again."
          : result.error === "purchase_revoked"
            ? "This purchase was refunded or needs review. Contact ReclaimBay."
            : "We could not verify this purchase. Please try again; your report stays in this tab.",
    );
  }
  return r;
}
export async function deviceBuyer(): Promise<Buyer> {
  if (!buyerPromise)
    buyerPromise = (async () => {
      let buyer = await localStore<Buyer | undefined>(
        "identity",
        "readonly",
        (s) => s.get("buyer"),
      );
      if (!buyer) {
        const pair = await crypto.subtle.generateKey(
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["sign", "verify"],
        );
        const proposed = {
          id: crypto.randomUUID(),
          privateKey: pair.privateKey,
          publicKey: await crypto.subtle.exportKey("jwk", pair.publicKey),
        };
        // IndexedDB add is atomic across tabs; never replace an existing buyer key.
        try {
          await localStore("identity", "readwrite", (s) =>
            s.add(proposed, "buyer"),
          );
          buyer = proposed;
        } catch {
          buyer = await localStore<Buyer>("identity", "readonly", (s) =>
            s.get("buyer"),
          );
          if (!buyer) throw Error("Unable to preserve purchase identity.");
        }
      }
      await json("/api/billing/buyer", {
        buyerId: buyer.id,
        publicKey: buyer.publicKey,
      });
      return buyer;
    })().catch((e) => {
      buyerPromise = null;
      throw e;
    });
  return buyerPromise;
}
export function purchaseProofMessage(
  route: string,
  challenge: string,
  payload: Record<string, string>,
) {
  return `ReclaimBay purchase v1\n${route}\n${challenge}\n${JSON.stringify(
    Object.fromEntries(
      Object.keys(payload)
        .sort()
        .map((k) => [k, payload[k]]),
    ),
  )}`;
}
export async function purchaseRequest(
  route: "checkout" | "status" | "fulfillment",
  payload: Record<string, string>,
) {
  const buyer = await deviceBuyer(),
    path = "/api/billing/" + route;
  const { id } = await (
    await json("/api/billing/challenge", { buyerId: buyer.id })
  ).json();
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    buyer.privateKey,
    new TextEncoder().encode(purchaseProofMessage(path, id, payload)),
  );
  const encoded = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return json(path, {
    buyerId: buyer.id,
    challenge: id,
    payload,
    signature: encoded,
  });
}
export async function reportOffer(): Promise<Offer> {
  if (!BILLING_API) return { available: false };
  const r = await fetch(BILLING_API + "/api/billing/offer", {
    cache: "no-store",
    credentials: "omit",
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw Error("The current offer is unavailable. Please try again.");
  return r.json();
}
export function offerPrice(o: Offer) {
  return typeof o.amount === "number"
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: o.currency ?? "usd",
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      }).format(o.amount / 100)
    : null;
}
