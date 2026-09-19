import assert from 'node:assert/strict';
import { forecastMaterialChanges, notifyForecastOwners } from './src/modules/integrations/forecast-notifications.ts';

const previous = {
  id: 'forecast-old',
  windFromDegrees: 0,
  windSpeed: 10,
  humidity: 70,
  weatherDescription: 'Berawan',
  weatherDescriptionEn: 'Cloudy',
};
const current = {
  id: 'forecast-current',
  windFromDegrees: 45,
  windSpeed: 20,
  humidity: 55,
  weatherDescription: 'Hujan Ringan',
  weatherDescriptionEn: 'Light Rain',
};
const policy = { windSpeedThresholdKmh: 20, humidityThresholdPercent: 60 };
assert.deepEqual(forecastMaterialChanges(previous, current, policy), ['WIND_DIRECTION', 'WIND_SPEED_THRESHOLD', 'HUMIDITY_THRESHOLD', 'RAIN_CONTEXT']);
assert.deepEqual(forecastMaterialChanges(previous, { ...current, windFromDegrees: 315 }, policy), ['WIND_DIRECTION', 'WIND_SPEED_THRESHOLD', 'HUMIDITY_THRESHOLD', 'RAIN_CONTEXT']);
assert.deepEqual(forecastMaterialChanges(previous, { ...previous, id: 'same-context', windFromDegrees: 44 }, policy), []);
assert.deepEqual(forecastMaterialChanges(previous, { ...previous, id: 'missing-values', windFromDegrees: null, windSpeed: null, humidity: null, weatherDescription: null, weatherDescriptionEn: null }, policy), []);
assert.deepEqual(forecastMaterialChanges(previous, current, { windSpeedThresholdKmh: null, humidityThresholdPercent: null }), ['WIND_DIRECTION', 'RAIN_CONTEXT']);

const created = [];
let reportQuery;
const tx = {
  trReport: {
    findMany: async query => {
      reportQuery = query;
      return [
        { id: 'report-a', reporterId: 'owner-a' },
        { id: 'report-b', reporterId: 'owner-b' },
      ];
    },
  },
  trNotification: {
    createMany: async ({ data, skipDuplicates }) => {
      assert.equal(skipDuplicates, true);
      for (const item of data) if (!created.some(existing => existing.eventKey === item.eventKey)) created.push(item);
      return { count: data.length };
    },
  },
};
await notifyForecastOwners(tx, 'region-a', current, ['WIND_DIRECTION', 'RAIN_CONTEXT']);
await notifyForecastOwners(tx, 'region-a', current, ['WIND_DIRECTION', 'RAIN_CONTEXT']);
assert.deepEqual(reportQuery.where, { case: { is: { regionId: 'region-a', handlingStatus: { not: 'CLOSED' } } } });
assert.deepEqual(created.map(item => item.userId), ['owner-a', 'owner-b']);
assert.deepEqual(created.map(item => item.reportId), ['report-a', 'report-b']);
assert.deepEqual(created.map(item => item.eventKey), ['forecast:forecast-current:report:report-a', 'forecast:forecast-current:report:report-b']);
assert.ok(created.every(item => item.title === 'Forecast updated for report area'));
assert.ok(created.every(item => item.type === 'REPORT_FORECAST'));
assert.ok(created.every(item => /BMKG forecast, not an on-site measurement/.test(item.message)));
assert.ok(created.every(item => !/evacuat|arrival|spread perimeter|confirmed fire/i.test(item.message)));
assert.equal(JSON.stringify(created).includes('region-a'), false);

console.log('BMKG material-change, idempotency and report-owner privacy checks passed.');
