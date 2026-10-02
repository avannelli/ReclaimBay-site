import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, test } from "node:test";
import {
  FOLLOW_UP_TEMPLATE,
  INTRO_TEMPLATE,
  campaignOf,
  composeFollowUp,
  composeIntro,
  OPT_OUT_INSTRUCTION,
  outreachFacts,
  servicesFromExcerpt,
  type ComposeInput,
} from "../../src/outreach/compose.js";
import {
  OPEN_STATUSES,
  OUTREACH_CLOSED,
  OUTREACH_STATUSES,
  OUTREACH_TRANSITIONS,
  REPLY_OUTCOMES,
  REPLY_PROSPECT_STATUS,
  draftEligibilityErrors,
  isValidEmail,
  outreachTransitionErrors,
  type DraftContext,
} from "../../src/outreach/lifecycle.js";
import { SendingDisabledError, disabledSender, senderFromConfig } from "../../src/outreach/sender.js";
import { loadConfig } from "../../src/config.js";
import { listUnsubscribeHeaders, messageComplianceErrors, senderIdentityErrors, unsubscribeUrl, type MessageForCompliance } from "../../src/outreach/compliance.js";
import { readinessErrors } from "../../src/outreach/dispatch.js";
import { OUTREACH_ELIGIBLE, STATUSES, statusRequirementErrors, transitionErrors, type StatusContext } from "../../src/prospectStatus.js";

const SITE = "https://smithauto.example.com/";
const input = (over: Partial<ComposeInput> = {}): ComposeInput => ({
  businessName: "Smith Auto",
  city: "Springfield",
  state: "IL",
  website: SITE,
  email: "service@smithauto.example.com",
  emailSourceUrl: `${SITE}contact`,
  signals: [
    { key: "independent_shop", value: "yes" },
    { key: "general_repair_services", value: "yes" },
    { key: "digital_inspections", value: "yes" },
  ],
  evidence: [
    { signalKey: "independent_shop", sourceUrl: SITE, excerpt: "Family owned since 1998." },
    { signalKey: "general_repair_services", sourceUrl: SITE, excerpt: "Names brakes, engine diagnostics, A/C: …Brake Service Diagnostics A/C Repairs…" },
    { signalKey: "digital_inspections", sourceUrl: `${SITE}inspections`, excerpt: "Our digital inspections include photos." },
  ],
  referralUrl: "https://reclaimbay.com/?ref=rb_abcdefghijkl&campaign=outreach-intro-t1",
  sender: { name: null, postalAddress: null },
  ...over,
});

