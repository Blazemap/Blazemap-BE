import { db, disconnect } from './src/config/db.ts';
import { env } from './src/config/env.ts';
try {
  if (process.argv.length !== 3 || process.argv[2] !== '--confirm-read-only-database') throw new Error('Explicit read-only database confirmation required');
  const keys = ['DATABASE_URL', 'BETTER_AUTH_SECRET', 'BETTER_AUTH_URL', 'FRONTEND_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'FIRMS_MAP_KEY', 'FIRMS_PRODUCTS', 'FIRMS_AREA', 'AI_SERVICE_URL', 'AI_SERVICE_TOKEN', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_FROM', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'TRIAGE_HOTSPOT_RADIUS_METERS', 'TRIAGE_HOTSPOT_WINDOW_HOURS', 'TRIAGE_SETTLEMENT_RADIUS_METERS'];
  console.log(JSON.stringify({ configurationPresent: Object.fromEntries(keys.map(key => [key, Boolean(env[key])])) }));
  const client = db();
  const runs = await client.trIntegrationRun.findMany({ where: { provider: 'FIRMS' }, orderBy: { startedAt: 'desc' }, take: 3, select: { id: true, status: true, startedAt: true, completedAt: true, received: true, imported: true, deduplicated: true, failureCode: true, scope: true } });
  const hotspots = await client.trHotspot.groupBy({ by: ['source', 'product'], _count: true });
  const tls = await client.$queryRaw`SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()`;
  console.log(JSON.stringify({ tls, runs, hotspots }));
  const started = Date.now();
  try { await client.$transaction(async tx => { await tx.$queryRaw`SELECT 1`; }, { maxWait: 10000, timeout: 30000 }); console.log(JSON.stringify({ transactionProbe: true, elapsedMs: Date.now() - started })); }
  catch (error) { console.log(JSON.stringify({ transactionProbe: false, elapsedMs: Date.now() - started, code: error.code, cause: /Unable to start/.test(error.message) ? 'START_TIMEOUT' : /expired/i.test(error.message) ? 'EXPIRED' : 'OTHER' })); }
} catch { console.error('Read-only runtime inspection failed'); process.exitCode = 1; }
finally { await disconnect(); }
