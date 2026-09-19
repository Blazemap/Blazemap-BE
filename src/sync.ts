import { syncSource } from './modules/integrations/index.js';
import { disconnect } from './config/index.js';
import { safeErrorCode, sourceSyncExitCode } from './utils/index.js';
try { const result = await syncSource(process.argv[2] ?? '', {}); console.log(`${result.provider}: ${result.status}; received ${result.received}; imported ${result.imported}; deduplicated ${result.deduplicated}`); }
catch (error) {
  const code = safeErrorCode(error, 'SYNC_FAILED');
  if (code === 'SYNC_RATE_LIMIT') console.log('Source sync skipped (SYNC_RATE_LIMIT)');
  else console.error(`Source sync failed (${code})`);
  process.exitCode = sourceSyncExitCode(error);
}
finally { await disconnect(); }
