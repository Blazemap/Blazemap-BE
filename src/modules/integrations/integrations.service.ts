import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { db, env, pollIntervals } from '../../config/index.js';
import { AppError, boundedText, fingerprint, jsonValue, unavailable } from '../../utils/index.js';
import { idSchema, type Actor, type Transaction } from '../../types/index.js';
import { lockedActor } from '../admin/access.js';
import { parseBmkg, parseFirms } from './parsing.js';
import { forecastMaterialChanges, notifyForecastOwners } from './forecast-notifications.js';

const products = z.array(z.enum(['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT', 'VIIRS_NOAA20_SP', 'VIIRS_SNPP_SP'])).min(1).max(3);
const areaSchema = z.tuple([z.coerce.number().min(-180).max(180), z.coerce.number().min(-90).max(90), z.coerce.number().min(-180).max(180), z.coerce.number().min(-90).max(90)]).refine(([w, s, e, n]) => w < e && s < n);
const syncSchema = z.strictObject({ regionIds: z.array(idSchema).min(1).max(30).optional() });
type SyncStage = 'FETCH' | 'PARSE' | 'DB';
export function firmsAreas(value: string | undefined) {
  const values = value?.split(';').map(area => area.trim()).filter(Boolean) ?? [];
  if (!values.length || values.length > 16) return null;
  const parsed = values.map(area => areaSchema.safeParse(area.split(/[,\s]+/)));
  return parsed.every(result => result.success) ? parsed.map(result => result.data!.join(',')) : null;
}
export function integrationFailureCode(error: unknown, provider: 'FIRMS' | 'BMKG', stage?: SyncStage) {
  const errors: object[] = [];
  let current = error;
  while (current && typeof current === 'object' && errors.length < 4) {
    errors.push(current);
    current = 'cause' in current ? current.cause : undefined;
  }
  const codes = errors.map(value => 'code' in value ? String(value.code) : '').filter(Boolean);
  const names = errors.map(value => value instanceof Error ? value.name : '').filter(Boolean);
  const kinds = errors.map(value => 'kind' in value ? String(value.kind) : '').filter(Boolean);
  if (codes.some(code => ['P1002', 'P2024', 'P2028', 'ETIMEDOUT', 'ETIME'].includes(code)) || kinds.includes('SocketTimeout')) return 'DB_TIMEOUT';
  if (stage === 'DB') {
    if (codes.includes('ENOENT')) return 'DB_CA_FILE';
    if (codes.some(code => ['ENOTFOUND', 'EAI_AGAIN'].includes(code))) return 'DB_DNS';
    if (codes.some(code => ['SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(code)) || kinds.includes('TlsConnectionError')) return 'DB_TLS';
    if (codes.some(code => ['P1000', '28P01'].includes(code)) || kinds.some(kind => ['AuthenticationFailed', 'DatabaseAccessDenied'].includes(kind))) return 'DB_AUTH';
    if (codes.some(code => ['ECONNREFUSED', 'ECONNRESET', 'P1001', 'P1017'].includes(code)) || kinds.some(kind => ['DatabaseNotReachable', 'ConnectionClosed', 'TooManyConnections', 'DatabaseDoesNotExist'].includes(kind))) return 'DB_CONNECTION';
    if (codes.some(code => ['P2021', 'P2022', '42P01', '42703'].includes(code)) || kinds.some(kind => ['TableDoesNotExist', 'ColumnNotFound'].includes(kind))) return 'DB_SCHEMA';
  }
  const code = codes[0] ?? '';
  if (provider === 'FIRMS') {
    if (code === 'FIRMS_RUN_TIMEOUT') return code;
    if (stage === 'PARSE') return 'FIRMS_CSV_SCHEMA';
    if (code === 'SOURCE_HTTP_STATUS') return 'FIRMS_HTTP_STATUS';
    if (code === 'SOURCE_PAYLOAD_TOO_LARGE') return 'FIRMS_PAYLOAD_TOO_LARGE';
    if (code === 'SOURCE_BODY_MISSING' || code === 'SOURCE_READ_FAILED') return 'FIRMS_RESPONSE_READ';
    if (names.some(name => name === 'TimeoutError' || name === 'AbortError')) return 'FIRMS_TIMEOUT';
    if (stage === 'DB' || /^P\d{4}$/.test(code) || ['ECONNREFUSED', 'ENOENT'].includes(code)) return 'DB_UNAVAILABLE';
    return 'FIRMS_SOURCE_FAILED';
  }
  if (code === 'SOURCE_HTTP_STATUS') return 'BMKG_HTTP_STATUS';
  if (names.some(name => name === 'TimeoutError' || name === 'AbortError')) return 'BMKG_TIMEOUT';
  if (stage === 'DB' || /^P\d{4}$/.test(code) || ['ECONNREFUSED', 'ENOENT'].includes(code)) return 'DB_UNAVAILABLE';
  return 'BMKG_SOURCE_FAILED';
}
export function firmsConfigured() { return !!env.FIRMS_MAP_KEY && products.safeParse(env.FIRMS_PRODUCTS?.split(',').map(v => v.trim())).success && firmsAreas(env.FIRMS_AREA) !== null; }
async function sourceContextChanged(tx: Transaction, caseId: string, runId: string, provider: string) {
  const c = await tx.trCase.update({ where: { id: caseId }, data: { contextRevision: { increment: 1 }, version: { increment: 1 }, latestAnalysisId: null }, select: { contextRevision: true } });
  await tx.trAuditLog.create({ data: { systemActor: 'source-sync', action: 'SOURCE_CONTEXT_CHANGED', targetType: 'CASE', targetId: caseId, details: { contextRevision: c.contextRevision, runId, provider } } });
}
async function lockRun(tx: Transaction, runId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "TrIntegrationRun" WHERE id = ${runId} AND status = 'RUNNING' AND "startedAt" > now() - interval '8 minutes' FOR UPDATE`;
  if (!rows.length) throw unavailable('Expired source run');
}
async function claimRun(provider: string, scope: unknown, actor: Actor | undefined, client: PrismaClient) {
  return client.$transaction(async tx => {
    if (actor) await lockedActor(tx, actor, true);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`integration:${provider}`}))`;
    await tx.trIntegrationRun.updateMany({ where: { provider, status: 'RUNNING', startedAt: { lt: new Date(Date.now() - 600000) } }, data: { status: 'FAILED', failureCode: 'RUN_EXPIRED', completedAt: new Date() } });
    const recent = await tx.trIntegrationRun.findFirst({ where: { provider }, orderBy: { startedAt: 'desc' } });
    const delay = provider === 'FIRMS' ? pollIntervals().FIRMS : 60000;
    if (recent?.status === 'RUNNING' || (recent && Date.now() - recent.startedAt.getTime() < delay)) throw new AppError('Integration recently requested; retry later', 429, 'SYNC_RATE_LIMIT');
    return tx.trIntegrationRun.create({ data: { provider, scope: jsonValue(scope) } });
  }, { maxWait: 10000, timeout: 30000 });
}
export async function syncSource(source: string, body: unknown, actor?: Actor, client: PrismaClient = db()) {
  const input = syncSchema.parse(body);
  const provider = z.enum(['FIRMS', 'BMKG']).parse(source.toUpperCase());
  let scope: unknown;
  let requestedProducts: string[] = [];
  let areas: string[] = [];
  let regions: { id: string; bmkgAdm4: string | null }[] = [];
  if (provider === 'FIRMS') {
    if (!firmsConfigured()) throw new AppError('FIRMS configuration unavailable', 503, 'FIRMS_CONFIG_INVALID');
    const parsedProducts = products.safeParse(env.FIRMS_PRODUCTS!.split(',').map(v => v.trim()));
    const parsedAreas = firmsAreas(env.FIRMS_AREA);
    if (!parsedProducts.success || !parsedAreas) throw new AppError('FIRMS configuration unavailable', 503, 'FIRMS_CONFIG_INVALID');
    requestedProducts = parsedProducts.data;
    areas = parsedAreas;
    scope = { products: requestedProducts, areas, days: 2 };
  } else {
    const refreshBefore = new Date(Date.now() - pollIntervals().BMKG);
    regions = input.regionIds ? await client.msRegion.findMany({ where: { verifiedAt: { not: null }, level: 4, bmkgAdm4: { not: null }, id: { in: input.regionIds } }, select: { id: true, bmkgAdm4: true }, take: 30 }) : await client.$queryRaw<{ id: string; bmkgAdm4: string | null }[]>`
      SELECT r.id, r."bmkgAdm4" FROM "MsRegion" r
      LEFT JOIN LATERAL (SELECT max(f."fetchedAt") AS fetched FROM "TrWeatherForecast" f WHERE f."regionId" = r.id AND f.provider = 'BMKG') latest ON true
      WHERE r."verifiedAt" IS NOT NULL AND r.level = 4 AND r."bmkgAdm4" ~ '^[0-9]{2}[.][0-9]{2}[.][0-9]{2}[.][0-9]{4}$'
        AND EXISTS (SELECT 1 FROM "TrCase" c WHERE c."regionId" = r.id AND c."handlingStatus" != 'CLOSED')
        AND (latest.fetched IS NULL OR latest.fetched <= ${refreshBefore})
      ORDER BY latest.fetched ASC NULLS FIRST, r.id LIMIT 30`;
    if (input.regionIds && regions.length !== input.regionIds.length) throw unavailable('Verified BMKG region mappings');
    if (!regions.length) return { id: null, provider, status: 'NO_DUE_REGIONS', received: 0, imported: 0, deduplicated: 0 };
    if (regions.some(region => !region.bmkgAdm4 || !/^\d{2}\.\d{2}\.\d{2}\.\d{4}$/.test(region.bmkgAdm4))) throw new AppError('Verified BMKG ADM4 mapping required', 503, 'BMKG_MAPPING_INVALID');
    const due: typeof regions = [];
    for (const region of regions) {
      const latest = await client.trWeatherForecast.findFirst({ where: { provider: 'BMKG', regionId: region.id }, orderBy: { fetchedAt: 'desc' }, select: { fetchedAt: true } });
      if (!latest || latest.fetchedAt <= refreshBefore) due.push(region);
    }
    if (!due.length) return { id: null, provider, status: 'CACHED', received: 0, imported: 0, deduplicated: 0 };
    regions = due;
    scope = { regionIds: regions.map(r => r.id) };
  }
  let run;
  try { run = await claimRun(provider, scope, actor, client); }
  catch (error) {
    if (error instanceof AppError && error.code === 'SYNC_RATE_LIMIT') throw error;
    const failureCode = integrationFailureCode(error, provider, 'DB');
    throw new AppError(`${provider} synchronization failed`, 503, failureCode);
  }
  let received = 0;
  let imported = 0;
  let stage: SyncStage = 'DB';
  try {
    if (provider === 'FIRMS') {
      for (const product of requestedProducts) {
        const seen = new Set<string>();
        for (const area of areas) {
          if (Date.now() - run.startedAt.getTime() > 420000) throw new AppError('FIRMS run exceeded the time limit', 503, 'FIRMS_RUN_TIMEOUT');
          stage = 'FETCH';
          const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(env.FIRMS_MAP_KEY!)}/${product}/${area}/2`;
          const response = await fetch(url, { signal: AbortSignal.timeout(60000), redirect: 'error' });
          const text = await boundedText(response);
          stage = 'PARSE';
          const rows = parseFirms(text, product);
          received += rows.length;
          const uniqueRows = rows.filter(row => {
            if (seen.has(row.observationKey)) return false;
            seen.add(row.observationKey);
            return true;
          });
          stage = 'DB';
          for (let offset = 0; offset < uniqueRows.length; offset += 500) {
            const batch = uniqueRows.slice(offset, offset + 500);
            if (Date.now() - run.startedAt.getTime() > 420000) throw new AppError('FIRMS run exceeded the time limit', 503, 'FIRMS_RUN_TIMEOUT');
            imported += await client.$transaction(async tx => {
              await lockRun(tx, run.id);
              const existingRows = await tx.trHotspot.findMany({ where: { observationKey: { in: batch.map(row => row.observationKey) } }, select: { observationKey: true, caseId: true, product: true, raw: true, confidenceRaw: true, frp: true, version: true } });
              const existingByKey = new Map(existingRows.map(row => [row.observationKey, row]));
              const fetchedAt = new Date();
              const newRows = batch.filter(row => !existingByKey.has(row.observationKey));
              const inserted = newRows.length ? (await tx.trHotspot.createMany({ data: newRows.map(row => ({ ...row, raw: jsonValue(row.raw), fetchedAt })) })).count : 0;
              const unchanged: string[] = [];
              const cases = new Set<string>();
              for (const row of batch) {
                const existing = existingByKey.get(row.observationKey);
                if (!existing) continue;
                const changed = existing.product !== row.product || existing.confidenceRaw !== row.confidenceRaw || existing.frp !== row.frp || existing.version !== row.version || fingerprint(existing.raw) !== fingerprint(row.raw);
                if (!changed) { unchanged.push(row.observationKey); continue; }
                await tx.trHotspot.update({ where: { observationKey: row.observationKey }, data: { ...row, raw: jsonValue(row.raw), fetchedAt } });
                if (existing.caseId) cases.add(existing.caseId);
              }
              if (unchanged.length) await tx.trHotspot.updateMany({ where: { observationKey: { in: unchanged } }, data: { fetchedAt } });
              for (const caseId of [...cases].sort()) await sourceContextChanged(tx, caseId, run.id, provider);
              return inserted;
            }, { maxWait: 10000, timeout: 30000 });
          }
        }
      }
    } else {
      for (const region of regions) {
        const refreshed = await client.trWeatherForecast.findFirst({ where: { provider: 'BMKG', regionId: region.id }, orderBy: { fetchedAt: 'desc' }, select: { fetchedAt: true } });
        if (refreshed && Date.now() - refreshed.fetchedAt.getTime() < pollIntervals().BMKG) continue;
        if (Date.now() - run.startedAt.getTime() > 480000) throw unavailable('BMKG run time limit');
        stage = 'FETCH';
        const response = await fetch(`https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=${encodeURIComponent(region.bmkgAdm4!)}`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
        const text = await boundedText(response, 2000000);
        stage = 'PARSE';
        const forecasts = parseBmkg(JSON.parse(text), region.bmkgAdm4!);
        if (!forecasts.length) throw unavailable('BMKG forecast');
        received += forecasts.length;
        stage = 'DB';
        imported += await client.$transaction(async tx => {
          await lockRun(tx, run.id);
          const evaluatedAt = new Date();
          const facts = { id: true, windFromDegrees: true, windSpeed: true, humidity: true, weatherDescription: true, weatherDescriptionEn: true } as const;
          const previous = await tx.trWeatherForecast.findFirst({ where: { provider: 'BMKG', regionId: region.id, issuedAt: { lte: evaluatedAt }, validAt: { lte: evaluatedAt }, fetchedAt: { lte: evaluatedAt } }, orderBy: [{ validAt: 'desc' }, { issuedAt: 'desc' }], select: facts });
          const currentInput = forecasts.filter(forecast => forecast.issuedAt <= evaluatedAt && forecast.validAt <= evaluatedAt).sort((a, b) => b.validAt.getTime() - a.validAt.getTime() || b.issuedAt.getTime() - a.issuedAt.getTime())[0];
          let current = null as null | { id: string; windFromDegrees: number | null; windSpeed: number | null; humidity: number | null; weatherDescription: string | null; weatherDescriptionEn: string | null };
          let count = 0;
          let changed = false;
          for (const forecast of forecasts) {
            const key = { provider: 'BMKG', regionId: region.id, issuedAt: forecast.issuedAt, validAt: forecast.validAt };
            const existing = await tx.trWeatherForecast.findUnique({ where: { provider_regionId_issuedAt_validAt: key }, select: { id: true, raw: true } });
            if (!existing || fingerprint(existing.raw) !== fingerprint(forecast.raw)) changed = true;
            const stored = await tx.trWeatherForecast.upsert({ where: { provider_regionId_issuedAt_validAt: key }, create: { ...forecast, regionId: region.id, raw: jsonValue(forecast.raw) }, update: { ...forecast, raw: jsonValue(forecast.raw), fetchedAt: evaluatedAt }, select: facts });
            if (forecast === currentInput) current = stored;
            if (!existing) count++;
          }
          if (changed) {
            const cases = await tx.trCase.findMany({ where: { regionId: region.id, handlingStatus: { not: 'CLOSED' } }, select: { id: true }, orderBy: { id: 'asc' } });
            for (const item of cases) await sourceContextChanged(tx, item.id, run.id, provider);
          }
          if (current) {
            const changes = forecastMaterialChanges(previous, current, { windSpeedThresholdKmh: env.BMKG_NOTIFY_WIND_SPEED_KMH ?? null, humidityThresholdPercent: env.BMKG_NOTIFY_HUMIDITY_PERCENT ?? null });
            await notifyForecastOwners(tx, region.id, current, changes);
          }
          return count;
        });
        await new Promise(resolve => setTimeout(resolve, 1100));
      }
    }
    if (provider === 'BMKG' && received === 0) {
      await client.trIntegrationRun.update({ where: { id: run.id, status: 'RUNNING' }, data: { status: 'OBSOLETE', completedAt: new Date(), received: 0, imported: 0, deduplicated: 0 } });
      return { id: run.id, provider, status: 'CACHED', received: 0, imported: 0, deduplicated: 0 };
    }
    const completedAt = new Date();
    const coverage = provider === 'FIRMS' ? { scope: jsonValue({ products: requestedProducts, areas, days: 2, observedFrom: new Date(Date.UTC(completedAt.getUTCFullYear(), completedAt.getUTCMonth(), completedAt.getUTCDate() - 1)).toISOString(), observedTo: run.startedAt.toISOString() }) } : {};
    stage = 'DB';
    await client.trIntegrationRun.update({ where: { id: run.id, status: 'RUNNING' }, data: { status: 'SUCCEEDED', completedAt, received, imported, deduplicated: received - imported, ...coverage } });
    return { id: run.id, provider, status: 'SUCCEEDED', received, imported, deduplicated: received - imported };
  } catch (error) {
    const failureCode = integrationFailureCode(error, provider, stage);
    await client.trIntegrationRun.updateMany({ where: { id: run.id, status: 'RUNNING' }, data: { status: 'FAILED', completedAt: new Date(), received, imported, deduplicated: Math.max(0, received - imported), failureCode } }).catch(() => undefined);
    throw new AppError(`${provider} synchronization failed`, 503, failureCode);
  }
}
