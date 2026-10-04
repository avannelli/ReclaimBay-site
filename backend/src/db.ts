import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

export type Db = PrismaClient;

export function createDb(databaseUrl: string, pool: { max?: number; idleTimeoutMillis?: number } = {}): Db {
  const adapter = new PrismaPg({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 5_000,
    ...pool,
  });
  return new PrismaClient({ adapter });
}
