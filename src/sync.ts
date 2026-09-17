import { syncSource } from './modules/integrations/index.js';
import { disconnect } from './config/index.js';
try { const result = await syncSource(process.argv[2] ?? '', {}); console.log(`${result.provider}: ${result.status}; imported ${result.imported}`); }
catch (error) { const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'SYNC_FAILED'; console.error(`Source sync unavailable or rate limited (${code})`); process.exitCode = 1; }
finally { await disconnect(); }
