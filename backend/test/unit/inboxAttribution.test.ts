import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { inboxSender, unsubscribeSender } from "../../src/outreach/gmailInbox.js";
import { inboxLogLines } from "../../src/outreach/inboxLog.js";
import { inbound, MAILBOX } from "../fixtures/fakeGmail.js";

describe("Inbox evidence/diagnostics boundaries", () => {
  test("ordinary alias/delegated Sender headers do not change the single From identity", () => {
    const m = inbound("private", "thread", { From: "Owner <OWNER@Shop.Example>", Sender: "personal-account@example.com" });
    assert.equal(inboxSender(m), "owner@shop.example");
    assert.equal(unsubscribeSender(m), null, "permanent unsubscribe identity remains independently strict");
  });
  for (const from of ["not an address", "a@shop.example, b@shop.example", "A <a@shop.example>, B <b@shop.example>", "a@shop.example\r\nX: injected"]) {
    test(`ordinary malformed/plural From is not evidence: ${JSON.stringify(from)}`, () => assert.equal(inboxSender(inbound("private", "thread", { From: from })), null));
  }
  test("duplicate From is not converted into an arbitrary first sender", () => {
    const m = inbound("private", "thread", { From: "a@shop.example" });
    m.payload!.headers!.push({ name: "FROM", value: "b@shop.example" });
    assert.equal(inboxSender(m), null);
  });
  test("unresolved diagnostics retain fixed reason/candidate IDs but no mail contents or provider identity", () => {
    const output = inboxLogLines({ checked: 1, items: [{ gmailId: "private-gmail-id", from: "private@shop.example", subject: "private subject", kind: "reply", outreachId: null, result: "ambiguous", attribution: { status: "ambiguous", outreachId: null, candidateOutreachIds: ["aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"], reason: "multiple_identities" } }] }, { apply: true, mailbox: MAILBOX }).join("\n");
    assert.match(output, /Inbox needs operator review 1/); assert.match(output, /multiple_identities/); assert.match(output, /aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/);
    for (const secret of ["private-gmail-id", "private@shop.example", "private subject"]) assert.ok(!output.includes(secret));
  });
});
