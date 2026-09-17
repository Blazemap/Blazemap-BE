import assert from 'node:assert/strict';
import { reportSchema } from './src/types/index.ts';

const report = { observationTypes: ['SMOKE'], observedAt: '2025-01-01T02:30:00Z', locationMode: 'OBSERVER_POSITION', latitude: 0, longitude: 0, description: 'Smoke across the river', attachmentIds: [], idempotencyKey: 'report-test-stable-key' };
assert.equal(reportSchema.parse(report).locationDescription, '');
for (const locationDescription of ['', '   ', 'N', 'North of the bridge']) {
  assert.equal(reportSchema.parse({ ...report, locationDescription }).locationDescription, locationDescription.trim());
}
const region = { ...report, latitude: null, longitude: null, regionId: 'verified-region', locationDescription: 'North of the bridge' };
assert.equal(reportSchema.parse(region).locationDescription, region.locationDescription);
for (const locationDescription of [undefined, '', '   ', 'N']) assert.equal(reportSchema.safeParse({ ...region, locationDescription }).success, false);
for (const change of [{ latitude: null }, { longitude: null }, { latitude: 91 }, { longitude: 181 }, { latitude: NaN }, { locationDescription: null }, { locationDescription: 'x'.repeat(1001) }, { observedAt: '2999-01-01T00:00:00Z' }, { observedAt: '2025-02-30T00:00:00Z' }, { description: '   ' }, { observationTypes: [] }, { reporterId: 'forged' }]) assert.equal(reportSchema.safeParse({ ...report, ...change }).success, false);
assert.equal(reportSchema.safeParse({ ...region, regionId: undefined }).success, false);
console.log('Report coordinate pairs, optional landmarks, region descriptions, time and strict request validation passed.');
