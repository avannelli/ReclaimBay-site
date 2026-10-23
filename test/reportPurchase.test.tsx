import assert from "node:assert/strict";
import { test, before } from "node:test";
import {
  createPublicKey,
  verify,
  type JsonWebKey as NodeJsonWebKey,
} from "node:crypto";
import "fake-indexeddb/auto";
import { renderToStaticMarkup } from "react-dom/server";
import { demoAnalysis, DEMO_DATE } from "../lib/demoReport";

process.env.NEXT_PUBLIC_BILLING_API_URL = "http://localhost:47892";
let p: typeof import("../lib/reportPurchase");
let recovery: typeof import("../lib/reportRecovery");
let ReportAccess: typeof import("../components/ReportAccess").default;
before(async () => {
  p = await import("../lib/reportPurchase");
  recovery = await import("../lib/reportRecovery");
  ReportAccess = (await import("../components/ReportAccess")).default;
});
const originalFetch = globalThis.fetch;
const bodies: { url: string; body: Record<string, unknown> }[] = [];
let publicKey: NodeJsonWebKey;
globalThis.fetch = async (input, init) => {
  const url = String(input),
    body = JSON.parse(String(init?.body ?? "{}"));
  bodies.push({ url, body });
  if (url.endsWith("/buyer")) publicKey = body.publicKey;
  if (url.endsWith("/challenge"))
    return Response.json({ id: "868690a6-067f-4d6b-9274-c301d5310ad1" });
  return Response.json({ paid: false });
};
test.after(() => {
  globalThis.fetch = originalFetch;
});

