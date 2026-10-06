/** Local-only, explicitly fictional visual-review workspace. Never uses a production URL. */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { createProspect, addEvidence, changeStatus } from "../prospects.js";
import { addManualCandidate } from "../discovery/service.js";
import { createOutreachDraft } from "../outreach/service.js";
import { appPage } from "../admin/views.js";

if (process.env.NODE_ENV === "production" || process.env.RAILWAY_ENVIRONMENT) throw new Error("Preview refuses a production environment.");
const backendRoot = fileURLToPath(new URL("../../", import.meta.url));
const envFile = new URL("../../.env", import.meta.url);
const local = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
const url = new URL(process.env.AOS_PREVIEW_DATABASE_URL ?? local.DATABASE_URL ?? "postgresql://localhost/reclaimbay_aos_preview");
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Preview only connects to localhost PostgreSQL.");
if (!process.env.AOS_PREVIEW_DATABASE_URL) url.pathname = "/reclaimbay_aos_preview";
if (!/^\/reclaimbay_aos_preview(?:_[a-z0-9]+)*$/.test(url.pathname)) throw new Error("Preview needs a dedicated reclaimbay_aos_preview database.");
const require = createRequire(import.meta.url);
const { Client } = require("pg") as { Client: new (opts: { connectionString: string }) => { connect(): Promise<void>; query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>; end(): Promise<void> } };
const adminUrl = new URL(url); adminUrl.pathname = "/postgres";
const admin = new Client({ connectionString: adminUrl.href }); await admin.connect();
try { if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [url.pathname.slice(1)])).rows.length) await admin.query(`CREATE DATABASE "${url.pathname.slice(1)}"`); } finally { await admin.end(); }
execFileSync(process.execPath, [fileURLToPath(new URL("../../node_modules/prisma/build/index.js", import.meta.url)), "migrate", "deploy"], { cwd: backendRoot, env: { ...process.env, DATABASE_URL: url.href }, stdio: "pipe" });
const db = createDb(url.href);
const secret = "local-preview-only-operator-2026";
const port = Number(process.env.AOS_PREVIEW_PORT ?? "8081");
const cfg = loadConfig({ DATABASE_URL: url.href, ADMIN_SECRET: secret, PORT: String(port), HOST: "127.0.0.1", TRUST_PROXY_HOPS: "0", OUTREACH_DAILY_LIMIT: "1", OUTREACH_SENDING_ENABLED: "0", OUTREACH_SENDER_NAME: "Preview Operator", OUTREACH_SENDER_EMAIL: "operator@reclaimbay.example", OUTREACH_POSTAL_ADDRESS: "123 Example Avenue, Example City, CA 90000", PUBLIC_API_URL: `http://127.0.0.1:${port}`, PUBLIC_SITE_URL: "https://reclaimbay.example", NODE_ENV: "development" });

