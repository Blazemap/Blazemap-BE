import assert from 'node:assert/strict';
process.env.DATABASE_URL = '';
const { sampleOperationsPlan, sampleOperationsFlags, sampleOperationsProvenance } = await import('./src/seed-sample-operations.ts');

const plan = sampleOperationsPlan(new Date('2026-09-19T00:00:00.000Z'));
assert.equal(sampleOperationsProvenance, 'sample-operations-v1');
assert.equal(plan.teams.length, 3);
assert.equal(plan.equipment.length, 6);
assert.equal(plan.layers.length, 2);
assert.equal(plan.layers.find(layer => layer.kind === 'ROAD').features.length >= 2, true);
assert.equal(plan.layers.find(layer => layer.kind === 'WATER_SOURCE').features.length >= 2, true);
assert.equal(new Set([...plan.teams, ...plan.equipment].map(item => item.name)).size, 9);
assert.ok(plan.teams.some(item => item.name === 'Tim Reaksi Cepat Palangka Raya'));
assert.ok(plan.equipment.some(item => item.name === 'Pompa Portabel'));
assert.ok(plan.equipment.some(item => item.name === 'Tangki Air'));
for (const layer of plan.layers) {
  assert.equal(layer.provider, 'SAMPLE');
  assert.equal(layer.license, 'Synthetic');
  assert.match(layer.sourceUrl, /^urn:/);
  assert.equal(layer.verifiedAt, null);
  for (const feature of layer.features) assert.equal(feature.attributes.provenance, sampleOperationsProvenance);
}
assert.equal(sampleOperationsFlags([]), false);
assert.equal(sampleOperationsFlags(['--apply', '--confirm-sample-operations']), true);
for (const args of [['--apply'], ['--confirm-sample-operations'], ['--unknown']]) assert.throws(() => sampleOperationsFlags(args));
const { sampleAssignmentPlan, inspectSampleAssignmentTargets } = await import('./src/seed-sample-operations.ts');
assert.equal(sampleOperationsFlags(['--with-assignments']), false);
const assignments = sampleAssignmentPlan();
assert.deepEqual(assignments.map(item => item.status), ['ASSIGNED', 'IN_PROGRESS', 'COMPLETED']);
assert.equal(new Set(assignments.map(item => item.id)).size, 3);
assert.ok(assignments.every(item => plan.teams.some(team => team.id === item.teamId)));
assert.ok(assignments.every(item => /Training scenario/.test(item.notes) && !('createdAt' in item)));
await assert.rejects(() => inspectSampleAssignmentTargets({ $queryRaw: async () => [], trCase: { findUnique: async () => null } }), /Synthetic case/);
let mismatch = false;
let signals = false;
const targetClient = {
  $queryRaw: async () => [],
  trCase: { findUnique: async ({ where }) => {
    const first = where.id.endsWith('01');
    return { handlingStatus: first ? 'CLOSED' : 'MONITORING', perimeterSource: 'Training fixture', latestAnalysisId: null, _count: { hotspots: signals ? 1 : 0, analyses: 0 }, reports: [{ id: first ? 'sample-v2-report-record-08' : 'sample-v2-report-record-10', idempotencyKey: first ? 'sample-v2-report-08' : 'sample-v2-report-10', payloadHash: 'verified-hash' }] };
  } },
  trAuditLog: { findMany: async ({ where }) => {
    const first = where.OR[0].targetId.endsWith('01');
    return [
      { targetType: 'CASE', details: { isSynthetic: !mismatch, version: 2, authorityReference: 'Training fixture', reportId: first ? 'sample-v2-report-record-08' : 'sample-v2-report-record-10' } },
      { targetType: 'REPORT', details: { isSynthetic: true, version: 2, governmentConfirmation: false, idempotencyKey: first ? 'sample-v2-report-08' : 'sample-v2-report-10', payloadHash: 'verified-hash' } },
    ];
  } },
};
await inspectSampleAssignmentTargets(targetClient);
mismatch = true;
await assert.rejects(() => inspectSampleAssignmentTargets(targetClient), /provenance mismatch/);
mismatch = false;
signals = true;
await assert.rejects(() => inspectSampleAssignmentTargets(targetClient), /operational signals/);
console.log('Sample operations plans, exact synthetic provenance, real-signal refusal and dual-confirmation flags passed.');