test("free preview is meaningful and withholds full rows and exports", () => {
  const { analysis } = demoAnalysis();
  const html = renderToStaticMarkup(
    <ReportAccess
      reportId={crypto.randomUUID()}
      fileName="private.csv"
      analysis={analysis}
      analyzedAt={DEMO_DATE}
      isSample={false}
      onReset={() => {}}
    />,
  );
  assert.match(html, /4,327.48/);
  assert.match(html, /6 declined jobs/);
  assert.match(html, /Timing belt and water pump/);
  assert.doesNotMatch(
    html,
    /Download PDF|Download CSV|Jordan|JAC-004|data-tour="total"/,
  );
  assert.match(html, /one-time|one-time purchase/i);
  // No phone/email column: the preview says so instead of inventing a call order.
  assert.match(html, /no phone or email column/);
  // Recovery is secondary and explained in one place, not in the primary view.
  assert.match(html, /If you close this tab/);
  assert.match(html, /reopen the same file/);
  assert.doesNotMatch(html, /type="checkbox"/);
});
test("a contact-rich report previews priorities but withholds names, vehicles and contact details", async () => {
  const [{ buildSampleTable }, { detectColumns, normalizeRows }, { analyze }] = await Promise.all([
    import("../lib/sampleData"),
    import("../lib/normalize"),
    import("../lib/analyze"),
  ]);
  const now = new Date("2026-10-23T12:00:00");
  const table = buildSampleTable(now);
  const data = normalizeRows(table, detectColumns(table).mapping, now);
  const analysis = analyze(data.opportunities, data.quality)!;
  const render = (isSample: boolean) =>
    renderToStaticMarkup(
      <ReportAccess reportId={crypto.randomUUID()} fileName={table.fileName} analysis={analysis} analyzedAt={now} isSample={isSample} onReset={() => {}} />,
    );
  const preview = render(false);
  assert.match(preview, /Call first/);
  assert.match(preview, /8 follow-ups/);
  assert.match(preview, /across <span[^>]*>15 follow-ups/);
  assert.match(preview, /14 more follow-ups in the complete call list/);
  assert.doesNotMatch(preview, /Riley Chen|Morgan Diaz|555-01|@example\.com|Ford F-150|Download PDF|Download CSV/);
  const sample = render(true);
  assert.match(sample, /Fictional sample/);
  assert.match(sample, /Riley Chen/);
  assert.match(sample, /555-0110/);
  assert.match(sample, /cannot be purchased/);
  assert.doesNotMatch(sample, /Unlock complete report|Purchase terms|Download PDF|Download CSV|type="password"/);
});
test("price display comes from a server offer and supports replacement prices", () => {
  assert.equal(
    p.offerPrice({ available: true, amount: 4900, currency: "usd" }),
    "$49",
  );
  assert.equal(
    p.offerPrice({ available: true, amount: 5925, currency: "usd" }),
    "$59.25",
  );
  assert.equal(p.offerPrice({ available: false }), null);
});
test("device credential is stable, nonextractable and contains no report", async () => {
  const [a, b] = await Promise.all([p.deviceBuyer(), p.deviceBuyer()]);
  assert.equal(a.id, b.id);
  assert.equal(a.privateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey("jwk", a.privateKey));
  const saved = await p.localStore("identity", "readonly", (s) =>
    s.get("buyer"),
  );
  assert.equal(saved.id, a.id);
  assert.equal(saved.privateKey.extractable, false);
  assert.deepEqual(Object.keys(saved).sort(), [
    "id",
    "privateKey",
    "publicKey",
  ]);
  assert.equal(await recovery.hasRecovery(crypto.randomUUID()), false);
});
test("transport signs exact route and opaque IDs; private report data never enters payloads", async () => {
  const reportId = crypto.randomUUID();
  await p.purchaseRequest("checkout", { reportId, priceId: "price_launch" });
  const sent = bodies.at(-1)!,
    b = sent.body as {
      signature: string;
      challenge: string;
      payload: Record<string, string>;
    };
  assert(
    verify(
      "sha256",
      Buffer.from(
        p.purchaseProofMessage("/api/billing/checkout", b.challenge, b.payload),
      ),
      {
        key: createPublicKey({ key: publicKey, format: "jwk" }),
        dsaEncoding: "ieee-p1363",
      },
      Buffer.from(b.signature, "base64url"),
    ),
  );
  assert(
    !verify(
      "sha256",
      Buffer.from(
        p.purchaseProofMessage("/api/billing/status", b.challenge, b.payload),
      ),
      {
        key: createPublicKey({ key: publicKey, format: "jwk" }),
        dsaEncoding: "ieee-p1363",
      },
      Buffer.from(b.signature, "base64url"),
    ),
  );
  assert.deepEqual(Object.keys(b.payload).sort(), ["priceId", "reportId"]);
  assert.doesNotMatch(
    JSON.stringify(bodies),
    /private.csv|4327|Timing belt|customer|analysis|password|dataset/i,
  );
});
test("encrypted recovery is explicit, survives module sessions, and rejects wrong passwords and tampering", async () => {
  const reportId = crypto.randomUUID(),
    snapshot = {
      reportId,
      fileName: "PRIVATE_CUSTOMER.csv",
      analysis: demoAnalysis().analysis,
      analyzedAt: DEMO_DATE,
    };
  assert.equal(await recovery.hasRecovery(reportId), false);
  await assert.rejects(
    recovery.saveRecovery(snapshot, "short"),
    /12 characters/,
  );
  await recovery.saveRecovery(snapshot, "a long private recovery password");
  const encrypted = await p.localStore("recovery", "readonly", (s) =>
    s.get(reportId),
  );
  assert.deepEqual(Object.keys(encrypted).sort(), [
    "data",
    "iv",
    "salt",
    "version",
  ]);
  assert.doesNotMatch(
    Buffer.from(encrypted.data).toString(),
    /PRIVATE_CUSTOMER|Timing belt|4327/,
  );
  await assert.rejects(
    recovery.restoreRecovery(reportId, "the wrong password"),
    /Unable to restore/,
  );
  const restored = await recovery.restoreRecovery(
    reportId,
    "a long private recovery password",
  );
  assert.equal(restored.analysis.total, 4327.48);
  assert.equal(restored.fileName, snapshot.fileName);
  assert.equal(restored.analyzedAt.getTime(), DEMO_DATE.getTime());
  assert(restored.analysis.ranked[0].date instanceof Date);
  new Uint8Array(encrypted.data)[0] ^= 1;
  await p.localStore("recovery", "readwrite", (s) =>
    s.put(encrypted, reportId),
  );
  await assert.rejects(
    recovery.restoreRecovery(reportId, "a long private recovery password"),
    /Unable to restore/,
  );
  await recovery.clearRecovery(reportId);
  assert.equal(await recovery.hasRecovery(reportId), false);
});
test("report references preserve earlier purchases without storing report content", async () => {
  const first = crypto.randomUUID(),
    second = crypto.randomUUID();
  await Promise.all([p.rememberReport(first), p.rememberReport(second)]);
  await p.rememberReport(first);
  const refs = await p.localStore("metadata", "readonly", (s) =>
    s.get("reports"),
  );
  assert.equal(refs.length, 2);
  assert.deepEqual(Object.keys(refs[0]).sort(), ["createdAt", "id"]);
  assert.equal(
    await p.localStore("metadata", "readonly", (s) => s.get("lastReport")),
    first,
  );
});
