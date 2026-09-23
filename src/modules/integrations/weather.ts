import { z } from 'zod';
import { env } from '../../config/env.js';
import { boundedText } from '../../utils/index.js';
import { latitudeSchema, longitudeSchema } from '../../types/index.js';

export const weatherAttribution = 'Source: Includes weather data from Google';

const pointSchema = z.object({ latitude: latitudeSchema, longitude: longitudeSchema });
const readingSchema = z.object({
  currentTime: z.iso.datetime({ offset: true }),
  temperature: z.object({ degrees: z.number().finite(), unit: z.literal('CELSIUS') }).optional(),
  relativeHumidity: z.number().int().min(0).max(100).optional(),
  wind: z.object({ speed: z.object({ value: z.number().finite().nonnegative(), unit: z.literal('KILOMETERS_PER_HOUR') }).optional(), direction: z.object({ degrees: z.number().finite().min(0).max(360) }).optional() }).optional(),
});
const forecastSchema = z.object({ id: z.string(), provider: z.literal('GOOGLE_WEATHER'), issuedAt: z.null(), attribution: z.literal(weatherAttribution), validAt: z.date(), fetchedAt: z.date(), temperature: z.number().finite().nullable(), humidity: z.number().int().min(0).max(100).nullable(), windSpeed: z.number().finite().nonnegative().nullable(), windSpeedUnit: z.literal('km/h'), windFromDegrees: z.number().min(0).lt(360).nullable() });
export const weatherResolutionSchema = z.object({
  status: z.enum(['CURRENT', 'UNAVAILABLE']), basis: z.enum(['CASE_COORDINATES', 'UNAVAILABLE']), stale: z.boolean(), unavailableReason: z.string().nullable(),
  provenance: z.object({ provider: z.literal('GOOGLE_WEATHER'), relationBasis: z.literal('CASE_COORDINATES'), containmentClaimed: z.literal(false), attribution: z.literal(weatherAttribution) }).nullable(),
  timestamps: z.object({ issuedAt: z.null(), validAt: z.iso.datetime({ offset: true }), fetchedAt: z.iso.datetime({ offset: true }), usableUntil: z.iso.datetime({ offset: true }) }).nullable(),
  forecast: forecastSchema.nullable(),
});
export type WeatherResolution = z.infer<typeof weatherResolutionSchema>;
const cache = new Map<string, { expires: number; value: WeatherResolution }>();
const pending = new Map<string, Promise<WeatherResolution>>();
const unavailable = (reason: string): WeatherResolution => ({ status: 'UNAVAILABLE', basis: 'UNAVAILABLE', stale: false, unavailableReason: reason, provenance: null, timestamps: null, forecast: null });

export function parseCurrentConditions(value: unknown, point: { latitude: number; longitude: number }, fetchedAt: Date): WeatherResolution {
  const reading = readingSchema.parse(value);
  const validAt = new Date(reading.currentTime);
  if (validAt.getTime() > fetchedAt.getTime() + 300000 || validAt.getTime() <= fetchedAt.getTime() - 3600000) return unavailable('WEATHER_READING_OUTDATED');
  const usableUntil = new Date(Math.min(validAt.getTime() + 3600000, fetchedAt.getTime() + 120000));
  const from = reading.wind?.direction?.degrees;
  const forecast = forecastSchema.parse({ id: `google-weather:${point.latitude}:${point.longitude}:${validAt.toISOString()}`, provider: 'GOOGLE_WEATHER', issuedAt: null, attribution: weatherAttribution, validAt, fetchedAt, temperature: reading.temperature?.degrees ?? null, humidity: reading.relativeHumidity ?? null, windSpeed: reading.wind?.speed?.value ?? null, windSpeedUnit: 'km/h', windFromDegrees: from == null ? null : from % 360 });
  return { status: 'CURRENT', basis: 'CASE_COORDINATES', stale: false, unavailableReason: null, provenance: { provider: 'GOOGLE_WEATHER', relationBasis: 'CASE_COORDINATES', containmentClaimed: false, attribution: weatherAttribution }, timestamps: { issuedAt: null, validAt: validAt.toISOString(), fetchedAt: fetchedAt.toISOString(), usableUntil: usableUntil.toISOString() }, forecast };
}

export async function resolveCurrentWeather(location: unknown, now = new Date(), fetcher: typeof fetch = fetch, key = env.GOOGLE_MAPS_SERVER_KEY): Promise<WeatherResolution> {
  const parsed = pointSchema.safeParse(location);
  if (!parsed.success) return unavailable('NO_CASE_COORDINATES');
  if (!key) return unavailable('WEATHER_NOT_CONFIGURED');
  const point = parsed.data;
  const cacheKey = `${point.latitude},${point.longitude}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > now.getTime() && cached.value.timestamps && Date.parse(cached.value.timestamps.usableUntil) > now.getTime()) return cached.value;
  cache.delete(cacheKey);
  const inflight = pending.get(cacheKey);
  if (inflight) return inflight;
  const request = (async () => {
    try {
      const url = new URL('https://weather.googleapis.com/v1/currentConditions:lookup');
      url.searchParams.set('location.latitude', String(point.latitude));
      url.searchParams.set('location.longitude', String(point.longitude));
      url.searchParams.set('unitsSystem', 'METRIC');
      const response = await fetcher(url, { headers: { 'X-Goog-Api-Key': key }, signal: AbortSignal.timeout(env.PROVIDER_TIMEOUT_MS ?? 8000), redirect: 'error' });
      const value = parseCurrentConditions(JSON.parse(await boundedText(response, 65536)), point, now);
      if (value.status === 'CURRENT') {
        if (cache.size >= 100) cache.delete(cache.keys().next().value!);
        cache.set(cacheKey, { value, expires: Math.min(now.getTime() + 120000, Date.parse(value.timestamps!.usableUntil)) });
      }
      return value;
    } catch {
      return unavailable('WEATHER_PROVIDER_UNAVAILABLE');
    }
  })();
  pending.set(cacheKey, request);
  try { return await request; }
  finally { pending.delete(cacheKey); }
}
