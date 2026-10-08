import assert from "node:assert/strict";
import type { LookupAddress, LookupOptions } from "node:dns";
import { describe, test } from "node:test";
import { createPublicLookup, isPublicAddress, validatePublicUrl, type AddressResolver } from "../../src/research/publicWeb.js";

describe("public-web address classes", () => {
  const rejected = [
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255",
    "127.0.0.1", "127.17.99.2", "127.255.255.255", "169.254.1.1", "172.16.0.1", "172.31.255.255",
    "192.168.1.1", "192.0.0.8", "192.0.0.171", "192.0.2.1", "192.88.99.2", "198.18.0.1",
    "198.19.255.255", "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
    "::", "::1", "::127.0.0.1", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "fec0::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:192.168.1.1", "::ffff:169.254.1.1",
    "64:ff9b::a00:1", "64:ff9b::7f00:1", "64:ff9b:1::1", "100::1", "2001:2::1", "2001:db8::1",
    "2002:0a00:0001::1", "3fff::1", "4000::1", "5f00::1", "2001:4860::1%zone", "not-an-ip", "999.1.1.1",
  ];
  for (const address of rejected) test(`${address} is not public`, () => assert.equal(isPublicAddress(address), false));
  for (const address of ["8.8.8.8", "1.1.1.1", "9.9.9.9", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0", "192.0.0.9", "192.0.0.10", "198.17.255.255", "198.20.0.0", "223.255.255.255", "2001:4860:4860::8888", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808", "2001:3::1", "2001:1::3"])
    test(`${address} is public`, () => assert.equal(isPublicAddress(address), true));
});

describe("URL canonicalization and local names", () => {
  for (const input of [
    "http://127.1/", "http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/", "http://127.0.0.1./",
    "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[fc00::1]/", "http://localhost/", "http://LOCALHOST./",
    "http://foo.localhost/", "http://localhost.localdomain/", "http://router/", "http://foo.local/", "http://foo.internal./",
    "http://foo.lan/", "http://foo.home.arpa/", "http://metadata.google.internal/", "http://kubernetes.default.svc/",
    "http://foo.onion/", "http://foo.invalid/", "http://user:password@8.8.8.8/", "file:///etc/passwd", "ftp://8.8.8.8/",
    "http://[fe80::1%25eth0]/", "http://999.1.1.1/", "http://exa mple.com/", "not a URL",
  ]) test(`rejects ${input}`, () => assert.throws(() => validatePublicUrl(input)));
  test("canonical public literals, mixed case, trailing dot and IDN names remain usable", () => {
    assert.equal(validatePublicUrl("http://0x08080808/").hostname, "8.8.8.8");
    assert.equal(validatePublicUrl("HTTPS://PUBLIC.EXAMPLE.COM./").hostname, "public.example.com.");
    assert.equal(validatePublicUrl("https://bücher.example.org/").hostname, "xn--bcher-kva.example.org");
  });
});

function resolveUsing(resolve: AddressResolver, host = "public.example.com", options: LookupOptions = { all: true }): Promise<string | LookupAddress[]> {
  return new Promise((accept, reject) => createPublicLookup(resolve)(host, options, (error, addresses) => error ? reject(error) : accept(addresses)));
}

describe("DNS results delivered to the connector", () => {
  test("public answers are passed directly, preserving order and family", async () => {
    const answers = [{ address: "8.8.8.8", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }];
    assert.deepEqual(await resolveUsing(async () => answers), answers);
    assert.equal(await resolveUsing(async () => answers, undefined, { family: 4 }), "8.8.8.8");
    assert.equal(await resolveUsing(async () => answers, undefined, { family: 6 }), "2606:4700:4700::1111");
  });
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fc00::1", "::ffff:10.0.0.1"]) {
    test(`rejects DNS returning ${address}`, async () => {
      const family = address.includes(":") ? 6 : 4;
      await assert.rejects(resolveUsing(async () => [{ address, family }]), { code: "ERR_RESEARCH_DESTINATION_BLOCKED" });
      await assert.rejects(resolveUsing(async () => [{ address: "8.8.8.8", family: 4 }, { address, family }]), { code: "ERR_RESEARCH_DESTINATION_BLOCKED" });
    });
  }
  test("empty/error DNS and malformed family/address answers fail closed", async () => {
    await assert.rejects(resolveUsing(async () => []), { code: "ENOTFOUND" });
    await assert.rejects(resolveUsing(async () => { throw Object.assign(new Error("lookup failed"), { code: "EAI_AGAIN" }); }), { code: "EAI_AGAIN" });
    await assert.rejects(resolveUsing(async () => [{ address: "8.8.8.8", family: 6 }]), { code: "ERR_RESEARCH_DESTINATION_BLOCKED" });
    await assert.rejects(resolveUsing(async () => [{ address: "bad", family: 4 }]), { code: "ERR_RESEARCH_DESTINATION_BLOCKED" });
  });
  test("a changed answer is checked on each new connection lookup", async () => {
    let calls = 0;
    const resolve: AddressResolver = async () => [{ address: ++calls === 1 ? "8.8.8.8" : "10.0.0.1", family: 4 }];
    assert.equal(await resolveUsing(resolve, undefined, {}), "8.8.8.8");
    await assert.rejects(resolveUsing(resolve), { code: "ERR_RESEARCH_DESTINATION_BLOCKED" });
    assert.equal(calls, 2);
  });
  test("private literals and internal names are rejected without DNS; public literals need none", async () => {
    const noDns: AddressResolver = async () => { assert.fail("DNS must not run"); };
    await assert.rejects(resolveUsing(noDns, "localhost"));
    await assert.rejects(resolveUsing(noDns, "127.0.0.1"));
    assert.equal(await resolveUsing(noDns, "8.8.8.8", {}), "8.8.8.8");
  });
});
