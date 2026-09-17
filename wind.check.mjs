import assert from 'node:assert/strict';
import { buildWindContext, loadWindContext } from './src/modules/integrations/wind.ts';
import { buildAnalysisContext } from './src/modules/integrations/snapshot.ts';
import { readFile } from 'node:fs/promises';
import { parseBmkg, windDirection } from './src/modules/integrations/parsing.ts';

const now = new Date('2026-09-17T10:00:00Z');
const region = { id: 'region', name: 'Verified village', level: 4, bmkgAdm4: '61.01.01.1001', verifiedAt: new Date('2026-01-01T00:00:00Z') };
const forecast = { id: 'forecast', regionId: 'region', provider: 'BMKG', issuedAt: new Date('2026-09-17T06:00:00Z'), validAt: new Date('2026-09-17T09:00:00Z'), fetchedAt: new Date('2026-09-17T08:00:00Z'), windSpeed: 12, windSpeedUnit: 'km/h', windFromDegrees: 0, windDirectionRaw: 'N' };
const build = (patch = {}, r = region, at = now) => buildWindContext(r, { ...forecast, ...patch }, at);
const ready = build();
assert.equal(ready.status, 'READY');
assert.equal(ready.windFromDegrees, 0);
assert.equal(ready.windToDegrees, 180);
assert.equal(ready.windSpeedKmh, 12);
assert.equal(ready.usableUntil, '2026-09-17T12:00:00.000Z');
assert.equal(ready.spatialExtent, null);
assert.equal(ready.settlementExposure, 'UNAVAILABLE');
assert.match(ready.summary, /from N.*toward S/);
for (const [raw, degrees] of Object.entries({ N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5, S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 })) {
  assert.deepEqual(windDirection(` ${raw.toLowerCase()} `, 12), { windFromDegrees: degrees, windToDegrees: (degrees + 180) % 360 });
  assert.equal(build({ windDirectionRaw: raw, windFromDegrees: degrees }).windToDegrees, (degrees + 180) % 360);
}
for (const speed of [null, undefined, 0, -1, NaN, Infinity]) assert.equal(windDirection('N', speed).windFromDegrees, null);
assert.equal(build({ windSpeed: 0 }).status, 'CALM');
assert.equal(build({ windSpeed: 0 }).windToDegrees, null);
assert.equal(build({ windSpeed: null }).status, 'MISSING_WIND');
assert.equal(build({ windDirectionRaw: 'VARIABLE', windFromDegrees: null }).status, 'MISSING_WIND');
assert.equal(build({ windFromDegrees: 90 }).status, 'INVALID');
assert.equal(build({ windSpeedUnit: 'm/s' }).status, 'INVALID');
assert.equal(build({ provider: 'DEMO' }).status, 'INVALID');
assert.equal(build({ regionId: 'elsewhere' }).status, 'INVALID');
assert.equal(build({}, null).status, 'NO_VERIFIED_REGION');
assert.equal(build({}, { ...region, verifiedAt: null }).status, 'NO_VERIFIED_REGION');
assert.equal(build({}, { ...region, level: 2 }).status, 'NO_VERIFIED_REGION');
assert.equal(buildWindContext(region, null, now).status, 'NO_FORECAST');
assert.equal(build({}, region, new Date('2026-09-17T12:00:00Z')).status, 'STALE');
assert.equal(build({ issuedAt: new Date('2026-09-16T10:00:00Z') }).status, 'STALE');
assert.equal(build({ validAt: new Date('2026-09-17T12:00:00Z') }).status, 'NOT_YET_VALID');
for (const patch of [
  { issuedAt: new Date('2026-09-17T11:00:00Z') },
  { fetchedAt: new Date('2026-09-17T11:00:00Z') },
  { fetchedAt: new Date('2026-09-17T05:00:00Z') },
  { issuedAt: new Date('2026-09-17T09:30:00Z'), fetchedAt: now },
  { validAt: new Date(NaN) }, { windSpeed: NaN }, { windSpeed: -1 },
]) assert.equal(build(patch).status, 'INVALID');
const row = { analysis_date: '2026-09-17T13:00:00+07:00', utc_datetime: '2026-09-17 09:00:00', ws: 12, wd: 'N' };
const parsed = parseBmkg({ data: [{ lokasi: { adm4: region.bmkgAdm4 }, cuaca: [[row]] }] }, region.bmkgAdm4)[0];
assert.equal(parsed.issuedAt.toISOString(), '2026-09-17T06:00:00.000Z');
assert.equal(parsed.validAt.toISOString(), '2026-09-17T09:00:00.000Z');
assert.equal(JSON.parse(JSON.stringify(ready)).windToDegrees, 180);
let queries = [];
const client = { trWeatherForecast: { findFirst: async query => { queries.push(query); return forecast; } } };
assert.equal((await loadWindContext(client, null, now)).windContext.status, 'NO_VERIFIED_REGION');
assert.equal(queries.length, 0);
assert.equal((await loadWindContext(client, region, now)).windContext.status, 'READY');
assert.deepEqual(queries[0].where, { provider: 'BMKG', regionId: region.id, validAt: { lte: now }, issuedAt: { lte: now }, fetchedAt: { lte: now } });
assert.deepEqual(queries[0].orderBy, [{ validAt: 'desc' }, { issuedAt: 'desc' }]);
queries = [];
const missing = { trWeatherForecast: { findFirst: async query => { queries.push(query); return null; } } };
assert.equal((await loadWindContext(missing, region, now)).windContext.status, 'NO_FORECAST');
assert.equal(queries.length, 2);
const c = { id: 'case', contextRevision: 1, verificationStatus: 'CONFIRMED_FIRE', reports: [], hotspots: [], fieldUpdates: [] };
const snapshot = buildAnalysisContext(c, { ...forecast, temperature: null, humidity: null }, [], [], ready);
assert.equal(snapshot.windContext.windToDegrees, snapshot.weather.windToDegrees);
assert.equal(snapshot.weather.windSpeedUnit, 'km/h');
assert.equal(buildAnalysisContext(c, null, [], [], build({}, null)).weather, null);
const routes = await readFile(new URL('./src/modules/api/api.routes.ts', import.meta.url), 'utf8');
assert.ok(routes.indexOf('router.use(sessionGuard)') < routes.indexOf("router.get('/admin/cases/:id'"));
assert.ok(routes.indexOf("router.use('/admin', adminGuard)") < routes.indexOf("router.get('/admin/cases/:id'"));
assert.match(routes, /router.get\('\/admin\/cases\/:id'.*private, no-store/);
console.log('Wind checks passed: cardinal, calm, missing, provenance, time, selection, snapshot, JSON serialization and protected route wiring.');
