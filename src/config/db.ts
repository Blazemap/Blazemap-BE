import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { env } from './env.js';
import { unavailable } from '../utils/index.js';

const client = env.DATABASE_URL ? new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL, max: 10, connectionTimeoutMillis: 3000, idleTimeoutMillis: 30000, statement_timeout: 10000 }), log: [] }) : null;
export function db() { if (!client) throw unavailable('Database'); return client; }
export async function databaseAvailable() {
  if (!client) return false;
  try { await client.$queryRaw`SELECT 1 FROM "MsSiteProfile" LIMIT 1`; return true; } catch { return false; }
}
export async function disconnect() { await client?.$disconnect(); }
