import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { fingerprint, unavailable } from '../../utils/index.js';
import { priorities } from '../../types/index.js';

export function windDirection(raw: string | null | undefined, speed: number | null | undefined) {
  const cardinal: Record<string, number> = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5, S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };
  const from = raw && speed != null && Number.isFinite(speed) && speed > 0 ? cardinal[raw.trim().toUpperCase()] ?? null : null;
  return { windFromDegrees: from, windToDegrees: from == null ? null : (from + 180) % 360 };
}
const rowSchema = z.object({
  latitude: z.coerce.number().min(-90).max(90), longitude: z.coerce.number().min(-180).max(180),
  acq_date: z.iso.date(), acq_time: z.string().regex(/^\d{3,4}$/), satellite: z.string().min(1), instrument: z.literal('VIIRS'),
  confidence: z.string().min(1), frp: z.string().optional(), version: z.string().optional(),
}).passthrough();
export function parseFirms(text: string, product: string) {
  if (!text.trimStart().startsWith('latitude,longitude,')) throw unavailable('FIRMS response');
  const rows = parse(text, { columns: true, skip_empty_lines: true, max_record_size: 10000 }) as unknown[];
  if (rows.length > 50000) throw unavailable('FIRMS response');
  return rows.map(value => {
    const r = rowSchema.parse(value);
    const time = r.acq_time.padStart(4, '0');
    if (Number(time.slice(0, 2)) > 23 || Number(time.slice(2)) > 59) throw unavailable('FIRMS acquisition time');
    const acquiredAt = new Date(`${r.acq_date}T${time.slice(0, 2)}:${time.slice(2)}:00Z`);
    const frp = r.frp ? z.coerce.number().nonnegative().parse(r.frp) : null;
    return { product, observationKey: fingerprint({ platform: r.satellite, instrument: r.instrument, latitude: r.latitude, longitude: r.longitude, acquiredAt: acquiredAt.toISOString() }), satellite: r.satellite, instrument: r.instrument, latitude: r.latitude, longitude: r.longitude, acquiredAt, confidenceRaw: r.confidence, frp, version: r.version ?? null, raw: r };
  });
}
const forecastSchema = z.object({ utc_datetime: z.string(), analysis_date: z.string(), t: z.number().nullable().optional(), hu: z.number().min(0).max(100).nullable().optional(), ws: z.number().nonnegative().nullable().optional(), wd: z.string().nullable().optional(), weather_desc: z.string().nullable().optional(), weather_desc_en: z.string().nullable().optional() }).passthrough();
export function parseBmkg(value: unknown, adm4: string) {
  const parsed = z.object({ data: z.array(z.object({ lokasi: z.object({ adm4: z.string() }), cuaca: z.array(z.array(forecastSchema)) })).min(1) }).parse(value);
  const location = parsed.data.find(d => d.lokasi.adm4 === adm4);
  if (!location) throw unavailable('BMKG region mapping');
  return location.cuaca.flat().map(r => {
    const utc = (value: string) => { const normalized = value.trim().replace(' ', 'T'); return z.iso.datetime({ offset: true }).parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(normalized) ? normalized : `${normalized}Z`); };
    return { issuedAt: new Date(utc(r.analysis_date)), validAt: new Date(utc(r.utc_datetime)), temperature: r.t ?? null, humidity: r.hu ?? null, windSpeed: r.ws ?? null, windDirectionRaw: r.wd ?? null, windFromDegrees: windDirection(r.wd, r.ws).windFromDegrees, weatherDescription: r.weather_desc ?? null, weatherDescriptionEn: r.weather_desc_en ?? null, raw: r };
  });
}
const citation = z.strictObject({ text: z.string().min(1).max(2000), sourceIds: z.array(z.string()).min(1).max(100) });
export const analysisSchema = z.strictObject({
  caseId: z.string(), contextRevision: z.number().int().positive(),
  evidenceLevel: z.enum(['LOW', 'MODERATE', 'HIGH', 'INSUFFICIENT_DATA']), impactLevel: z.enum(['LOW', 'MODERATE', 'HIGH', 'INSUFFICIENT_DATA']), suggestedPriority: z.enum(priorities),
  reasons: z.array(citation).min(1).max(20), missingInformation: z.array(z.string().max(2000)).max(30),
  monitoringAreas: z.array(z.strictObject({ name: z.string().max(200), reason: z.string().max(2000), sourceIds: z.array(z.string()).min(1).max(100) })).max(30),
  suggestedChecks: z.array(z.string().max(2000)).max(30), limitations: z.array(z.string().max(2000)).min(1).max(30), model: z.string().min(1).max(200), generatedAt: z.iso.datetime({ offset: true }),
});
export function validateAnalysisSafety(output: z.infer<typeof analysisSchema>, context: { observations: { id: string }[]; spatialContext: { id: string; name: string | null; relationBasis?: string; distanceMeters?: number | null; downwind?: boolean | null }[] }) {
  const citations = new Set(output.reasons.flatMap(r => r.sourceIds));
  if (output.evidenceLevel !== 'INSUFFICIENT_DATA' && !context.observations.some(o => citations.has(o.id))) throw unavailable('AI evidence grounding');
  const supportedSpatial = context.spatialContext.filter(s => s.relationBasis !== 'ADMINISTRATIVE_REGION_ONLY' && typeof s.distanceMeters === 'number' && Number.isFinite(s.distanceMeters) && s.distanceMeters >= 0);
  if (output.impactLevel !== 'INSUFFICIENT_DATA' && !supportedSpatial.some(s => citations.has(s.id))) throw unavailable('AI impact grounding');
  if (output.evidenceLevel === 'INSUFFICIENT_DATA' && output.impactLevel === 'INSUFFICIENT_DATA' && output.suggestedPriority !== 'UNASSESSED') throw unavailable('AI priority grounding');
  for (const area of output.monitoringAreas) if (!supportedSpatial.some(s => s.name === area.name && area.sourceIds.includes(s.id))) throw unavailable('AI spatial grounding');
  const denied = /\b(?:evacuat\w*|dispatch\w*|deploy\w*|warn(?:ing|ings)?|perimeters?|firebreaks?|suppress(?:ion)?|publish\w*)\b|\b(?:fire|incident)\s+(?:(?:is|was|has been)\s+)?(?:confirmed|verified)\b|\bconfirmed\s+(?:fire|incident)\b|\bno\s+fire\b|\b(?:all\s+clear|no\s+risk|safe\s+route)\b|\bsmoke\b[^.!?\n]{0,160}\b(?:arriv\w*|reach\w*|eta|\d+\s*(?:minutes?|hours?))\b|\b(?:fire|wildfire|flames?)\b[^.!?\n]{0,100}\b(?:spread|travel|arriv|reach|advance)\w*\b|\b(?:spread|propagation)\s+(?:speed|rate)\b|\d+(?:\.\d+)?\s*%|<[^>]+>/i;
  const texts = [...output.reasons.map(r => r.text), ...output.monitoringAreas.flatMap(a => [a.name, a.reason]), ...output.missingInformation, ...output.suggestedChecks, ...output.limitations];
  if (texts.some(text => denied.test(text.normalize('NFKC').replace(/\p{Cf}/gu, '')))) throw unavailable('AI protected-action validation');
}
export function validateAnalysisReferences(value: { reasons: { text?: string; sourceIds: string[] }[]; monitoringAreas: { sourceIds: string[] }[] }, ids: Set<string>) {
  for (const item of [...value.reasons, ...value.monitoringAreas]) if (!item.sourceIds.length || new Set(item.sourceIds).size !== item.sourceIds.length || item.sourceIds.some(id => !ids.has(id))) throw unavailable('AI evidence validation');
}
