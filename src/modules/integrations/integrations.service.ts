import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { db, env, pollIntervals } from '../../config/index.js';
import { AppError, boundedText, fingerprint, jsonValue, unavailable } from '../../utils/index.js';
import { type Actor, type Transaction } from '../../types/index.js';
import { lockedActor } from '../admin/access.js';
import { parseFirms } from './parsing.js';

const products = z.array(z.enum(['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT', 'VIIRS_NOAA20_SP', 'VIIRS_SNPP_SP'])).min(1).max(3);
const areaSchema = z.tuple([z.coerce.number().min(-180).max(180), z.coerce.number().min(-90).max(90), z.coerce.number().min(-180).max(180), z.coerce.number().min(-90).max(90)]).refine(([w, s, e, n]) => w < e && s < n);
const syncSchema = z.strictObject({});
type SyncStage = 'FETCH' | 'PARSE' | 'DB';
export function firmsAreas(value: string | undefined) {
  const values = value?.split(';').map(area => area.trim()).filter(Boolean) ?? [];
  if (!values.length || values.length > 16) return null;
  const parsed = values.map(area => areaSchema.safeParse(area.split(/[,\s]+/)));
  return parsed.every(result => result.success) ? parsed.map(result => result.data!.join(',')) : null;
}
export function integrationFailureCode(error: unknown, provider: 'FIRMS', stage?: SyncStage) {
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
  if (code === 'FIRMS_RUN_TIMEOUT') return code;
  if (stage === 'PARSE') return 'FIRMS_CSV_SCHEMA';
  if (code === 'SOURCE_HTTP_STATUS') return 'FIRMS_HTTP_STATUS';
  if (code === 'SOURCE_PAYLOAD_TOO_LARGE') return 'FIRMS_PAYLOAD_TOO_LARGE';
  if (code === 'SOURCE_BODY_MISSING' || code === 'SOURCE_READ_FAILED') return 'FIRMS_RESPONSE_READ';
  if (names.some(name => name === 'TimeoutError' || name === 'AbortError')) return 'FIRMS_TIMEOUT';
  if (stage === 'DB' || /^P\d{4}$/.test(code) || ['ECONNREFUSED', 'ENOENT'].includes(code)) return 'DB_UNAVAILABLE';
  return 'FIRMS_SOURCE_FAILED';
}
export function firmsConfigured() { return !!env.FIRMS_MAP_KEY && products.safeParse(env.FIRMS_PRODUCTS?.split(',').map(v => v.trim())).success && firmsAreas(env.FIRMS_AREA) !== null; }
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
    const delay = pollIntervals().FIRMS;
    if (recent?.status === 'RUNNING' || (recent && Date.now() - recent.startedAt.getTime() < delay)) throw new AppError('Integration recently requested; retry later', 429, 'SYNC_RATE_LIMIT');
    return tx.trIntegrationRun.create({ data: { provider, scope: jsonValue(scope) } });
  }, { maxWait: 10000, timeout: 30000 });
}
export async function syncSource(source: string, body: unknown, actor?: Actor, client: PrismaClient = db()) {
  const provider = z.literal('FIRMS').parse(source.toUpperCase());
  syncSchema.parse(body);
  if (!firmsConfigured()) throw new AppError('FIRMS configuration unavailable', 503, 'FIRMS_CONFIG_INVALID');
  const parsedProducts = products.safeParse(env.FIRMS_PRODUCTS!.split(',').map(v => v.trim()));
  const parsedAreas = firmsAreas(env.FIRMS_AREA);
  if (!parsedProducts.success || !parsedAreas) throw new AppError('FIRMS configuration unavailable', 503, 'FIRMS_CONFIG_INVALID');
  const requestedProducts = parsedProducts.data;
  const areas = parsedAreas;
  const scope = { products: requestedProducts, areas, days: 2 };
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
              const existingRows = await tx.trHotspot.findMany({ where: { observationKey: { in: batch.map(row => row.observationKey) } }, select: { observationKey: true, product: true, raw: true, confidenceRaw: true, frp: true, version: true } });
              const existingByKey = new Map(existingRows.map(row => [row.observationKey, row]));
              const fetchedAt = new Date();
              const newRows = batch.filter(row => !existingByKey.has(row.observationKey));
              const inserted = newRows.length ? (await tx.trHotspot.createMany({ data: newRows.map(row => ({ ...row, raw: jsonValue(row.raw), fetchedAt })) })).count : 0;
              const unchanged: string[] = [];
              for (const row of batch) {
                const existing = existingByKey.get(row.observationKey);
                if (!existing) continue;
                const changed = existing.product !== row.product || existing.confidenceRaw !== row.confidenceRaw || existing.frp !== row.frp || existing.version !== row.version || fingerprint(existing.raw) !== fingerprint(row.raw);
                if (!changed) { unchanged.push(row.observationKey); continue; }
                await tx.trHotspot.update({ where: { observationKey: row.observationKey }, data: { ...row, raw: jsonValue(row.raw), fetchedAt } });
              }
              if (unchanged.length) await tx.trHotspot.updateMany({ where: { observationKey: { in: unchanged } }, data: { fetchedAt } });
              return inserted;
            }, { maxWait: 10000, timeout: 30000 });
          }
        }
      }
    const completedAt = new Date();
    const coverage = { scope: jsonValue({ products: requestedProducts, areas, days: 2, observedFrom: new Date(Date.UTC(completedAt.getUTCFullYear(), completedAt.getUTCMonth(), completedAt.getUTCDate() - 1)).toISOString(), observedTo: run.startedAt.toISOString() }) };
    stage = 'DB';
    await client.trIntegrationRun.update({ where: { id: run.id, status: 'RUNNING' }, data: { status: 'SUCCEEDED', completedAt, received, imported, deduplicated: received - imported, ...coverage } });
    return { id: run.id, provider, status: 'SUCCEEDED', received, imported, deduplicated: received - imported };
  } catch (error) {
    const failureCode = integrationFailureCode(error, provider, stage);
    await client.trIntegrationRun.updateMany({ where: { id: run.id, status: 'RUNNING' }, data: { status: 'FAILED', completedAt: new Date(), received, imported, deduplicated: Math.max(0, received - imported), failureCode } }).catch(() => undefined);
    throw new AppError(`${provider} synchronization failed`, 503, failureCode);
  }
}
