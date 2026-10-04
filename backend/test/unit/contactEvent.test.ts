import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, test } from "node:test";
import { EVENT_TYPES } from "../../src/validation.js";

/*
 * Design Partner v1: the contact_clicked event agrees across the allow-list,
 * the schema, and the migrations; and the site's contact link is built from
 * fixed constants only, so no report data can ever reach it.
 */

const backend = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");

describe("contact_clicked: the allow-list, the schema, and the migration agree", () => {
  test("the event allow-list is exactly the schema's EventType enum", () => {
    const block = /enum EventType \{([^}]*)\}/.exec(backend("prisma/schema.prisma"))![1]!;
    const values = block.split("\n").map((l) => l.trim()).filter(Boolean);
    assert.deepEqual([...EVENT_TYPES], values);
    assert.ok(EVENT_TYPES.includes("contact_clicked"));
  });

  test("exactly one migration adds it, additively", () => {
    const dir = new URL("../../prisma/migrations/", import.meta.url);
    const adding = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, sql: readFileSync(new URL(`${d.name}/migration.sql`, dir), "utf8") }))
      .filter((m) => m.sql.includes("contact_clicked"));
    assert.equal(adding.length, 1);
    const statements = adding[0]!.sql.split("\n").filter((l) => l.trim() && !l.trim().startsWith("--"));
    assert.deepEqual(statements, [`ALTER TYPE "EventType" ADD VALUE 'contact_clicked';`]);
  });
});

describe("the site's contact link (lib/contact.ts)", () => {
  // The site's own module, loaded as it ships (tsx compiles it; it has no imports).
  const load = async () =>
    (await import(new URL("../../../lib/contact.ts", import.meta.url).href)) as {
      CONTACT_EMAIL: string;
      CONTACT_SUBJECT: string;
      CONTACT_BODY: string;
      contactMailto: (...args: unknown[]) => string;
    };

  test("takes no arguments and always returns the same fixed link", async () => {
    const { contactMailto } = await load();
    assert.equal(contactMailto.length, 0, "the builder declares no parameters");
    // Even if something were passed, the link can't change: nothing reads it.
    assert.equal(contactMailto("$12,345", "Jane Customer", "report.csv"), contactMailto());
  });

  test("opens mail to hello@reclaimbay.com with the fixed subject and blank template", async () => {
    const { contactMailto, CONTACT_EMAIL } = await load();
    assert.equal(CONTACT_EMAIL, "hello@reclaimbay.com");
    const link = new URL(contactMailto());
    assert.equal(link.protocol, "mailto:");
    assert.equal(link.pathname, "hello@reclaimbay.com");
    assert.deepEqual([...link.searchParams.keys()], ["subject", "body"]);
    assert.equal(link.searchParams.get("subject"), "Talk to ReclaimBay");
    assert.equal(
      link.searchParams.get("body"),
      "Hi ReclaimBay,\n\nShop name:\nShop management system:\nBest phone or time to reach me:\nWhat I'd like help with:\n",
    );
    assert.ok(!contactMailto().includes("alex@"), "never the outreach sender's address");
  });

  test("the module is constants only: no imports, so no report or invitation data is in reach", () => {
    const source = readFileSync(new URL("../../../lib/contact.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /^\s*import\s/m);
    assert.match(source, /export function contactMailto\(\): string \{/);
  });
});
