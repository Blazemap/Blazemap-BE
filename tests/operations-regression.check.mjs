import assert from 'node:assert/strict';
import console from 'node:console';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { URL } from 'node:url';
import { lockNearbyWorkflow } from '../src/modules/notifications/nearby.service.ts';
import { lockNotificationEmailWorkflow } from '../src/modules/notifications/email.service.ts';
import { errorHandler } from '../src/middleware/guards.ts';
import { linkRelatedReports } from '../src/modules/admin/admin.service.ts';
import { operationalConditions, operationalSchema, verificationSchema, perimeterPatchSchema } from '../src/types/index.ts';

const lock = () => { throw new Error('A void-valued advisory lock must not use $queryRaw'); };

test('nearby workflow acquires its advisory lock without decoding a void result', async () => {
  let locked = false;
  await lockNearbyWorkflow({ $queryRaw: lock, $executeRaw: async () => { locked = true; } });
  assert.equal(locked, true);
});

test('email claim acquires its advisory lock without decoding a void result', async () => {
  let locked = false;
  await lockNotificationEmailWorkflow({ $queryRaw: lock, $executeRaw: async () => { locked = true; } });
  assert.equal(locked, true);
});

test('unhandled database errors log only safe metadata and return a generic response', () => {
  const original = console.error;
  const logged = [];
  console.error = (...args) => { logged.push(args); };
  let response;
  const res = { status(value) { this.statusCode = value; return this; }, json(value) { response = { status: this.statusCode, body: value }; return this; } };
  try {
    errorHandler(new Error('secret payload should not be logged'), { method: 'POST', route: { path: '/admin/cases/:id/assignments' } }, res, () => {});
  } finally {
    console.error = original;
  }
  assert.deepEqual(response, { status: 500, body: { message: 'Request could not be completed', code: 'INTERNAL_ERROR' } });
  assert.deepEqual(logged, [['Unhandled request failure', { method: 'POST', route: '/admin/cases/:id/assignments', name: 'Error', code: 'UNKNOWN' }]]);
});

test('confirmed-fire and perimeter inputs accept only unique bounded related report selections', () => {
  const perimeter = { type: 'Polygon', coordinates: [[[113, -2], [113.01, -2], [113.01, -2.01], [113, -2]]] };
  const confirmation = { outcome: 'CONFIRMED_FIRE', decisionNote: 'Field team confirmed visible fire.', observationId: 'field-1', version: 1, perimeter, boundaryUsesObservationSourceTime: true };
  const patch = { reporterMessage: 'Boundary reviewed for report owners.', version: 1, perimeter, perimeterObservedAt: new Date().toISOString(), perimeterSource: 'Field review', reason: 'Boundary revision reviewed', authorityReference: 'APPLICATION_ADMIN_ROLE' };
  for (const schema of [verificationSchema, perimeterPatchSchema]) {
    const input = schema === verificationSchema ? confirmation : patch;
    assert.equal(schema.safeParse({ ...input, relatedReportIds: ['report-a', 'report-b'] }).success, true);
    assert.equal(schema.safeParse({ ...input, relatedReportIds: ['report-a', 'report-a'] }).success, false);
    assert.equal(schema.safeParse({ ...input, relatedReportIds: Array.from({ length: 101 }, (_, index) => `report-${index}`) }).success, false);
  }
  assert.equal(verificationSchema.safeParse({ outcome: 'NOT_FIRE', reason: 'Not a fire', reporterMessage: 'Inspection completed', fieldUpdateId: 'field-1', version: 1, operatorWorkflow: true, relatedReportIds: ['report-a'] }).success, false);
});

test('related reports are not linked when any selected report belongs to another case', async () => {
  let writes = 0;
  const tx = {
    $queryRaw: async () => [{ id: 'a' }, { id: 'b' }],
    trReport: {
      findMany: async () => [{ id: 'a', caseId: null, reviewStatus: 'REVIEWED', locationMode: 'INCIDENT_ESTIMATE', latitude: -2, longitude: 113 }, { id: 'b', caseId: 'other-case', reviewStatus: 'REVIEWED', locationMode: 'INCIDENT_ESTIMATE', latitude: -2, longitude: 113 }],
      count: async () => 1,
      updateMany: async () => { writes++; return { count: 2 }; },
    },
    trAuditLog: { create: async () => { writes++; } },
  };
  await assert.rejects(linkRelatedReports(tx, 'admin', 'case-1', ['a', 'b'], 'Same incident confirmed'), error => error.code === 'REPORT_NOT_ELIGIBLE');
  assert.equal(writes, 0);
});

