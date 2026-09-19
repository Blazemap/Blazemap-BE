import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { db } from '../../config/index.js';
import { publicationSchema, warningSnapshotSchema, warningSaveSchema, warningActionSchema, type Actor, type Transaction } from '../../types/index.js';
import { AppError, fingerprint, jsonValue } from '../../utils/index.js';
import { audit, lockedActor, verifiedRegion } from './access.js';
import { assertPublicationRevision, nextPublicationTimestamp } from './rules.js';
import { publicationDto, publicationSelect } from './information.service.js';

export { warningSaveSchema, warningActionSchema } from '../../types/index.js';

export function eligibleWarningReference(feature: { kind: string; layer: { provider: string; verifiedAt: Date | null }; updates: { id: string; condition: string; observedAt: Date }[] }, updateId: string, now = Date.now()) {
  const latest = feature.updates[0];
  return !!feature.layer.verifiedAt && !/sample|demo|simulat/i.test(feature.layer.provider) && !!latest && latest.id === updateId && latest.observedAt.getTime() <= now && now - latest.observedAt.getTime() <= 86400000 && (feature.kind === 'ROAD' ? ['PASSABLE', 'RESTRICTED', 'IMPASSABLE'].includes(latest.condition) : feature.kind === 'DESIGNATED_LOCATION' && ['AVAILABLE', 'UNAVAILABLE'].includes(latest.condition));
}
const featureInclude = { layer: true, updates: { take: 1, orderBy: [{ observedAt: 'desc' as const }, { createdAt: 'desc' as const }, { id: 'desc' as const }] } };
async function references(tx: Transaction, refs: { featureId: string; updateId: string }[]) {
  if (new Set(refs.map(r => r.featureId)).size !== refs.length) throw new AppError('Duplicate operational feature', 400, 'INVALID_REFERENCE');
  const result = [];
  for (const ref of [...refs].sort((a, b) => a.featureId.localeCompare(b.featureId))) {
    await tx.$queryRaw`SELECT id FROM "MsMapFeature" WHERE id = ${ref.featureId} FOR UPDATE`;
    const feature = await tx.msMapFeature.findUnique({ where: { id: ref.featureId }, include: featureInclude });
    const sample = await tx.trAuditLog.findFirst({ where: { systemActor: 'sample-operations-v1', action: 'SAMPLE_OPERATION_CREATED', OR: [{ targetType: 'FEATURE', targetId: ref.featureId }, { targetType: 'OPERATIONAL_UPDATE', targetId: ref.updateId }] }, select: { id: true } });
    if (!feature || sample || !eligibleWarningReference(feature, ref.updateId)) throw new AppError('Operational reference is unverified, stale, sample, or changed; reload and review', 409, 'INVALID_REFERENCE');
    const latest = feature.updates[0]!;
    result.push({ ...ref, name: feature.name || 'Unnamed operational feature', kind: feature.kind, condition: latest.condition, source: latest.source, observedAt: latest.observedAt.toISOString(), provider: feature.layer.provider });
  }
  return warningSnapshotSchema.parse({ kind: 'INFORMATIONAL_ADVISORY', operationalReferences: result });
}
export async function warningOptions(client: PrismaClient = db()) {
  const features = await client.msMapFeature.findMany({ where: { kind: { in: ['ROAD', 'DESIGNATED_LOCATION'] }, layer: { verifiedAt: { not: null } } }, include: featureInclude, orderBy: { name: 'asc' }, take: 300 });
  const samples = await client.trAuditLog.findMany({ where: { systemActor: 'sample-operations-v1', action: 'SAMPLE_OPERATION_CREATED', targetType: { in: ['FEATURE', 'OPERATIONAL_UPDATE'] } }, select: { targetId: true } });
  const excluded = new Set(samples.map(s => s.targetId));
  return features.filter(f => !excluded.has(f.id) && !excluded.has(f.updates[0]?.id ?? '') && eligibleWarningReference(f, f.updates[0]?.id ?? '')).map(f => ({ featureId: f.id, updateId: f.updates[0]!.id, name: f.name || 'Unnamed operational feature', kind: f.kind, condition: f.updates[0]!.condition, source: f.updates[0]!.source, observedAt: f.updates[0]!.observedAt, provider: f.layer.provider }));
}
async function replay(tx: Transaction, actor: Actor, key: string, hash: string) {
  const existing = await tx.trAuditLog.findFirst({ where: { actorId: actor.id, targetType: 'PUBLICATION', action: 'WARNING_COMMAND', details: { path: ['idempotencyKey'], equals: key } } });
  if (!existing) return null;
  const details = z.object({ payloadHash: z.string() }).parse(existing.details);
  if (details.payloadHash !== hash) throw new AppError('Request key already used for different content', 409, 'IDEMPOTENCY_CONFLICT');
  return publicationDto(await tx.trPublicInformation.findUniqueOrThrow({ where: { id: existing.targetId }, select: publicationSelect() }));
}
export async function saveWarning(actor: Actor, body: unknown, id?: string, client: PrismaClient = db()) {
  const input = warningSaveSchema.parse(body);
  const hash = fingerprint({ input, id: id ?? null });
  return client.$transaction(async tx => {
    await lockedActor(tx, actor, true, 'canPublishInformation');
    const existing = await replay(tx, actor, input.idempotencyKey, hash);
    if (existing) return existing;
    if (id) await tx.$queryRaw`SELECT id FROM "TrPublicInformation" WHERE id = ${id} FOR UPDATE`;
    const old = id ? await tx.trPublicInformation.findUniqueOrThrow({ where: { id } }) : null;
    if (old && (old.type !== 'WARNING' || !['DRAFT', 'PUBLISHED'].includes(old.status))) throw new AppError('Only warning drafts or current warnings can be edited', 409, 'INVALID_PUBLICATION_STATE');
    if (old) assertPublicationRevision(old.updatedAt, input.expectedUpdatedAt ?? '');
    const parsed = publicationSchema.parse({ title: input.title, summary: input.summary, body: input.body, sources: input.sources, regionIds: input.regionIds, validUntil: input.validUntil, type: 'WARNING', publicLocationMode: 'REGION_ONLY' });
    if (new Date(input.validUntil) <= new Date()) throw new AppError('Validity must be in the future', 400, 'INVALID_VALIDITY');
    if (new Set(input.regionIds).size !== input.regionIds.length) throw new AppError('Duplicate region', 400, 'INVALID_REGION');
    for (const region of input.regionIds) await verifiedRegion(tx, region);
    const snapshot = await references(tx, input.operationalReferences);
    const { regionIds, validUntil, ...fields } = parsed;
    const data = { ...fields, caseId: null, reportId: null, outcome: null, publicLatitude: null, publicLongitude: null, privacyReview: null, validUntil: new Date(validUntil!), sources: jsonValue(fields.sources), publicCaseSnapshot: jsonValue(snapshot) };
    if (old?.status === 'DRAFT') await tx.trPublicInformationRegion.deleteMany({ where: { publicInformationId: old.id } });
    const item = old?.status === 'DRAFT' ? await tx.trPublicInformation.update({ where: { id: old.id }, data: { ...data, updatedAt: nextPublicationTimestamp(old.updatedAt), regions: { create: regionIds.map(regionId => ({ regionId })) } }, select: publicationSelect() }) : await tx.trPublicInformation.create({ data: { ...data, slug: `warning-${input.idempotencyKey}`, authorId: actor.id, supersedesId: old?.id, regions: { create: regionIds.map(regionId => ({ regionId })) } }, select: publicationSelect() });
    await audit(tx, actor.id, 'WARNING_COMMAND', 'PUBLICATION', item.id, 'Warning draft saved', { idempotencyKey: input.idempotencyKey, payloadHash: hash, action: 'save', reviewedUpdatedAt: old?.updatedAt.toISOString() ?? null, before: old ? { title: old.title, summary: old.summary, body: old.body, sources: old.sources, validUntil: old.validUntil, advisory: old.publicCaseSnapshot } : null, after: { title: item.title, summary: item.summary, body: item.body, sources: item.sources, regionIds, validUntil: item.validUntil, advisory: snapshot } });
    return publicationDto(item);
  });
}
export async function warningAction(actor: Actor, id: string, body: unknown, client: PrismaClient = db()) {
  const input = warningActionSchema.parse(body);
  const hash = fingerprint({ input, id });
  return client.$transaction(async tx => {
    await lockedActor(tx, actor, true, 'canPublishInformation');
    const existing = await replay(tx, actor, input.idempotencyKey, hash);
    if (existing) return existing;
    await tx.$queryRaw`SELECT id FROM "TrPublicInformation" WHERE id = ${id} FOR UPDATE`;
    const item = await tx.trPublicInformation.findUniqueOrThrow({ where: { id }, include: { regions: true } });
    if (item.type !== 'WARNING' || item.status !== (input.action === 'publish' ? 'DRAFT' : 'PUBLISHED')) throw new AppError('Warning state changed; reload before continuing', 409, 'INVALID_PUBLICATION_STATE');
    assertPublicationRevision(item.updatedAt, input.expectedUpdatedAt);
    if (input.action === 'publish') {
      if (await tx.trAttachment.count({ where: { publicationId: id, approvedAt: { not: null }, revokedAt: null } })) throw new AppError('Warning workflow supports reviewed text and operational references only', 409, 'WARNING_MEDIA_UNSUPPORTED');
      publicationSchema.parse({ title: item.title, summary: item.summary, body: item.body, type: 'WARNING', sources: item.sources, regionIds: item.regions.map(r => r.regionId), publicLocationMode: 'REGION_ONLY' });
      if (!item.validUntil || item.validUntil <= new Date() || !Array.isArray(item.sources) || !item.sources.length || !item.regions.length) throw new AppError('Warning needs future validity, sources and affected regions', 400, 'INVALID_WARNING');
      for (const region of item.regions) await verifiedRegion(tx, region.regionId);
      const snapshot = warningSnapshotSchema.parse(item.publicCaseSnapshot);
      const current = await references(tx, snapshot.operationalReferences.map(r => ({ featureId: r.featureId, updateId: r.updateId })));
      if (fingerprint(current) !== fingerprint(snapshot)) throw new AppError('Operational context changed; save and preview again', 409, 'INVALID_REFERENCE');
      if (item.supersedesId) {
        const changed = await tx.trPublicInformation.updateMany({ where: { id: item.supersedesId, status: 'PUBLISHED', type: 'WARNING' }, data: { status: 'SUPERSEDED', updatedAt: new Date() } });
        if (!changed.count) throw new AppError('Warning being replaced is no longer current', 409, 'PUBLICATION_CONFLICT');
      }
    }
    const updated = await tx.trPublicInformation.update({ where: { id }, data: { updatedAt: nextPublicationTimestamp(item.updatedAt), ...(input.action === 'publish' ? { status: 'PUBLISHED', publishedAt: new Date(), publisherId: actor.id, authorityReference: input.authorityReference } : { status: 'WITHDRAWN', withdrawalReason: input.reason }) }, select: publicationSelect() });
    await audit(tx, actor.id, 'WARNING_COMMAND', 'PUBLICATION', id, input.reason ?? input.authorityReference, { idempotencyKey: input.idempotencyKey, payloadHash: hash, action: input.action, reviewedUpdatedAt: input.expectedUpdatedAt, explicitApproval: true, authorityBasis: 'APPLICATION_ADMIN_ROLE', advisoryKind: 'INFORMATIONAL_ADVISORY' });
    return publicationDto(updated);
  });
}
