/** ReclaimBay's real-network research boundary. Injected HttpGet fixtures remain separate. */
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent } from "undici";
import type { HttpGet } from "@avannelli/aos/fetch";

class DestinationBlocked extends Error {
  readonly code = "ERR_RESEARCH_DESTINATION_BLOCKED";
  constructor() { super("Research destination is not public."); }
}

function ranges(entries: readonly [string, number][], family: "ipv4" | "ipv6") {
  const list = new BlockList();
  for (const [address, prefix] of entries) list.addSubnet(address, prefix, family);
  return list;
}

// Address classes, not a list of public providers/networks. Registry references:
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
// https://www.iana.org/assignments/ipv6-address-space/
// Review when IANA changes special-purpose/reserved assignments.
const nonPublic4 = ranges([
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
], "ipv4");
const globalProtocol4 = ranges([["192.0.0.9", 32], ["192.0.0.10", 32]], "ipv4");
const mapped4 = ranges([["::ffff:0:0", 96]], "ipv6");
const nat64 = ranges([["64:ff9b::", 96]], "ipv6");
const nonPublic6 = ranges([
  // IANA reserved space (including deprecated/site-local/translation allocations).
  ["::", 8], ["100::", 8], ["200::", 7], ["400::", 6], ["800::", 5], ["1000::", 4],
  ["4000::", 3], ["6000::", 3], ["8000::", 3], ["a000::", 3], ["c000::", 3],
  ["e000::", 4], ["f000::", 5], ["f800::", 6], ["fc00::", 7], ["fe00::", 9],
  ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
  // Non-global protocol assignments, documentation and transitional 6to4 space.
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
], "ipv6");
// More-specific IANA globally-reachable exceptions to the protocol-assignment block.
const globalProtocol6 = ranges([
  ["2001:1::1", 128], ["2001:1::2", 128], ["2001:1::3", 128],
  ["2001:3::", 32], ["2001:4:112::", 48], ["2001:20::", 28], ["2001:30::", 28],
], "ipv6");

/** A validated IPv6 literal's embedded last 32 bits, normalized by WHATWG URL. */
function embedded4(address: string): string {
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [left, right] = normalized.split("::");
  const a = left ? left.split(":") : [];
  const b = right ? right.split(":") : [];
  const words = right === undefined ? a : [...a, ...Array<string>(8 - a.length - b.length).fill("0"), ...b];
  const hi = Number.parseInt(words[6]!, 16), lo = Number.parseInt(words[7]!, 16);
  return [hi >>> 8, hi & 255, lo >>> 8, lo & 255].join(".");
}

/** Node validates syntax; BlockList performs numeric CIDR matching, including mapped addresses. */
export function isPublicAddress(address: string): boolean {
  if (address.includes("%")) return false; // Scoped IPv6 is never a public-web destination.
  const family = isIP(address);
  if (family === 4) return globalProtocol4.check(address, "ipv4") || !nonPublic4.check(address, "ipv4");
  if (family !== 6) return false;
  if (mapped4.check(address, "ipv6") || nat64.check(address, "ipv6")) return isPublicAddress(embedded4(address));
  return globalProtocol6.check(address, "ipv6") || !nonPublic6.check(address, "ipv6");
}

const localSuffixes = ["localhost", "local", "localdomain", "internal", "lan", "home", "home.arpa", "corp", "svc", "onion", "test", "invalid", "example", "in-addr.arpa", "ip6.arpa"];

function validateHostname(hostname: string): string {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new DestinationBlocked();
    return host;
  }
  const name = host.replace(/\.$/, "");
  if (!name.includes(".") || name.includes("..") || localSuffixes.some((suffix) => name === suffix || name.endsWith(`.${suffix}`))) throw new DestinationBlocked();
  return host; // Preserve absolute trailing-dot semantics for DNS.
}

export function validatePublicUrl(input: string): URL {
  // WHATWG canonicalizes decimal/hex/octal IPv4 and IDNs before the checks.
  const url = new URL(input);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) throw new DestinationBlocked();
  validateHostname(url.hostname);
  return url;
}

export type AddressResolver = (hostname: string) => Promise<readonly LookupAddress[]>;
const resolveAddresses: AddressResolver = (hostname) => lookup(hostname, { all: true });

