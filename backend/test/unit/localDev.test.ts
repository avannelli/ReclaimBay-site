import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { localDevDefaults, localDevErrors, localDevWarnings } from "../../src/localDev.js";

/*
 * The local development guard: the dev:* scripts run only on this computer,
 * against a database on this computer, and never in production.
 */

const LOCAL = "postgresql://dev:pw@localhost:5432/reclaimbay_dev";
const SECRET = "x".repeat(32);

describe("local development: only here, only against a local database", () => {
  test("a local database on this computer is accepted", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      assert.deepEqual(localDevErrors({ DATABASE_URL: `postgresql://dev:pw@${host}:5432/reclaimbay_dev` }), [], host);
    }
  });

  test("any other database is refused, whatever it is called", () => {
    for (const url of [
      "postgresql://postgres:pw@postgres.railway.internal:5432/railway",
      "postgresql://postgres:pw@monorail.proxy.rlwy.net:41234/railway",
      "postgresql://dev:pw@192.168.1.20:5432/reclaimbay_dev",
      "postgresql://dev:pw@localhost.example.com:5432/reclaimbay_dev",
    ]) {
      assert.match(localDevErrors({ DATABASE_URL: url }).join(), /not this computer/, url);
    }
    assert.match(localDevErrors({}).join(), /DATABASE_URL isn't set/);
    assert.match(localDevErrors({ DATABASE_URL: "not a url" }).join(), /isn't a valid connection URL/);
  });

  test("production and Railway are refused even with a local-looking database", () => {
    assert.match(localDevErrors({ DATABASE_URL: LOCAL, NODE_ENV: "production" }).join(), /NODE_ENV is production/);
    assert.match(localDevErrors({ DATABASE_URL: LOCAL, RAILWAY_ENVIRONMENT: "production" }).join(), /Railway/);
  });

  test("it listens on this computer only and trusts no proxy, unless backend/.env says otherwise", () => {
    assert.deepEqual(localDevDefaults({}), { HOST: "localhost", TRUST_PROXY_HOPS: "0" });
    assert.deepEqual(localDevDefaults({ HOST: "127.0.0.1", TRUST_PROXY_HOPS: "0" }), { HOST: "127.0.0.1", TRUST_PROXY_HOPS: "0" });
  });

  test("it warns about the test database and a missing admin password, without stopping", () => {
    assert.deepEqual(localDevWarnings({ DATABASE_URL: LOCAL, ADMIN_SECRET: SECRET }), []);
    assert.match(localDevWarnings({ DATABASE_URL: LOCAL, TEST_DATABASE_URL: LOCAL, ADMIN_SECRET: SECRET }).join(), /integration-test database/);
    assert.match(localDevWarnings({ DATABASE_URL: LOCAL, ADMIN_SECRET: "short" }).join(), /ADMIN_SECRET/);
  });

  test("production starts the app directly; only the dev:* scripts go through the guard", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    assert.equal(pkg.scripts.start, "node dist/server.js", "production is unchanged");
    assert.match(pkg.scripts.dev!, /src\/scripts\/devServer\.ts/);
    const server = readFileSync(new URL("../../src/server.ts", import.meta.url), "utf8");
    assert.doesNotMatch(server, /localDev/, "the production entry point never imports the dev guard");
    for (const f of ["devServer.ts", "devDb.ts", "seedDev.ts"]) {
      assert.match(readFileSync(new URL(`../../src/scripts/${f}`, import.meta.url), "utf8"), /requireLocalDev\(/, `${f} checks first`);
    }
  });
});
