// Real browser + PostgreSQL + signed webhook simulation. No Stripe/network calls.
// Build first with the localhost URLs documented in docs/SCANNER_PURCHASES.md.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, stat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import pg from "../../backend/node_modules/pg/lib/index.js";

const root = process.cwd(),
  folder = path.resolve("review/m2-purchase-verification");
// Fresh downloads each run, so export assertions never see an earlier run's files.
await rm(path.join(folder, "downloads"), { recursive: true, force: true });
await mkdir(path.join(folder, "downloads"), { recursive: true });
try {
  process.loadEnvFile(path.join(root, "backend/.env"));
} catch {
  /* Process env may provide local DB. */
}
const dbUrl = new URL(process.env.DATABASE_URL ?? "");
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(dbUrl.hostname) ||
  process.env.NODE_ENV === "production" ||
  process.env.RAILWAY_ENVIRONMENT
)
  throw Error("Disposable local database required");
const database = "reclaimbay_billing_browser_" + process.pid + "_" + Date.now();
dbUrl.pathname = "/postgres";
const pool = new pg.Pool({ connectionString: dbUrl.href });
await pool.query('CREATE DATABASE "' + database + '"');
dbUrl.pathname = "/" + database;
const control = crypto.randomUUID(),
  requests = [],
  errors = [],
  steps = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let backend, chrome, ws, server, analytics;
