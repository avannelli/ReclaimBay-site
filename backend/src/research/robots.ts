/*
 * A small robots.txt reader (RFC 9309): the group for our user agent, else
 * the "*" group; the longest matching Allow/Disallow rule wins, Allow on a
 * tie. Wildcards "*" and the end anchor "$" are supported.
 */

export interface RobotsRules {
  allow: string[];
  disallow: string[];
}

/** Rules for `agent` (matched as a lowercase product token) from a robots.txt body. */
export function parseRobots(body: string, agent: string): RobotsRules {
  const groups: { agents: string[]; allow: string[]; disallow: string[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" && value) current.allow.push(value);
    if (key === "disallow" && value) current.disallow.push(value);
  }
  const token = agent.toLowerCase();
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && token.includes(a)));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  return {
    allow: chosen.flatMap((g) => g.allow),
    disallow: chosen.flatMap((g) => g.disallow),
  };
}

function patternLength(pattern: string, path: string): number {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`).test(path) ? pattern.length : -1;
}

/** Whether `path` (with its query string) may be fetched under these rules. */
export function robotsAllows(rules: RobotsRules, path: string): boolean {
  let best = -1;
  let allowed = true;
  for (const p of rules.disallow) {
    const n = patternLength(p, path);
    if (n > best) {
      best = n;
      allowed = false;
    }
  }
  for (const p of rules.allow) {
    const n = patternLength(p, path);
    if (n >= best && n >= 0) {
      best = n;
      allowed = true;
    }
  }
  return allowed;
}
