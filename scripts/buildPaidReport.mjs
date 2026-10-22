import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nextEnv from "@next/env";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Match Next's .env precedence, while defining only the public analytics origin.
// Never inline process.env wholesale into the private or public browser bundle.
nextEnv.loadEnvConfig(root);
await build({
  entryPoints: [path.join(root, "paid/report.tsx")],
  outfile: path.join(root, "backend/private/report.js"),
  bundle: true,
  minify: true,
  sourcemap: false,
  platform: "browser",
  format: "iife",
  globalName: "ReclaimBayPaid",
  jsx: "automatic",
  tsconfig: path.join(root, "tsconfig.json"),
  define: {
    "process.env.NODE_ENV": '"production"',
    "process.env.NEXT_PUBLIC_ANALYTICS_API_URL": JSON.stringify(
      process.env.NEXT_PUBLIC_ANALYTICS_API_URL ?? "",
    ),
  },
  logLevel: "warning",
});
