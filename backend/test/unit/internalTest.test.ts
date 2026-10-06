import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, test } from "node:test";
import { parseProspectInput } from "../../src/prospects.js";

/*
 * The internal outreach test (Prospect.internalTest) is a database mark set
 * once, at creation, by one function; read only to leave tests out of the
 * business metrics and to label them. Nothing that drafts, queues, sends, or
 * reads the inbox knows it exists: an internal test goes through every check.
 */

const SRC = new URL("../../src/", import.meta.url);
const files = (dir: URL): string[] =>
  readdirSync(dir).flatMap((f) => {
    const u = new URL(f, dir);
    if (statSync(u).isDirectory()) return f === "generated" ? [] : files(new URL(`${f}/`, dir)).map((g) => `${f}/${g}`);
    return f.endsWith(".ts") ? [f] : [];
  });
const read = (f: string) => readFileSync(new URL(f, SRC), "utf8");
const mentioning = files(SRC).filter((f) => read(f).includes("internalTest"));

describe("internal outreach test: one mark, set once, never special-cased", () => {
  test("only these files mention it: creation, the metric exclusions, and labels", () => {
    assert.deepEqual(mentioning.sort(), [
      "admin/commandCenter.ts", // read-only metric exclusions and activity labels
      "admin/outreachViews.ts", // label
      "admin/prospectViews.ts", // label, the form
      "admin/stats.ts", // excluded from the analytics summary and prospect intent
      "admin/ui.ts", // the label itself
      "outreach/metrics.ts", // excluded from the funnel
      "outreach/operations.ts", // selected for the label
      "prospects.ts", // the one creation path
      "routes/admin.ts", // the form's route
      "routes/adminOutreach.ts", // read-only prospect filter labels
    ]);
  });

  test("nothing that drafts, queues, sends, or reads the inbox special-cases it", () => {
    for (const f of ["outreach/dispatch.ts", "outreach/eligibility.ts", "outreach/records.ts", "outreach/service.ts", "outreach/prepare.ts", "outreach/compliance.ts", "outreach/lifecycle.ts", "outreach/gmail.ts", "outreach/gmailInbox.ts", "outreach/sender.ts", "invitations/service.ts"]) {
      assert.doesNotMatch(read(f), /internalTest/, `${f} treats every prospect alike`);
    }
  });

  test("it is written in exactly two places: insertProspect stores what createInternalTestProspect passes", () => {
    const writes = [...read("prospects.ts").matchAll(/internalTest: ([^,\n}]+)/g)].map((m) => m[1]!.trim());
    assert.deepEqual(writes, ["details.internalTest === true", "true"]);
    assert.match(read("prospects.ts"), /export async function createInternalTestProspect[\s\S]*?raw\.confirmInternalTest !== "yes"[\s\S]*?\{ internalTest: true, notes: \[INTERNAL_TEST_NOTE\] \}/);
    // Everywhere else it's only ever compared with false (excluded), selected or copied (labelled), or typed.
    for (const f of ["admin/stats.ts", "outreach/metrics.ts", "outreach/operations.ts"]) {
      for (const m of read(f).matchAll(/internalTest: ([^,\n}]+)/g)) assert.ok(["false", "true", "p.internalTest", "boolean;"].includes(m[1]!.trim()), `${f}: ${m[0]}`);
    }
  });

  test("the prospect form's fields never carry it: a submitted internalTest is ignored", () => {
    const { input } = parseProspectInput({ businessName: "Smith Auto", internalTest: "true", confirmInternalTest: "yes" });
    assert.equal("internalTest" in input.fields, false);
    assert.equal(JSON.stringify(input).includes("internalTest"), false);
  });
});
