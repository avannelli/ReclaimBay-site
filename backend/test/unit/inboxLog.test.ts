import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { InboxReport } from "../../src/outreach/gmailInbox.js";
import { inboxLogLines } from "../../src/outreach/inboxLog.js";

/*
 * The inbox job runs every few minutes and its output goes to the host's
 * logs. It prints counts, and for mail matched to one of our messages only its
 * kind, result, and our message id: never a sender, subject, or content.
 */

const MATCHED_REPLY = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
const MATCHED_BOUNCE = "7a1b2c3d-1111-4222-8333-444455556666";
const report: InboxReport = {
  checked: 7,
  items: [
    { gmailId: "g1", kind: "reply", from: "stranger@private.example", subject: "Your lab results are ready", outreachId: null, result: "unmatched" },
    { gmailId: "g2", kind: "auto_reply", from: "boss@another.example", subject: "Out of office until Monday", outreachId: null, result: "ignored" },
    { gmailId: "g3", kind: "own", from: "hello@reclaimbay.example", subject: "Our own message", outreachId: null, result: "ignored" },
    { gmailId: "g4", kind: "delay", from: "mailer-daemon@googlemail.com", subject: "Delivery Status Notification (Delay)", outreachId: null, result: "ignored" },
    { gmailId: "g5", kind: "reply", from: "owner@shop.example", subject: "Re: Declined work at Shop Auto", outreachId: MATCHED_REPLY, result: "recorded" },
    { gmailId: "g6", kind: "bounce", from: "mailer-daemon@googlemail.com", subject: "Delivery Status Notification (Failure)", outreachId: MATCHED_BOUNCE, result: "duplicate" },
    { gmailId: "g7", kind: "unsubscribe", from: "gone@elsewhere.example", subject: "unsubscribe", outreachId: null, result: "unmatched" },
  ],
};
const SENSITIVE = report.items.flatMap((i) => [i.from, i.subject]).filter((s) => s !== "unsubscribe");

describe("inbox job output: counts, never mail metadata", () => {
  test("no sender address or subject appears, unmatched, ignored, or matched", () => {
    const out = inboxLogLines(report, { apply: true, mailbox: "alex@reclaimbay.example" }).join("\n");
    for (const s of SENSITIVE) assert.ok(!out.includes(s), `never logged: ${s}`);
    assert.doesNotMatch(out, /@(private|another|shop|elsewhere)\.example|googlemail/, "no address at all, except the authorized mailbox in the summary");
  });

  test("the counts are still there, and matched mail keeps just its kind, result, and our message id", () => {
    assert.deepEqual(inboxLogLines(report, { apply: true, mailbox: "alex@reclaimbay.example" }), [
      "APPLIED: 7 messages read from alex@reclaimbay.example's mailbox.",
      "  own 1, auto-replies 1, delays 1, unmatched 2, matched 2",
      "  matched: reply recorded 1, bounce duplicate 1",
      `  reply recorded -> ${MATCHED_REPLY}`,
      `  bounce duplicate -> ${MATCHED_BOUNCE}`,
    ]);
  });

  test("a dry run says so; an empty run is two lines", () => {
    assert.deepEqual(inboxLogLines({ checked: 0, items: [] }, { apply: false, mailbox: "m@x.example" }), [
      "DRY RUN (nothing is recorded; pass --apply): 0 messages read from m@x.example's mailbox.",
      "  own 0, auto-replies 0, delays 0, unmatched 0, matched 0",
    ]);
  });

  test("the inbox script prints only inboxLogLines, and has no path to sending", () => {
    const script = readFileSync(new URL("../../src/scripts/readOutreachInbox.ts", import.meta.url), "utf8");
    assert.match(script, /for \(const line of inboxLogLines\(r, \{ apply, mailbox: gmail\.account \}\)\) console\.log\(line\);/);
    assert.doesNotMatch(script, /\.from\b|\.subject\b|\.snippet\b/, "no mail metadata printed directly");
    assert.doesNotMatch(script, /dispatch|sender\.js|\.send\(/, "nothing that sends");
  });
});