/** This is the socket's lookup, not a preflight followed by a second resolver. */
export function createPublicLookup(resolve: AddressResolver = resolveAddresses): LookupFunction {
  return (hostname, options, callback) => {
    void (async () => {
      const host = validateHostname(hostname);
      const literal = isIP(host);
      const answers = literal ? [{ address: host, family: literal }] : await resolve(host);
      const addresses = answers.map(({ address, family }) => ({ address, family }));
      if (!addresses.length) throw Object.assign(new Error("No DNS addresses."), { code: "ENOTFOUND" });
      // Reject mixed public/private results, even if the client prefers the public family.
      if (addresses.some((a) => isIP(a.address) !== a.family || !isPublicAddress(a.address))) throw new DestinationBlocked();
      const selected = options.family ? addresses.filter((a) => a.family === options.family) : addresses;
      if (!selected.length) throw Object.assign(new Error("No DNS addresses for this family."), { code: "ENOTFOUND" });
      if (options.all) callback(null, selected);
      else callback(null, selected[0]!.address, selected[0]!.family);
    })().catch((error: NodeJS.ErrnoException) => callback(error, []));
  };
}

type TransportFetch = (url: string, options: RequestInit) => Promise<Response>;

function classify(error: unknown): string {
  const e = error as { name?: string; message?: string; code?: string; cause?: { code?: string; message?: string } } | null | undefined;
  if (e?.code === "ERR_RESEARCH_DESTINATION_BLOCKED" || e?.cause?.code === "ERR_RESEARCH_DESTINATION_BLOCKED") return "destination_blocked";
  const text = `${e?.name ?? ""} ${e?.message ?? ""} ${e?.code ?? ""} ${e?.cause?.code ?? ""} ${e?.cause?.message ?? ""}`;
  if (/TimeoutError|aborted|timeout/i.test(text)) return "timeout";
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) return "dns";
  if (/CERT|SSL|TLS|self[- ]signed|UNABLE_TO_VERIFY|ALTNAME/i.test(text)) return "tls";
  return "connection";
}

/** Dependencies are trusted test seams, never URL/request/environment options. No bypass flag exists. */
export function createPublicWebTransport(deps: { resolve?: AddressResolver; fetch?: TransportFetch } = {}) {
  // Direct sockets: no environment proxy, global dispatcher, or hostname-only DNS cache.
  // Undici passes this lookup to Node net/tls.connect. Each new connection can use
  // only the validated returned addresses; an existing connection is already pinned.
  const dispatcher = new Agent({ connect: { lookup: createPublicLookup(deps.resolve) } });
  // Node's bundled Undici declarations and the pinned agent differ in FormData
  // iterator types. The documented Dispatcher runtime contract is compatible;
  // this adapter issues GETs without a body, never passes FormData.
  const nativeDispatcher = dispatcher as unknown as NonNullable<RequestInit["dispatcher"]>;
  const fetchImpl: TransportFetch = deps.fetch ?? ((url, options) => globalThis.fetch(url, options));
  const get: HttpGet = async (input, opts) => {
    try {
      let url = validatePublicUrl(input);
      const signal = AbortSignal.timeout(opts.timeoutMs); // One budget across DNS, all hops and body.
      for (let redirects = 0; ; redirects++) {
        signal.throwIfAborted();
        const response = await fetchImpl(url.href, {
          dispatcher: nativeDispatcher, redirect: "manual", signal,
          headers: { "user-agent": opts.userAgent, accept: "text/html,application/xhtml+xml,text/plain;q=0.8" },
        });
        const location = response.headers.get("location");
        if ([301, 302, 303, 307, 308].includes(response.status) && location !== null) {
          await response.body?.cancel().catch(() => undefined);
          if (redirects >= 20) throw new TypeError("Maximum redirects reached.");
          url = validatePublicUrl(new URL(location, url).href);
          continue;
        }
        const contentType = response.headers.get("content-type");
        let bytes = 0;
        const chunks: Uint8Array[] = [];
        if (response.body) {
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done || !value) break;
            chunks.push(value);
            bytes += value.byteLength;
            if (bytes >= opts.maxBytes) { await reader.cancel().catch(() => undefined); break; }
          }
        }
        const body = new TextDecoder("utf-8").decode(Buffer.concat(chunks).subarray(0, opts.maxBytes));
        return { url: input, finalUrl: response.url || url.href.replace(/#.*$/, ""), status: response.status, contentType, body, bytes, error: null };
      }
    } catch (error) {
      return { url: input, finalUrl: null, status: null, contentType: null, body: null, bytes: 0, error: classify(error) };
    }
  };
  return { get, close: () => dispatcher.close() };
}

/** Only research's default real transport is restricted; supplied HttpGet fixtures remain injectable. */
export const publicHttpGet = createPublicWebTransport().get;
