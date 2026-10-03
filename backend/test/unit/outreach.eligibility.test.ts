import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { OPT_OUT_INSTRUCTION } from "../../src/outreach/compose.js";
import { sendingStatus } from "../../src/outreach/dispatch.js";
import { ELIGIBILITY_STAGES, eligibilityErrors, wasContacted, type EligibilityFacts } from "../../src/outreach/eligibility.js";

/*
 * The one outreach eligibility rule, and the sending headline. Pure: every
 * fact the rule needs is passed in.
 */

const CFG = {
  outreachSender: { name: "Alex Rivera", email: "hello@reclaimbay.example", postalAddress: "1 Main St, Ventura, CA 93001" },
  publicApiUrl: "https://api.reclaimbay.example",
};
const EMAIL = "service@shop.example.com";
const stored = {
  body: `Hello.\n\n${OPT_OUT_INSTRUCTION}\n1 Main St, Ventura, CA 93001`,
  recipientEmail: EMAIL,
  senderName: "Alex Rivera",
  senderEmail: "hello@reclaimbay.example",
  unsubscribeToken: "tok_0123456789abcdef",
};
const facts = (over: Partial<EligibilityFacts> = {}): EligibilityFacts => ({
  stage: "prepare",
  kind: "initial",
  prospect: { status: "ready_to_contact", businessName: "Shop Auto", hasPublicContact: true, qualification: "meets_criteria", email: EMAIL, emailSourceUrl: "https://shop.example.com/contact" },
  suppressed: [],
  bounced: false,
  firstSent: null,
  ...over,
});
const withMessage = (stage: "queue" | "send", over: Partial<EligibilityFacts> = {}) => facts({ stage, message: { stored, cfg: CFG }, ...over });

