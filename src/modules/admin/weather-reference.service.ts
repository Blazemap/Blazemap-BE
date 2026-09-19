import { z } from 'zod';
import { db } from '../../config/index.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { Actor } from '../../types/index.js';
import { AppError, boundedText, fingerprint, jsonValue } from '../../utils/index.js';
import { parseBmkg } from '../integrations/parsing.js';
import { audit, lockedActor } from './access.js';
import { assertVersion } from './rules.js';

export const adm4Schema = z.string().regex(/^\d{2}\.\d{2}\.\d{2}\.\d{4}$/);
const name = z.string().trim().min(1).max(200);
const locationSchema = z.object({ adm4: adm4Schema, desa: name, kecamatan: name, kotkab: name, provinsi: name, lat: z.number().finite().min(-90).max(90), lon: z.number().finite().min(-180).max(180) });
export function parseWeatherReference(value: unknown, adm4: string) {
  const response = z.object({ lokasi: locationSchema, data: z.array(z.object({ lokasi: locationSchema })).min(1).max(10) }).parse(value);
  if (response.lokasi.adm4 !== adm4 || response.data.some(row => row.lokasi.adm4 !== adm4)) throw new AppError('BMKG location mismatch', 502, 'BMKG_LOCATION_MISMATCH');
  const location = response.lokasi;
  if (response.data.some(row => fingerprint(row.lokasi) !== fingerprint(location))) throw new AppError('BMKG location mismatch', 502, 'BMKG_LOCATION_MISMATCH');
  const forecasts = parseBmkg(value, adm4).map(({ raw: _raw, ...forecast }) => forecast);
  if (!forecasts.length || forecasts.length > 100) throw new AppError('BMKG forecast unavailable', 502, 'BMKG_FORECAST_UNAVAILABLE');
  return { relationBasis: 'WEATHER_REFERENCE' as const, provider: 'BMKG' as const, adm4, location, locationFingerprint: fingerprint(location), sourceUrl: `https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=${adm4}`, fetchedAt: new Date().toISOString(), forecasts, disclaimer: 'Provider representative point, NOT a legal boundary. This reference does not establish that the case is inside this village.' };
}
export async function fetchWeatherReference(adm4: string) {
  adm4Schema.parse(adm4);
  try {
    const response = await fetch(`https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=${encodeURIComponent(adm4)}`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
    return parseWeatherReference(JSON.parse(await boundedText(response, 1000000)), adm4);
  } catch (error) {
    if (error instanceof AppError && error.code === 'BMKG_LOCATION_MISMATCH') throw error;
    throw new AppError('BMKG reference unavailable', 502, 'BMKG_REFERENCE_UNAVAILABLE');
  }
}
export async function previewWeatherReference(actor: Actor, body: unknown, client: PrismaClient = db()) {
  const { adm4 } = z.strictObject({ adm4: adm4Schema }).parse(body);
  await client.$transaction(tx => lockedActor(tx, actor, true));
  return fetchWeatherReference(adm4);
}
export async function saveWeatherReference(actor: Actor, id: string, body: unknown, client: PrismaClient = db(), fetcher = fetchWeatherReference) {
  const input = z.strictObject({ version: z.number().int().positive(), adm4: adm4Schema, locationFingerprint: z.string().min(1).max(128), reviewed: z.literal(true), reason: z.string().trim().min(5).max(2000) }).parse(body);
  await client.$transaction(tx => lockedActor(tx, actor, true));
  const reference = await fetcher(input.adm4);
  if (reference.adm4 !== input.adm4 || reference.locationFingerprint !== input.locationFingerprint) throw new AppError('Preview changed; review again', 409, 'BMKG_REVIEW_REQUIRED');
  return client.$transaction(async tx => {
    await lockedActor(tx, actor, true);
    await tx.$queryRaw`SELECT id FROM "TrCase" WHERE id = ${id} FOR UPDATE`;
    const current = await tx.trCase.findUniqueOrThrow({ where: { id } });
    assertVersion(current.version, input.version);
    await tx.trCase.update({ where: { id, version: input.version }, data: { bmkgAdm4Reference: input.adm4, weatherReference: jsonValue(reference), version: { increment: 1 }, contextRevision: { increment: 1 }, latestAnalysisId: null } });
    await audit(tx, actor.id, 'CASE_WEATHER_REFERENCE_CHANGED', 'CASE', id, input.reason, { relationBasis: 'WEATHER_REFERENCE', before: current.bmkgAdm4Reference, after: input.adm4, locationFingerprint: reference.locationFingerprint });
    return reference;
  });
}
