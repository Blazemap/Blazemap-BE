import assert from 'node:assert/strict';
import console from 'node:console';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import { demoAreas, demoDatabase } from './seed-areas.ts';
const features = demoAreas();
assert.equal(features.length, 10);
assert.equal(new Set(features.map(feature => feature.id)).size, 10);
for (const feature of features) {
  assert.equal(feature.properties.demo, true);
  assert.equal(feature.properties.verification, 'NOT_VERIFIED');
  assert.ok(feature.properties.areaHectares > 0);
  const ring = feature.geometry.coordinates[0];
  assert.deepEqual(ring[0], ring.at(-1));
  assert.equal(ring.length, 5);
  for (const [longitude, latitude] of ring) { assert.ok(longitude >= 108 && longitude <= 119); assert.ok(latitude >= -5 && latitude <= 5); }
}
const env = { NODE_ENV: 'test', DEMO_SEED_CONFIRM: 'ISOLATED_DEMO_ONLY', DATABASE_URL: 'postgresql://localhost/blazemap', DEMO_DATABASE_URL: 'postgresql://localhost/blazemap_demo_test' };
assert.equal(demoDatabase(env, {}), 'blazemap_demo_test');
assert.throws(() => demoDatabase({ ...env, NODE_ENV: 'production' }, {}));
assert.throws(() => demoDatabase({ ...env, DATABASE_URL: env.DEMO_DATABASE_URL }, {}));
assert.throws(() => demoDatabase({ ...env, DEMO_SEED_CONFIRM: '' }, {}));
const rejected = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./seed-cases.ts', import.meta.url)), '--apply', '--confirm-demo-database'], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production', DATABASE_URL: 'postgresql://localhost/unused', DEMO_DATABASE_URL: 'postgresql://localhost/blazemap_demo_test' } });
assert.equal(rejected.status, 1);
assert.match(rejected.stderr, /Demo case seed failed/);
console.log('Demo polygon generation and isolated case-seeder refusal checks passed. No database writes.');
