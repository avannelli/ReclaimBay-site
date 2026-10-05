import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { unsubscribeSender, unsubscribeMarkers, classifyInbound } from "../../src/outreach/gmailInbox.js";
import { inboxLogLines } from "../../src/outreach/inboxLog.js";
import { inbound, MAILBOX } from "../fixtures/fakeGmail.js";

describe("emailed unsubscribe identity", () => {
  for (const value of ["owner@shop.example", "Owner <OWNER@Shop.Example>", '"Owner, Jr." <owner@shop.example>']) {
    test(`one normalized sender: ${value}`, () => assert.equal(unsubscribeSender(inbound("x", "t", { From: value, Subject: "unsubscribe" })), "owner@shop.example"));
  }
  for (const value of ["", "not an address", "owner@shop.example, other@shop.example", "Other <other@shop.example>, Owner <owner@shop.example>", "owner@shop.example\r\nX: bad", "https://private.example/u/secret@shop.example"]) {
    test(`ambiguous/malformed sender is rejected: ${JSON.stringify(value)}`, () => assert.equal(unsubscribeSender(inbound("x", "t", { From: value, Subject: "unsubscribe" })), null));
  }
  test("duplicate From and conflicting Sender are not identity evidence", () => {
    const m = inbound("x", "t", { From: "owner@shop.example", Subject: "unsubscribe" });
    m.payload!.headers!.push({ name: "FROM", value: "other@shop.example" });
    assert.equal(unsubscribeSender(m), null);
    m.payload!.headers!.pop();
    m.payload!.headers!.push({ name: "Sender", value: "other@shop.example" });
    assert.equal(unsubscribeSender(m), null);
  });
  test("Sender must also be a single matching identity, not a list containing the expected address", () => {
    const m = inbound("x", "t", { From: "owner@shop.example", Sender: "Owner <owner@shop.example>, Other <other@shop.example>", Subject: "unsubscribe" });
    assert.equal(unsubscribeSender(m), null);
    m.payload!.headers!.find((h) => h.name === "Sender")!.value = "Owner <owner@shop.example>";
    assert.equal(unsubscribeSender(m), "owner@shop.example");
  });
  test("exact-subject classification is unchanged; ordinary opt-out prose remains a normal reply", () => {
    for (const subject of ["unsubscribe", " Re: UNSUBSCRIBE "]) assert.equal(classifyInbound(inbound("x", "t", { From: "owner@shop.example", Subject: subject }), MAILBOX).kind, "unsubscribe");
    assert.equal(classifyInbound(inbound("x", "t", { From: "delegate@shop.example", Subject: "Re: Hello" }, [], "Please stop emailing"), MAILBOX).kind, "reply");
  });
  test("review CLI diagnostics expose only counts, never inbound identity or content", () => {
    const output = inboxLogLines({ checked: 1, items: [{ gmailId: "private-id", from: "private@shop.example", subject: "private subject", kind: "unsubscribe", outreachId: null, result: "review_open" }] }, { apply: true, mailbox: MAILBOX }).join("\n");
    assert.match(output, /emailed unsubscribe needs review 1/);
    for (const value of ["private-id", "private@shop.example", "private subject"]) assert.ok(!output.includes(value));
  });
  test("all quoted unsubscribe markers are normalized and deduplicated while ordinary replies retain their first marker", () => {
    const a = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"; const b = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
    const m = inbound("x", "t", { From: "owner@shop.example", Subject: "unsubscribe" }, [{ mimeType: "text/plain", text: `X-ReclaimBay-Outreach: ${a.toUpperCase()}\nX-ReclaimBay-Outreach: ${b}\nX-ReclaimBay-Outreach: ${a}` }]);
    assert.deepEqual(unsubscribeMarkers(m), [a, b]);
    assert.equal(classifyInbound(m, MAILBOX).markerOutreachId, a);
  });
});