if (!process.argv.includes("--empty") && await db.prospect.count() === 0 && await db.discoveryCandidate.count() === 0) {
  const make = async (name: string, slug: string, city: string) => {
    const site = `https://${slug}.example`;
    const p = await createProspect(db, { businessName: name, website: site, city, state: "CA", country: "US", email: `office@${slug}.example`, emailSourceUrl: `${site}/contact`, signal_collision_repair_services: "yes", signal_independent_shop: "yes", signal_general_repair_services: "unknown", signal_has_website: "unknown", signal_has_public_contact: "unknown" });
    await addEvidence(db, p.id, { signalKey: "collision_repair_services", sourceUrl: `${site}/services`, excerpt: `${name}: We offer automotive collision repair and paintless dent repair.` });
    await changeStatus(db, p.id, "qualified", null); return p;
  };
  const harbor = await make("Harbor Collision", "harbor-fixture", "Ventura");
  await changeStatus(db, harbor.id, "ready_to_contact", null);
  const elm = await make("Elm Street Auto Body", "elm-fixture", "Ojai");
  await changeStatus(db, elm.id, "ready_to_contact", null);
  const draft = (await createOutreachDraft(db, elm.id, { siteUrl: cfg.publicSiteUrl, sender: cfg.outreachSender })).outreach;
  const sentAt = new Date(Date.now() - 3 * 86_400_000);
  // Fictional recorded outcomes for visual review; no provider or dispatcher is called.
  await db.outreach.update({ where: { id: draft.id }, data: { status: "replied", statusChangedAt: sentAt, sentAt, repliedAt: new Date(), openForProspectId: null, provider: "local-fixture", providerMessageId: "fixture-message" } });
  await db.prospect.update({ where: { id: elm.id }, data: { status: "engaged" } });
  await db.outreachReply.create({ data: { outreachId: draft.id, receivedAt: new Date(), summary: "Fictional preview reply: We have an estimate export. What columns do you need?" } });
  await db.outreachEvent.createMany({ data: [{ outreachId: draft.id, type: "sent", detail: "Fictional local preview record", createdAt: sentAt }, { outreachId: draft.id, type: "replied", detail: "Fictional local preview record", createdAt: new Date() }] });
  const north = await make("Northline Collision & Paint", "northline-fixture", "Camarillo");
  await createOutreachDraft(db, north.id, { siteUrl: cfg.publicSiteUrl, sender: cfg.outreachSender });
  const candidate = await addManualCandidate(db, { businessName: "Juniper Auto Body", website: "https://juniper-fixture.example", city: "Ventura", state: "CA", country: "US" });
  await addManualCandidate(db, { businessName: "Coastal Collision Studio", website: "https://coastal-fixture.example", city: "Oxnard", state: "CA", country: "US" });
  const research = await db.candidateResearch.create({ data: { candidateId: candidate.id, status: "completed", version: "r12", trigger: "admin", outcome: "website_verified", pagesFetched: 2, queuedAt: new Date(Date.now() - 3_600_000), finishedAt: new Date(), warnings: ["Fictional fixture: public email needs operator verification."] } });
  const source = await db.researchSource.create({ data: { researchId: research.id, kind: "website", url: "https://juniper-fixture.example/services", ok: true, httpStatus: 200 } });
  await db.researchFact.create({ data: { researchId: research.id, sourceId: source.id, field: "services", state: "verified", value: "Collision and auto body repair", excerpt: "Fictional fixture: We offer automotive collision repair." } });
  const session = await db.analyticsSession.create({ data: { anonymousSessionId: randomUUID(), prospectId: elm.id } });
  await db.productEvent.createMany({ data: ["landing_view", "upload_started", "scan_completed", "report_exported"].map(eventType => ({ sessionId: session.id, prospectId: elm.id, eventType: eventType as "landing_view" | "upload_started" | "scan_completed" | "report_exported", isSample: false, exportType: eventType === "report_exported" ? "csv" as const : null })) });
}
const app = await buildApp(cfg, db, false);
app.addHook("preHandler", (req, reply, done) => {
  if (req.method === "POST" && !["/admin/login", "/admin/logout"].includes(req.url.split("?")[0]!)) { reply.code(405).type("text/html; charset=utf-8").send(appPage("Read-only preview · ReclaimBay", "overview", "<h1>Read-only visual preview</h1><div class=\"card\">The action is preserved in the application. This visual-review server blocks writes to keep its fixture records stable. <a href=\"/admin\">Return to Overview</a>.</div>")); return; }
  done();
});
app.addHook("onSend", (_req, reply, payload, done) => {
  if (typeof payload === "string" && String(reply.getHeader("content-type")).includes("text/html")) payload = payload.replace(/(<main id="main"[^>]*>)/, '$1<div class="callout warn" style="margin-bottom:22px"><b>Local visual preview</b> · Fictional fixture records · Sending disabled · Read-only</div>');
  done(null, payload);
});
await app.listen({ host: "127.0.0.1", port });
console.log(`Local AOS preview: http://127.0.0.1:${port}/admin`);
console.log(`Local-only sign-in secret: ${secret}`);
const close = async () => { await app.close(); await db.$disconnect(); process.exit(0); };
process.once("SIGINT", close); process.once("SIGTERM", close);
