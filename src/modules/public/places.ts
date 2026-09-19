import { z } from 'zod';
import { AppError } from '../../utils/index.js';

const point = z.tuple([z.number().finite().min(94).max(142), z.number().finite().min(-12).max(7)]);
const feature = z.object({ geometry: z.object({ type: z.literal('Point'), coordinates: point }), properties: z.object({ name: z.string().trim().min(1).max(200), countrycode: z.string(), state: z.string().max(200).optional(), city: z.string().max(200).optional(), extent: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]).optional() }) });
export function parsePlaces(value: unknown) {
  const response = z.object({ features: z.array(z.unknown()).max(100) }).parse(value);
  return response.features.flatMap(raw => {
    const parsed = feature.safeParse(raw);
    if (!parsed.success || parsed.data.properties.countrycode.toUpperCase() !== 'ID') return [];
    const { geometry: { coordinates: [longitude, latitude] }, properties: p } = parsed.data;
    const e = p.extent;
    const bbox = e && point.safeParse([e[0], e[3]]).success && point.safeParse([e[2], e[1]]).success && e[0] < e[2] && e[3] < e[1] && longitude >= e[0] && longitude <= e[2] && latitude >= e[3] && latitude <= e[1] ? [e[0], e[3], e[2], e[1]] as [number, number, number, number] : null;
    return [{ name: p.name, label: [...new Set([p.name, p.city, p.state, 'Indonesia'].filter(Boolean))].join(', '), latitude, longitude, bbox }];
  }).slice(0, 5);
}
export function createPlaceSearch(request: typeof fetch = fetch, now = Date.now) {
  const cache = new Map<string, { expires: number; data: ReturnType<typeof parsePlaces> }>();
  let nextRequest = 0;
  let busy = false;
  return async (input: unknown) => {
    const query = z.object({ q: z.string().trim().min(3).max(120).regex(/^[\p{L}\p{N}\p{M} .,'’()-]+$/u) }).parse(input).q;
    const key = query.toLocaleLowerCase('en');
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return cached.data;
    if (busy || now() < nextRequest) throw new AppError('Place search is busy. Please try again shortly.', 429, 'RATE_LIMIT');
    busy = true;
    nextRequest = now() + 1000;
    try {
      const url = new URL(process.env.PHOTON_URL || 'https://photon.komoot.io/api/');
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid geocoder configuration');
      url.search = new URLSearchParams({ q: query, limit: '5', countrycode: 'ID', bbox: '94,-12,142,7', lang: 'en' }).toString();
      const response = await request(url, { signal: AbortSignal.timeout(8000), redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': 'Blazemap-PlaceSearch/1.0' } });
      if (!response.ok) throw new Error('Provider unavailable');
      const text = await response.text();
      if (text.length > 100000) throw new Error('Invalid provider response');
      const data = parsePlaces(JSON.parse(text));
      if (cache.size >= 200) cache.delete(cache.keys().next().value!);
      cache.set(key, { expires: now() + 300000, data });
      return data;
    } catch {
      throw new AppError('Place search is unavailable. Please try again.', 503, 'GEOCODER_UNAVAILABLE');
    } finally { busy = false; }
  };
}
export const searchPlaces = createPlaceSearch();
