import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, test } from "node:test";

/*
 * Stage 5D Phase A: the send gate's topology (outreach/records.ts
 * lockSendGate). Read from the source, like "only the dispatcher calls a
 * sender": exactly these top-level transactions take the gate, each as its
 * first statement; no helper takes it; every other transaction in these
 * modules is one that can't make or stop a send; and nothing inside a gated
 * transaction touches the network. The real-Postgres tests
 * (test/integration/sendGate.test.ts) show the gate is actually taken.
 */

const SRC = new URL("../../src/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, SRC), "utf8");

/** Every top-level function that takes the gate, and how many gated transactions it runs. */
const GATED: Record<string, Record<string, number>> = {
  "outreach/dispatch.ts": { setSendingSwitch: 1, dispatchQueued: 2, confirmStuckSent: 1 },
  "outreach/service.ts": { discardOutreach: 1, queueOutreach: 1, applyProviderEvent: 1, recordReply: 1, classifyReply: 1, recordInboundReply: 1, unsubscribeOutreach: 1 },
  "prospects.ts": { updateProspect: 1, changeStatus: 1 },
  "invitations/service.ts": { revokeInvitation: 1, revokeInvitationForOutreach: 1 },
};

/** Transactions in those modules that can't make or stop a send, so take no gate. */
const UNGATED: Record<string, string[]> = {
  "outreach/dispatch.ts": [],
  "outreach/service.ts": ["createOutreachDraft"],
  "prospects.ts": ["createProspect"],
  "invitations/service.ts": ["createInvitationForOutreach", "openInvitation"],
};

/** Helpers that run inside a caller's transaction: they must never take the gate themselves. */
const HELPERS: Record<string, string[]> = {
  "outreach/records.ts": ["cancelOne", "cancelOpenOutreach", "suppressEmail"],
  "outreach/service.ts": ["moveOutreachInTx", "advanceProspect", "queueBlockers", "recordSentInTx", "applyReplyOutcome", "recordReplyInTx"],
  "prospects.ts": ["changeStatusInTx", "insertProspect"],
  "invitations/service.ts": ["createInvitationInTx", "revokeInvitationInTx", "attributeSession"],
};

/** The name of the function each position falls in (the nearest function declaration before it). */
function enclosingFunction(src: string, index: number): string {
  const decl = /^(?:export )?(?:async )?function (\w+)/gm;
  let name = "(top level)";
  for (let m = decl.exec(src); m && m.index < index; m = decl.exec(src)) name = m[1]!;
  return name;
}

/** A function's whole text, from its declaration to the closing brace at the start of a line. */
function functionText(src: string, name: string): string {
  const start = src.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\b`, "m"));
  assert.ok(start >= 0, `function ${name} exists`);
  const end = src.indexOf("\n}\n", start);
  return src.slice(start, end === -1 ? undefined : end + 2);
}

/** The body of the transaction callback that starts at `$transaction(` at `index`. */
function transactionBody(src: string, index: number): string {
  const open = src.indexOf("{", src.indexOf("=>", index));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error("unbalanced transaction body");
}

const transactions = (src: string) => [...src.matchAll(/\$transaction\(/g)].map((m) => m.index!);
/** The callback header, then only comments, then the gate. */
const GATE_FIRST = /^\$transaction\(async \(tx\)(?::\s*Promise<\w+>)?\s*=>\s*\{\s*(?:\/\/[^\n]*\n\s*)*await lockSendGate\(tx\);/;
/** Anything that reaches the network, or a function that does. */
const NETWORK = /\bfetch\(|fetchImpl|sender\.send\(|sender\.check\(|\.check\(\)|client\.|getThread|listMessages|findSentAttempt|pollGmailInbox|gmailStatus|verifyIdentity|recheck\(/;

describe("the send gate", () => {
  test("exactly the listed top-level transactions take it, each as its first statement", () => {
    const src = (dir: URL): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? (e.name === "generated" ? [] : src(new URL(`${e.name}/`, dir)).map((f) => `${e.name}/${f}`)) : e.name.endsWith(".ts") ? [e.name] : [],
      );
    const found: Record<string, Record<string, number>> = {};
    for (const file of src(SRC)) {
      const text = read(file);
      for (const m of text.matchAll(/lockSendGate\(/g)) {
        if (text.slice(Math.max(0, m.index! - 20), m.index!).includes("const ")) continue; // its definition
        const fn = enclosingFunction(text, m.index!);
        (found[file] ??= {})[fn] = (found[file]?.[fn] ?? 0) + 1;
      }
    }
    assert.deepEqual(found, GATED, "no other code takes the gate, and none of these misses it");

    for (const [file, fns] of Object.entries(GATED)) {
      const text = read(file);
      for (const [fn, count] of Object.entries(fns)) {
        const body = functionText(text, fn);
        const gated = transactions(body).filter((i) => GATE_FIRST.test(body.slice(i)));
        assert.equal(gated.length, count, `${file} ${fn}: the gate is the first statement of ${count} transaction(s)`);
      }
    }
  });

  test("every other transaction in these modules is one that can't make or stop a send", () => {
    for (const [file, allowed] of Object.entries(UNGATED)) {
      const text = read(file);
      const ungated = transactions(text)
        .filter((i) => !GATE_FIRST.test(text.slice(i)))
        .map((i) => enclosingFunction(text, i));
      assert.deepEqual([...new Set(ungated)].sort(), [...allowed].sort(), `${file}: a new transaction here must take the gate, or be listed as unable to affect a send`);
    }
  });

  test("helpers never take it: the transaction that calls them already holds it", () => {
    for (const [file, fns] of Object.entries(HELPERS)) {
      const text = read(file);
      for (const fn of fns) assert.doesNotMatch(functionText(text, fn), /lockSendGate|pg_advisory/, `${file} ${fn}`);
    }
    // Only the gate's own definition names the lock.
    for (const file of ["outreach/dispatch.ts", "outreach/service.ts", "prospects.ts", "invitations/service.ts"]) {
      assert.doesNotMatch(read(file), /pg_advisory|73_?160_?201/, `${file} uses lockSendGate, never the raw lock`);
    }
  });

  test("nothing inside a gated transaction makes a network call", () => {
    for (const [file, fns] of Object.entries(GATED)) {
      const text = read(file);
      for (const fn of Object.keys(fns)) {
        const body = functionText(text, fn);
        for (const i of transactions(body).filter((t) => GATE_FIRST.test(body.slice(t)))) {
          assert.doesNotMatch(transactionBody(body, i), NETWORK, `${file} ${fn}: the network is called outside the gate`);
        }
      }
    }
  });
});
