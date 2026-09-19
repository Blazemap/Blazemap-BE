import assert from 'node:assert/strict';
import { verifyCase } from './src/modules/admin/admin.service.ts';

const actor = { id: 'operator', role: 'ADMIN', active: true, canConfirmIncidents: true };
let user = { ...actor, emailVerified: true };
let mandate = { id: 'mandate-audit', details: { mandate: 'Configured operational mandate', role: 'ADMIN', active: true, canConfirmIncidents: true } };
let field = { id: 'field', caseId: 'case', findings: 'VISIBLE_FIRE', source: 'Patrol observation', observedAt: new Date('2026-09-01'), latitude: -2, longitude: 110 };
let state = { c: { id: 'case', version: 1, contextRevision: 2, perimeterRevision: 0, verificationStatus: 'UNVERIFIED', handlingStatus: 'OPEN', latitude: null, longitude: null }, audits: [], decisions: [], progress: [] };
let failAudit = false;
const tx = {
  $queryRaw: async () => [],
  msUser: { findUnique: async () => user },
  trAuditLog: { findFirst: async () => mandate, create: async ({ data }) => { if (failAudit && data.action === 'CASE_PERIMETER_UPDATED') throw new Error('Audit failed'); state.audits.push(data); } },
  trCase: { findUniqueOrThrow: async () => ({ ...state.c }), update: async ({ data }) => { for (const [key, value] of Object.entries(data)) if (value !== undefined) state.c[key] = value && typeof value === 'object' && 'increment' in value ? (state.c[key] ?? 0) + value.increment : value; return { ...state.c }; } },
  trFieldUpdate: { findFirst: async ({ where }) => field?.caseId === where.caseId && field?.id === where.id ? field : null },
  trVerification: { create: async ({ data }) => state.decisions.push(data) },
  trReport: { findMany: async () => [{ id: 'owner-report' }], findUniqueOrThrow: async () => ({ reporterId: 'reporter' }) },
  trReportProgress: { createMany: async ({ data }) => state.progress.push(...data) },
  trNotification: { createMany: async () => ({ count: 1 }) },
};
const client = { $transaction: async action => { const before = structuredClone(state); try { return await action(tx); } catch (error) { state = before; throw error; } } };
const input = { operatorWorkflow: true, authorityReference: 'Operator-supplied application authority note', outcome: 'CONFIRMED_FIRE', fieldUpdateId: 'field', version: 1, reason: 'Visible fire verified by field inspection.', reporterMessage: 'Visible fire verified by field inspection.', perimeter: { type: 'Polygon', coordinates: [[[110, -2], [110.01, -2], [110.01, -2.01], [110, -2]]] }, perimeterObservedAt: '2026-09-01T00:00:00Z', perimeterSource: 'Patrol boundary observation' };
const original = structuredClone(state);
for (const coordinates of [
  [[[110, -2], [110.02, -2.02], [110, -2.02], [110.02, -2], [110, -2]]],
  [[[110, -2], [110.01, -2], [110, -2]]],
]) {
  await assert.rejects(verifyCase(actor, 'case', { ...input, perimeter: { type: 'Polygon', coordinates } }, client));
  assert.deepEqual(state, original);
}
await assert.rejects(verifyCase(actor, 'case', { ...input, perimeter: { type: 'Polygon', coordinates: [[[110, -2], [110.01, -2], [110.01, -2.01]]] } }, client));
assert.deepEqual(state, original);
const { perimeter, ...withoutPolygon } = input;
await assert.rejects(verifyCase(actor, 'case', withoutPolygon, client));
assert.deepEqual(state, original);
await verifyCase(actor, 'case', input, client);
assert.deepEqual(state.c.perimeter, perimeter);
assert.equal(state.c.verificationStatus, 'CONFIRMED_FIRE');
assert.equal(state.c.version, 2);
assert.equal(state.c.contextRevision, 3);
assert.equal(state.c.perimeterRevision, 1);
assert.equal(state.decisions[0].authorityReference, input.authorityReference);
assert.equal(state.audits.some(a => a.action === 'CASE_PERIMETER_UPDATED' && a.details.authorityNoteSource === 'OPERATOR_SUPPLIED'), true);
assert.equal(state.progress[0].description, input.reporterMessage);
assert.equal(JSON.stringify(state.progress).includes(mandate.details.mandate), false);
await assert.rejects(verifyCase(actor, 'case', input, client), { code: 'VERSION_CONFLICT' });
state = structuredClone(original);
for (const change of [{ role: 'USER' }, { active: false }, { emailVerified: false }]) {
  user = { ...actor, emailVerified: true, ...change };
  await assert.rejects(verifyCase(actor, 'case', input, client));
  assert.deepEqual(state, original);
}
user = { ...actor, emailVerified: true };
const configured = mandate;
mandate = null;
user = { ...actor, emailVerified: true, canConfirmIncidents: false, canPublishInformation: false };
await verifyCase(actor, 'case', input, client);
assert.equal(state.decisions[0].authorityReference, input.authorityReference);
state = structuredClone(original);
mandate = configured;
field.findings = 'SMOKE_ONLY';
await assert.rejects(verifyCase(actor, 'case', input, client), { code: 'INSUFFICIENT_EVIDENCE' });
field.findings = 'VISIBLE_FIRE';
field.caseId = 'other-case';
await assert.rejects(verifyCase(actor, 'case', input, client), { code: 'INVALID_EVIDENCE' });
field.caseId = 'case';
failAudit = true;
await assert.rejects(verifyCase(actor, 'case', input, client), /Audit failed/);
assert.deepEqual(state, original);
console.log('Atomic confirmation: polygon, ADMIN role with false flags and no mandate, operator note, evidence, stale actor/version, owner privacy and audit rollback passed.');
