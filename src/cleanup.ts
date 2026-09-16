import { cleanupUploads } from './modules/uploads/index.js';
import { disconnect } from './config/index.js';
try { const result = await cleanupUploads(); console.log(`Expired unbound uploads processed: ${result.processed}`); }
catch { console.error('Upload cleanup unavailable'); process.exitCode = 1; }
finally { await disconnect(); }
