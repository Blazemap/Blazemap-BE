import test from 'node:test';
import assert from 'node:assert/strict';
import { fieldSchema, reportActionSchema, reviewerAssessmentSource, verificationSchema } from '../src/types/index.ts';
import { authorize } from '../src/modules/admin/rules.ts';
import { lockedActor } from '../src/modules/admin/access.ts';
import { submitReportAction, updateCase } from '../src/modules/admin/admin.service.ts';
import { publishInformation } from '../src/modules/admin/information.service.ts';
import { areaHectares, publicPerimeter } from '../src/utils/geometry.ts';
import { errorHandler } from '../src/middleware/guards.ts';

test('expired Prisma transaction returns a safe actionable response', () => {
  let status, body;
  errorHandler(Object.assign(new Error('secret database connection details'), { code: 'P2028' }), {}, { status(value) { status = value; return this; }, json(value) { body = value; } }, () => {});
  assert.equal(status, 503);
  assert.equal(body.code, 'TRANSACTION_FAILED');
  assert.doesNotMatch(JSON.stringify(body), /secret/);
});
const input = { operatorWorkflow: true, authorityReference: 'Operator-supplied application authority note', outcome: 'CONFIRMED_FIRE', fieldUpdateId: 'field', version: 1, reason: 'Observed visible flames', reporterMessage: 'Observed visible flames', perimeter: { type: 'Polygon', coordinates: [[[110, -2], [111, -2], [110.5, -1], [110, -2]]] }, perimeterObservedAt: new Date(Date.now() - 60000).toISOString(), perimeterSource: 'Field survey' };
const reportAction = { status: 'CONFIRMED_FIRE', description: 'Observed visible flames', attachmentIds: ['photo'], idempotencyKey: 'ec511181-f67f-453f-9ba0-d9df568758d5', confirmed: { evidence: { findings: 'VISIBLE_FIRE', source: reviewerAssessmentSource }, perimeter: input.perimeter, authorityReference: 'APPLICATION_ADMIN_ROLE', expectedCaseVersion: 1 } };
test('report action schema keeps status, optional attachments and confirmation perimeter in one payload', () => {
  assert.equal(reportActionSchema.safeParse(reportAction).success, true);
  assert.equal(reportActionSchema.safeParse({ ...reportAction, attachmentIds: [] }).success, true);
  assert.equal(reportActionSchema.safeParse({ ...reportAction, attachmentIds: Array.from({ length: 6 }, (_, index) => `photo-${index}`) }).success, false);
  assert.equal(reportActionSchema.safeParse({ ...reportAction, confirmed: undefined }).success, false);
  const { confirmed: _confirmed, ...plain } = reportAction;
  assert.equal(reportActionSchema.safeParse({ ...plain, status: 'REVIEWED', attachmentIds: [] }).success, true);
  assert.equal(reportActionSchema.safeParse({ ...plain, status: 'DECLINED', confirmed: { perimeter: input.perimeter } }).success, false);
});
test('bad confirmation polygon is rejected before status transaction', async () => {
  let transactions = 0;
  const client = { $transaction: async () => { transactions++; } };
  const bad = { ...reportAction, confirmed: { ...reportAction.confirmed, perimeter: { type: 'Polygon', coordinates: [[[110, -2], [111, -1], [110, -1], [111, -2], [110, -2]]] } } };
  await assert.rejects(submitReportAction({ id: 'admin' }, 'report', bad, client));
  assert.equal(transactions, 0);
});
test('open confirmation polygon is rejected before any transaction or write', async () => {
  let transactions = 0;
  const client = { $transaction: async () => { transactions++; } };
  const open = { ...reportAction, confirmed: { ...reportAction.confirmed, perimeter: { type: 'Polygon', coordinates: [[[110, -2], [111, -2], [110.5, -1], [110.25, -1.5]]] } } };
  await assert.rejects(submitReportAction({ id: 'admin' }, 'report', open, client), /closed/);
  assert.equal(transactions, 0);
});
test('confirmed action rejects a current non-ADMIN before report or case writes', async () => {
  let writes = 0;
  const tx = {
    $queryRaw: async () => {},
    msUser: { findUnique: async () => ({ id: 'user', role: 'USER', active: true, emailVerified: true, canConfirmIncidents: true, canPublishInformation: true }) },
    trReport: { findUniqueOrThrow: async () => { writes++; } },
  };
  await assert.rejects(submitReportAction({ id: 'user' }, 'report', { ...reportAction, attachmentIds: [] }, { $transaction: callback => callback(tx) }), error => error.code === 'FORBIDDEN');
  assert.equal(writes, 0);
});
test('confirmed action rejects a stale linked case version before writes', async () => {
  let writes = 0;
  const tx = {
    $queryRaw: async () => {},
    msUser: { findUnique: async () => ({ id: 'admin', role: 'ADMIN', active: true, emailVerified: true, canConfirmIncidents: false, canPublishInformation: false }) },
    trReport: { findUniqueOrThrow: async () => ({ id: 'report', number: 'R-1', reviewStatus: 'NEW', caseId: 'case', regionId: null, locationMode: 'INCIDENT_ESTIMATE', latitude: -2, longitude: 110 }) },
    trReportProgress: { findUnique: async () => null, create: async () => { writes++; } },
    trCase: { findUniqueOrThrow: async () => ({ id: 'case', verificationStatus: 'UNVERIFIED', version: 2, perimeter: null, perimeterObservedAt: null, perimeterSource: null, perimeterRevision: 0 }), update: async () => { writes++; } },
  };
  await assert.rejects(submitReportAction({ id: 'admin' }, 'report', { ...reportAction, attachmentIds: [] }, { $transaction: callback => callback(tx) }), error => error.code === 'VERSION_CONFLICT');
  assert.equal(writes, 0);
});
for (const confirmed of [false, true]) test(`report action is idempotent without reusing attachments and rejects changed content: confirmed=${confirmed}`, async () => {
  const existing = { id: 'progress', reportId: 'report', payloadHash: 'stored', stage: 'REVIEWED', description: 'Reviewed evidence', createdAt: new Date(), attachments: [] };
  let writes = 0;
  const tx = {
    $queryRaw: async () => {},
    msUser: { findUnique: async () => ({ id: 'admin', role: 'ADMIN', active: true, emailVerified: true, canConfirmIncidents: false, canPublishInformation: false }) },
    trReport: { findUniqueOrThrow: async () => ({ id: 'report', reviewStatus: 'NEW', caseId: null }) },
    trReportProgress: { findUnique: async () => existing, create: async () => { writes++; } },
  };
  const client = { $transaction: callback => callback(tx) };
  const body = confirmed ? { ...reportAction, attachmentIds: [] } : { status: 'REVIEWED', description: 'Reviewed evidence', attachmentIds: [], idempotencyKey: 'ec511181-f67f-453f-9ba0-d9df568758d5' };
  const crypto = await import('node:crypto');
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
  existing.payloadHash = crypto.createHash('sha256').update(JSON.stringify(canonical({ reportId: 'report', ...body }))).digest('hex');
  const result = await submitReportAction({ id: 'admin' }, 'report', body, client);
  assert.equal(result.id, 'progress');
  await assert.rejects(submitReportAction({ id: 'admin' }, 'report', { ...body, description: 'Changed description' }, client), /key already used/);
  assert.equal(writes, 0);
});
for (const [latency, failure] of [[0, null], [400, null], [1000, 'timeout'], [0, 'notification'], [0, 'audit']]) test(`no-photo transaction: ${latency}ms simulated latency, failure=${failure}`, async () => {
  const state = { report: 'NEW', progress: 0, notification: 0, field: 0, verification: 0, incident: 0, audits: 0 };
  const tx = {
    $queryRaw: async () => {},
    msUser: { findUnique: async () => ({ id: 'admin', role: 'ADMIN', active: true, emailVerified: true, canConfirmIncidents: false, canPublishInformation: false }) },
    msRegion: { findFirst: async () => null },
    trReport: {
      findUniqueOrThrow: async () => ({ id: 'report', number: 'R-1', reporterId: 'reporter', reviewStatus: state.report, caseId: 'case', regionId: null, locationMode: 'INCIDENT_ESTIMATE', latitude: -2, longitude: 110 }),
      update: async ({ data }) => { state.report = data.reviewStatus; },
    },
    trReportProgress: {
      findUnique: async () => null,
      create: async () => ({ id: `progress-${++state.progress}` }),
      findUniqueOrThrow: async () => ({ id: 'progress-1', stage: 'CONFIRMED_FIRE', description: reportAction.description, createdAt: new Date(), attachments: [] }),
    },
    trCase: {
      findUniqueOrThrow: async () => ({ id: 'case', verificationStatus: 'UNVERIFIED', handlingStatus: 'OPEN', version: 1, perimeter: null, perimeterObservedAt: null, perimeterSource: null, perimeterRevision: 0 }),
      update: async () => { state.incident++; return { perimeterRevision: 1 }; },
    },
    trFieldUpdate: { create: async ({ data }) => { state.field++; assert.equal(data.findings, 'VISIBLE_FIRE'); assert.equal(data.source, reviewerAssessmentSource); return { id: 'field-1' }; } },
    trAttachment: { updateMany: async () => assert.fail('No attachment update is needed') },
    trNotification: { createMany: async ({ data }) => { if (failure === 'notification') throw new Error('notification failed'); assert.equal(data[0].userId, 'reporter'); state.notification += data.length; return { count: data.length }; } },
    trVerification: { create: async () => { state.verification++; }, findFirst: async () => null },
    trAuditLog: { create: async ({ data }) => { if (failure === 'audit' && data.action === 'REPORT_ACTION_RECORDED') throw new Error('audit failed'); state.audits++; if (data.action === 'REVIEWER_ASSESSMENT_RECORDED') { assert.equal(data.details.verificationBasis, 'OPERATOR_ASSESSMENT'); assert.equal(data.details.independentFieldObservation, false); assert.equal(data.details.locationSource, 'OPERATOR_MAPPED_BOUNDARY'); } } },
  };
  const client = { $transaction: async (callback, options) => {
    const before = structuredClone(state);
    let elapsed = 0;
    const wrap = target => new Proxy(target, { get(object, key) {
      const value = object[key];
      if (typeof value === 'function') return async (...args) => {
        elapsed += latency;
        if (elapsed > (options?.timeout ?? 5000)) throw Object.assign(new Error('Transaction expired'), { code: 'P2028' });
        return value(...args);
      };
      return value && typeof value === 'object' ? wrap(value) : value;
    } });
    try { return await callback(wrap(tx)); }
    catch (error) { Object.assign(state, before); throw error; }
  } };
  const before = structuredClone(state);
  const request = submitReportAction({ id: 'admin' }, 'report', { ...reportAction, attachmentIds: [] }, client);
  if (failure) {
    await assert.rejects(request, failure === 'timeout' ? { code: 'P2028' } : new RegExp(`${failure} failed`));
    assert.deepEqual(state, before);
    return;
  }
  const result = await request;
  assert.equal(result.id, 'progress-1');
  assert.deepEqual(state, { report: 'REVIEWED', progress: 1, notification: 1, field: 1, verification: 1, incident: 1, audits: 4 });
});
test('confirmed action rejects overwriting an already confirmed case and directs boundary changes to revision', async () => {
  let writes = 0;
  const tx = {
    $queryRaw: async () => {},
    msUser: { findUnique: async () => ({ id: 'admin', role: 'ADMIN', active: true, emailVerified: true, canConfirmIncidents: false, canPublishInformation: false }) },
    trReport: { findUniqueOrThrow: async () => ({ id: 'report', number: 'R-1', reviewStatus: 'REVIEWED', caseId: 'case', regionId: null, locationMode: 'INCIDENT_ESTIMATE', latitude: -2, longitude: 110 }) },
    trReportProgress: { findUnique: async () => null, create: async () => { writes++; } },
    trCase: { findUniqueOrThrow: async () => ({ id: 'case', verificationStatus: 'CONFIRMED_FIRE', version: 4, perimeter: input.perimeter, perimeterObservedAt: new Date(input.perimeterObservedAt), perimeterSource: 'Field survey', perimeterRevision: 1 }) },
  };
  await assert.rejects(submitReportAction({ id: 'admin' }, 'report', { ...reportAction, attachmentIds: [] }, { $transaction: callback => callback(tx) }), /Revise boundary/);
  assert.equal(writes, 0);
});
test('confirmed action rejects an unavailable attachment before any status or verification update', async () => {
  const state = { report: 'NEW', progress: 0, field: 0, verification: 0, incident: 0 };
  const tx = {
    $queryRaw: async () => {},
    msUser: { findUnique: async () => ({ id: 'admin', role: 'ADMIN', active: true, emailVerified: true, canConfirmIncidents: false, canPublishInformation: false }) },
    msRegion: { findFirst: async () => null },
    trReport: {
      findUniqueOrThrow: async () => ({ id: 'report', number: 'R-1', reporterId: 'reporter', reviewStatus: state.report, caseId: 'case', regionId: null, locationMode: 'INCIDENT_ESTIMATE', latitude: -2, longitude: 110 }),
      update: async () => { state.report = 'REVIEWED'; },
    },
    trReportProgress: { findUnique: async () => null, create: async () => ({ id: `progress-${++state.progress}` }) },
    trCase: {
      findUniqueOrThrow: async () => ({ id: 'case', verificationStatus: 'UNVERIFIED', version: 1, perimeter: null, perimeterObservedAt: null, perimeterSource: null, perimeterRevision: 0 }),
      update: async () => { state.incident++; return { perimeterRevision: 1 }; },
    },
    trFieldUpdate: { create: async () => ({ id: `field-${++state.field}` }) },
    trAttachment: { updateMany: async () => ({ count: 0 }) },
    trVerification: { create: async () => { state.verification++; }, findFirst: async () => null },
  };
  const client = { $transaction: async callback => {
    const before = structuredClone(state);
    try { return await callback(tx); }
    catch (error) { Object.assign(state, before); throw error; }
  } };
  await assert.rejects(submitReportAction({ id: 'admin' }, 'report', reportAction, client), /attachments are unavailable/);
  assert.deepEqual(state, { report: 'NEW', progress: 0, field: 0, verification: 0, incident: 0 });
});
test('field evidence permits an operator VISIBLE_FIRE update without a photo', () => {
  const field = { findings: 'VISIBLE_FIRE', description: 'Visible flames observed directly', source: 'Field operator', observedAt: new Date(Date.now() - 60000).toISOString(), latitude: null, longitude: null, attachmentIds: [] };
  assert.equal(fieldSchema.safeParse(field).success, true);
  assert.equal(fieldSchema.safeParse({ ...field, attachmentIds: Array.from({ length: 6 }, (_, index) => `photo-${index}`) }).success, false);
});
test('operator confirmation requires authority note, atomic perimeter and evidence metadata', () => {
  assert.equal(verificationSchema.safeParse(input).success, true);
  for (const key of ['authorityReference', 'perimeter', 'fieldUpdateId', 'perimeterObservedAt', 'perimeterSource', 'reporterMessage']) {
    const incomplete = { ...input };
    delete incomplete[key];
    assert.equal(verificationSchema.safeParse(incomplete).success, false, key);
  }
});
test('private perimeter revision preserves confirmed status and increments versioned revision with audit', async () => {
  let update;
  let audit;
  const current = { id: 'case', number: 'C-1', title: 'Case', latitude: -2, longitude: 110, regionId: null, verificationStatus: 'CONFIRMED_FIRE', handlingStatus: 'MONITORING', priority: 'HIGH', priorityReason: 'Reviewed', version: 7, contextRevision: 4, latestAnalysisId: null, openedAt: new Date(), updatedAt: new Date(), closedAt: null, closureReason: null, perimeter: input.perimeter, perimeterObservedAt: new Date(input.perimeterObservedAt), perimeterSource: 'Field survey', perimeterRevision: 2 };
  const tx = {
    $queryRaw: async () => {},
    msUser: { findUnique: async () => ({ id: 'admin', role: 'ADMIN', active: true, emailVerified: true, canConfirmIncidents: false, canPublishInformation: false }) },
    trCase: {
      findUniqueOrThrow: async () => current,
      update: async request => {
        update = request;
        return { ...current, perimeter: request.data.perimeter, perimeterObservedAt: request.data.perimeterObservedAt, perimeterSource: request.data.perimeterSource, perimeterRevision: 3, version: 8 };
      },
    },
    trAuditLog: { create: async request => { audit = request; } },
  };
  const revised = { ...input.perimeter, coordinates: [[[110, -2], [111.2, -2], [110.5, -0.8], [110, -2]]] };
  const result = await updateCase({ id: 'admin' }, 'case', { version: 7, perimeter: revised, perimeterObservedAt: input.perimeterObservedAt, perimeterSource: 'Revised field survey', reason: 'Adjusted to the latest observed boundary', authorityReference: 'Operator authority note' }, { $transaction: callback => callback(tx) });
  assert.deepEqual(update.where, { id: 'case', version: 7 });
  assert.deepEqual(update.data.perimeterRevision, { increment: 1 });
  assert.deepEqual(update.data.version, { increment: 1 });
  assert.equal(update.data.verificationStatus, undefined);
  assert.equal(result.perimeterRevision, 3);
  assert.equal(result.version, 8);
  assert.equal(audit.data.action, 'CASE_PERIMETER_UPDATED');
  assert.equal(audit.data.details.before.revision, 2);
  assert.equal(audit.data.details.after.revision, 3);
});
test('public perimeter is exposed only from an explicitly approved confirmed snapshot', () => {
  const approved = { geometry: input.perimeter, observedAt: input.perimeterObservedAt, source: 'Government-reviewed mapped area', areaHectares: areaHectares(input.perimeter), revision: 1 };
  const snapshot = { verificationStatus: 'CONFIRMED_FIRE', publicPerimeter: approved };
  assert.deepEqual(publicPerimeter({ publicLocationMode: 'APPROVED_INCIDENT_PERIMETER', publicCaseSnapshot: snapshot }), { publicPerimeter: approved });
  assert.deepEqual(publicPerimeter({ publicLocationMode: 'NONE', publicCaseSnapshot: snapshot }), {});
  assert.deepEqual(publicPerimeter({ publicLocationMode: 'APPROVED_INCIDENT_PERIMETER', publicCaseSnapshot: { ...snapshot, verificationStatus: 'UNVERIFIED' } }), {});
});
test('generic approved-perimeter publication requires the reviewed case version', async () => {
  const updatedAt = new Date('2026-09-01T00:00:00Z');
  const item = { id: 'publication', status: 'DRAFT', updatedAt, regions: [], sources: [{ title: 'Source', url: 'https://example.org/source' }], validUntil: null, type: 'UPDATE', outcome: null, reportId: null, caseId: 'case', publicLocationMode: 'APPROVED_INCIDENT_PERIMETER', publicLatitude: null, publicLongitude: null, privacyReview: 'Approved perimeter after privacy review', supersedesId: null };
  let writes = 0;
  const tx = {
    $queryRaw: async () => {},
    msUser: { findUnique: async () => ({ id: 'admin', role: 'ADMIN', active: true, emailVerified: true, canConfirmIncidents: false, canPublishInformation: false }) },
    trPublicInformation: { findUniqueOrThrow: async () => item, update: async () => { writes++; return { ...item, regions: [], attachments: [], replacements: [], supersedes: null, publishedAt: new Date() }; } },
    trCase: { findUniqueOrThrow: async () => ({ id: 'case', number: 'C-1', title: 'Case', version: 4, verificationStatus: 'CONFIRMED_FIRE', handlingStatus: 'MONITORING', perimeter: input.perimeter, perimeterObservedAt: new Date(input.perimeterObservedAt), perimeterSource: 'Field survey', perimeterRevision: 1, region: null }) },
    trAuditLog: { create: async () => {} },
  };
  const client = { $transaction: callback => callback(tx) };
  await assert.rejects(publishInformation({ id: 'admin' }, 'publication', { expectedUpdatedAt: updatedAt.toISOString(), authorityReference: 'Publication authority', expectedCaseVersion: 3 }, client), /changed since publication review/);
  assert.equal(writes, 0);
});
test('active verified ADMIN implicitly grants both operations regardless of stored flags', () => {
  for (const capability of ['canConfirmIncidents', 'canPublishInformation']) {
    const user = { role: 'ADMIN', active: true, emailVerified: true, canConfirmIncidents: false, canPublishInformation: false };
    assert.doesNotThrow(() => authorize(user, capability));
    for (const change of [{ role: 'USER' }, { active: false }, { emailVerified: false }, { emailVerified: undefined }]) {
      assert.throws(() => authorize({ ...user, canConfirmIncidents: true, canPublishInformation: true, ...change }, capability));
    }
  }
});
test('locked actor uses current database role and verification, never stale caller grants', async () => {
  const actor = { id: 'operator', role: 'ADMIN', active: true, emailVerified: true, canConfirmIncidents: true, canPublishInformation: true };
  let current = { ...actor, canConfirmIncidents: false, canPublishInformation: false };
  let locked = false;
  const tx = { $queryRaw: async () => { locked = true; }, msUser: { findUnique: async () => { assert.equal(locked, true); return current; } } };
  const effective = await lockedActor(tx, actor, true, 'canPublishInformation');
  assert.equal(effective.canConfirmIncidents, true);
  assert.equal(effective.canPublishInformation, true);
  for (const change of [{ role: 'USER' }, { active: false }, { emailVerified: false }]) {
    current = { ...actor, ...change };
    await assert.rejects(lockedActor(tx, actor, true));
  }
  current = { ...actor, role: 'USER' };
  const citizen = await lockedActor(tx, actor);
  assert.equal(citizen.canConfirmIncidents, false);
  assert.equal(citizen.canPublishInformation, false);
});
