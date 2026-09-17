import assert from 'node:assert/strict';
process.env.DATABASE_URL = '';
for (const key of ['TRIAGE_HOTSPOT_RADIUS_METERS', 'TRIAGE_HOTSPOT_WINDOW_HOURS', 'TRIAGE_SETTLEMENT_RADIUS_METERS']) process.env[key] = '';
const reports = await import('./src/modules/reports/reports.service.ts');
const now = new Date('2026-09-17T12:00:00Z');
const row = { id: 'report', number: 'R-1', locationMode: 'INCIDENT_ESTIMATE', latitude: 0, longitude: 110, observedAt: new Date('2026-09-17T10:00:00Z') };
let reads = 0, rows = [row], hotspots = [], settlements = [], layers = [], latest = null;
const client = {
  $transaction: async promises => Promise.all(promises),
  trReport: { findMany: async () => rows, count: async () => rows.length, findFirst: async () => row },
  trHotspot: { findMany: async ({ where, take }) => { reads++; assert.equal(where.source, 'NASA FIRMS'); assert.equal(take, 10001); return hotspots; } },
  msMapFeature: { findMany: async () => { reads++; return settlements; } },
  msMapLayer: { findMany: async () => { reads++; return layers; } },
  trIntegrationRun: { findFirst: async () => { reads++; return latest; } },
};
const policy = { TRIAGE_HOTSPOT_RADIUS_METERS: '1000', TRIAGE_HOTSPOT_WINDOW_HOURS: '1', TRIAGE_SETTLEMENT_RADIUS_METERS: '1000' };
const evaluate = async (input = row, settings = policy) => (await reports.triageReports([input], client, settings, now, true)).get(input.id);
const admin = { id: 'admin', role: 'ADMIN' };
assert.equal((await reports.listReports(admin, {}, true, client)).data[0].triage.level, 'UNKNOWN');
assert.equal((await reports.getReport(admin, row.id, true, client)).triage.level, 'UNKNOWN');
assert.equal('triage' in (await reports.listReports(admin, {}, false, client)).data[0], false);
assert.equal('triage' in await reports.getReport(admin, row.id, false, client), false);
assert.equal(reads, 0);
await assert.rejects(reports.listReports({ ...admin, role: 'USER' }, {}, true, client), { code: 'FORBIDDEN' });
for (const input of [{ ...row, locationMode: 'OBSERVER_POSITION' }, { ...row, latitude: null }, { ...row, number: '[DEMO]-1' }, { ...row, observedAt: new Date('invalid') }]) assert.equal((await evaluate(input)).level, 'UNKNOWN');
for (const value of [undefined, '', '0', '-1', 'NaN', 'Infinity']) assert.equal((await evaluate(row, { ...policy, TRIAGE_HOTSPOT_RADIUS_METERS: value })).level, 'UNKNOWN');
assert.equal(reads, 0);
assert.deepEqual((await evaluate()).missingData, ['SATELLITE_COVERAGE', 'SETTLEMENT_COVERAGE']);
hotspots = [{ id: 'hotspot', source: 'NASA FIRMS', product: 'VIIRS_NOAA20_NRT', raw: {}, acquiredAt: row.observedAt, longitude: 110.001, latitude: 0 }];
assert.equal((await evaluate()).level, 'CRITICAL');
assert.equal((await evaluate()).satelliteMatch.acquiredAt, row.observedAt.toISOString());
for (const change of [{ product: 'DEMO' }, { raw: { demo: true } }, { acquiredAt: new Date('2026-09-16T10:00:00Z') }, { longitude: 111 }, { latitude: NaN }]) {
  const original = hotspots[0]; hotspots[0] = { ...original, ...change };
  assert.equal((await evaluate()).level, 'UNKNOWN'); hotspots[0] = original;
}
layers = [{ id: 'settlements', name: 'Verified settlement survey', provider: 'Survey authority', sourceDate: new Date('2026-09-01T00:00:00Z'), verifiedAt: new Date('2026-09-02T00:00:00Z'), coverage: 'Kalimantan' }];
settlements = [{ id: 'village', layerId: 'settlements', name: 'Village', attributes: {}, geometry: { type: 'Point', coordinates: [110.001, 0] } }];
assert.equal((await evaluate()).level, 'CRITICAL');
hotspots = [];
assert.equal((await evaluate()).level, 'HIGH');
assert.ok((await evaluate()).missingData.includes('SATELLITE_COVERAGE'));
settlements[0].geometry = { type: 'Polygon', coordinates: [[[109.99, -0.01], [110.01, -0.01], [110.01, 0.01], [109.99, 0.01], [109.99, -0.01]]] };
assert.equal((await evaluate()).settlementMatch.distanceMeters, 0);
settlements = [];
latest = { status: 'SUCCEEDED', completedAt: new Date('2026-09-17T11:50:00Z'), scope: { products: ['VIIRS_NOAA20_NRT'], area: '109,-1,111,1', days: 2, observedFrom: '2026-09-16T00:00:00Z', observedTo: '2026-09-17T11:40:00Z' } };
assert.equal((await evaluate()).level, 'UNKNOWN');
layers[0].coverage = JSON.stringify({ bbox: [109, -1, 111, 1], validFrom: '2026-09-01T00:00:00Z', validTo: '2026-10-01T00:00:00Z', complete: true });
assert.equal((await evaluate()).level, 'MEDIUM');
assert.equal((await reports.triageReports([row], client, policy, now, false)).get(row.id).level, 'UNKNOWN');
const originalHotspots = hotspots;
hotspots = Array.from({ length: 10001 }, () => ({ source: 'DEMO', acquiredAt: now }));
assert.ok((await evaluate()).missingData.includes('TRUNCATED_CONTEXT'));
assert.equal((await evaluate()).level, 'UNKNOWN');
hotspots = originalHotspots;
for (const change of [{ status: 'FAILED' }, { completedAt: new Date('2026-09-17T09:00:00Z') }, { scope: { area: '109,-1,111,1', products: ['VIIRS_NOAA20_NRT'], days: 2 } }, { scope: { ...latest.scope, area: '110,-1,111,1' } }, { scope: { ...latest.scope, observedTo: '2026-09-17T10:30:00Z' } }]) {
  const original = latest; latest = { ...original, ...change };
  assert.equal((await evaluate()).level, 'UNKNOWN'); latest = original;
}
for (const change of [{ provider: 'DEMO' }, { verifiedAt: null }, { coverage: 'Verified for Kalimantan' }, { coverage: JSON.stringify({ bbox: [110, -1, 111, 1], validFrom: '2026-09-01T00:00:00Z', validTo: '2026-10-01T00:00:00Z', complete: true }) }]) {
  const original = layers[0]; layers[0] = { ...original, ...change };
  assert.equal((await evaluate()).level, 'UNKNOWN'); layers[0] = original;
}
assert.equal((await evaluate({ ...row, observedAt: new Date('2025-01-01T00:00:00Z') })).level, 'UNKNOWN');
settlements = [{ id: 'invalid', layerId: 'settlements', geometry: { type: 'Polygon', coordinates: [] }, name: null }];
assert.ok((await evaluate()).missingData.includes('SETTLEMENT_GEOMETRY'));
settlements = [];
rows = Array.from({ length: 100 }, (_, i) => ({ ...row, id: `report-${i}` }));
reads = 0;
const batch = await reports.triageReports(rows, client, policy, now, true);
assert.equal(reads, 4);
assert.equal(batch.size, 100);
assert.ok([...batch.values()].every(value => value.level === 'MEDIUM' && value.evaluatedAt === now.toISOString()));
assert.deepEqual(await reports.triageReports(rows, client, policy, now, true), batch);
console.log('Triage policy, observer/demo exclusion, spatial-time matches, missing-source combinations, historical/coverage guards, own-report isolation and constant four-query batching passed.');
