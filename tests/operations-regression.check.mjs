import assert from 'node:assert/strict';
import console from 'node:console';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { URL } from 'node:url';
import { lockNearbyWorkflow } from '../src/modules/notifications/nearby.service.ts';
import { lockNotificationEmailWorkflow } from '../src/modules/notifications/email.service.ts';
import { errorHandler } from '../src/middleware/guards.ts';
import { operationalConditions, operationalSchema } from '../src/types/index.ts';

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