describe("outreach lifecycle rules", () => {
  test("every message status has a transition entry; end states are final", () => {
    for (const s of OUTREACH_STATUSES) assert.ok(Array.isArray(OUTREACH_TRANSITIONS[s]), s);
    for (const s of ["bounced", "failed", "replied", "cancelled"] as const) assert.deepEqual(OUTREACH_TRANSITIONS[s], [], s);
    assert.deepEqual([...OPEN_STATUSES], ["draft", "queued"]);
  });

  test("the main path is allowed step by step; skipping is refused", () => {
    const path = ["draft", "queued", "sent", "delivered", "replied"] as const;
    for (let i = 1; i < path.length; i++) assert.deepEqual(outreachTransitionErrors(path[i - 1]!, path[i]!), [], `${path[i - 1]} -> ${path[i]}`);
    assert.deepEqual(outreachTransitionErrors("sent", "replied"), [], "a reply needs no delivery receipt");
    assert.equal(outreachTransitionErrors("draft", "sent").length, 1, "a draft is never sent without being queued");
    assert.equal(outreachTransitionErrors("draft", "replied").length, 1);
    assert.equal(outreachTransitionErrors("cancelled", "draft").length, 1, "a cancelled draft can't be revived");
    assert.match(outreachTransitionErrors("draft", "draft")[0]!, /Already/);
  });

  const ready: DraftContext = {
    status: "new",
    businessName: "Smith Auto",
    hasPublicContact: true,
    qualification: "meets_criteria",
    email: "service@smithauto.example.com",
    emailSourceUrl: `${SITE}contact`,
  };

  test("a first draft: qualified, a published email, and New, Qualified, or Ready to contact", () => {
    for (const status of ["new", "qualified", "ready_to_contact"] as const) assert.deepEqual(draftEligibilityErrors("initial", { ...ready, status }), [], status);
    assert.match(draftEligibilityErrors("initial", { ...ready, qualification: "unverified" }).join(), /Outreach requires Qualification "Meets criteria"; this prospect is Unverified/);
    assert.match(draftEligibilityErrors("initial", { ...ready, qualification: "disqualified" }).join(), /Disqualified/);
    assert.match(draftEligibilityErrors("initial", { ...ready, businessName: null }).join(), /Outreach requires a business name/);
    assert.deepEqual(draftEligibilityErrors("initial", { ...ready, email: null, emailSourceUrl: null }), ["Outreach requires a public business email with the URL where it was found."]);
    assert.deepEqual(draftEligibilityErrors("initial", { ...ready, emailSourceUrl: null }), ["Outreach requires a public business email with the URL where it was found."]);
  });

  test("closed, contacted, or later prospects can't get a first draft; Do not contact can't get anything", () => {
    for (const status of ["contacted", "engaged", "meeting", "proposal", "customer", "not_a_fit", "lost", "archived"] as const) {
      assert.match(draftEligibilityErrors("initial", { ...ready, status }).join(), /only prepared for New, Qualified, Ready to contact/, status);
    }
    assert.deepEqual(draftEligibilityErrors("initial", { ...ready, status: "do_not_contact" }), ["This prospect must never be contacted."]);
    assert.deepEqual(draftEligibilityErrors("follow_up", { ...ready, status: "do_not_contact" }), ["This prospect must never be contacted."]);
  });

  test("a follow-up is only for a Contacted prospect", () => {
    assert.deepEqual(draftEligibilityErrors("follow_up", { ...ready, status: "contacted" }), []);
    for (const status of ["new", "ready_to_contact", "engaged", "lost"] as const) assert.equal(draftEligibilityErrors("follow_up", { ...ready, status }).length, 1, status);
  });

  test("only Ready to contact may be queued for sending", () => {
    assert.deepEqual([...OUTREACH_ELIGIBLE], ["ready_to_contact"]);
  });

  test("every reply outcome maps to a prospect move that is allowed from Contacted", () => {
    const ctx: StatusContext = { businessName: "Smith Auto", hasPublicContact: true, qualification: "meets_criteria" };
    for (const r of REPLY_OUTCOMES) assert.deepEqual(transitionErrors("contacted", REPLY_PROSPECT_STATUS[r], ctx, "Replied."), [], r);
    assert.equal(REPLY_PROSPECT_STATUS.do_not_contact, "do_not_contact");
    assert.equal(REPLY_PROSPECT_STATUS.unclassified, "engaged");
  });

  test("statuses that end outreach include Do not contact and never Ready to contact", () => {
    assert.ok(OUTREACH_CLOSED.includes("do_not_contact"));
    for (const s of OUTREACH_ELIGIBLE) assert.ok(!OUTREACH_CLOSED.includes(s));
  });
});

describe("commercial outcome statuses", () => {
  const ctx: StatusContext = { businessName: "Smith Auto", hasPublicContact: true, qualification: "meets_criteria" };
  test("engaged -> meeting -> proposal -> customer, and Lost from any stage after contact", () => {
    const path = ["contacted", "engaged", "meeting", "proposal", "customer"] as const;
    for (let i = 1; i < path.length; i++) assert.deepEqual(transitionErrors(path[i - 1]!, path[i]!, ctx, null), [], `${path[i - 1]} -> ${path[i]}`);
    for (const s of ["contacted", "engaged", "meeting", "proposal"] as const) assert.deepEqual(transitionErrors(s, "lost", ctx, "Went with another tool."), [], s);
    assert.equal(transitionErrors("new", "meeting", ctx, null).length, 1, "a meeting needs contact first");
  });

  test("Lost needs a reason; Meeting, Proposal, and Lost carry no field requirements", () => {
    assert.match(transitionErrors("contacted", "lost", ctx, null).join(), /requires a reason/);
    const empty: StatusContext = { businessName: null, hasPublicContact: false, qualification: "disqualified" };
    for (const s of ["meeting", "proposal", "lost"] as const) assert.deepEqual(statusRequirementErrors(s, empty), [], s);
    assert.ok(STATUSES.includes("lost"));
  });
});

