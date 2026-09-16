import { syncSource } from './modules/integrations/index.js';
import { disconnect } from './config/index.js';
try { const result = await syncSource(process.argv[2] ?? '', {}); console.log(`${result.provider}: ${result.status}; imported ${result.imported}`); }
catch { console.error('Source sync unavailable or rate limited'); process.exitCode = 1; }
finally { await disconnect(); }