test('unreviewed reports cannot be attached to a confirmed case', async () => {
  let wrote = false;
  const tx = {
    $queryRaw: async () => [],
    trReport: { findMany: async () => [{ id: 'a', caseId: null, reviewStatus: 'NEW', locationMode: 'INCIDENT_ESTIMATE' }], count: async () => 0, updateMany: async () => { wrote = true; return { count: 1 }; } },
  };
  await assert.rejects(linkRelatedReports(tx, 'admin', 'case-1', ['a'], 'Reviewed incident'), error => error.code === 'REPORT_NOT_ELIGIBLE');
  assert.equal(wrote, false);
});

test('reports without an incident point cannot be attached from the picker', async () => {
  let wrote = false;
  const tx = {
    $queryRaw: async () => [],
    trReport: { findMany: async () => [{ id: 'a', caseId: null, reviewStatus: 'REVIEWED', locationMode: 'INCIDENT_ESTIMATE', latitude: null, longitude: null }], count: async () => 0, updateMany: async () => { wrote = true; return { count: 1 }; } },
  };
  await assert.rejects(linkRelatedReports(tx, 'admin', 'case-1', ['a'], 'Reviewed incident'), error => error.code === 'REPORT_NOT_ELIGIBLE');
  assert.equal(wrote, false);
});

test('related reports are linked as one bounded batch after verification checks', async () => {
  const writes = [];
  const tx = {
    $queryRaw: async () => [],
    trReport: {
      findMany: async () => [{ id: 'a', caseId: null, reviewStatus: 'REVIEWED', locationMode: 'INCIDENT_ESTIMATE', latitude: -2, longitude: 113 }, { id: 'b', caseId: null, reviewStatus: 'REVIEWED', locationMode: 'INCIDENT_ESTIMATE', latitude: -2, longitude: 113 }],
      count: async () => 1,
      updateMany: async args => { writes.push(args); return { count: 2 }; },
    },
    trAuditLog: { create: async args => { writes.push(args); } },
  };
  await linkRelatedReports(tx, 'admin', 'case-1', ['b', 'a'], 'Same incident confirmed');
  assert.equal(writes.length, 3);
  assert.deepEqual(writes[0].where.id.in, ['a', 'b']);
  assert.equal(writes[0].data.caseId, 'case-1');
});

test('related report linking fails when the database updates fewer rows than selected', async () => {
  let audited = false;
  const tx = {
    $queryRaw: async () => [],
    trReport: {
      findMany: async () => [{ id: 'a', caseId: null, reviewStatus: 'REVIEWED', locationMode: 'INCIDENT_ESTIMATE', latitude: -2, longitude: 113 }, { id: 'b', caseId: null, reviewStatus: 'REVIEWED', locationMode: 'INCIDENT_ESTIMATE', latitude: -2, longitude: 113 }],
      count: async () => 1,
      updateMany: async () => ({ count: 1 }),
    },
    trAuditLog: { create: async () => { audited = true; } },
  };
  await assert.rejects(linkRelatedReports(tx, 'admin', 'case-1', ['a', 'b'], 'Same incident confirmed'), error => error.code === 'REPORT_ALREADY_LINKED');
  assert.equal(audited, false);
});

test('operational feature conditions accepted by the API are allowed by the migration', async () => {
  const migration = await readFile(new URL('../prisma/migrations/20260923010000_designated_location_conditions/migration.sql', import.meta.url), 'utf8');
  const featureConditions = migration.match(/"subjectType" = 'FEATURE' AND "condition" IN \(([^)]+)\)/)?.[1];
  assert.ok(featureConditions);
  for (const condition of operationalConditions.FEATURE) {
    assert.ok(featureConditions.includes(`'${condition}'`), `${condition} is missing from the SQL constraint`);
  }
  for (const condition of ['AVAILABLE', 'UNAVAILABLE']) {
    assert.equal(operationalSchema.safeParse({ subjectType: 'FEATURE', subjectId: 'location-1', condition, source: 'Field inspection', observedAt: new Date().toISOString(), reason: 'Verified location condition', idempotencyKey: randomUUID() }).success, true);
  }
});
