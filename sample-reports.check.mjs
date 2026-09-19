import assert from 'node:assert/strict';
process.env.DATABASE_URL = '';
const { samplePayloads, sampleFlags, disclaimer } = await import('./src/seed-sample-reports.ts');
const { triageReports } = await import('./src/modules/reports/triage.ts');
const now = new Date();
const samples = samplePayloads(now);
assert.equal(samples.length, 10);
assert.equal(new Set(samples.map(({ payload }) => `${payload.latitude},${payload.longitude}`)).size, 10);
assert.deepEqual(Object.fromEntries([...new Set(samples.map(s => s.email))].map(email => [email, samples.filter(s => s.email === email).length])), { 'user@blazemap.test': 2, 'reporter01@blazemap.test': 2, 'reporter02@blazemap.test': 2, 'reporter03@blazemap.test': 2, 'reporter04@blazemap.test': 1, 'reporter05@blazemap.test': 1 });
assert.equal(sampleFlags([]), false);
assert.equal(sampleFlags(['--apply', '--confirm-sample-reports']), true);
for (const args of [['--apply'], ['--confirm-sample-reports'], ['--unknown']]) assert.throws(() => sampleFlags(args));
for (const [index, { payload }] of samples.entries()) {
  assert.equal(payload.idempotencyKey, `sample-report-v1-${String(index + 1).padStart(2, '0')}`);
  assert.equal(Date.parse(payload.observedAt), now.getTime() - (index + 1) * 600000);
  assert.deepEqual(payload.observationTypes, [['SMOKE', 'FLAME', 'BURNING_SMELL'][index % 3]]);
  assert.equal(payload.description.endsWith(disclaimer), true);
  assert.match(payload.description, /simulated/);
  assert.deepEqual(payload.attachmentIds, []);
  assert.equal(payload.locationMode, 'INCIDENT_ESTIMATE');
  const row = { ...payload, id: payload.idempotencyKey, number: 'R-example', observedAt: new Date(payload.observedAt) };
  const client = new Proxy({}, { get() { throw new Error('Sample triage must not query real evidence'); } });
  const result = (await triageReports([row], client, { TRIAGE_HOTSPOT_RADIUS_METERS: '1000', TRIAGE_HOTSPOT_WINDOW_HOURS: '24', TRIAGE_SETTLEMENT_RADIUS_METERS: '1000' }, now, true)).get(row.id);
  assert.equal(result.level, 'UNKNOWN');
  assert.ok(result.reasonCodes.includes('DEMO_EXCLUDED'));
  assert.equal(result.satelliteMatch, null);
  assert.equal(result.settlementMatch, null);
}
console.log('Sample payloads, ownership distribution, write flags and triage exclusion passed.');
