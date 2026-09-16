import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { db } from '../../config/index.js';
import { publicationSchema, publishSchema, withdrawalSchema, settingsSchema, informationQuerySchema, type Actor, type Transaction } from '../../types/index.js';
import { AppError, jsonValue } from '../../utils/index.js';
import { audit, lockedActor, verifiedRegion } from './access.js';
import { assertPublicationRevision, nextPublicationTimestamp } from './rules.js';

const publicStatuses = ['PUBLISHED', 'SUPERSEDED', 'WITHDRAWN'] as const;
const publicLinkSchema = z.object({ id: z.string().min(1), slug: z.string().min(1), status: z.enum(publicStatuses), publishedAt: z.date() });
export function publicationSelect(now = new Date()) {
  return {
    id: true, slug: true, title: true, summary: true, body: true, type: true, status: true, sources: true, publishedAt: true, updatedAt: true, validUntil: true,
    authorityReference: true, withdrawalReason: true, supersedesId: true,
    supersedes: { select: { id: true, slug: true, status: true, publishedAt: true } },
    attachments: { where: { approvedAt: { not: null }, revokedAt: null }, select: { id: true, filename: true, contentType: true, size: true } },
    regions: { select: { region: { select: { id: true, name: true, timezone: true } } } },
    replacements: { where: { status: { in: [...publicStatuses] }, publishedAt: { lte: now } }, select: { id: true, slug: true, status: true, publishedAt: true }, orderBy: { publishedAt: 'desc' } },
  } satisfies Prisma.TrPublicInformationSelect;
}
export function publicationDto<T extends { regions: { region: unknown }[]; validUntil: Date | null; replacements?: unknown[] | null; supersedes?: unknown; supersedesId?: string | null }>(item: T) {
  const { supersedes, replacements, ...fields } = item;
  const now = new Date();
  const parent = publicLinkSchema.safeParse(supersedes);
  return {
    ...fields, regions: item.regions.map(v => v.region), expired: !!item.validUntil && item.validUntil <= now,
    supersedesId: parent.success && parent.data.publishedAt <= now ? parent.data.id : null,
    replacements: (replacements ?? []).flatMap(value => {
      const link = publicLinkSchema.safeParse(value);
      return link.success && link.data.publishedAt <= now ? [{ id: link.data.id, slug: link.data.slug, status: link.data.status }] : [];
    }),
  };
}
export function activePublicationWhere(input: { active: boolean; type?: string }, now: Date): Prisma.TrPublicInformationWhereInput {
  if (!input.active) return {};
  return {
    status: 'PUBLISHED', publishedAt: { lte: now },
    ...(input.type === 'WARNING' ? { validUntil: { gt: now } } : { AND: [{ OR: [{ validUntil: { gt: now } }, { validUntil: null, type: { not: 'WARNING' } }] }] }),
  };
}
export async function listInformation(query: unknown, admin = false, client: PrismaClient = db()) {
  const { page, pageSize, search, type, regionId, active } = informationQuerySchema.parse(query);
  const now = new Date();
  const where: Prisma.TrPublicInformationWhereInput = { ...(admin ? {} : { status: 'PUBLISHED', publishedAt: { lte: now } }), ...activePublicationWhere({ active, type }, now), type, ...(regionId ? { regions: { some: { regionId } } } : {}), ...(search ? { OR: [{ title: { contains: search, mode: 'insensitive' } }, { summary: { contains: search, mode: 'insensitive' } }] } : {}) };
  const [data, total] = await client.$transaction([client.trPublicInformation.findMany({ where, select: publicationSelect(now), orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }), client.trPublicInformation.count({ where })]);
  return { data: data.map(publicationDto), meta: { total, page, pageSize } };
}
export async function getInformation(id: string, admin = false, client: PrismaClient = db()) {
  const now = new Date();
  const item = await client.trPublicInformation.findFirst({ where: admin ? { id } : { slug: id, status: { in: [...publicStatuses] }, publishedAt: { lte: now } }, select: { ...publicationSelect(now), ...(admin ? { caseId: true, publicLocationMode: true, publicLatitude: true, publicLongitude: true, privacyReview: true } : {}) } });
  if (!item) throw new AppError('Information not found', 404, 'NOT_FOUND');
  return publicationDto(item);
}
async function validateRegions(tx: Transaction, ids: string[]) {
  if (new Set(ids).size !== ids.length) throw new AppError('Duplicate region', 400, 'INVALID_REGION');
  for (const id of ids) await verifiedRegion(tx, id);
}
export async function saveInformation(actor: Actor, body: unknown, id?: string, client: PrismaClient = db()) {
  const patch = z.record(z.string(), z.unknown()).parse(body);
  return client.$transaction(async tx => {
    await lockedActor(tx, actor, true);
    if (id) await tx.$queryRaw`SELECT id FROM "TrPublicInformation" WHERE id = ${id} FOR UPDATE`;
    const old = id ? await tx.trPublicInformation.findUniqueOrThrow({ where: { id }, include: { regions: true } }) : null;
    const input = publicationSchema.parse(old ? { title: old.title, summary: old.summary, body: old.body, type: old.type, sources: old.sources, regionIds: old.regions.map(r => r.regionId), caseId: old.caseId, validUntil: old.validUntil?.toISOString() ?? null, publicLocationMode: old.publicLocationMode, publicLatitude: old.publicLatitude, publicLongitude: old.publicLongitude, privacyReview: old.privacyReview, ...patch } : body);
    await validateRegions(tx, input.regionIds);
    const { regionIds, validUntil, ...fields } = input;
    const data = { ...fields, sources: jsonValue(fields.sources), validUntil: validUntil ? new Date(validUntil) : null, publicLatitude: fields.publicLocationMode === 'APPROVED_INCIDENT_POINT' ? fields.publicLatitude : null, publicLongitude: fields.publicLocationMode === 'APPROVED_INCIDENT_POINT' ? fields.publicLongitude : null };
    let item;
    if (old?.status === 'DRAFT') {
      await tx.trPublicInformationRegion.deleteMany({ where: { publicInformationId: old.id } });
      item = await tx.trPublicInformation.update({ where: { id: old.id, status: 'DRAFT' }, data: { ...data, updatedAt: nextPublicationTimestamp(old.updatedAt), regions: { create: regionIds.map(regionId => ({ regionId })) } }, select: publicationSelect() });
    } else {
      if (old && old.status !== 'PUBLISHED') throw new AppError('Only a current publication can be replaced', 409, 'INVALID_PUBLICATION_STATE');
      const slug = `${input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'information'}-${randomUUID()}`;
      item = await tx.trPublicInformation.create({ data: { ...data, slug, authorId: actor.id, supersedesId: old?.id, regions: { create: regionIds.map(regionId => ({ regionId })) } }, select: publicationSelect() });
    }
    await audit(tx, actor.id, old?.status === 'PUBLISHED' ? 'REPLACEMENT_DRAFT_CREATED' : 'DRAFT_SAVED', 'PUBLICATION', item.id);
    return publicationDto(item);
  });
}
export async function publishInformation(actor: Actor, id: string, body: unknown, client: PrismaClient = db()) {
  const input = publishSchema.parse(body);
  return client.$transaction(async tx => {
    await lockedActor(tx, actor, true, 'canPublishInformation');
    await tx.$queryRaw`SELECT id FROM "TrPublicInformation" WHERE id = ${id} FOR UPDATE`;
    const item = await tx.trPublicInformation.findUniqueOrThrow({ where: { id }, include: { regions: true } });
    if (item.status !== 'DRAFT') throw new AppError('Only drafts can be published', 409, 'INVALID_PUBLICATION_STATE');
    assertPublicationRevision(item.updatedAt, input.expectedUpdatedAt);
    if (!Array.isArray(item.sources) || !item.sources.length) throw new AppError('At least one factual source is required', 400, 'SOURCES_REQUIRED');
    if (item.validUntil && item.validUntil <= new Date()) throw new AppError('Validity must end after publication', 400, 'INVALID_VALIDITY');
    if (item.type === 'WARNING' && !item.validUntil) throw new AppError('Warnings require a validity end time', 400, 'VALIDITY_REQUIRED');
    await validateRegions(tx, item.regions.map(v => v.regionId));
    let snapshot: Prisma.InputJsonValue | undefined;
    if (item.caseId) {
      await tx.$queryRaw`SELECT id FROM "TrCase" WHERE id = ${item.caseId} FOR UPDATE`;
      const c = await tx.trCase.findUniqueOrThrow({ where: { id: item.caseId } });
      if (item.publicLocationMode === 'APPROVED_INCIDENT_POINT' && (!item.privacyReview || item.publicLatitude == null || item.publicLongitude == null)) throw new AppError('Public point needs explicit privacy review', 400, 'PRIVACY_REVIEW_REQUIRED');
      snapshot = jsonValue({ id: c.id, number: c.number, title: item.title, verificationStatus: c.verificationStatus, handlingStatus: c.handlingStatus, approvedAt: new Date().toISOString() });
    }
    if (item.supersedesId) {
      const old = await tx.trPublicInformation.updateMany({ where: { id: item.supersedesId, status: 'PUBLISHED' }, data: { status: 'SUPERSEDED', updatedAt: new Date() } });
      if (!old.count) throw new AppError('The publication being replaced is no longer current', 409, 'PUBLICATION_CONFLICT');
    }
    const updated = await tx.trPublicInformation.update({ where: { id, status: 'DRAFT', updatedAt: new Date(input.expectedUpdatedAt) }, data: { status: 'PUBLISHED', publisherId: actor.id, authorityReference: input.authorityReference, updatedAt: nextPublicationTimestamp(item.updatedAt), publishedAt: new Date(), publicCaseSnapshot: snapshot }, select: publicationSelect() });
    await audit(tx, actor.id, 'INFORMATION_PUBLISHED', 'PUBLICATION', id, input.authorityReference, { reviewedUpdatedAt: item.updatedAt.toISOString() });
    return publicationDto(updated);
  });
}
export async function withdrawInformation(actor: Actor, id: string, body: unknown) {
  const { reason } = withdrawalSchema.parse(body);
  return db().$transaction(async tx => {
    await lockedActor(tx, actor, true, 'canPublishInformation');
    const updated = await tx.trPublicInformation.update({ where: { id, status: 'PUBLISHED' }, data: { status: 'WITHDRAWN', withdrawalReason: reason }, select: publicationSelect() });
    await tx.trAttachment.updateMany({ where: { publicationId: id }, data: { revokedAt: new Date() } });
    await audit(tx, actor.id, 'INFORMATION_WITHDRAWN', 'PUBLICATION', id, reason);
    return publicationDto(updated);
  });
}
export async function getSettings(admin = false) {
  const item = await db().msSiteProfile.findFirst({ where: { id: 'site', ...(admin ? {} : { verifiedAt: { not: null } }) }, select: { name: true, operator: true, email: true, phone: true, address: true, hours: true, verifiedAt: true, ...(admin ? { source: true, updatedAt: true } : {}) } });
  return item;
}
export async function updateSettings(actor: Actor, body: unknown) {
  const input = settingsSchema.parse(body);
  return db().$transaction(async tx => {
    await lockedActor(tx, actor, true, 'canPublishInformation');
    const data = { ...input, verifiedAt: new Date(input.verifiedAt) };
    await tx.msSiteProfile.upsert({ where: { id: 'site' }, create: { id: 'site', ...data }, update: data });
    await audit(tx, actor.id, 'SITE_PROFILE_UPDATED', 'SITE', 'site', input.source);
    return { ...input };
  });
}