try {
  backend = spawn(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "test/fixtures/billingServer.ts"],
    {
      cwd: path.join(root, "backend"),
      windowsHide: true,
      env: {
        ...process.env,
        NODE_ENV: "test",
        TEST_DATABASE_URL: dbUrl.href,
        BILLING_FIXTURE_CONTROL: control,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("Local billing fixture did not start")),
      60000,
    );
    let text = "";
    backend.stdout.on("data", (chunk) => {
      text += chunk;
      if (text.includes("BILLING_FIXTURE_READY")) {
        clearTimeout(timer);
        resolve();
      }
    });
    backend.stderr.on("data", () => {
      /* Do not print environment/DB errors containing credentials. */
    });
    backend.once("exit", () => {
      clearTimeout(timer);
      reject(Error("Local billing fixture exited before readiness"));
    });
  });
  const state = async (action = "state") => {
    const r = await fetch("http://127.0.0.1:47892/local-fixture", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fixture-control": control,
      },
      body: JSON.stringify({ action }),
    });
    assert.equal(r.status, 200);
    return r.json();
  };
  server = createServer(async (req, res) => {
    try {
      const base = path.resolve("out"),
        u = new URL(req.url, "http://127.0.0.1");
      let target = path.resolve(base, "." + decodeURIComponent(u.pathname));
      if (target !== base && !target.startsWith(base + path.sep))
        throw Error("Outside export");
      try {
        if ((await stat(target)).isDirectory())
          target = path.join(target, "index.html");
      } catch {
        target += ".html";
      }
      res.setHeader(
        "Content-Type",
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".woff2": "font/woff2",
          ".txt": "text/plain",
        }[path.extname(target)] ?? "application/octet-stream",
      );
      res.end(await readFile(target));
    } catch {
      res.statusCode = 404;
      res.end("Not found");
    }
  });
  await new Promise((resolve) => server.listen(47890, "127.0.0.1", resolve));
  analytics = createServer(async (req, res) => {
    for await (const chunk of req) {
      if (chunk.length > 16384) throw Error("Oversized synthetic analytics");
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.end("{}");
  });
  await new Promise((resolve) => analytics.listen(47891, "127.0.0.1", resolve));
  const profile = path.join(folder, "profile-" + Date.now());
  await mkdir(profile);
  const chromePath =
    process.env.CHROME_PATH ??
    "C:/Program Files/Google/Chrome/Application/chrome.exe";
  chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-extensions",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "--user-data-dir=" + profile,
      "about:blank",
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  let port;
  for (let i = 0; i < 100; i++) {
    try {
      port = Number(
        (
          await readFile(path.join(profile, "DevToolsActivePort"), "utf8")
        ).split("\n")[0],
      );
      if (port) break;
    } catch {}
    await sleep(100);
  }
  assert(port, "Chrome not available");
  const targets = async () =>
    await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  ws = new WebSocket(
    (await targets()).find((t) => t.type === "page").webSocketDebuggerUrl,
  );
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let seq = 0;
  const pending = new Map();
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq,
        timer = setTimeout(() => {
          pending.delete(id);
          reject(Error("CDP timeout: " + method));
        }, 20000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  ws.addEventListener("message", (event) => {
    const m = JSON.parse(event.data);
    if (m.id) {
      const p = pending.get(m.id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(m.id);
        if (m.error) p.reject(Error(JSON.stringify(m.error)));
        else p.resolve(m.result);
      }
      return;
    }
    if (m.method === "Network.requestWillBeSent")
      requests.push(m.params.request);
    if (m.method === "Runtime.exceptionThrown")
      errors.push(m.params.exceptionDetails);
    if (m.method === "Page.javascriptDialogOpening")
      void send("Page.handleJavaScriptDialog", { accept: true });
    if (m.method === "Fetch.requestPaused") {
      const { requestId, request } = m.params,
        u = new URL(request.url);
      if (
        ["http:", "https:"].includes(u.protocol) &&
        !["127.0.0.1", "localhost"].includes(u.hostname)
      )
        void send("Fetch.failRequest", {
          requestId,
          errorReason: "BlockedByClient",
        });
      else void send("Fetch.continueRequest", { requestId });
    }
  });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  await send("Page.bringToFront");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: path.join(folder, "downloads"),
  });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const wait = async (expression, label) => {
    for (let i = 0; i < 150; i++) {
      if (await evaluate(expression)) return;
      await sleep(100);
    }
    throw Error(
      "Browser timeout: " +
        label +
        "; " +
        (await evaluate('document.querySelector("main")?.innerText')),
    );
  };
  const click = async (text) => {
    assert(
      await evaluate(
        `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes(${JSON.stringify(text)})&&!b.disabled&&!b.closest('[inert]'));if(!b)return false;b.click();return true;})()`,
      ),
      "Button: " + text,
    );
  };
  const home = async () => {
    await send("Page.navigate", { url: "http://127.0.0.1:47890/" });
    await wait(
      `(()=>{const b=document.querySelector('main button');return !!b&&Object.keys(b).some(k=>k.startsWith('__reactProps')&&typeof b[k]?.onClick==='function')})()`,
      "hydration",
    );
  };
  const upload = async (
    selector = "input[type=file]",
    resume = false,
    file = path.join(folder, "private-1000.csv"),
  ) => {
    const { root: doc } = await send("DOM.getDocument"),
      { nodeId } = await send("DOM.querySelector", {
        nodeId: doc.nodeId,
        selector,
      });
    assert(nodeId);
    await send("DOM.setFileInputFiles", {
      nodeId,
      files: [file],
    });
    if (resume) {
      await wait(
        `!!document.querySelector('[data-tour="total"]')`,
        "same-file paid resume",
      );
      return;
    }
    await wait(
      `document.querySelector('main')?.textContent.includes('Free scanner preview')&&!document.querySelector('main > div[inert]')`,
      "free preview",
    );
    await wait(
      `[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Unlock complete report')&&!b.disabled)`,
      "offer",
    );
  };
  const snapshot = async (label) => {
    steps.push({
      label,
      text: await evaluate('document.querySelector("main")?.innerText'),
    });
    await writeFile(
      path.join(folder, label + ".png"),
      Buffer.from(
        (await send("Page.captureScreenshot", { format: "png" })).data,
        "base64",
      ),
    );
  };
  const storage = () =>
    evaluate(
      `new Promise((resolve,reject)=>{const o=indexedDB.open('reclaimbay-purchases-v1',1);o.onsuccess=()=>{const db=o.result,t=db.transaction(['identity','metadata','recovery'],'readonly'),all={};for(const n of ['identity','metadata','recovery']){const r=t.objectStore(n).getAll();r.onsuccess=()=>all[n]=r.result;}t.oncomplete=()=>{db.close();resolve(JSON.stringify({all,local:{...localStorage},session:{...sessionStorage}}));};t.onerror=reject;};})`,
    );
  await writeFile(
    path.join(folder, "private-1000.csv"),
    "Service,Amount,Customer\nBrake repair,100,PRIVATE_TEST_ADA\nTransmission,900,PRIVATE_TEST_BO",
  );
  await home();
  await upload();
  await snapshot("free-preview");
  let text = await evaluate('document.querySelector("main").innerText');
  assert.match(text, /\$1,000/);
  assert.match(text, /\$49 USD one-time/);
  assert.doesNotMatch(text, /PRIVATE_TEST_|Download CSV|Download PDF/);
  assert.doesNotMatch(
    await storage(),
    /PRIVATE_TEST_|Transmission|private-1000|password/i,
  );
  const setPassword = (value) =>
    evaluate(
      `(()=>{const e=document.querySelector('input[type=password]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
  // Optional, explicit and secondary: open "If you close this tab" and save an encrypted local copy.
  await evaluate(
    `[...document.querySelectorAll('main details summary')].find(s=>s.textContent.includes('If you close this tab')).click()`,
  );
  await setPassword("private recovery phrase 123");
  await click("Save encrypted copy");
  await wait(
    `document.querySelector('main').innerText.includes('Encrypted copy saved')`,
    "pre-checkout encrypted copy",
  );
  await click("Unlock complete report");
  await sleep(700);
  assert.equal((await state()).sessions, 1);
  assert.match(
    await evaluate('document.querySelector("main").innerText'),
    /FREE SCANNER PREVIEW/,
  );
  assert.doesNotMatch(
    await storage(),
    /PRIVATE_TEST_|Transmission|private-1000|private recovery phrase/,
  );
  // Interrupt the original tab while the hosted session is still unpaid.
  await home();
  await wait(
    `!!document.querySelector('input[type=password]')`,
    "interrupted checkout recovery",
  );
  await setPassword("private recovery phrase 123");
  await click("Restore encrypted report");
  await wait(
    `document.querySelector('main')?.textContent.includes('Free scanner preview')`,
    "unpaid recovery remains preview",
  );
  await wait(
    `[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Unlock complete report')&&!b.disabled)`,
    "restored offer",
  );
  assert.match(
    await evaluate('document.querySelector("main").innerText'),
    /\$1,000/,
  );
  assert.equal(
    await evaluate(`!!document.querySelector('[data-tour="total"]')`),
    false,
  );
  assert.equal((await state()).entitlements, 0);
  await click("Unlock complete report");
  await sleep(400);
  assert.equal((await state()).sessions, 1);
  steps.push({
    label: "encrypted-recovery-during-unpaid-checkout",
    result:
      "original tab reloaded; correct report recovered locally; no unpaid unlock; same Stripe fixture session reused",
  });
  // Visiting a forged success/cancel page in another tab cannot confer access.
  await evaluate(
    `void window.open('/checkout-return?result=complete&paid=true','_blank')`,
  );
  await sleep(700);
  assert.equal((await state()).entitlements, 0);
  assert.equal(
    await evaluate(`!!document.querySelector('[data-tour="total"]')`),
    false,
  );
  await evaluate(
    `void window.open('/checkout-return?result=cancelled','_blank')`,
  );
  await sleep(300);
  await click("Reopen secure Checkout");
  await sleep(400);
  assert.equal((await state()).sessions, 1);
  steps.push({
    label: "cancel-or-interrupt-reuses-checkout",
    result:
      "same opaque report and one Stripe fixture session; analysis retained",
  });
  await state("pay");
  await evaluate(`window.dispatchEvent(new Event('focus'))`);
  await wait(`!!document.querySelector('[data-tour="total"]')`, "paid report");
  await snapshot("paid-report");
  assert.match(
    await evaluate('document.querySelector("main").innerText'),
    /PRIVATE_TEST_ADA/,
  );
  await click("Download CSV");
  await click("Download PDF");
  await click("Download Call Sheet (PDF)");
  await click("Download Follow-up List (CSV)");
  await sleep(1500);
  const downloads = await readdir(path.join(folder, "downloads"));
  assert(downloads.some((f) => f.endsWith(".pdf")));
  assert(downloads.some((f) => f.endsWith(".csv")));
  const callList = downloads.find((f) => /call-list.*.csv$/.test(f));
  assert(callList, "follow-up list CSV downloaded");
  assert(downloads.some((f) => /call-sheet.*.pdf$/.test(f)), "call sheet PDF downloaded");
  const callListCsv = await readFile(path.join(folder, "downloads", callList), "utf8");
  assert.match(callListCsv, /Call order,Group,Customer/);
  assert.match(callListCsv, /PRIVATE_TEST_BO/);
  const csv = await readFile(
    path.join(
      folder,
      "downloads",
      downloads.find((f) => f.endsWith(".csv")),
    ),
    "utf8",
  );
  assert.match(csv, /PRIVATE_TEST_ADA/);
  assert.match(csv, /PRIVATE_TEST_BO/);
  assert.equal(
    (
      await readFile(
        path.join(
          folder,
          "downloads",
          downloads.find((f) => f.endsWith(".pdf")),
        ),
      )
    )
      .subarray(0, 4)
      .toString(),
    "%PDF",
  );
  await send("Browser.grantPermissions", {
    origin: "http://127.0.0.1:47890",
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  await click("Copy summary");
  assert.match(
    await evaluate("navigator.clipboard.readText()"),
    /Reported declined value: \$1,000/,
  );
  // Also verify the explicit Save button independently of automatic opt-in save.
  await click("Delete recovery copy");
  await wait(
    `!document.querySelector('main').innerText.includes('Encrypted copy saved')`,
    "delete pre-checkout copy",
  );
  await setPassword("private recovery phrase 123");
  await click("Save encrypted copy");
  await wait(
    `document.querySelector('main').innerText.includes('Encrypted copy saved')`,
    "explicit encrypted recovery",
  );
  assert.doesNotMatch(
    await storage(),
    /PRIVATE_TEST_|Transmission|private-1000|private recovery phrase/,
  );
  await home();
  await wait(
    `document.querySelector('main').innerText.includes('Resume your previous report')`,
    "resume",
  );
  await setPassword("wrong password");
  await click("Restore encrypted report");
  await wait(
    `document.querySelector('[role=alert]')?.textContent.includes('Unable to restore')`,
    "wrong password denied",
  );
  await setPassword("private recovery phrase 123");
  await click("Restore encrypted report");
  await wait(
    `!!document.querySelector('[data-tour="total"]')`,
    "restored paid report",
  );
  await snapshot("restored-paid-report");
  assert.match(
    await evaluate('document.querySelector("main").innerText'),
    /PRIVATE_TEST_BO/,
  );
  await click("Delete recovery copy");
  await wait(
    `!document.querySelector('main').innerText.includes('Encrypted copy saved')`,
    "recovery deletion",
  );
  await home();
  await wait(
    `!!document.querySelector('section input[type=password]')`,
    "file resume",
  );
  await upload("section:has(input[type=password]) input[type=file]", true);
  await wait(
    `!!document.querySelector('[data-tour="total"]')`,
    "same-file purchase resume",
  );
  // A new XLSX analysis is a different report: a prior purchase must not unlock it.
  await home();
  await upload(
    "input[type=file]",
    false,
    path.resolve("test/fixtures/audit.xlsx"),
  );
  await sleep(500);
  assert.equal(
    await evaluate(`!!document.querySelector('[data-tour="total"]')`),
    false,
  );
  assert.match(
    await evaluate('document.querySelector("main").innerText'),
    /\$1,000/,
  );
  assert.equal((await state()).sessions, 1);
  await home();
  await wait(
    `!!document.querySelector('section select')`,
    "earlier report references",
  );
  await evaluate(
    `(()=>{const s=document.querySelector('section select');s.value=s.options[0].value;s.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await upload("section:has(input[type=password]) input[type=file]", true);
  steps.push({
    label: "new-XLSX-is-unpaid-earlier-purchase-retained",
    result:
      "new report stayed in preview; original CSV still unlocked without another payment",
  });
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  assert.equal(
    await evaluate("document.documentElement.scrollWidth>innerWidth"),
    false,
  );
  await snapshot("paid-mobile");
  const final = await state();
  assert.equal(final.sessions, 1);
  assert.equal(final.purchases, 1);
  assert.equal(final.entitlements, 1);
  assert.equal(final.outreach, 0);
  assert.equal(final.campaigns, 0);
  const sent = requests
    .filter((r) => r.method === "POST")
    .map((r) => r.postData ?? "")
    .join("\n");
  assert.doesNotMatch(
    sent,
    /PRIVATE_TEST_|Transmission|Brake repair|private-1000|private recovery phrase|analysis|ranked|fileName/,
  );
  assert.equal(errors.length, 0, JSON.stringify(errors));
  for (const entry of await readdir("out/_next/static/chunks"))
    if (entry.endsWith(".js"))
      assert.doesNotMatch(
        await readFile("out/_next/static/chunks/" + entry, "utf8"),
        /Download CSV|Download PDF/,
        "Paid export renderer must not be in public static assets",
      );
  await writeFile(
    path.join(folder, "result.json"),
    JSON.stringify(
      {
        mode: "local signed Stripe simulation; hosted Stripe test-mode UI not verified",
        steps,
        requests: requests.map((r) => ({
          url: r.url,
          method: r.method,
          postData: r.postData,
        })),
        errors,
        final,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: local purchase, preview, cancellation/interruption, signed fulfillment, PDF/CSV/summary, encrypted recovery, original-file resume, privacy and mobile checks.",
  );
} finally {
  ws?.close();
  chrome?.kill();
  server?.closeAllConnections();
  analytics?.closeAllConnections();
  await Promise.all([
    server && new Promise((r) => server.close(r)),
    analytics && new Promise((r) => analytics.close(r)),
  ]);
  if (backend && backend.exitCode === null) {
    backend.stdin.end("shutdown");
    await Promise.race([
      new Promise((r) => backend.once("exit", r)),
      sleep(3000),
    ]);
    if (backend.exitCode === null) backend.kill();
  }
  await pool.query('DROP DATABASE "' + database + '" WITH (FORCE)');
  await pool.end();
}
