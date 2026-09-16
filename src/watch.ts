import { runSourcesWatch } from './modules/integrations/index.js';
import { disconnect } from './config/index.js';

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
try { await runSourcesWatch(controller.signal); }
catch { console.error('Source watcher unavailable'); process.exitCode = 1; }
finally { await disconnect(); }
