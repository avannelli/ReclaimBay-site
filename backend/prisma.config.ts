import { defineConfig } from "prisma/config";

// Load backend/.env for local CLI runs. Railway injects env vars directly.
try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the process environment.
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  // Optional for `prisma generate`; required for `prisma migrate deploy`.
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
