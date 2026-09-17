import 'dotenv/config';
import pg from 'pg';
import { databaseAvailable, disconnect } from './dist/config/db.js';

const deadline = setTimeout(() => { console.log(JSON.stringify({ probe: 'deadline', elapsedMs: 90000 })); process.exit(1); }, 90000);
const timed = async (probe, operation) => {
  const started = Date.now();
  try {
    const available = await operation();
    console.log(JSON.stringify({ probe, available, elapsedMs: Date.now() - started }));
    if (!available) process.exitCode = 1;
  }
  catch { console.log(JSON.stringify({ probe, available: false, elapsedMs: Date.now() - started })); process.exitCode = 1; }
};
try {
  await Promise.all(Array.from({ length: 4 }, (_, i) => timed(`guard-cold-${i + 1}`, databaseAvailable)));
  for (let i = 1; i <= 3; i++) await timed(`guard-warm-${i}`, databaseAvailable);
  await new Promise(resolve => setTimeout(resolve, 31000));
  await timed('guard-after-31s-idle', databaseAvailable);
  await disconnect();
  if (process.env.DATABASE_URL) {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000, statement_timeout: 10000, query_timeout: 12000 });
    const ssl = client.connectionParameters.ssl;
    console.log(JSON.stringify({ tlsEnabled: !!ssl, certificateVerification: !!ssl && ssl.rejectUnauthorized !== false && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0' }));
    let connected = false;
    try {
      await timed('transport-connect-5s', async () => { await client.connect(); connected = true; return true; });
      if (connected) {
        for (let i = 1; i <= 3; i++) await timed(`select-1-${i}`, async () => { await client.query('SELECT 1'); return true; });
        await timed('auth-schema', async () => {
          await client.query('SELECT u.id, u.active, u.role, u."canConfirmIncidents", u."canPublishInformation", s.token, s."expiresAt", a.password, v.identifier FROM "MsUser" u, "TrSession" s, "TrAccount" a, "TrAuthVerification" v LIMIT 0');
          return true;
        });
      }
    } finally { await client.end().catch(() => {}); }
  }
} finally { await disconnect(); clearTimeout(deadline); }
