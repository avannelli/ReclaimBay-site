import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifyPublicBuild } from "../scripts/verifyPublicBuild.mjs";

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "reclaimbay-public-boundary-"),
  );
  try {
    for (const name of [
      "public",
      "out/_next/static/chunks",
      "backend/private",
      ".next",
    ])
      await mkdir(path.join(root, name), { recursive: true });
    await writeFile(
      path.join(root, "backend/private/report.js"),
      'var ReclaimBayPaid={mount(){return "Download PDF"}};',
    );
    await writeFile(path.join(root, "out/index.html"), "<h1>Free preview</h1>");
    await writeFile(
      path.join(root, ".next/export-detail.json"),
      JSON.stringify({ success: true, outDirectory: path.join(root, "out") }),
    );
    await run(root);
  } finally {
    // Only the unique temporary fixture directory created above may be removed.
    if (
      path.dirname(root) !== path.resolve(os.tmpdir()) ||
      !path.basename(root).startsWith("reclaimbay-public-boundary-")
    )
      throw Error("Unsafe fixture cleanup");
    await rm(root, { recursive: true, force: true });
  }
}
test("public release verification accepts a clean static export without confusing recovery code with data", async () =>
  fixture(async (root) => {
    await writeFile(
      path.join(root, "out/_next/static/chunks/app.js"),
      "function saveRecovery(){return {version:1,salt:crypto.getRandomValues(new Uint8Array(16)),iv:crypto.getRandomValues(new Uint8Array(12))}}",
    );
    const r = await verifyPublicBuild(root);
    assert.equal(r.checked, 2);
  }));
test("public release verification blocks a renamed paid bundle and bundled paid exports", async () =>
  fixture(async (root) => {
    const file = path.join(root, "out/_next/static/chunks/leaked.js");
    await writeFile(
      file,
      'var ReclaimBayPaid={mount(){return "Download PDF"}};',
    );
    await assert.rejects(verifyPublicBuild(root), /Private material/);
    await writeFile(file, 'function renamed(){return "Download CSV"}');
    await assert.rejects(verifyPublicBuild(root), /Private material/);
  }));
test("public release verification rejects report files, private paths, recovery artifacts and source maps", async () =>
  fixture(async (root) => {
    for (const name of [
      "report.csv",
      "report.xlsx",
      "report.pdf",
      "chunk.js.map",
      "recovery.txt",
      "private/report.js",
      "review/browser-profile/Current",
    ]) {
      const file = path.join(root, "out", name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "synthetic");
      await assert.rejects(
        verifyPublicBuild(root),
        /forbidden path or file type/,
      );
      const removal = path.resolve(root, "out", name.split("/")[0]);
      assert(removal.startsWith(path.join(root, "out") + path.sep));
      await rm(removal, { recursive: true, force: true });
    }
  }));
test("public release verification rejects leaked secrets and serialized recovery/private-key material without printing values", async () =>
  fixture(async (root) => {
    const file = path.join(root, "out/notes.txt");
    for (const text of [
      "sk_test_NOT_A_REAL_SECRET_fixture",
      "whsec_NOT_A_REAL_SECRET_fixture",
      '{"salt":[1,2],"iv":[3,4],"data":"ciphertext"}',
      '{"kty":"EC","d":"' + "a".repeat(43) + '"}',
    ]) {
      await writeFile(file, text);
      await assert.rejects(
        verifyPublicBuild(root),
        (e) =>
          e instanceof Error &&
          e.message === "Private material detected in public package.",
      );
    }
  }));
test("public release verification refuses a different export root and source-public symlink", async () =>
  fixture(async (root) => {
    await writeFile(
      path.join(root, ".next/export-detail.json"),
      JSON.stringify({ success: true, outDirectory: root }),
    );
    await assert.rejects(verifyPublicBuild(root), /static export/);
    await writeFile(
      path.join(root, ".next/export-detail.json"),
      JSON.stringify({ success: true, outDirectory: path.join(root, "out") }),
    );
    await symlink(
      path.join(root, "backend/private"),
      path.join(root, "public/linked"),
      "junction",
    );
    await assert.rejects(verifyPublicBuild(root), /symbolic link/);
  }));
