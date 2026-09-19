import { z } from 'zod';
import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { windDirection } from './parsing.js';

const regionSchema = z.object({ id: z.string(), name: z.string(), level: z.literal(4), bmkgAdm4: z.string().regex(/^\d{2}\.\d{2}\.\d{2}\.\d{4}$/), verifiedAt: z.date() });
const forecastSchema = z.object({ id: z.string(), regionId: z.string(), provider: z.literal('BMKG'), issuedAt: z.date(), validAt: z.date(), fetchedAt: z.date(), windSpeed: z.number().finite().nonnegative().nullable(), windSpeedUnit: z.literal('km/h'), windFromDegrees: z.number().min(0).lt(360).nullable(), windDirectionRaw: z.string().nullable() });
export const windContextSchema = z.object({
  status: z.enum(['READY', 'CALM', 'MISSING_WIND', 'STALE', 'NOT_YET_VALID', 'INVALID', 'NO_FORECAST', 'NO_VERIFIED_REGION']), evaluatedAt: z.iso.datetime({ offset: true }), usableUntil: z.iso.datetime({ offset: true }).nullable(),
  forecast: z.object({ id: z.string(), provider: z.literal('BMKG'), regionId: z.string(), regionName: z.string(), issuedAt: z.iso.datetime({ offset: true }), validAt: z.iso.datetime({ offset: true }), fetchedAt: z.iso.datetime({ offset: true }) }).nullable(),
  windSpeedKmh: z.number().finite().nonnegative().nullable(), windFromDegrees: z.number().min(0).lt(360).nullable(), windToDegrees: z.number().min(0).lt(360).nullable(), summary: z.string().min(1).max(1000), disclaimer: z.literal('Downwind attention, not predicted perimeter'), spatialExtent: z.null(), settlementExposure: z.literal('UNAVAILABLE'), ruleVersion: z.string().min(1).max(100),
});
const labels = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function buildWindContext(regionValue: unknown, forecastValue: unknown, now = new Date()) {
  const region = regionSchema.safeParse(regionValue);
  const base = { evaluatedAt: now.toISOString(), usableUntil: null as string | null, forecast: null as null | { id: string; provider: 'BMKG'; regionId: string; regionName: string; issuedAt: string; validAt: string; fetchedAt: string }, windSpeedKmh: null as number | null, windFromDegrees: null as number | null, windToDegrees: null as number | null, disclaimer: 'Downwind attention, not predicted perimeter', spatialExtent: null, settlementExposure: 'UNAVAILABLE' as const, ruleVersion: 'wind-context-1' };
  if (!region.success || region.data.verifiedAt > now) return { ...base, status: 'NO_VERIFIED_REGION', summary: 'No verified administrative level IV BMKG region mapping for this case.' };
  if (forecastValue == null) return { ...base, status: 'NO_FORECAST', summary: 'No BMKG forecast is stored for the verified case region.' };
  const parsed = forecastSchema.safeParse(forecastValue);
  if (!parsed.success || parsed.data.regionId !== region.data.id) return { ...base, status: 'INVALID', summary: 'Forecast provenance, units or wind values are invalid; direction unavailable.' };
  const f = parsed.data;
  base.forecast = { id: f.id, provider: 'BMKG', regionId: region.data.id, regionName: region.data.name, issuedAt: f.issuedAt.toISOString(), validAt: f.validAt.toISOString(), fetchedAt: f.fetchedAt.toISOString() };
  if (f.issuedAt > now || f.fetchedAt > now || f.issuedAt > f.fetchedAt || f.issuedAt > f.validAt) return { ...base, status: 'INVALID', summary: 'Forecast timestamps are inconsistent; direction unavailable.' };
  const usableUntil = Math.min(f.validAt.getTime() + 10800000, f.issuedAt.getTime() + 86400000, f.fetchedAt.getTime() + 86400000);
  base.usableUntil = new Date(usableUntil).toISOString();
  base.windSpeedKmh = f.windSpeed;
  const direction = windDirection(f.windDirectionRaw, f.windSpeed);
  if (f.windSpeed !== null && f.windSpeed > 0 && direction.windFromDegrees !== f.windFromDegrees) return { ...base, status: 'INVALID', summary: 'Stored wind bearing does not match the source cardinal direction.' };
  base.windFromDegrees = direction.windFromDegrees;
  base.windToDegrees = direction.windToDegrees;
  if (now.getTime() >= usableUntil) return { ...base, status: 'STALE', summary: 'Forecast is outside the 3-hour valid-time window or 24-hour issue/fetch freshness limit; no current arrow.' };
  if (f.validAt > now) return { ...base, status: 'NOT_YET_VALID', summary: 'Forecast valid time is in the future; no current arrow.' };
  if (f.windSpeed === 0) return { ...base, status: 'CALM', summary: 'BMKG forecast wind is calm (0 km/h); no downwind direction.' };
  if (f.windSpeed === null || direction.windFromDegrees === null) return { ...base, status: 'MISSING_WIND', summary: 'Forecast wind speed or cardinal direction is unavailable or variable; no downwind direction.' };
  return { ...base, status: 'READY', summary: `BMKG forecast wind from ${labels[Math.round(direction.windFromDegrees / 22.5) % 16]} (${direction.windFromDegrees}°), toward ${labels[Math.round(direction.windToDegrees! / 22.5) % 16]} (${direction.windToDegrees}°), ${f.windSpeed} km/h. Regional forecast, not an on-site measurement.` };
}
export async function loadWindContext(client: PrismaClient | Prisma.TransactionClient, region: unknown, now = new Date()) {
  const parsed = regionSchema.safeParse(region);
  if (!parsed.success || parsed.data.verifiedAt > now) return { forecast: null, windContext: buildWindContext(region, null, now) };
  const where = { provider: 'BMKG', regionId: parsed.data.id };
  const forecast = await client.trWeatherForecast.findFirst({ where: { ...where, validAt: { lte: now }, issuedAt: { lte: now }, fetchedAt: { lte: now } }, orderBy: [{ validAt: 'desc' }, { issuedAt: 'desc' }] })
    ?? await client.trWeatherForecast.findFirst({ where, orderBy: [{ issuedAt: 'desc' }, { validAt: 'asc' }] });
  return { forecast, windContext: buildWindContext(region, forecast, now) };
}
