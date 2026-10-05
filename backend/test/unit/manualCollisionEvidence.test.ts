import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { collisionEvidenceErrors, hasCollisionResearchConflict } from "../../src/research/collisionFit.js";

const business = { businessName: "Harbor Collision", website: "https://harbor.example.com" };
const evidence = (excerpt = "We offer collision repair.", sourceUrl = `${business.website}/services`, signalKey = "collision_repair_services") => ({ signalKey, sourceUrl, excerpt });

describe("stored manual collision evidence", () => {
  test("Yes needs actual collision-specific evidence, not a name, mechanical signal or generic attestation", () => {
    for (const items of [[], [evidence("Brakes and oil changes.")], [evidence("Harbor Collision")], [evidence("Public page supports collision_repair_services.")], [evidence("We offer collision repair.", undefined, "general_repair_services")]]) assert.ok(collisionEvidenceErrors(business, items).length);
  });
  test("source-backed repair and human-verified specialty evidence work", () => {
    for (const text of ["We offer collision repair.", "We provide auto body repair.", "We offer automotive paintless dent repair."]) assert.deepEqual(collisionEvidenceErrors(business, [evidence(text)]), []);
  });
  test("unattributed, malformed, blank and third-party evidence cannot support fit", () => {
    for (const item of [evidence(undefined, "https://other.example.com/services"), evidence(undefined, "ftp://harbor.example.com/services"), evidence(undefined, "https://user:password@harbor.example.com/services"), evidence(" "), evidence("We outsource collision repair."), evidence("We sell collision repair equipment.")]) assert.ok(collisionEvidenceErrors(business, [item]).length);
  });
  test("positive and negative excerpts stay contradictory regardless of order", () => {
    const yes = evidence(); const no = evidence("We do not offer collision repair.");
    for (const items of [[yes, no], [no, yes], [no]]) assert.match(collisionEvidenceErrors(business, items).join(" "), /contradictory/);
  });
  test("a public listing without a website must explicitly identify the recorded business", () => {
    const noSite = { ...business, website: null };
    assert.ok(collisionEvidenceErrors(noSite, [evidence()]).length);
    assert.deepEqual(collisionEvidenceErrors(noSite, [evidence("Harbor Collision: We offer collision repair.")]), []);
  });
  test("a changed website cannot reuse the old website's evidence", () => {
    assert.ok(collisionEvidenceErrors({ ...business, website: "https://changed.example.com" }, [evidence()]).length);
  });
  test("shared listing hosts do not establish identity merely by matching the hostname", () => {
    const listing = { ...business, website: "https://www.facebook.com/harbor" };
    assert.ok(collisionEvidenceErrors(listing, [evidence(undefined, "https://www.facebook.com/another-shop")]).length);
    assert.deepEqual(collisionEvidenceErrors(listing, [evidence("Harbor Collision: We offer collision repair.", "https://www.facebook.com/harbor")]), []);
  });
  test("completed research disagreement uses the existing collision conflict rule", () => {
    assert.equal(hasCollisionResearchConflict(["Collision/body evidence is contradictory; verify product fit manually."]), true);
    assert.equal(hasCollisionResearchConflict(['Research found "collision_repair_services" = no, but a person recorded yes; the person\'s value was kept.']), true);
    assert.equal(hasCollisionResearchConflict([]), false);
  });
});
