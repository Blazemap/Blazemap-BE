import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { env } from './env.js';
import { unavailable } from '../utils/index.js';

export function databaseConnectionConfig(connectionString: string, ca: string | undefined) {
  if (!ca) return { connectionString };
  const url = new URL(connectionString);
  url.searchParams.delete('sslrootcert');
  url.searchParams.delete('sslmode');
  return { connectionString: url.toString(), ssl: { ca, rejectUnauthorized: true } };
}
const client = env.DATABASE_URL ? new PrismaClient({ adapter: new PrismaPg({ ...databaseConnectionConfig(env.DATABASE_URL, env.DATABASE_CA_PEM), max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 300000, statement_timeout: 10000, query_timeout: 12000 }), log: [] }) : null;
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