describe("outreach message generation", () => {
  test("services come only from research's own vocabulary", () => {
    assert.deepEqual(servicesFromExcerpt("Names brakes, suspension/steering, A/C: …"), ["brakes", "suspension and steering", "A/C"]);
    assert.deepEqual(servicesFromExcerpt("Names brakes, laser tag: …"), ["brakes"], "an unknown label is dropped");
    assert.deepEqual(servicesFromExcerpt("We do brakes and A/C."), [], "a person's free-text excerpt names nothing");
  });

  test("the first message uses the stored facts, and says where each came from", () => {
    const m = composeIntro(input());
    assert.equal(m.template, INTRO_TEMPLATE);
    assert.equal(m.campaign, campaignOf(INTRO_TEMPLATE));
    assert.equal(m.campaign, "outreach-intro-t1");
    assert.equal(m.subject, "Declined work at Smith Auto");
    assert.match(m.body, /^Hi Smith Auto team,/);
    assert.match(m.body, /I came across Smith Auto in Springfield, IL while looking for independent auto repair shops\./);
    assert.match(m.body, /I saw that you handle brakes, engine diagnostics, and A\/C, and that you offer digital inspections\./);
    assert.ok(m.body.includes("https://reclaimbay.com/?ref=rb_abcdefghijkl&campaign=outreach-intro-t1"));
    assert.match(m.body, /reply "no thanks" and we won't contact Smith Auto again/);
    assert.deepEqual(
      m.evidence.map((f) => f.key),
      ["business_name", "recipient", "location", "independent_shop", "general_repair_services", "digital_inspections"],
    );
    const sources = new Set(input().evidence.map((e) => e.sourceUrl));
    for (const f of m.evidence) {
      if (f.signalKey) assert.ok(f.sourceUrl && sources.has(f.sourceUrl) && f.excerpt, `${f.key} carries its evidence`);
    }
    assert.equal(m.evidence.find((f) => f.key === "recipient")!.sourceUrl, `${SITE}contact`);
  });

  test("a signal without evidence, a 'no', or an unknown is never mentioned", () => {
    const noEvidence = composeIntro(input({ evidence: input().evidence.filter((e) => e.signalKey !== "digital_inspections") }));
    assert.doesNotMatch(noEvidence.body, /inspection/i);
    assert.ok(!noEvidence.evidence.some((f) => f.key === "digital_inspections"));

    const no = composeIntro(input({ signals: [...input().signals.filter((s) => s.key !== "digital_inspections"), { key: "digital_inspections", value: "no" }] }));
    assert.doesNotMatch(no.body, /inspection/i);

    const notIndependent = composeIntro(input({ evidence: input().evidence.filter((e) => e.signalKey !== "independent_shop") }));
    assert.match(notIndependent.body, /looking for auto repair shops/);
    assert.doesNotMatch(notIndependent.body, /independent/);

    const noCity = composeIntro(input({ city: null, state: null }));
    assert.match(noCity.body, /I came across Smith Auto while looking/);
  });

  test("general repair without named services stays general", () => {
    const m = composeIntro(input({ evidence: input().evidence.map((e) => (e.signalKey === "general_repair_services" ? { ...e, excerpt: "Full-service repair shop." } : e)) }));
    assert.match(m.body, /I saw that you do general repair work and offer digital inspections\./);
  });

  test("excerpts are references, never quoted into the message", () => {
    const m = composeIntro(input());
    for (const e of input().evidence) assert.ok(!m.body.includes(e.excerpt), e.signalKey);
  });

  test("website-condition facts are recorded but not used by intro@t1", () => {
    const withSite = input({
      signals: [...input().signals, { key: "website_not_https", value: "yes" }, { key: "no_online_booking", value: "yes" }],
      evidence: [...input().evidence, { signalKey: "website_not_https", sourceUrl: SITE, excerpt: "http only" }, { signalKey: "no_online_booking", sourceUrl: SITE, excerpt: "No scheduler." }],
    });
    const keys = outreachFacts(withSite).map((f) => f.key);
    assert.ok(keys.includes("website_not_https") && keys.includes("no_online_booking"));
    const m = composeIntro(withSite);
    assert.doesNotMatch(m.body, /not on HTTPS|online booking/i);
    assert.ok(!m.evidence.some((f) => f.key === "website_not_https"));
  });

  test("the sender's name and postal address are used when configured, and nothing is invented when not", () => {
    assert.match(composeIntro(input()).body, /The ReclaimBay team/);
    const signed = composeIntro(input({ sender: { name: "Alex", postalAddress: "1 Main St, Ventura, CA 93001" } })).body;
    assert.match(signed, /Alex\nReclaimBay/);
    assert.match(signed, /1 Main St, Ventura, CA 93001$/);
  });

  test("generation is deterministic", () => {
    assert.deepEqual(composeIntro(input()), composeIntro(input()));
  });

  test("a follow-up refers to the first message by date and keeps the thread subject", () => {
    const m = composeFollowUp(input(), { subject: "Declined work at Smith Auto", sentAt: new Date("2026-10-02T15:00:00Z") });
    assert.equal(m.template, FOLLOW_UP_TEMPLATE);
    assert.equal(m.subject, "Re: Declined work at Smith Auto");
    assert.match(m.body, /Following up on my note from 2026-10-02/);
    assert.equal(composeFollowUp(input(), { subject: "Re: x", sentAt: new Date() }).subject, "Re: x");
  });
});

describe("no sending in this version", () => {
  test("the only sender refuses to send", async () => {
    assert.equal(disabledSender.enabled, false);
    assert.equal(senderFromConfig(loadConfig({ DATABASE_URL: "postgres://x", RESEND_API_KEY: "re_x", OUTREACH_SENDING_ENABLED: "1" })), disabledSender, "without OUTREACH_PROVIDER nothing can send");
    await assert.rejects(
      disabledSender.send({ outreachId: "x", idempotencyKey: "outreach-x", attempt: 1, firstAttemptAt: new Date(), to: "a@b.co", from: { name: "A", email: "c@d.co" }, replyTo: "c@d.co", subject: "s", text: "b", headers: {} }),
      SendingDisabledError,
    );
  });

  test("no email library is installed and outreach code makes no network calls", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).join(" ");
    assert.doesNotMatch(deps, /mail|smtp|resend|sendgrid|postmark|mailgun|ses|gmail|googleapis/i);

    // Only the Gmail adapter talks to the network, and only through the fetch it is given.
    const dir = new URL("../../src/outreach/", import.meta.url);
    const files = readdirSync(dir)
      // sender.ts only hands the injected fetch to the Gmail layer.
      .filter((f) => f !== "gmail.ts" && f !== "gmailAuth.ts" && f !== "sender.ts")
      .map((f) => [f, readFileSync(new URL(f, dir), "utf8")] as const);
    files.push(["adminOutreach.ts", readFileSync(new URL("../../src/routes/adminOutreach.ts", import.meta.url), "utf8")]);
    // Passing an injected fetch along is fine; calling one is not.
    for (const [f, src] of files) assert.doesNotMatch(src, /\bfetch\(|from "node:(net|tls|http|https|dgram)"|nodemailer/i, f);
    const gmail = readFileSync(new URL("gmail.ts", dir), "utf8");
    assert.doesNotMatch(gmail, /from "node:(net|tls|http|https|dgram)"|nodemailer|smtp\.gmail\.com/i);
    assert.equal((gmail.match(/\bthis\.fetchImpl\(/g) ?? []).length, 1, "the API call, through the injected fetch");
    const auth = readFileSync(new URL("gmailAuth.ts", dir), "utf8");
    assert.doesNotMatch(auth, /from "node:(net|tls|http|https|dgram)"|nodemailer|createSign|private_key/i, "no hand-rolled OAuth signing");
    assert.match(auth, /fetchImplementation: fetchImpl/, "the official OAuth library uses the injected fetch");
  });
});

describe("sending compliance and readiness", () => {
  const ready = {
    outreachSender: { name: "Alex Rivera", email: "alex@reclaimbay.example", postalAddress: "1 Main St, Ventura, CA 93001" },
    publicApiUrl: "https://api.reclaimbay.example",
    outreachSendingArmed: true,
  };
  const message = (over: Partial<MessageForCompliance> = {}): MessageForCompliance => ({
    body: `Hi.\n\nIf you'd rather not hear from us, reply "no thanks" and we won't contact Smith Auto again.\n1 Main St, Ventura, CA 93001`,
    recipientEmail: "service@smithauto.example.com",
    senderName: "Alex Rivera",
    senderEmail: "alex@reclaimbay.example",
    unsubscribeToken: "abcdefghijklmnopqrstuvwxyz012345",
    ...over,
  });

  test("a sender needs a name, a valid email, a postal address, and an unsubscribe URL", () => {
    assert.deepEqual(senderIdentityErrors(ready), []);
    const none = senderIdentityErrors({ outreachSender: { name: null, email: null, postalAddress: null }, publicApiUrl: null });
    assert.equal(none.length, 4);
    assert.match(none.join(" "), /OUTREACH_SENDER_NAME.*OUTREACH_SENDER_EMAIL.*OUTREACH_POSTAL_ADDRESS.*PUBLIC_API_URL/);
    assert.match(senderIdentityErrors({ ...ready, outreachSender: { ...ready.outreachSender, email: "not an email" } }).join(), /isn't a valid address/);
  });

  test("a message must carry the opt-out, the postal address, its sender, and an unsubscribe token", () => {
    assert.deepEqual(messageComplianceErrors(message(), ready), []);
    assert.match(messageComplianceErrors(message({ body: "Hi. 1 Main St, Ventura, CA 93001" }), ready).join(), /how to opt out/);
    assert.match(messageComplianceErrors(message({ body: `reply "no thanks"` }), ready).join(), /postal address/);
    assert.match(messageComplianceErrors(message({ senderName: null }), ready).join(), /different sender name/);
    assert.match(messageComplianceErrors(message({ unsubscribeToken: null }), ready).join(), /no unsubscribe link/);
    assert.match(messageComplianceErrors(message({ recipientEmail: "Smith <a@b.co>" }), ready).join(), /isn't a valid address/);
    assert.ok(composeIntro(input({ sender: { name: "Alex Rivera", postalAddress: "1 Main St, Ventura, CA 93001" } })).body.includes(OPT_OUT_INSTRUCTION), "the template carries the opt-out the check looks for");
  });

  test("one-click unsubscribe headers follow RFC 8058", () => {
    const url = unsubscribeUrl("https://api.reclaimbay.example", "tok_123-abc");
    assert.equal(url, "https://api.reclaimbay.example/u/tok_123-abc");
    assert.deepEqual(listUnsubscribeHeaders(url, "alex@reclaimbay.example"), {
      "List-Unsubscribe": "<https://api.reclaimbay.example/u/tok_123-abc>, <mailto:alex@reclaimbay.example?subject=unsubscribe>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  test("email validity: one plain address with a dotted domain", () => {
    for (const ok of ["service@shop.example.com", "a.b+c@x-y.co"]) assert.ok(isValidEmail(ok), ok);
    for (const bad of ["", "no-at.example.com", "a@b", "two@@x.com", "Name <a@b.co>", "a@b.co, c@d.co", "a b@c.co"]) assert.ok(!isValidEmail(bad), bad);
  });

  test("readiness: the deployment arm, a provider, and the sender identity are all required", () => {
    const enabled = { ...disabledSender, enabled: true };
    assert.deepEqual(readinessErrors(ready, enabled), []);
    assert.match(readinessErrors({ ...ready, outreachSendingArmed: false }, enabled).join(), /OUTREACH_SENDING_ENABLED/);
    assert.match(readinessErrors(ready, disabledSender).join(), /No email provider is configured/);
  });

  test("only the dispatcher calls a sender", () => {
    const src = new URL("../../src/", import.meta.url);
    const walk = (dir: URL): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? (e.name === "generated" ? [] : walk(new URL(`${e.name}/`, dir))) : e.name.endsWith(".ts") ? [new URL(e.name, dir).pathname] : [],
      );
    const callers = walk(src).filter((f) => /sender\.send\(/.test(readFileSync(new URL(`file://${f}`), "utf8")));
    assert.deepEqual(callers.map((f) => f.split("/src/")[1]), ["outreach/dispatch.ts"]);
  });
});
