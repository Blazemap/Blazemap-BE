import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { db, env } from '../../config/index.js';
import { warningSnapshotSchema, publicationSchema, publishSchema, outcomePublicationSchema, withdrawalSchema, settingsSchema, informationQuerySchema, type Actor, type Transaction } from '../../types/index.js';
import { AppError, jsonValue, fingerprint } from '../../utils/index.js';
import { richTextDocumentSchema } from '../../utils/rich-text.js';
import { areaHectares, publicPerimeter, publicPerimeterSchema } from '../../utils/geometry.js';
import { audit, lockedActor, verifiedRegion } from './access.js';
import { assertPublicationRevision, nextPublicationTimestamp, publicPoint } from './rules.js';

const publicStatuses = ['PUBLISHED', 'SUPERSEDED', 'WITHDRAWN'] as const;
export function assertActiveCasePublication(value: { handlingStatus: string; verificationStatus: string }) {
  if (value.handlingStatus === 'CLOSED') throw new AppError('Use the completion News workflow for closed cases', 409, 'COMPLETION_NEWS_REQUIRED');
  if (value.verificationStatus !== 'CONFIRMED_FIRE') throw new AppError('Confirm the case before preparing a public incident update', 409, 'CASE_NOT_CONFIRMED');
}
const publicLinkSchema = z.object({ id: z.string().min(1), slug: z.string().min(1), status: z.enum(publicStatuses), publishedAt: z.date() });
const publicCaseContextSchema = z.object({ number: z.string().min(1), handlingStatus: z.enum(['OPEN', 'CHECK_SCHEDULED', 'ON_SCENE', 'RESPONDING', 'MONITORING', 'CLOSED']) });
export function publicationSelect(now = new Date(), coverOnly = false) {
  return {
    id: true, slug: true, title: true, summary: true, body: true, bodyRich: true, type: true, outcome: true, status: true, sources: true, publishedAt: true, updatedAt: true, validUntil: true,
    authorityReference: true, withdrawalReason: true, supersedesId: true,
    publicLocationMode: true, publicLatitude: true, publicLongitude: true, publicCaseSnapshot: true,
    supersedes: { select: { id: true, slug: true, status: true, publishedAt: true } },
    attachments: { where: { approvedAt: { not: null }, approvedById: { not: null }, sourceAttachmentId: { not: null }, revokedAt: null }, select: { id: true, filename: true, contentType: true, size: true }, orderBy: [{ approvedAt: 'asc' as const }, { id: 'asc' as const }], ...(coverOnly ? { take: 1 } : {}) },
    regions: { select: { region: { select: { id: true, name: true, timezone: true } } } },
    replacements: { where: { status: { in: [...publicStatuses] }, publishedAt: { lte: now } }, select: { id: true, slug: true, status: true, publishedAt: true }, orderBy: { publishedAt: 'desc' } },
  } satisfies Prisma.TrPublicInformationSelect;
}
export function publicationDto<T extends { regions: { region: unknown }[]; validUntil: Date | null; replacements?: unknown[] | null; supersedes?: unknown; supersedesId?: string | null; publicLocationMode?: string; publicLatitude?: number | null; publicLongitude?: number | null; publicCaseSnapshot?: unknown }>(item: T) {
  const { supersedes, replacements, publicCaseSnapshot, ...fields } = item;
  const bodyRich = 'bodyRich' in fields && fields.bodyRich ? richTextDocumentSchema.safeParse(fields.bodyRich) : null;
  const location = { publicLocationMode: item.publicLocationMode ?? 'NONE', publicLatitude: item.publicLatitude ?? null, publicLongitude: item.publicLongitude ?? null, publicCaseSnapshot };
  const point = publicPoint(location);
  const now = new Date();
  const parent = publicLinkSchema.safeParse(supersedes);
  const context = publicCaseContextSchema.safeParse(publicCaseSnapshot);
  const advisory = warningSnapshotSchema.safeParse(publicCaseSnapshot);
  return {
    ...fields, bodyRich: bodyRich?.success ? bodyRich.data : null, ...(advisory.success ? { advisory: advisory.data } : {}), publicLatitude: point.latitude, publicLongitude: point.longitude, ...point, ...publicPerimeter(location), ...(context.success ? { caseNumber: context.data.number, handlingStatus: context.data.handlingStatus, windContext: null } : {}), regions: item.regions.map(v => v.region), expired: !!item.validUntil && item.validUntil <= now,
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
  const { page, pageSize, search, type, regionId, active, news, feed, from } = informationQuerySchema.parse(query);
  const now = new Date();
  const filters: Prisma.TrPublicInformationWhereInput[] = [
    ...(active ? [activePublicationWhere({ active, type }, now)] : []),
    ...(feed ? [{ OR: [{ validUntil: null }, { validUntil: { gt: now } }] }] : []),
    ...(news || feed ? [{ type: { not: 'WARNING' as const } }] : []),
    ...(search ? [{ OR: [{ title: { contains: search, mode: 'insensitive' as const } }, { summary: { contains: search, mode: 'insensitive' as const } }] }] : []),
  ];
  const where: Prisma.TrPublicInformationWhereInput = { ...(admin ? {} : { status: 'PUBLISHED', publishedAt: { lte: now } }), type, ...(feed ? { status: 'PUBLISHED', caseId: { not: null }, privacyReview: { not: null }, publishedAt: { lte: now, ...(from ? { gte: new Date(from) } : {}) } } : {}), ...(news ? { status: 'PUBLISHED', publishedAt: { lte: now }, privacyReview: { not: null }, OR: [{ outcome: 'DECLINED' }, { caseId: { not: null }, AND: [{ publicCaseSnapshot: { path: ['verificationStatus'], equals: 'CONFIRMED_FIRE' } }, { publicCaseSnapshot: { path: ['handlingStatus'], equals: 'CLOSED' } }] }] } : {}), ...(regionId ? { regions: { some: { regionId } } } : {}), ...(filters.length ? { AND: filters } : {}) };
  const [data, total] = await client.$transaction([client.trPublicInformation.findMany({ where, select: publicationSelect(now, !admin), orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }), client.trPublicInformation.count({ where })]);
  return { data: data.map(publicationDto), meta: { total, page, pageSize } };
}
export async function getInformation(id: string, admin = false, client: PrismaClient = db()) {
  const now = new Date();
  const item = await client.trPublicInformation.findFirst({ where: admin ? { id } : { slug: id, status: { in: [...publicStatuses] }, publishedAt: { lte: now } }, select: { ...publicationSelect(now), case: { select: { verificationStatus: true, handlingStatus: true } }, ...(admin ? { caseId: true, publicLocationMode: true, publicLatitude: true, publicLongitude: true, privacyReview: true } : {}) } });
  if (!item) throw new AppError('Information not found', 404, 'NOT_FOUND');
  const { case: liveCase, ...publication } = item;
  return { ...publicationDto(publication), activeMapEligible: liveCase?.verificationStatus === 'CONFIRMED_FIRE' && liveCase.handlingStatus !== 'CLOSED' && publicCaseContextSchema.safeParse(publication.publicCaseSnapshot).data?.handlingStatus !== 'CLOSED' };
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
    const input = publicationSchema.parse(old ? { title: old.title, summary: old.summary, body: old.body, type: old.type, outcome: old.outcome, reportId: old.reportId, sources: old.sources, regionIds: old.regions.map(r => r.regionId), caseId: old.caseId, validUntil: old.validUntil?.toISOString() ?? null, publicLocationMode: old.publicLocationMode, publicLatitude: old.publicLatitude, publicLongitude: old.publicLongitude, privacyReview: old.privacyReview, ...patch } : body);
    if (input.caseId) {
      await tx.$queryRaw`SELECT id FROM "TrCase" WHERE id = ${input.caseId} FOR UPDATE`;
      assertActiveCasePublication(await tx.trCase.findUniqueOrThrow({ where: { id: input.caseId }, select: { handlingStatus: true, verificationStatus: true } }));
    }
    if (input.type === 'WARNING' || old?.type === 'WARNING') throw new AppError('Use the controlled warning workflow', 400, 'WARNING_WORKFLOW_REQUIRED');
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
import { evaluateNearby, notifyNearbyCompletion, lockNearbyWorkflow } from '../notifications/nearby.service.js';

export async function publishInformation(actor: Actor, id: string, body: unknown, client: PrismaClient = db()) {
  const input = publishSchema.parse(body);
  return client.$transaction(async tx => {
    await lockNearbyWorkflow(tx);
    await lockedActor(tx, actor, true, 'canPublishInformation');
    await tx.$queryRaw`SELECT id FROM "TrPublicInformation" WHERE id = ${id} FOR UPDATE`;
    const item = await tx.trPublicInformation.findUniqueOrThrow({ where: { id }, include: { regions: true } });
    if (item.type === 'WARNING') throw new AppError('Use the controlled warning workflow', 400, 'WARNING_WORKFLOW_REQUIRED');
    if (item.status !== 'DRAFT') throw new AppError('Only drafts can be published', 409, 'INVALID_PUBLICATION_STATE');
    assertPublicationRevision(item.updatedAt, input.expectedUpdatedAt);
    if (!Array.isArray(item.sources) || !item.sources.length) throw new AppError('At least one factual source is required', 400, 'SOURCES_REQUIRED');
    if (item.validUntil && item.validUntil <= new Date()) throw new AppError('Validity must end after publication', 400, 'INVALID_VALIDITY');
    await validateRegions(tx, item.regions.map(v => v.regionId));
    if (item.outcome) {
      if (!item.privacyReview?.trim()) throw new AppError('News requires explicit privacy review', 400, 'PRIVACY_REVIEW_REQUIRED');
      if (item.outcome === 'DECLINED') {
        if (!item.reportId || item.publicLocationMode !== 'NONE' || item.caseId) throw new AppError('Declined report publications must not imply a verified incident location', 400, 'INVALID_OUTCOME');
        await tx.$queryRaw`SELECT id FROM "TrReport" WHERE id = ${item.reportId} FOR UPDATE`;
        const report = await tx.trReport.findUniqueOrThrow({ where: { id: item.reportId } });
        if (report.reviewStatus !== 'DECLINED') throw new AppError('Report disposition changed; review the draft again', 409, 'OUTCOME_CHANGED');
      } else if (!item.caseId) throw new AppError('Confirmed outcome requires a case', 400, 'INVALID_OUTCOME');
    }
    let snapshot: Prisma.InputJsonValue | undefined;
    if (item.publicLocationMode === 'APPROVED_INCIDENT_PERIMETER' && (!item.caseId || !item.privacyReview?.trim())) throw new AppError('Public perimeter needs a case and explicit privacy review', 400, 'PRIVACY_REVIEW_REQUIRED');
    if (item.caseId) {
      await tx.$queryRaw`SELECT id FROM "TrCase" WHERE id = ${item.caseId} FOR UPDATE`;
      const c = await tx.trCase.findUniqueOrThrow({ where: { id: item.caseId }, select: { id: true, number: true, verificationStatus: true, handlingStatus: true, version: true, perimeter: true, perimeterObservedAt: true, perimeterSource: true, perimeterRevision: true } });
      assertActiveCasePublication(c);
      if ((item.outcome === 'CONFIRMED' || item.publicLocationMode === 'APPROVED_INCIDENT_PERIMETER') && input.expectedCaseVersion !== c.version) throw new AppError('Case changed since publication review', 409, 'VERSION_CONFLICT');
      if (item.outcome === 'CONFIRMED' && c.verificationStatus !== 'CONFIRMED_FIRE') throw new AppError('Case is no longer confirmed', 409, 'OUTCOME_CHANGED');
      if (item.outcome === 'CONFIRMED' && c.handlingStatus !== 'CLOSED') throw new AppError('Completed News announcements require a closed case', 409, 'OUTCOME_NOT_COMPLETED');
      if (item.publicLocationMode === 'APPROVED_INCIDENT_POINT' && (!item.privacyReview || item.publicLatitude == null || item.publicLongitude == null)) throw new AppError('Public point needs explicit privacy review', 400, 'PRIVACY_REVIEW_REQUIRED');
      let publicPerimeter;
      if (item.publicLocationMode === 'APPROVED_INCIDENT_PERIMETER') {
        const parsed = publicPerimeterSchema.omit({ areaHectares: true }).safeParse({ geometry: c.perimeter, observedAt: c.perimeterObservedAt?.toISOString(), source: c.perimeterSource, revision: c.perimeterRevision });
        if (c.verificationStatus !== 'CONFIRMED_FIRE' || !parsed.success) throw new AppError('A confirmed fire with a valid audited perimeter is required', 409, 'INVALID_PERIMETER');
        publicPerimeter = { ...parsed.data, areaHectares: areaHectares(parsed.data.geometry) };
      }
      snapshot = jsonValue({ id: c.id, number: c.number, title: item.title, verificationStatus: c.verificationStatus, handlingStatus: c.handlingStatus, approvedAt: new Date().toISOString(), ...(publicPerimeter ? { publicPerimeter } : {}) });
    }
    if (item.supersedesId) {
      const old = await tx.trPublicInformation.updateMany({ where: { id: item.supersedesId, status: 'PUBLISHED' }, data: { status: 'SUPERSEDED', updatedAt: new Date() } });
      if (!old.count) throw new AppError('The publication being replaced is no longer current', 409, 'PUBLICATION_CONFLICT');
    }
    const updated = await tx.trPublicInformation.update({ where: { id, status: 'DRAFT', updatedAt: new Date(input.expectedUpdatedAt) }, data: { status: 'PUBLISHED', publisherId: actor.id, authorityReference: input.authorityReference, updatedAt: nextPublicationTimestamp(item.updatedAt), publishedAt: new Date(), publicCaseSnapshot: snapshot }, select: publicationSelect() });
    await audit(tx, actor.id, 'INFORMATION_PUBLISHED', 'PUBLICATION', id, input.authorityReference, { reviewedUpdatedAt: item.updatedAt.toISOString(), authorityBasis: 'APPLICATION_ADMIN_ROLE', authorityNoteSource: 'OPERATOR_SUPPLIED' });
    await evaluateNearby(tx, undefined, id);
    if (item.caseId && item.outcome === 'CONFIRMED') await notifyNearbyCompletion(tx, item.caseId, id, item.summary);
    return publicationDto(updated);
  }, { timeout: 30000 });
}
export async function publishOutcome(actor: Actor, body: unknown, client: PrismaClient = db()) {
  const input = outcomePublicationSchema.parse(body);
  if (!env.BETTER_AUTH_URL) throw new AppError('Canonical application URL is not configured', 503, 'CONFIGURATION_REQUIRED');
  const origin = new URL(env.BETTER_AUTH_URL).origin;
  const slug = `outcome-${input.idempotencyKey}`;
  const signature = fingerprint(input);
  return client.$transaction(async tx => {
    await lockNearbyWorkflow(tx);
    await lockedActor(tx, actor, true, 'canPublishInformation');
    const existing = await tx.trPublicInformation.findUnique({ where: { slug }, select: { ...publicationSelect(), authorId: true, privacyReview: true } });
    if (existing) {
      if (existing.authorId !== actor.id || existing.privacyReview !== signature) throw new AppError('Publication key already used', 409, 'IDEMPOTENCY_CONFLICT');
      const { authorId: _authorId, privacyReview: _privacyReview, ...safe } = existing;
      return publicationDto(safe);
    }
    const reportId = input.reportId;
    await tx.$queryRaw`SELECT id FROM "TrReport" WHERE id = ${reportId} FOR UPDATE`;
    const report = await tx.trReport.findUniqueOrThrow({ where: { id: reportId } });
    if (report.reviewStatus !== 'DECLINED') throw new AppError('Report is no longer declined', 409, 'OUTCOME_CHANGED');
    const now = new Date();
    const publicationData = {
      slug, title: 'Report review: declined', summary: input.message, body: input.message,
      type: 'UPDATE', outcome: 'DECLINED', reportId,
      status: 'PUBLISHED', authorId: actor.id, publisherId: actor.id, publishedAt: now, authorityReference: 'APPLICATION_ADMIN_ROLE',
      sources: [{ title: `System record ${report.number}`, url: `${origin}/api/public/information/${slug}` }],
      privacyReview: signature, publicLocationMode: 'NONE',
    } satisfies Prisma.TrPublicInformationUncheckedCreateInput;
    const item = await tx.trPublicInformation.create({ data: publicationData, select: publicationSelect() });
    await audit(tx, actor.id, 'OUTCOME_PRIVACY_APPROVED_AND_PUBLISHED', 'PUBLICATION', item.id, undefined, { approvedAt: now.toISOString(), explicitApproval: true, publicText: input.message, authorityBasis: 'APPLICATION_ADMIN_ROLE' });
    return publicationDto(item);
  });
}
export async function withdrawInformation(actor: Actor, id: string, body: unknown) {
  const { reason } = withdrawalSchema.parse(body);
  return db().$transaction(async tx => {
    await lockNearbyWorkflow(tx);
    await lockedActor(tx, actor, true, 'canPublishInformation');
    const updated = await tx.trPublicInformation.update({ where: { id, status: 'PUBLISHED', type: { not: 'WARNING' } }, data: { status: 'WITHDRAWN', withdrawalReason: reason }, select: publicationSelect() });
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
    await lockNearbyWorkflow(tx);
    await lockedActor(tx, actor, true, 'canPublishInformation');
    const data = { ...input, verifiedAt: new Date(input.verifiedAt) };
    await tx.msSiteProfile.upsert({ where: { id: 'site' }, create: { id: 'site', ...data }, update: data });
    await audit(tx, actor.id, 'SITE_PROFILE_UPDATED', 'SITE', 'site', input.source);
    return { ...input };
  });
}
