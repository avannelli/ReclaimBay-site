import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const extensions = new Set([
  ".html",
  ".txt",
  ".js",
  ".css",
  ".woff2",
  ".woff",
  ".png",
  ".svg",
  ".ico",
  ".jpg",
  ".jpeg",
  ".webp",
  ".avif",
]);
const forbiddenPath =
  /(?:^|\/)(?:\.env[^/]*|\.git|\.next|\.dev\.vars[^/]*|backend|private|paid|review|test|fixtures|node_modules|indexeddb|local storage|session storage|recovery|identity|browser-profile[^/]*)(?:\/|\.|$)/i;
const paidRenderer = /Download (?:CSV|PDF)/;
const stripeSecret =
  /(?:\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9_-]{8,}|\bwhsec_[A-Za-z0-9_-]{8,})/;
const recoveryMaterial =
  /["']kty["']\s*:\s*["']EC["'][\s\S]{0,600}["']d["']\s*:\s*["'][A-Za-z0-9_-]{43}["']|["']salt["']\s*:\s*(?:\[|["'])[^;]{0,1000}["']iv["']\s*:\s*(?:\[|["'])/;

async function files(directory) {
  const info = await lstat(directory);
  if (info.isSymbolicLink())
    throw Error(
      "Public package contains a symbolic link; refusing to follow it.",
    );
  if (!info.isDirectory()) throw Error("Expected a public package directory.");
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name),
      item = await lstat(file);
    if (item.isSymbolicLink())
      throw Error(
        "Public package contains a symbolic link; refusing to follow it.",
      );
    if (item.isDirectory()) result.push(...(await files(file)));
    else if (item.isFile()) result.push(file);
    else
      throw Error("Public package contains an unsupported filesystem entry.");
  }
  return result;
}

/** Check build artifacts only. Never read the customer's browser profile/storage. */
export async function verifyPublicBuild(
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
) {
  root = path.resolve(root);
  const out = path.join(root, "out"),
    privateFile = path.join(root, "backend/private/report.js");
  const detail = JSON.parse(
    await readFile(path.join(root, ".next/export-detail.json"), "utf8"),
  );
  if (detail.success !== true || path.resolve(detail.outDirectory) !== out)
    throw Error("A successful static export to out/ is required.");
  if ((await lstat(privateFile)).isSymbolicLink())
    throw Error("Private report artifact must be a regular file.");
  const privateBytes = await readFile(privateFile);
  if (!privateBytes.length) throw Error("Private report artifact is empty.");
  const privateHash = createHash("sha256").update(privateBytes).digest("hex");
  const secretValues = Object.entries(process.env)
    .filter(
      ([name, value]) =>
        !name.startsWith("NEXT_PUBLIC_") &&
        /^(?:STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|DATABASE_URL|ADMIN_SECRET|RESEND_API_KEY|GMAIL_CLIENT_SECRET|GMAIL_TOKEN_ENCRYPTION_KEY)$/.test(
          name,
        ) &&
        value &&
        value.length >= 12,
    )
    .map(([, value]) => Buffer.from(value));
  let checked = 0;
  for (const directory of [path.join(root, "public"), out]) {
    for (const file of await files(directory)) {
      const relative = path.relative(directory, file).replaceAll(path.sep, "/");
      if (
        forbiddenPath.test(relative) ||
        !extensions.has(path.extname(file).toLowerCase())
      )
        throw Error("Public package contains a forbidden path or file type.");
      const data = await readFile(file);
      if (
        data.includes(privateBytes) ||
        secretValues.some((value) => data.includes(value))
      )
        throw Error("Private material detected in public package.");
      const text = data.toString("utf8");
      if (
        paidRenderer.test(text) ||
        stripeSecret.test(text) ||
        recoveryMaterial.test(text)
      )
        throw Error("Private material detected in public package.");
      checked++;
    }
  }
  return {
    checked,
    publicDirectory: "out/",
    privateArtifactSha256: privateHash,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  verifyPublicBuild()
    .then((result) =>
      console.log(
        `Public release boundary PASS: ${result.checked} files checked; paid asset remains private.`,
      ),
    )
    .catch(() => {
      // Never print matched data, secret values, report contents or raw parser errors.
      console.error(
        "Public release boundary FAILED. Inspect the package locally; do not publish it.",
      );
      process.exitCode = 1;
    });
}
