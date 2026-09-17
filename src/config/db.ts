import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { env } from './env.js';
import { unavailable } from '../utils/index.js';

const client = env.DATABASE_URL ? new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 300000, statement_timeout: 10000, query_timeout: 12000 }), log: [] }) : null;
export function db() { if (!client) throw unavailable('Database'); return client; }
let lastFailureLog = 0;
let readiness: Promise<boolean> | undefined;
export function databaseAvailable() {
  return readiness ??= probeDatabase().finally(() => { readiness = undefined; });
}
async function probeDatabase() {
  if (!client) return false;
  try { await client.$queryRaw`SELECT 1 FROM "MsSiteProfile" LIMIT 1`; return true; }
  catch {
    if (Date.now() - lastFailureLog > 30000) {
      lastFailureLog = Date.now();
      console.warn('Database readiness probe failed; inspect connectivity, pool capacity and schema with the read-only connection check.');
    }
    return false;
  }
}
export async function disconnect() { await client?.$disconnect(); }
