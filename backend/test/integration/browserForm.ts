import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const FORM_BROWSER = [process.env.FORM_BROWSER,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
].find((p): p is string => Boolean(p && existsSync(p)));

/** Use native HTML form ownership and successful-control serialization.
 * Detached local HTML only: no form submission, fetch, or application server. */
export async function browserCampaignPayload(html: string, values: { name: string; reason: string; messageIds: string[]; confirm: boolean }) {
  if (!FORM_BROWSER) throw new Error("Set FORM_BROWSER to a Chromium browser executable.");
  const temporaryRoot = path.resolve(tmpdir());
  const dir = await mkdtemp(path.join(temporaryRoot, "reclaimbay-form-"));
  try {
    const file = path.join(dir, "form.html");
    const script = `const values=${JSON.stringify(values).replace(/</g, "\\u003c")};
      const form=document.querySelector('form[action="/admin/outreach/campaign/start"]');
      form.querySelector('[name="name"]').value=values.name;
      form.querySelector('[name="reason"]').value=values.reason;
      for(const input of form.querySelectorAll('input[name^="m:"]')) input.checked=values.messageIds.includes(input.name.slice(2));
      form.querySelector('[name="confirm"]').checked=values.confirm;
      const result=document.createElement('pre'); result.id='serialized-payload';
      result.textContent=new URLSearchParams(new FormData(form)).toString(); document.body.append(result);`;
    await writeFile(file, html.replace("</body>", `<script>${script}</script></body>`));
    const { stdout } = await promisify(execFile)(FORM_BROWSER, ["--headless", "--disable-gpu", "--no-first-run",
      "--no-default-browser-check", "--disable-background-networking", `--user-data-dir=${path.join(dir, "profile")}`,
      "--dump-dom", pathToFileURL(file).href], { timeout: 30_000, maxBuffer: 2_000_000, windowsHide: true });
    const encoded = /<pre id="serialized-payload">([^<]*)<\/pre>/.exec(stdout)?.[1];
    if (encoded === undefined) throw new Error("Browser did not serialize the campaign form.");
    return new URLSearchParams(encoded.replace(/&amp;/g, "&"));
  } finally {
    if (!path.resolve(dir).startsWith(temporaryRoot + path.sep)) throw new Error("Unexpected browser temporary directory.");
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
