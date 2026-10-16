import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "../../src/db.js";
import { calibrateReadiness } from "../../src/discovery/calibration.js";
import { RESEARCH_VERSION } from "../../src/research/researcher.js";
import { freshDb, skipReason, truncate, TEST_DATABASE_URL } from "./helpers.js";

/* R16.2: database calibration is read-only, deterministic, and agrees with the live decision. */

const NOW = new Date("2026-10-15T12:00:00.000Z");

describe("readiness calibration against a database (read-only)", { skip: skipReason }, () => {
  let db: Db, seq = 0;
  before(async () => { db = await freshDb(); });
  beforeEach(async () => { await truncate(db); });
  after(async () => { await db?.$disconnect(); });

  /** Every row of every application table, so any write at all would show. */
  const everything = async () => {
    const tables = await db.$queryRawUnsafe<{ table_name: string }[]>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name");
    return Promise.all(tables.map(async ({ table_name }) => [table_name, await db.$queryRawUnsafe(`SELECT row_to_json(t)::text AS r FROM "${table_name}" t ORDER BY 1`)]));
  };

  async function seeded(name: string, opts: { version?: string; current?: boolean; phone?: string; website?: string } = {}) {
    const n = ++seq;
    const website = opts.website ?? `https://calibration${n}.example.com/`;
    const c = await db.discoveryCandidate.create({ data: { businessName: name, nameKey: name.toLowerCase(), provider: "manual", city: "Ventura", state: "CA", streetAddress: `${n} Main St`,
      website, phone: opts.phone ?? null, status: "researched", categoryVerdict: "in_target", categorySource: "website", websiteVerifiedAt: NOW } });
    const run = await db.candidateResearch.create({ data: { candidateId: c.id, version: opts.version ?? RESEARCH_VERSION, status: "completed", outcome: "website_verified", trigger: "cli", subjectWebsite: website, warnings: [], queuedAt: NOW, finishedAt: NOW } });
    const source = await db.researchSource.create({ data: { researchId: run.id, kind: "website", url: website, ok: true } });
    const facts: [string, string, string | null][] = opts.current === false ? [["address", `${n} Main St`, null]]
      : [["location_identity", "verified_location", null], ["ownership_class", "independent", null], ["site_locations", "1", null], ["page_location", "own_location", null], ["commercial_quote", "observed", "We are family-owned."]];
    for (const [field, value, excerpt] of facts) await db.researchFact.create({ data: { researchId: run.id, field, value, excerpt, state: "verified", sourceId: source.id } });
    await db.candidateSignal.create({ data: { candidateId: c.id, key: "automotive_repair_services", value: "yes", origin: "research" } });
    for (const excerpt of ["Names brakes: Brake repair for cars.", "Names engine: Engine repair for cars."])
      await db.candidateEvidence.create({ data: { candidateId: c.id, signalKey: "automotive_repair_services", sourceUrl: website, excerpt, origin: "research", researchId: run.id } });
    return c;
  }
  const seedAll = async () => {
    const ready = await seeded("Current Ready Garage");
    const stale = await seeded("Stale Garage", { version: "r15", current: false });
    const prot = await seeded("Protected Garage");
    const p = await db.prospect.create({ data: { referralCode: "calibration-protected", businessName: prot.businessName, website: prot.website, city: "Ventura", state: "CA" } });
    await db.outreach.create({ data: { prospectId: p.id, kind: "initial", template: "fixture", subject: "Keep", body: "Keep", evidence: [], generatedAt: NOW, recipientEmail: "office@example.com", recipientSourceUrl: prot.website!, status: "sent" } });
    const target = await seeded("Flagged Garage");
    await db.discoveryCandidate.create({ data: { businessName: "Flag Raiser", nameKey: "flag raiser", provider: "manual", possibleDuplicateCandidateId: target.id, duplicateHold: true, status: "needs_review" } });
    const phoneA = await seeded("Phone One", { phone: "(805) 555-0142" });
    const phoneB = await seeded("Phone Two", { phone: "(805) 555-0142" });
    return { ready, stale, prot, target, phoneA, phoneB };
  };

  test("classifies current, stale, protected and duplicate candidates exactly as the live decision does", async () => {
    const ids = await seedAll();
    const result = await calibrateReadiness(db, { now: NOW });
    const row = (id: string) => result.rows.find((r) => r.id === id)!;
    assert.equal(result.readOnly, "on");
    assert.deepEqual([row(ids.ready.id).immediate, row(ids.ready.id).projection.sufficient], ["still_ready", true]);
    assert.deepEqual([row(ids.stale.id).current.code, row(ids.stale.id).immediate, row(ids.stale.id).projection.sufficient], ["policy_refresh", "fresh_research", false]);
    assert.equal(row(ids.prot.id).immediate, "protected");
    assert.equal(row(ids.target.id).immediate, "duplicate_hold");
    for (const id of [ids.phoneA.id, ids.phoneB.id]) assert.ok(row(id).relationships.blocking.some((b) => /Same phone number/.test(b)));
    assert.equal(result.summary.workload.researchLoops, 0);
  });
  test("zero writes: every table is byte-identical and nothing is queued, even run twice", async () => {
    await seedAll();
    const before = await everything();
    const a = await calibrateReadiness(db, { now: NOW });
    const b = await calibrateReadiness(db, { now: NOW });
    assert.deepEqual(a, b, "deterministic for the same data and time");
    assert.deepEqual(await everything(), before);
    assert.equal(await db.candidateResearch.count({ where: { status: { in: ["queued", "running"] } } }), 0);
    assert.equal(await db.prospect.count(), 1);
  });
  test("limits to the requested candidates", async () => {
    const ids = await seedAll();
    const result = await calibrateReadiness(db, { ids: [ids.stale.id, ids.ready.id], now: NOW });
    assert.deepEqual(result.rows.map((r) => r.id), [ids.stale.id, ids.ready.id].sort());
  });
  test("the CLI reads the database read-only and writes only its report files", async () => {
    const ids = await seedAll();
    const before = await everything();
    const dir = await mkdtemp(path.join(tmpdir(), "calibration-"));
    try {
      const root = fileURLToPath(new URL("../../", import.meta.url));
      const env = { ...process.env, DATABASE_URL: TEST_DATABASE_URL, RESEARCH_AUTORUN_ENABLED: "0", OUTREACH_SENDING_ENABLED: "0" };
      const out = execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/scripts/readinessCalibration.ts", "--ids", `${ids.stale.id},${ids.ready.id}`, "--now", NOW.toISOString(),
        "--out", path.join(dir, "r.json"), "--markdown", path.join(dir, "r.md")], { cwd: root, env, encoding: "utf8" });
      const printed = JSON.parse(out) as { readOnly: string; summary: { candidates: number } };
      assert.equal(printed.readOnly, "on"); assert.equal(printed.summary.candidates, 2);
      assert.match(await readFile(path.join(dir, "r.md"), "utf8"), /leave Ready/);
      assert.deepEqual(await everything(), before);
      // Snapshot mode needs no database at all.
      const snapshot = { checkedAt: NOW.toISOString(), readOnly: "on", candidates: [] };
      await writeFile(path.join(dir, "s.json"), JSON.stringify(snapshot));
      const offline = JSON.parse(execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/scripts/readinessCalibration.ts", "--snapshot", path.join(dir, "s.json")],
        { cwd: root, env: { ...env, DATABASE_URL: "postgresql://unused.invalid:1/none" }, encoding: "utf8" })) as { summary: { candidates: number } };
      assert.equal(offline.summary.candidates, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
