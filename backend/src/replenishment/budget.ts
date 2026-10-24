/*
 * Request budgets for prescreening.
 *
 * The meter sits below the research transport, at the physical HTTP boundary, so every redirect hop,
 * robots.txt read and retry counts as a request, and response bytes are counted as they stream. Past
 * its cap a request is refused before it is made and a body is cut off; the business is then recorded
 * as an error, never accepted on a partial read.
 *
 * A batch reserves one business's full cap durably before screening it and settles the actual use
 * afterwards (Ledger, in service.ts), so a crash leaves the reservation charged, never refunded.
 */
import { ReplenishmentStop } from "./policy.js";

type TransportFetch = (url: string, init: RequestInit & { dispatcher?: unknown }) => Promise<Response>;

export interface Meter {
  fetch: TransportFetch;
  /** Requests and bytes used so far. */
  used(): { fetches: number; bytes: number };
  /** Whether a cap refused a request or cut a body short. */
  exceeded(): boolean;
}

export function meteredFetch(caps: { fetches: number; bytes: number }, inner: TransportFetch = (url, init) => globalThis.fetch(url, init as RequestInit)): Meter {
  let fetches = 0;
  let bytes = 0;
  let exceeded = false;
  const fetch: TransportFetch = async (url, init) => {
    if (fetches >= caps.fetches || bytes >= caps.bytes) {
      exceeded = true;
      throw new ReplenishmentStop("Per-business request budget exhausted.");
    }
    fetches++;
    const response = await inner(url, init);
    // A null-body status cannot be re-wrapped (and has nothing to count).
    if (!response.body || [101, 204, 205, 304].includes(response.status)) return response;
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) return controller.close();
          const room = caps.bytes - bytes;
          const accepted = value.subarray(0, Math.max(0, room));
          bytes += accepted.byteLength;
          if (accepted.byteLength) controller.enqueue(accepted);
          if (accepted.byteLength < value.byteLength) {
            exceeded = true;
            await reader.cancel().catch(() => undefined);
            controller.close();
          }
        } catch (e) {
          controller.error(e);
        }
      },
      async cancel() {
        await reader.cancel().catch(() => undefined);
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  return { fetch, used: () => ({ fetches, bytes }), exceeded: () => exceeded };
}
