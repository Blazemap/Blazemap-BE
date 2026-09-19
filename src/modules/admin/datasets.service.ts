import { z } from 'zod';
import { db } from '../../config/index.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { featureKinds, idSchema, latitudeSchema, longitudeSchema, paginationSchema, reasonSchema, timeSchema, type Actor } from '../../types/index.js';
import { AppError, jsonValue } from '../../utils/index.js';
import { audit, bumpContext, lockedActor, verifiedRegion } from './access.js';

const point = z.tuple([longitudeSchema, latitudeSchema]);
const line = z.array(point).min(2).max(10000);
const ring = z.array(point).min(4).max(10000).refine(v => JSON.stringify(v[0]) === JSON.stringify(v.at(-1)), 'Polygon rings must be closed');
export const geometrySchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('Point'), coordinates: point }),
  z.strictObject({ type: z.literal('LineString'), coordinates: line }),
  z.strictObject({ type: z.literal('Polygon'), coordinates: z.array(ring).min(1).max(100) }),
  z.strictObject({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(ring).min(1).max(100)).min(1).max(100) }),
]);
export const regionSchema = z.strictObject({ name: z.string().trim().min(2).max(200), level: z.number().int().min(1).max(4), code: z.string().trim().min(2).max(32), bmkgAdm4: z.string().regex(/^\d{2}\.\d{2}\.\d{2}\.\d{4}$/).nullish(), timezone: z.enum(['Asia/Pontianak', 'Asia/Makassar', 'Asia/Jakarta']), parentId: idSchema.nullish(), datasetId: idSchema, verifiedAt: timeSchema, reason: reasonSchema }).refine(v => !v.bmkgAdm4 || v.level === 4, 'BMKG mapping requires administrative level IV');
const layerSchema = z.strictObject({ name: z.string().trim().min(3).max(200), kind: z.enum(featureKinds), provider: z.string().trim().min(3).max(200), sourceUrl: z.url({ protocol: /^https:$/ }).max(2000), license: z.string().trim().min(3).max(1000), attribution: z.string().trim().min(3).max(1000), coverage: z.string().trim().min(3).max(1000), version: z.string().trim().min(1).max(100), sourceDate: timeSchema, verifiedAt: timeSchema, reason: reasonSchema,
  features: z.array(z.strictObject({ sourceId: z.string().trim().min(1).max(128), kind: z.enum(featureKinds), name: z.string().max(200).nullish(), geometry: geometrySchema, regionId: idSchema.nullish(), attributes: z.record(z.string().max(100), z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()])).default({}) })).max(200),
}).refine(v => new Set(v.features.map(f => f.sourceId)).size === v.features.length, 'Feature identities must be unique');
export async function createRegion(actor: Actor, body: unknown) {
  const { reason, verifiedAt, ...data } = regionSchema.parse(body);
  return db().$transaction(async tx => {
    await lockedActor(tx, actor, true, 'canPublishInformation');
    const dataset = await tx.msMapLayer.findFirst({ where: { id: data.datasetId, kind: 'BOUNDARY', verifiedAt: { not: null } } });
    if (!dataset) throw new AppError('Region requires a verified boundary dataset', 400, 'INVALID_DATASET');
    if (data.parentId) {
      const parent = await tx.msRegion.findUniqueOrThrow({ where: { id: data.parentId } });
      if (parent.level !== data.level - 1 || !parent.verifiedAt) throw new AppError('Region parent has an incompatible level', 400, 'INVALID_REGION');
    }
    const region = await tx.msRegion.create({ data: { ...data, verifiedAt: new Date(verifiedAt) }, select: { id: true, name: true, level: true, code: true, bmkgAdm4: true, timezone: true, datasetId: true, parentId: true, verifiedAt: true } });
    await audit(tx, actor.id, 'REGION_REGISTERED', 'REGION', region.id, reason);
    return region;
  });
}
export async function importLayer(actor: Actor, body: unknown) {
  const { reason, features, sourceDate, verifiedAt, ...input } = layerSchema.parse(body);
  return db().$transaction(async tx => {
    await lockedActor(tx, actor, true, 'canPublishInformation');
    for (const id of [...new Set(features.flatMap(f => f.regionId ? [f.regionId] : []))]) await verifiedRegion(tx, id);
    const layer = await tx.msMapLayer.create({ data: { ...input, sourceDate: new Date(sourceDate), verifiedAt: new Date(verifiedAt), features: { create: features.map(f => ({ ...f, geometry: jsonValue(f.geometry), attributes: jsonValue(f.attributes) })) } }, select: { id: true, name: true, kind: true, provider: true, version: true, sourceDate: true, importedAt: true, verifiedAt: true } });
    await tx.trCase.updateMany({ where: { regionId: { in: features.flatMap(f => f.regionId ? [f.regionId] : []) }, handlingStatus: { not: 'CLOSED' } }, data: { contextRevision: { increment: 1 }, version: { increment: 1 }, latestAnalysisId: null, updatedAt: new Date() } });
    await audit(tx, actor.id, 'DATASET_IMPORTED', 'LAYER', layer.id, reason, { featureCount: features.length });
    return { ...layer, featureCount: features.length };
  }, { timeout: 15000 });
}
export async function listLayers() {
  return db().msMapLayer.findMany({ select: { id: true, name: true, kind: true, provider: true, sourceUrl: true, license: true, attribution: true, coverage: true, version: true, sourceDate: true, importedAt: true, verifiedAt: true, _count: { select: { features: true } } }, take: 100, orderBy: { importedAt: 'desc' } });
}
export async function listRegions(query: unknown, client: PrismaClient = db()) {
  const { search, bmkgMapped } = z.strictObject({ search: z.string().trim().max(200).optional(), bmkgMapped: z.enum(['true', 'false']).optional() }).parse(query);
  const rows = await client.msRegion.findMany({
    where: { verifiedAt: { not: null }, ...(bmkgMapped === 'true' ? { bmkgAdm4: { not: null }, level: 4 } : bmkgMapped === 'false' ? { bmkgAdm4: null } : {}), ...(search ? { name: { contains: search, mode: 'insensitive' as const } } : {}) },
    select: { id: true, name: true, code: true, level: true, timezone: true, bmkgAdm4: true },
    orderBy: { name: 'asc' },
    take: 100,
  });
  return rows.map(({ bmkgAdm4, ...region }) => ({ ...region, bmkgMapped: bmkgAdm4 !== null }));
}
export async function listFeatures(query: unknown) {
  const { page, pageSize, regionId, search } = paginationSchema.parse(query);
  const where = { regionId, ...(search ? { name: { contains: search, mode: 'insensitive' as const } } : {}) };
  const [data, total] = await db().$transaction([db().msMapFeature.findMany({ where, select: { id: true, layerId: true, kind: true, name: true, regionId: true, geometry: true }, skip: (page - 1) * pageSize, take: pageSize, orderBy: { id: 'asc' } }), db().msMapFeature.count({ where })]);
  return { data, meta: { total, page, pageSize } };
}
export async function listHotspots(query: unknown) {
  const { page, pageSize } = paginationSchema.parse(query);
  const [data, total] = await db().$transaction([db().trHotspot.findMany({ select: { id: true, source: true, product: true, satellite: true, instrument: true, acquiredAt: true, latitude: true, longitude: true, confidenceRaw: true, frp: true, fetchedAt: true, caseId: true }, take: pageSize, skip: (page - 1) * pageSize, orderBy: { acquiredAt: 'desc' } }), db().trHotspot.count()]);
  return { data, meta: { total, page, pageSize } };
}
export async function associateHotspot(actor: Actor, id: string, body: unknown) {
  const input = z.strictObject({ caseId: idSchema.nullable(), reason: reasonSchema }).parse(body);
  return db().$transaction(async tx => {
    await lockedActor(tx, actor, true);
    await tx.$queryRaw`SELECT id FROM "TrHotspot" WHERE id = ${id} FOR UPDATE`;
    const old = await tx.trHotspot.findUniqueOrThrow({ where: { id } });
    const ids = [...new Set([old.caseId, input.caseId].filter((v): v is string => !!v))].sort();
    for (const caseId of ids) await tx.$queryRaw`SELECT id FROM "TrCase" WHERE id = ${caseId} FOR UPDATE`;
    if (input.caseId && input.caseId !== old.caseId) {
      const target = await tx.trCase.findUniqueOrThrow({ where: { id: input.caseId } });
      if (target.handlingStatus === 'CLOSED' || target.verificationStatus === 'NOT_FIRE') throw new AppError('Reopen or correct the case before linking evidence', 409, 'CASE_REVIEW_REQUIRED');
    }
    await tx.trHotspot.update({ where: { id }, data: { caseId: input.caseId } });
    for (const caseId of ids) { await bumpContext(tx, caseId); await audit(tx, actor.id, 'HOTSPOT_ASSOCIATION_CHANGED', 'CASE', caseId, input.reason, { hotspotId: id, previousCaseId: old.caseId, caseId: input.caseId }); }
    return { id, caseId: input.caseId };
  });
}
