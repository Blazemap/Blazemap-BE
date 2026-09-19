import assert from 'node:assert/strict';
process.env.DATABASE_URL = '';
const validation = await import('./src/types/index.ts');
const service = await import('./src/modules/admin/admin.service.ts');
const { fingerprint } = await import('./src/utils/index.ts');

const key = '11111111-1111-4111-8111-111111111111';
const actor = { id: 'admin-1', role: 'ADMIN', active: true, emailVerified: true, canConfirmIncidents: true, canPublishInformation: true };
assert.deepEqual(validation.teamSchema.parse({ name: 'Tim Reaksi Cepat', organization: 'Unit operasi', reason: 'Create an operational team', idempotencyKey: key }), { name: 'Tim Reaksi Cepat', organization: 'Unit operasi', reason: 'Create an operational team', idempotencyKey: key });
assert.throws(() => validation.teamSchema.parse({ name: 'Tim Reaksi Cepat' }));
assert.deepEqual(validation.teamPatchSchema.parse({ version: 1, active: false, reason: 'Temporarily remove from service' }), { version: 1, active: false, reason: 'Temporarily remove from service' });
assert.throws(() => validation.teamPatchSchema.parse({ active: false, reason: 'Temporarily remove from service' }));
assert.deepEqual(validation.equipmentSchema.parse({ name: 'Pompa Portabel', kind: 'Pompa', teamId: null, reason: 'Register operational equipment', idempotencyKey: key }), { name: 'Pompa Portabel', kind: 'Pompa', teamId: null, reason: 'Register operational equipment', idempotencyKey: key });
assert.deepEqual(validation.equipmentPatchSchema.parse({ version: 2, teamId: null, reason: 'Return equipment to shared inventory' }), { version: 2, teamId: null, reason: 'Return equipment to shared inventory' });
assert.deepEqual(validation.assignmentSchema.parse({ version: 1, teamId: 'team-1', notes: 'Inspect reported smoke', reason: 'Assign team for field handling', idempotencyKey: key }), { version: 1, teamId: 'team-1', notes: 'Inspect reported smoke', reason: 'Assign team for field handling', idempotencyKey: key });
assert.deepEqual(validation.assignmentPatchSchema.parse({ version: 3, status: 'IN_PROGRESS', reason: 'Team confirmed work has started' }), { version: 3, status: 'IN_PROGRESS', reason: 'Team confirmed work has started' });
assert.deepEqual(validation.operationalSchema.parse({ subjectType: 'FEATURE', subjectId: 'road-1', condition: 'PASSABLE', source: 'Authorized field update', observedAt: new Date().toISOString(), notes: null, reason: 'Record inspected access condition', idempotencyKey: key }).idempotencyKey, key);
assert.throws(() => validation.operationalSchema.parse({ subjectType: 'TEAM', subjectId: 'team-1', condition: 'AVAILABLE', source: 'Field update', observedAt: new Date().toISOString(), reason: 'Record current availability', idempotencyKey: 'short' }));

const teamBody = { name: 'Tim Reaksi Cepat', organization: null, reason: 'Create an operational team', idempotencyKey: key };
const storedTeam = { id: 'team-1', name: teamBody.name, organization: null, active: true, version: 1, createdAt: new Date(), updatedAt: new Date(), payloadHash: fingerprint({ actorId: actor.id, ...teamBody }) };
let teamCreates = 0;
const txBase = { $queryRaw: async () => [], msUser: { findUnique: async () => actor } };
const replayClient = { $transaction: async callback => callback({ ...txBase, msTeam: { findUnique: async () => storedTeam, create: async () => { teamCreates++; } } }) };
const replay = await service.createTeam(actor, teamBody, replayClient);
assert.equal(replay.id, storedTeam.id);
assert.equal(teamCreates, 0);
const conflictClient = { $transaction: async callback => callback({ ...txBase, msTeam: { findUnique: async () => null, findUniqueOrThrow: async () => ({ ...storedTeam, version: 2 }), updateMany: async () => ({ count: 0 }) } }) };
await assert.rejects(() => service.updateTeam(actor, storedTeam.id, { version: 1, active: false, reason: 'Temporarily remove from service' }, conflictClient), error => error.code === 'VERSION_CONFLICT');

const sampleClient = { $transaction: async callback => callback({ ...txBase, trOperationalUpdate: { findUnique: async () => null }, msTeam: { findFirst: async () => ({ id: 'sample-team' }) }, trAuditLog: { findFirst: async () => ({ id: 'sample-audit' }) } }) };
await assert.rejects(() => service.addOperationalUpdate(actor, { subjectType: 'TEAM', subjectId: 'sample-team', condition: 'AVAILABLE', source: 'Field update', observedAt: new Date().toISOString(), notes: null, reason: 'Record current availability', idempotencyKey: key }, sampleClient), error => error.code === 'SAMPLE_DATA');

const sampleAssignmentClient = { $transaction: async callback => callback({ ...txBase, trAssignment: { findUnique: async () => null }, trCase: { findUniqueOrThrow: async () => ({ id: 'real-case', version: 1, handlingStatus: 'OPEN', verificationStatus: 'UNVERIFIED' }) }, msTeam: { findFirst: async () => ({ id: 'sample-team' }) }, trAuditLog: { findFirst: async () => ({ id: 'sample-audit' }) } }) };
await assert.rejects(() => service.assignTeam(actor, 'real-case', { version: 1, teamId: 'sample-team', notes: 'Inspect reported smoke', reason: 'Request field response', idempotencyKey: key }, sampleAssignmentClient), error => error.code === 'SAMPLE_DATA');

const routes = await import('node:fs/promises').then(fs => fs.readFile(new URL('./src/modules/api/api.routes.ts', import.meta.url), 'utf8'));
for (const route of ['/admin/teams/:id', '/admin/equipment/:id', '/admin/cases/:id/assignments', '/admin/assignments/:id', '/admin/operational-updates']) assert.match(routes, new RegExp(route.replaceAll('/', '\\/')));
assert.ok(routes.indexOf("router.use('/admin', adminGuard)") < routes.indexOf("router.get('/admin/operations'"));
console.log('Operational validation, idempotent replay, version conflict, sample refusal and protected-route contracts passed.');
