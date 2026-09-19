import type { Transaction } from '../../types/index.js';

type ForecastFacts = {
  id: string;
  windFromDegrees: number | null;
  windSpeed: number | null;
  humidity: number | null;
  weatherDescription: string | null;
  weatherDescriptionEn: string | null;
};

type ForecastPolicy = {
  windSpeedThresholdKmh: number | null;
  humidityThresholdPercent: number | null;
};

export type ForecastMaterialChange = 'WIND_DIRECTION' | 'WIND_SPEED_THRESHOLD' | 'HUMIDITY_THRESHOLD' | 'RAIN_CONTEXT';

function crossed(previous: number | null, current: number | null, threshold: number | null) {
  return threshold !== null && previous !== null && current !== null && (previous < threshold) !== (current < threshold);
}

function rainContext(forecast: ForecastFacts) {
  const description = [forecast.weatherDescription, forecast.weatherDescriptionEn].filter((value): value is string => !!value?.trim()).join(' ');
  if (!description) return null;
  return /\b(?:hujan|rain|drizzle|shower|storm|petir|thunder)\w*\b/i.test(description.normalize('NFKC'));
}

export function forecastMaterialChanges(previous: ForecastFacts | null, current: ForecastFacts, policy: ForecastPolicy): ForecastMaterialChange[] {
  if (!previous) return [];
  const changes: ForecastMaterialChange[] = [];
  if (previous.windFromDegrees !== null && current.windFromDegrees !== null) {
    const difference = Math.abs(previous.windFromDegrees - current.windFromDegrees);
    if (Math.min(difference, 360 - difference) >= 45) changes.push('WIND_DIRECTION');
  }
  if (crossed(previous.windSpeed, current.windSpeed, policy.windSpeedThresholdKmh)) changes.push('WIND_SPEED_THRESHOLD');
  if (crossed(previous.humidity, current.humidity, policy.humidityThresholdPercent)) changes.push('HUMIDITY_THRESHOLD');
  const previousRain = rainContext(previous), currentRain = rainContext(current);
  if (previousRain !== null && currentRain !== null && previousRain !== currentRain) changes.push('RAIN_CONTEXT');
  return changes;
}

export async function notifyForecastOwners(tx: Transaction, regionId: string, forecast: ForecastFacts, changes: ForecastMaterialChange[]) {
  if (!changes.length) return { count: 0 };
  const reports = await tx.trReport.findMany({
    where: { case: { is: { regionId, handlingStatus: { not: 'CLOSED' } } } },
    select: { id: true, reporterId: true },
    orderBy: { id: 'asc' },
  });
  if (!reports.length) return { count: 0 };
  const labels: Record<ForecastMaterialChange, string> = {
    WIND_DIRECTION: 'wind direction',
    WIND_SPEED_THRESHOLD: 'wind speed context',
    HUMIDITY_THRESHOLD: 'humidity context',
    RAIN_CONTEXT: 'rain context',
  };
  return tx.trNotification.createMany({
    data: reports.map(report => ({
      userId: report.reporterId,
      reportId: report.id,
      eventKey: `forecast:${forecast.id}:report:${report.id}`,
      type: 'REPORT_FORECAST',
      title: 'Forecast updated for report area',
      message: `Regional ${changes.map(change => labels[change]).join(', ')} changed. BMKG forecast, not an on-site measurement. Potential impact remains unavailable without a verified geospatial calculation.`,
    })),
    skipDuplicates: true,
  });
}
