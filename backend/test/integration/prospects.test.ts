import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Db } from "../../src/db.js";
import * as service from "../../src/prospects.js";
import { ProspectError } from "../../src/prospects.js";
import { SCORING_VERSION, scoreProspect } from "../../src/scoring.js";
import { WEBSITE, freshDb, readyForm, skipReason, truncate } from "./helpers.js";

const {
  addEvidence,
  addNote,
  changeStatus,
  createProspect,
  deleteEvidence,
  listProspects,
  rescoreProspects,
  scoringInputFromRecord,
  updateProspect,
} = service;

async function rejects(p: Promise<unknown>, pattern: RegExp, kind: ProspectError["kind"] = "invalid") {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof ProspectError, `expected ProspectError, got ${String(err)}`);
    assert.equal(err.kind, kind);
    assert.match(err.messages.join(" | "), pattern);
    return true;
  });
}

describe("prospect service", { skip: skipReason }, () => {
  let db: Db;
  before(async () => {
    db = await freshDb();
  });
  beforeEach(async () => truncate(db));
  after(async () => db?.$disconnect());

  const load = (id: string) => db.prospect.findUniqueOrThrow({ where: { id }, include: { signals: true } });

  describe("create", () => {
    test("stores fields, recorded signals only, cached score and a Created history row", async () => {
      const p = await createProspect(db, readyForm());
      const stored = await load(p.id);
      assert.match(stored.referralCode, /^rb_[a-z0-9]{12}$/);
      assert.equal(stored.state, "IL", "2-letter state is upper-cased");
      assert.equal(stored.country, "US");
      assert.equal(stored.status, "new");
      // unknown is not stored; derived yes is not stored either
      assert.deepEqual(stored.signals.map((s) => `${s.key}=${s.value}`).sort(), [
        "digital_inspections=yes",
        "general_repair_services=yes",
        "independent_shop=yes",
        "no_online_booking=no",
      ]);
      const expected = scoreProspect(scoringInputFromRecord(stored));
      assert.equal(stored.score, expected.score);
      assert.equal(stored.score, 25 + 20 + 10 + 10 + 5); // + public contact + has website
      assert.equal(stored.scoreVersion, SCORING_VERSION);
      assert.ok(stored.scoredAt);
      const history = await db.prospectStatusChange.findMany({ where: { prospectId: p.id } });
      assert.deepEqual(history.map((h) => [h.fromStatus, h.toStatus, h.reason]), [[null, "new", "Created"]]);
    });

    test("a name-only prospect is valid and scores 0", async () => {
      const p = await createProspect(db, { businessName: "Valley Motors" });
      assert.equal(p.score, 0);
    });

    test("rejects contact details without a public source", async () => {
      await rejects(createProspect(db, readyForm({ phoneSourceUrl: "" })), /public URL where it is listed/);
      await rejects(createProspect(db, readyForm({ email: "shop@smithauto.example.com" })), /Email needs the public URL/);
      await rejects(createProspect(db, readyForm({ phone: "", phoneSourceUrl: WEBSITE })), /without a phone/);
    });

    test("rejects malformed values", async () => {
      await rejects(createProspect(db, readyForm({ website: "javascript:alert(1)" })), /valid http\(s\) URL/);
      await rejects(createProspect(db, readyForm({ phone: "call us" })), /Phone must be/);
      await rejects(createProspect(db, readyForm({ email: "nope", emailSourceUrl: WEBSITE })), /Email must be/);
      await rejects(createProspect(db, readyForm({ country: "USA" })), /2-letter/);
      await rejects(createProspect(db, readyForm({ businessName: "x".repeat(121) })), /too long/);
      await rejects(createProspect(db, readyForm({ signal_independent_shop: "maybe" })), /Invalid value/);
    });

    test("rejects observations that contradict stored fields", async () => {
      await rejects(createProspect(db, readyForm({ website: "", signal_no_online_booking: "no" })), /only be observed on a website/);
      await rejects(createProspect(db, readyForm({ signal_has_website: "yes" })), /set automatically/);
      await rejects(createProspect(db, readyForm({ signal_has_website: "no" })), /website is stored/);
      assert.equal(await db.prospect.count(), 0, "nothing written on validation failure");
    });
  });

  describe("update", () => {
    test("recomputes the cached score when inputs change", async () => {
      const p = await createProspect(db, readyForm());
      const updated = await updateProspect(db, p.id, readyForm({ signal_multiple_bays_or_staff: "yes" }));
      assert.equal(updated.score, p.score + 15);
      const stored = await load(p.id);
      assert.equal(stored.score, scoreProspect(scoringInputFromRecord(stored)).score);
    });

    test("keeps observedAt for unchanged signals, drops signals set to unknown", async () => {
      const p = await createProspect(db, readyForm());
      const before = new Map((await load(p.id)).signals.map((s) => [s.key, s.observedAt.getTime()]));
      await new Promise((r) => setTimeout(r, 15));
      await updateProspect(db, p.id, readyForm({ signal_digital_inspections: "no", signal_no_online_booking: "unknown" }));
      const after = new Map((await load(p.id)).signals.map((s) => [s.key, s]));
      assert.equal(after.get("independent_shop")!.observedAt.getTime(), before.get("independent_shop"));
      assert.equal(after.get("digital_inspections")!.value, "no");
      assert.ok(after.get("digital_inspections")!.observedAt.getTime() > before.get("digital_inspections")!);
      assert.ok(!after.has("no_online_booking"));
    });

    test("leaves rows for signals retired by a newer scoring version untouched", async () => {
      const p = await createProspect(db, readyForm());
      await db.prospectSignal.create({ data: { prospectId: p.id, key: "retired_signal", value: "yes" } });
      await updateProspect(db, p.id, readyForm());
      const keys = (await load(p.id)).signals.map((s) => s.key);
      assert.ok(keys.includes("retired_signal"));
      assert.equal((await load(p.id)).score, p.score, "retired keys never score");
    });

    test("can't remove the requirements of the current status", async () => {
      const p = await createProspect(db, readyForm());
      await changeStatus(db, p.id, "qualified", null);
      await changeStatus(db, p.id, "ready_to_contact", null);
      await rejects(
        updateProspect(db, p.id, readyForm({ phone: "", phoneSourceUrl: "" })),
        /public business phone or email.*Move the prospect out of Ready to contact/,
      );
      await rejects(updateProspect(db, p.id, readyForm({ signal_independent_shop: "no" })), /this prospect is Disqualified/);
      await rejects(
        updateProspect(db, p.id, readyForm({ signal_general_repair_services: "unknown" })),
        /this prospect is Unverified/,
      );
      const stored = await load(p.id);
      assert.equal(stored.phone, "(555) 010-0100", "unchanged after refusal");
    });

    test("unknown prospect is not_found", async () => {
      await rejects(updateProspect(db, "00000000-0000-4000-8000-000000000000", readyForm()), /not found/, "not_found");
    });
  });

  describe("status", () => {
    test("walks the main path and records every change", async () => {
      const p = await createProspect(db, readyForm());
      for (const s of ["qualified", "ready_to_contact", "contacted", "engaged", "customer"]) {
        await changeStatus(db, p.id, s, null);
      }
      const stored = await load(p.id);
      assert.equal(stored.status, "customer");
      const history = await db.prospectStatusChange.findMany({ where: { prospectId: p.id }, orderBy: { createdAt: "asc" } });
      assert.deepEqual(
        history.map((h) => h.toStatus),
        ["new", "qualified", "ready_to_contact", "contacted", "engaged", "customer"],
      );
      assert.equal(history.at(-1)!.fromStatus, "engaged");
    });

    test("enforces gates", async () => {
      const noContact = await createProspect(db, readyForm({ phone: "", phoneSourceUrl: "" }));
      await rejects(changeStatus(db, noContact.id, "ready_to_contact", null), /Can't move from New/);
      await changeStatus(db, noContact.id, "qualified", null);
      await rejects(changeStatus(db, noContact.id, "ready_to_contact", null), /public business phone or email/);

      const chain = await createProspect(db, readyForm({ signal_independent_shop: "no" }));
      await rejects(changeStatus(db, chain.id, "qualified", null), /this prospect is Disqualified/);

      // Unverified (a required criterion unknown) is blocked however high the score.
      const unverified = await createProspect(
        db,
        readyForm({ businessName: "Unverified Auto", signal_general_repair_services: "unknown", signal_multiple_bays_or_staff: "yes" }),
      );
      assert.equal(unverified.score, 65, "High-band score");
      await rejects(changeStatus(db, unverified.id, "qualified", null), /this prospect is Unverified/);
      // Confirming the criterion unlocks it.
      await updateProspect(db, unverified.id, readyForm({ businessName: "Unverified Auto", signal_multiple_bays_or_staff: "yes" }));
      await changeStatus(db, unverified.id, "qualified", null);
      await changeStatus(db, unverified.id, "ready_to_contact", null);

      const unnamed = await createProspect(db, {});
      await rejects(changeStatus(db, unnamed.id, "qualified", null), /business name/);
      await rejects(changeStatus(db, unnamed.id, "bogus", null), /Unknown status/);
    });

    test("do_not_contact requires a reason and is permanent", async () => {
      const p = await createProspect(db, readyForm());
      await rejects(changeStatus(db, p.id, "do_not_contact", "  "), /requires a reason/);
      await changeStatus(db, p.id, "do_not_contact", "Owner asked by phone not to be contacted");
      for (const s of ["new", "archived", "ready_to_contact", "qualified"]) {
        await rejects(changeStatus(db, p.id, s, "reopen"), /permanent/);
      }
      // Editing details is still possible, but the status stays.
      await updateProspect(db, p.id, readyForm({ city: "Chatham" }));
      assert.equal((await load(p.id)).status, "do_not_contact");
    });

    test("racing identical changes: exactly one wins, one history row", async () => {
      // Whether the database runs these concurrently (compare-and-set
      // conflict) or one after the other ("Already Qualified"), only one
      // may apply.
      const p = await createProspect(db, readyForm());
      const results = await Promise.allSettled([
        changeStatus(db, p.id, "qualified", null),
        changeStatus(db, p.id, "qualified", null),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      const history = await db.prospectStatusChange.count({ where: { prospectId: p.id } });
      assert.equal(history, 2, "one Created row plus exactly one change");
    });
  });

  describe("notes and evidence", () => {
    test("adds notes; rejects empty and oversized", async () => {
      const p = await createProspect(db, readyForm());
      await addNote(db, p.id, "  Called the listed number; front desk said to email.  ");
      await rejects(addNote(db, p.id, "   "), /can't be empty/);
      await rejects(addNote(db, p.id, "x".repeat(2001)), /too long/);
      const notes = await db.prospectNote.findMany({ where: { prospectId: p.id } });
      assert.deepEqual(notes.map((n) => n.body), ["Called the listed number; front desk said to email."]);
    });

    test("evidence is tied to a real signal, a public URL, and a short excerpt", async () => {
      const p = await createProspect(db, readyForm());
      const e = await addEvidence(db, p.id, {
        signalKey: "digital_inspections",
        sourceUrl: `${WEBSITE}/services`,
        excerpt: "We text you photos from every digital inspection.",
      });
      assert.equal(e.signalKey, "digital_inspections");
      await rejects(addEvidence(db, p.id, { signalKey: "made_up", sourceUrl: WEBSITE, excerpt: "x" }), /Choose the signal/);
      await rejects(addEvidence(db, p.id, { signalKey: "has_website", sourceUrl: "ftp://x.example.com", excerpt: "x" }), /public http/);
      await rejects(
        addEvidence(db, p.id, { signalKey: "has_website", sourceUrl: WEBSITE, excerpt: "y".repeat(281) }),
        /at most 280/,
      );
      assert.equal(await db.prospectEvidence.count(), 1);
    });

    test("evidence can only be removed from its own prospect", async () => {
      const a = await createProspect(db, readyForm());
      const b = await createProspect(db, readyForm({ businessName: "Ace" }));
      const e = await addEvidence(db, a.id, { signalKey: "independent_shop", sourceUrl: WEBSITE, excerpt: "Family owned since 1984" });
      await rejects(deleteEvidence(db, b.id, e.id), /not found/, "not_found");
      await deleteEvidence(db, a.id, e.id);
      assert.equal(await db.prospectEvidence.count(), 0);
    });
  });

  describe("rescore", () => {
    test("recomputes stale caches only, unless asked for all", async () => {
      const p = await createProspect(db, readyForm());
      const q = await createProspect(db, readyForm({ businessName: "Ace" }));
      await db.prospect.update({ where: { id: p.id }, data: { score: 3, scoreVersion: "v0" } });
      assert.equal(await rescoreProspects(db), 1);
      assert.equal((await load(p.id)).score, q.score);
      assert.equal((await load(p.id)).scoreVersion, SCORING_VERSION);
      assert.equal(await rescoreProspects(db), 0, "idempotent");
      assert.equal(await rescoreProspects(db, { all: true }), 2);
    });
  });

  describe("list", () => {
    test("filters by search, status, qualification, band, and geography; sorts by score", async () => {
      const high = await createProspect(db, readyForm({ signal_multiple_bays_or_staff: "yes" })); // 85
      const medium = await createProspect(db, { businessName: "Ace Automotive", city: "Riverton", state: "WY", signal_independent_shop: "yes", signal_multiple_bays_or_staff: "yes" }); // 40
      const low = await createProspect(db, { businessName: "Valley Motors", city: "Fresno", state: "CA" }); // 0
      // Disqualified, yet scores 60: qualification and band are independent.
      const dq = await createProspect(db, readyForm({ businessName: "Midas Downtown", signal_independent_shop: "no", signal_multiple_bays_or_staff: "yes" }));
      assert.equal(dq.score, 60);
      await changeStatus(db, high.id, "qualified", null);

      const ids = async (f: service.ProspectFilters) => (await listProspects(db, f)).rows.map((r) => r.prospect.id);
      assert.deepEqual(await ids({}), [high.id, dq.id, medium.id, low.id], "score desc");
      assert.deepEqual(await ids({ q: "valley" }), [low.id]);
      assert.deepEqual(await ids({ q: "rb_" }), [high.id, dq.id, medium.id, low.id], "referral code search");
      assert.deepEqual(await ids({ status: "qualified" }), [high.id]);
      assert.deepEqual(await ids({ band: "high" }), [high.id, dq.id], "band is score-only, so it includes the disqualified shop");
      assert.deepEqual(await ids({ band: "medium" }), [medium.id]);
      assert.deepEqual(await ids({ band: "low" }), [low.id]);
      assert.deepEqual(await ids({ band: "disqualified" }), await ids({}), "no longer a band");
      assert.deepEqual(await ids({ qualification: "disqualified" }), [dq.id]);
      assert.deepEqual(await ids({ qualification: "meets_criteria" }), [high.id]);
      assert.deepEqual(await ids({ qualification: "unverified" }), [medium.id, low.id]);
      assert.deepEqual(await ids({ qualification: "meets_criteria", band: "high" }), [high.id], "rank qualified prospects");
      // The SQL filters agree with scoring.ts for every row.
      for (const r of (await listProspects(db, {})).rows) {
        const q = r.result.qualification;
        assert.ok((await ids({ qualification: q })).includes(r.prospect.id), `${r.prospect.businessName}: ${q}`);
        assert.ok((await ids({ band: r.result.band })).includes(r.prospect.id), `${r.prospect.businessName}: ${r.result.band}`);
      }
      assert.deepEqual(await ids({ state: "wy" }), [medium.id], "state is case-insensitive");
      assert.deepEqual(await ids({ city: "fres" }), [low.id]);
      assert.deepEqual(await ids({ sort: "name" }), [medium.id, dq.id, high.id, low.id]);
      assert.deepEqual(await ids({ status: "nonsense", band: "nonsense", qualification: "nonsense", sort: "nonsense" }), await ids({}));
      assert.ok((await listProspects(db, {})).rows.every((r) => !r.stale));
    });
  });

  test("there is no way to delete a prospect", () => {
    for (const name of Object.keys(service)) assert.doesNotMatch(name, /^(delete|remove)Prospect/i);
  });
});
