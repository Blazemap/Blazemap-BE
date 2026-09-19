import { db, disconnect, env } from './config/index.js';
import { inspectOsmSource, runOsmImport } from './modules/spatial/service.js';

const dryRun = process.argv.slice(2).includes('--dry-run');
try {
  const result = dryRun ? await inspectOsmSource(env) : await runOsmImport(db(), env);
  console.log(JSON.stringify(result));
} catch (error) {
  const message = error instanceof Error ? error.message : 'Spatial import failed';
  console.error(message);
  process.exitCode = 1;
} finally { await disconnect(); }
