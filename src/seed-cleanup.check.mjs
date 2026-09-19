import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertNoReferences, cleanupOptions, guard } from './seed-cleanup.ts';

test('dry-run is the default and apply requires explicit confirmation', () => {
  assert.equal(cleanupOptions([]).apply, false);
  assert.throws(() => cleanupOptions(['--apply']));
  assert.equal(cleanupOptions(['--apply', '--confirm-seeded-records-only']).apply, true);
  assert.throws(() => cleanupOptions(['--force']));
});
test('unknown and immutable references block removal', () => {
  const targets = new Set(['fixture']);
  assert.throws(() => assertNoReferences([{ id: 'real-report', caseId: 'fixture' }], 'caseId', targets, new Set(), 'reports'));
  assert.throws(() => assertNoReferences([{ id: 'audit', actorId: 'fixture' }], 'actorId', targets, new Set(), 'audits'));
  assertNoReferences([{ id: 'fixture-session', userId: 'fixture' }], 'userId', targets, new Set(['fixture-session']), 'sessions');
  assertNoReferences([{ id: 'real-session', userId: 'private-user' }], 'userId', targets, new Set(), 'sessions');
});
test('failed provenance blocks instead of accepting approximate identities', () => {
  assert.throws(() => guard(false, 'provenance mismatch'), /provenance mismatch/);
  guard(true, 'verified');
});