describe("outreach eligibility: one rule for preparing, queueing, and sending", () => {
  test("an eligible prospect passes at every stage", () => {
    assert.deepEqual(eligibilityErrors(facts()), []);
    assert.deepEqual(eligibilityErrors(withMessage("queue")), []);
    assert.deepEqual(eligibilityErrors(withMessage("send")), []);
    assert.deepEqual([...ELIGIBILITY_STAGES], ["prepare", "queue", "send"]);
  });

  test("anything that makes a business ineligible stops it at every stage, with the same reason", () => {
    const cases: [string, Partial<EligibilityFacts>, RegExp][] = [
      ["suppressed", { suppressed: [{ email: EMAIL, reason: "unsubscribed" }] }, /The address service@shop\.example\.com is suppressed \(unsubscribed\); it must not be emailed again\./],
      ["bounced", { bounced: true }, /A message to service@shop\.example\.com bounced/],
      ["Do not contact", { prospect: { ...facts().prospect, status: "do_not_contact" } }, /must never be contacted/],
      ["not qualified", { prospect: { ...facts().prospect, qualification: "unverified" } }, /Meets criteria/],
      ["no published email", { prospect: { ...facts().prospect, emailSourceUrl: null } }, /public business email with the URL where it was found/],
      ["already contacted", { firstSent: { sentAt: new Date("2026-09-01T10:00:00Z") } }, /A first message was already sent/],
    ];
    for (const [name, over, reason] of cases) {
      for (const f of [facts(over), withMessage("queue", over), withMessage("send", over)]) {
        assert.match(eligibilityErrors(f).join(" "), reason, `${name} at ${f.stage}`);
      }
    }
  });

  test("preparing says how to go on; a stored message is held to the sender and the address it was prepared for", () => {
    assert.match(eligibilityErrors(facts({ firstSent: { sentAt: new Date("2026-09-01T10:00:00Z") } })).join(), /already sent on 2026-09-01\. Prepare a follow-up to it instead\./);
    assert.deepEqual(eligibilityErrors(withMessage("send", { firstSent: { sentAt: null } })), ["A first message was already sent to this prospect."]);

    const moved = withMessage("send", { prospect: { ...facts().prospect, email: "new@shop.example.com" } });
    assert.match(eligibilityErrors(moved).join(), /business email changed since this message was prepared/);
    const otherSender = withMessage("queue", { message: { stored: { ...stored, senderEmail: "someone@else.example" }, cfg: CFG } });
    assert.match(eligibilityErrors(otherSender).join(), /prepared for a different sender email/);
    const noIdentity = withMessage("send", { message: { stored, cfg: { ...CFG, outreachSender: { name: null, email: null, postalAddress: null } } } });
    assert.match(eligibilityErrors(noIdentity).join(), /OUTREACH_SENDER_NAME/);
    assert.deepEqual(eligibilityErrors(facts({ message: undefined })), [], "preparing checks no stored message");
  });

  test("a first message is drafted and queued from New or Qualified, but only sent to Ready to contact", () => {
    for (const status of ["new", "qualified"] as const) {
      const prospect = { ...facts().prospect, status };
      assert.deepEqual(eligibilityErrors(facts({ prospect })), [], `prepare ${status}`);
      assert.deepEqual(eligibilityErrors(withMessage("queue", { prospect })), [], `queue ${status}`);
      assert.match(eligibilityErrors(withMessage("send", { prospect })).join(), /only sent to Ready to contact prospects/, `send ${status}`);
    }
  });

  test("a follow-up answers one sent, unanswered message of this prospect's, once", () => {
    const contacted = { ...facts().prospect, status: "contacted" as const };
    const sent = { status: "sent" as const, sentAt: new Date() };
    const fu = (followUp: EligibilityFacts["followUp"]) => eligibilityErrors(facts({ kind: "follow_up", prospect: contacted, followUp }));
    assert.deepEqual(fu({ original: sent, alreadyFollowedUp: false }), []);
    assert.match(fu({ original: null, alreadyFollowedUp: false }).join(), /isn't one of this prospect's/);
    assert.match(fu({ original: { status: "replied", sentAt: new Date() }, alreadyFollowedUp: false }).join(), /that one is Replied/);
    assert.match(fu({ original: sent, alreadyFollowedUp: true }).join(), /already has a follow-up/);
    assert.deepEqual(
      eligibilityErrors(facts({ kind: "follow_up", prospect: contacted, firstSent: { sentAt: new Date() } })),
      [],
      "an earlier first message doesn't block a follow-up",
    );
  });

  test("an address contacted for another business is never prepared, queued, or sent for this one", () => {
    const elsewhere = { contactedElsewhere: { email: EMAIL, businessName: "Other Shop Auto" } };
    for (const f of [facts(elsewhere), withMessage("queue", elsewhere), withMessage("send", elsewhere)]) {
      assert.match(eligibilityErrors(f).join(" "), /The address service@shop\.example\.com was already contacted for Other Shop Auto\. An address is only ever emailed for one business\./, f.stage);
    }
    assert.deepEqual(eligibilityErrors(facts({ contactedElsewhere: null })), []);
  });

  test("a follow-up goes only to the address its first message went to", () => {
    const contacted = { ...facts().prospect, status: "contacted" as const };
    const followUp = { original: { status: "sent" as const, sentAt: new Date() }, alreadyFollowedUp: false };
    assert.deepEqual(eligibilityErrors(facts({ kind: "follow_up", prospect: contacted, followUp, firstRecipient: EMAIL })), []);
    const moved = { ...contacted, email: "new@shop.example.com" };
    assert.match(eligibilityErrors(facts({ kind: "follow_up", prospect: moved, followUp, firstRecipient: EMAIL })).join(), /goes to the address the first message was sent to \(service@shop\.example\.com\)/);
    // Queued or sending: the stored follow-up, too.
    const stuck = withMessage("send", { kind: "follow_up", prospect: { ...contacted, email: "new@shop.example.com" }, firstRecipient: EMAIL });
    assert.match(eligibilityErrors(stuck).join(), /goes to the address the first message was sent to/);
    assert.deepEqual(eligibilityErrors(facts({ firstRecipient: "someone@else.example" })), [], "only a follow-up is held to its first message's address");
  });

  test("contacted: the send started and wasn't refused before it went out", () => {
    const at = new Date();
    const cases: [string, Parameters<typeof wasContacted>[0], boolean][] = [
      ["a draft", { status: "draft", sentAt: null, sendStartedAt: null }, false],
      ["queued, not claimed", { status: "queued", sendStartedAt: null, sentAt: null }, false],
      ["queued, outcome unknown", { status: "queued", sendStartedAt: at, sentAt: null }, true],
      ["sent", { status: "sent", sendStartedAt: at, sentAt: at }, true],
      ["bounced", { status: "bounced", sendStartedAt: at, sentAt: at }, true],
      ["replied", { status: "replied", sendStartedAt: at, sentAt: at }, true],
      ["refused before sending", { status: "failed", sendStartedAt: at, sentAt: null }, false],
      ["failed after sending", { status: "failed", sendStartedAt: at, sentAt: at }, true],
      ["cancelled before its send", { status: "cancelled", sendStartedAt: null, sentAt: null }, false],
      ["cancelled after its send started", { status: "cancelled", sendStartedAt: at, sentAt: null }, true],
      ["confirmed sent by a person", { status: "sent", sendStartedAt: at, sentAt: at }, true],
    ];
    for (const [name, o, expected] of cases) assert.equal(wasContacted(o), expected, name);
  });

  test("no step keeps its own copy of the rule", () => {
    const read = (f: string) => readFileSync(new URL(`../../src/outreach/${f}`, import.meta.url), "utf8");
    for (const f of ["service.ts", "dispatch.ts", "prepare.ts"]) {
      assert.doesNotMatch(read(f), /draftEligibilityErrors|emailSuppression\.find/, `${f} decides eligibility only through eligibility.ts`);
    }
    assert.match(read("service.ts"), /outreachEligibility\(tx, \{ stage: "prepare"/);
    assert.match(read("service.ts"), /messageEligibilityErrors\(tx, o, cfg, "queue"\)/);
    assert.match(read("dispatch.ts"), /messageEligibilityErrors\(tx, o, cfg, "send"\)/);
  });
});

describe("the sending headline: is mail going out, and if not, why", () => {
  const base = { switchOn: true, blockers: [] as string[], remaining: 17, limit: 20, queued: 4 };

  test("off is off, whatever else is ready", () => {
    const s = sendingStatus({ ...base, switchOn: false });
    assert.equal(s.label, "Sending is OFF");
    assert.equal(s.tone, "quiet");
    assert.equal(sendingStatus({ ...base, switchOn: false, blockers: ["No email provider is configured."] }).label, "Sending is OFF");
  });

  test("on, but blocked: says so, with the first reason", () => {
    const s = sendingStatus({ ...base, blockers: ["Gmail authorization was revoked.", "Second."] });
    assert.equal(s.label, "Sending is ON, but blocked");
    assert.equal(s.tone, "neg");
    assert.equal(s.detail, "Nothing can be sent: Gmail authorization was revoked.");
  });

  test("on, with the daily limit used up: paused, not broken", () => {
    const s = sendingStatus({ ...base, remaining: 0 });
    assert.equal(s.label, "Sending is ON, paused by the daily limit");
    assert.equal(s.tone, "warn");
    assert.match(s.detail, /All 20 sends/);
  });

  test("on and able to send: what is waiting and how much room is left", () => {
    assert.deepEqual(sendingStatus(base), { tone: "pos", glyph: "●", label: "Sending is ON", detail: "4 queued. 17 of 20 daily sends left." });
    assert.equal(sendingStatus({ ...base, queued: 0 }).detail, "Nothing is queued. 17 of 20 daily sends left.");
  });

  test("every state pairs its colour with a glyph and words", () => {
    const states = [sendingStatus({ ...base, switchOn: false }), sendingStatus({ ...base, blockers: ["x"] }), sendingStatus({ ...base, remaining: 0 }), sendingStatus(base)];
    assert.equal(new Set(states.map((s) => s.glyph)).size, 4);
    assert.equal(new Set(states.map((s) => s.label)).size, 4);
  });
});
