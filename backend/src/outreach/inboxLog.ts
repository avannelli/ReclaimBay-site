/*
 * What an inbox run prints (outreach:inbox, scheduled every few minutes, so
 * every line lands in the host's logs). Counts only, plus, for mail matched to
 * one of our outreach messages, its kind, result, and our message id. Never a
 * sender's address, a subject, or any content: most of the mailbox is mail that
 * has nothing to do with outreach, and none of it belongs in the logs.
 */
import type { InboxReport } from "./gmailInbox.js";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function inboxLogLines(r: InboxReport, opts: { apply: boolean; mailbox: string }): string[] {
  const count = (pred: (i: InboxReport["items"][number]) => boolean) => r.items.filter(pred).length;
  const matched = r.items.filter((i) => i.outreachId);
  const byOutcome = new Map<string, number>();
  for (const i of matched) byOutcome.set(`${i.kind} ${i.result}`, (byOutcome.get(`${i.kind} ${i.result}`) ?? 0) + 1);

  return [
    `${opts.apply ? "APPLIED" : "DRY RUN (nothing is recorded; pass --apply)"}: ${plural(r.checked, "message")} read from ${opts.mailbox}'s mailbox.`,
    `  own ${count((i) => i.kind === "own")}, auto-replies ${count((i) => i.kind === "auto_reply")}, delays ${count((i) => i.kind === "delay")}, unmatched ${count((i) => i.result === "unmatched")}, matched ${matched.length}`,
    ...(byOutcome.size ? [`  matched: ${[...byOutcome].map(([k, n]) => `${k} ${n}`).join(", ")}`] : []),
    // Our own message id is enough to find the message in the admin; nothing about the mail itself.
    ...matched.map((i) => `  ${i.kind} ${i.result} -> ${i.outreachId}`),
  ];
}
