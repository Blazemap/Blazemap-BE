import { z } from 'zod';
import { resolveCurrentWeather, weatherResolutionSchema, type WeatherResolution } from './weather.js';

export const windContextSchema = z.object({
  status: z.enum(['READY', 'CALM', 'MISSING_WIND', 'STALE', 'INVALID', 'UNAVAILABLE']),
  evaluatedAt: z.iso.datetime({ offset: true }), usableUntil: z.iso.datetime({ offset: true }).nullable(),
  basis: weatherResolutionSchema.shape.basis, provenance: weatherResolutionSchema.shape.provenance,
  timestamps: weatherResolutionSchema.shape.timestamps, stale: z.boolean(), unavailableReason: z.string().nullable(),
  forecast: z.object({ id: z.string(), provider: z.literal('GOOGLE_WEATHER'), regionId: z.null(), regionName: z.string(), selectionBasis: z.literal('CASE_COORDINATES'), issuedAt: z.null(), validAt: z.iso.datetime({ offset: true }), fetchedAt: z.iso.datetime({ offset: true }), attribution: z.string() }).nullable(),
  windSpeedKmh: z.number().finite().nonnegative().nullable(), windFromDegrees: z.number().min(0).lt(360).nullable(), windToDegrees: z.number().min(0).lt(360).nullable(), summary: z.string().min(1).max(1000), disclaimer: z.literal('Downwind attention, not predicted perimeter'), spatialExtent: z.null(), settlementExposure: z.literal('UNAVAILABLE'), ruleVersion: z.string().min(1).max(100),
});
const labels = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function buildWindContext(resolutionValue: unknown, now = new Date()) {
  const parsed = weatherResolutionSchema.safeParse(resolutionValue);
  const empty = {
    evaluatedAt: now.toISOString(), usableUntil: null as string | null, basis: 'UNAVAILABLE' as WeatherResolution['basis'],
    provenance: null as WeatherResolution['provenance'], timestamps: null as WeatherResolution['timestamps'], stale: false,
    unavailableReason: null as string | null, forecast: null as z.infer<typeof windContextSchema>['forecast'],
    windSpeedKmh: null as number | null, windFromDegrees: null as number | null, windToDegrees: null as number | null,
    disclaimer: 'Downwind attention, not predicted perimeter' as const, spatialExtent: null, settlementExposure: 'UNAVAILABLE' as const, ruleVersion: 'wind-context-3',
  };
  if (!parsed.success) return { ...empty, status: 'INVALID' as const, unavailableReason: 'INVALID_WEATHER_RESOLUTION', summary: 'Weather resolution is invalid; no current wind is available.' };
  const resolution = parsed.data;
  const base = { ...empty, basis: resolution.basis, provenance: resolution.provenance, timestamps: resolution.timestamps, stale: resolution.stale, unavailableReason: resolution.unavailableReason, usableUntil: resolution.timestamps?.usableUntil ?? null };
  if (resolution.status === 'UNAVAILABLE') return { ...base, status: 'UNAVAILABLE' as const, summary: 'Current weather at the case coordinates is unavailable.' };
  const forecast = resolution.forecast;
  if (!forecast || !resolution.provenance || !resolution.timestamps) return { ...base, status: 'INVALID' as const, summary: 'Weather resolution is incomplete; no current wind is available.' };
  base.forecast = { id: forecast.id, provider: forecast.provider, regionId: null, regionName: '', selectionBasis: 'CASE_COORDINATES', issuedAt: null, validAt: resolution.timestamps.validAt, fetchedAt: resolution.timestamps.fetchedAt, attribution: forecast.attribution };
  base.windSpeedKmh = forecast.windSpeed;
  if (now >= new Date(resolution.timestamps.usableUntil)) return { ...base, status: 'STALE' as const, stale: true, summary: 'Current conditions are outside their usable window; no current arrow.' };
  if (forecast.windSpeed === 0) return { ...base, status: 'CALM' as const, summary: 'Google Weather reports calm wind (0 km/h); no downwind direction.' };
  if (forecast.windSpeed === null || forecast.windFromDegrees === null) return { ...base, status: 'MISSING_WIND' as const, summary: 'Current wind speed or direction is unavailable; no downwind direction.' };
  base.windFromDegrees = forecast.windFromDegrees;
  base.windToDegrees = (forecast.windFromDegrees + 180) % 360;
  return { ...base, status: 'READY' as const, summary: `Google Weather wind from ${labels[Math.round(forecast.windFromDegrees / 22.5) % 16]} (${forecast.windFromDegrees}°), toward ${labels[Math.round(base.windToDegrees / 22.5) % 16]} (${base.windToDegrees}°), ${forecast.windSpeed} km/h. Conditions at case coordinates, not an on-site measurement.` };
}

export async function loadWindContext(_client: unknown, caseValue: unknown, now = new Date()) {
  const weather = await resolveCurrentWeather(caseValue, now);
  const windContext = buildWindContext(weather, now);
  const forecast = weather.status === 'CURRENT' && ['READY', 'CALM', 'MISSING_WIND'].includes(windContext.status) ? weather.forecast : null;
  return { forecast, windContext, weather };
}
