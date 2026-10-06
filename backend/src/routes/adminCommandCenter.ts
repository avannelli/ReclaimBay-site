import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import type { OutreachSender } from "../outreach/sender.js";
import { campaignWorkspace, commandActivity, loadOverview, loadSystemStatus, researchWorkspace } from "../admin/commandCenter.js";
import type { ProviderCheckMemo } from "../admin/sendingState.js";
import { provideShellStatus } from "../admin/shell.js";
import { activityPage, campaignsPage, diagnosticPage, overviewPage, researchPage, systemPage } from "../admin/commandViews.js";

/** Registered inside the existing authenticated admin scope. GET projections only. */
export async function commandCenterRoutes(app: FastifyInstance, opts: { db: Db; config: Config; sender: OutreachSender; providerChecks?: ProviderCheckMemo }) {
  const { db, config, sender, providerChecks } = opts;
  app.get("/admin", async (req, reply) => {
    const data = await loadOverview(db, config, sender, providerChecks, new Date(), req.log);
    provideShellStatus(req, data.system.shell);
    return reply.type("text/html; charset=utf-8").send(overviewPage(data));
  });
  app.get("/admin/system", async (req, reply) => {
    const data = await loadSystemStatus(db, config, sender, providerChecks, new Date(), req.log);
    provideShellStatus(req, data.shell);
    return reply.type("text/html; charset=utf-8").send(systemPage(data));
  });
  app.get<{ Querystring: { internal?: string } }>("/admin/activity", async (req, reply) => reply.type("text/html; charset=utf-8").send(activityPage(await commandActivity(db, req.query.internal === "1"), req.query.internal === "1")));
  app.get<{ Querystring: { status?: string; q?: string } }>("/admin/research", async (req, reply) => reply.type("text/html; charset=utf-8").send(researchPage(await researchWorkspace(db, req.query.status, req.query.q))));
  app.get("/admin/campaigns", async (_req, reply) => reply.type("text/html; charset=utf-8").send(campaignsPage(await campaignWorkspace(db))));
  app.get("/admin/diagnostic", (_req, reply) => reply.type("text/html; charset=utf-8").send(diagnosticPage()));
}
