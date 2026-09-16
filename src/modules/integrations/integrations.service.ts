import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { db, env, pollIntervals } from '../../config/index.js';
import { AppError, boundedText, fingerprint, jsonValue, unavailable } from '../../utils/index.js';
import { idSchema, type Actor, type Transaction } from '../../types/index.js';
import { lockedActor } from '../admin/access.js';
import { parseBmkg, parseFirms } from './parsing.js';

const products = z.array(z.enum(['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT', 'VIIRS_NOAA20_SP', 'VIIRS_SNPP_SP'])).min(1).max(3);
const areaSchema = z.tuple([z.coerce.number().min(-180).max(180), z.coerce.number().min(-90).max(90), z.coerce.number().min(-180).max(180), z.coerce.number().min(-90).max(90)]).refine(([w, s, e, n]) => w < e && s < n);
const syncSchema = z.strictObject({ regionIds: z.array(idSchema).min(1).max(30).optional() });
export function firmsConfigured() { return !!env.FIRMS_MAP_KEY && products.safeParse(env.FIRMS_PRODUCTS?.split(',').map(v => v.trim())).success && areaSchema.safeParse(env.FIRMS_AREA?.split(',')).success; }
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
  });
}
export async function syncSource(source: string, body: unknown, actor?: Actor, client: PrismaClient = db()) {
  const input = syncSchema.parse(body);
  const provider = z.enum(['FIRMS', 'BMKG']).parse(source.toUpperCase());
  let scope: unknown;
  let requestedProducts: string[] = [];
  let area = '';
  let regions: { id: string; bmkgAdm4: string | null }[] = [];
  if (provider === 'FIRMS') {
    if (!firmsConfigured()) throw unavailable('FIRMS configuration');
    const parsedProducts = products.safeParse(env.FIRMS_PRODUCTS!.split(',').map(v => v.trim()));
    const parsedArea = areaSchema.safeParse(env.FIRMS_AREA!.split(','));
    if (!parsedProducts.success || !parsedArea.success) throw unavailable('FIRMS configuration');
    requestedProducts = parsedProducts.data;
    area = parsedArea.data.join(',');
    scope = { products: requestedProducts, area, days: 2 };
  } else {
    const refreshBefore = new Date(Date.now() - pollIntervals().BMKG);
    regions = input.regionIds ? await client.msRegion.findMany({ where: { verifiedAt: { not: null }, bmkgAdm4: { not: null }, id: { in: input.regionIds } }, select: { id: true, bmkgAdm4: true }, take: 30 }) : await client.$queryRaw<{ id: string; bmkgAdm4: string | null }[]>`
      SELECT r.id, r."bmkgAdm4" FROM "MsRegion" r
      LEFT JOIN LATERAL (SELECT max(f."fetchedAt") AS fetched FROM "TrWeatherForecast" f WHERE f."regionId" = r.id AND f.provider = 'BMKG') latest ON true
      WHERE r."verifiedAt" IS NOT NULL AND r."bmkgAdm4" IS NOT NULL
        AND EXISTS (SELECT 1 FROM "TrCase" c WHERE c."regionId" = r.id AND c."handlingStatus" != 'CLOSED')
        AND (latest.fetched IS NULL OR latest.fetched <= ${refreshBefore})
      ORDER BY latest.fetched ASC NULLS FIRST, r.id LIMIT 30`;
    if (input.regionIds && regions.length !== input.regionIds.length) throw unavailable('Verified BMKG region mappings');
    if (!regions.length) return { id: null, provider, status: 'NO_DUE_REGIONS', received: 0, imported: 0, deduplicated: 0 };
    const due: typeof regions = [];
    for (const region of regions) {
      const latest = await client.trWeatherForecast.findFirst({ where: { regionId: region.id }, orderBy: { fetchedAt: 'desc' }, select: { fetchedAt: true } });
      if (!latest || latest.fetchedAt <= refreshBefore) due.push(region);
    }
    if (!due.length) return { id: null, provider, status: 'CACHED', received: 0, imported: 0, deduplicated: 0 };
    regions = due;
    scope = { regionIds: regions.map(r => r.id) };
  }
  const run = await claimRun(provider, scope, actor, client);
  let received = 0;
  let imported = 0;
  try {
    if (provider === 'FIRMS') {
      for (const product of requestedProducts) {
        const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(env.FIRMS_MAP_KEY!)}/${product}/${area}/2`;
        const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error' });
        const rows = parseFirms(await boundedText(response), product);
        received += rows.length;
        for (let offset = 0; offset < rows.length; offset += 200) {
          const batch = rows.slice(offset, offset + 200);
          if (Date.now() - run.startedAt.getTime() > 480000) throw unavailable('FIRMS run time limit');
          imported += await client.$transaction(async tx => {
            await lockRun(tx, run.id);
            let inserted = 0;
            const cases = new Set<string>();
            for (const row of batch) {
              const existing = await tx.trHotspot.findUnique({ where: { observationKey: row.observationKey }, select: { id: true, caseId: true, confidenceRaw: true, frp: true, version: true } });
              await tx.trHotspot.upsert({ where: { observationKey: row.observationKey }, create: { ...row, raw: jsonValue(row.raw) }, update: { ...row, raw: jsonValue(row.raw), fetchedAt: new Date() } });
              if (!existing) inserted++;
              else if (existing.caseId && (existing.confidenceRaw !== row.confidenceRaw || existing.frp !== row.frp || existing.version !== row.version)) cases.add(existing.caseId);
            }
            for (const caseId of [...cases].sort()) await sourceContextChanged(tx, caseId, run.id, provider);
            return inserted;
          }, { timeout: 30000 });
        }
      }
    } else {
      for (const region of regions) {
        const refreshed = await client.trWeatherForecast.findFirst({ where: { regionId: region.id }, orderBy: { fetchedAt: 'desc' }, select: { fetchedAt: true } });
        if (refreshed && Date.now() - refreshed.fetchedAt.getTime() < pollIntervals().BMKG) continue;
        if (Date.now() - run.startedAt.getTime() > 480000) throw unavailable('BMKG run time limit');
        const response = await fetch(`https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=${encodeURIComponent(region.bmkgAdm4!)}`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
        const forecasts = parseBmkg(JSON.parse(await boundedText(response, 2000000)), region.bmkgAdm4!);
        if (!forecasts.length) throw unavailable('BMKG forecast');
        received += forecasts.length;
        imported += await client.$transaction(async tx => {
          await lockRun(tx, run.id);
          let count = 0;
          let changed = false;
          for (const forecast of forecasts) {
            const key = { provider: 'BMKG', regionId: region.id, issuedAt: forecast.issuedAt, validAt: forecast.validAt };
            const existing = await tx.trWeatherForecast.findUnique({ where: { provider_regionId_issuedAt_validAt: key }, select: { id: true, raw: true } });
            if (!existing || fingerprint(existing.raw) !== fingerprint(forecast.raw)) changed = true;
            await tx.trWeatherForecast.upsert({ where: { provider_regionId_issuedAt_validAt: key }, create: { ...forecast, regionId: region.id, raw: jsonValue(forecast.raw) }, update: { ...forecast, raw: jsonValue(forecast.raw), fetchedAt: new Date() } });
            if (!existing) count++;
          }
          if (changed) {
            const cases = await tx.trCase.findMany({ where: { regionId: region.id, handlingStatus: { not: 'CLOSED' } }, select: { id: true }, orderBy: { id: 'asc' } });
            for (const item of cases) await sourceContextChanged(tx, item.id, run.id, provider);
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
    await client.trIntegrationRun.update({ where: { id: run.id, status: 'RUNNING' }, data: { status: 'SUCCEEDED', completedAt: new Date(), received, imported, deduplicated: received - imported } });
    return { id: run.id, provider, status: 'SUCCEEDED', received, imported, deduplicated: received - imported };
  } catch {
    await client.trIntegrationRun.updateMany({ where: { id: run.id, status: 'RUNNING' }, data: { status: 'FAILED', completedAt: new Date(), received, imported, failureCode: 'SOURCE_UNAVAILABLE' } });
    throw unavailable(provider);
  }
}
