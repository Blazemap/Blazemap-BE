import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { db } from '../../config/index.js';
import { reportDraftSchema, reportPublishSchema, reportQueueQuerySchema, type Actor, type Transaction } from '../../types/index.js';
import { AppError, jsonValue } from '../../utils/index.js';
import { areaHectares, publicPerimeterSchema } from '../../utils/geometry.js';
import { richTextToPlainText } from '../../utils/rich-text.js';
import { evaluateNearby, lockNearbyWorkflow, notifyNearbyCompletion } from '../notifications/nearby.service.js';
import { audit, lockedActor, verifiedRegion } from './access.js';
import { applicationAdminAuthority } from './confirmation.service.js';
import { nextPublicationTimestamp } from './rules.js';
import { publicationDto, publicationSelect } from './information.service.js';

const draftKey = (caseId: string) => `case-report:${caseId}`;
const publishedStatuses = ['PUBLISHED', 'SUPERSEDED', 'WITHDRAWN'] as const;

function reportPublicationSelect(now = new Date()) {
  return {
    ...publicationSelect(now),
    caseId: true,
    privacyReview: true,
    publicLocationMode: true,
  } satisfies Prisma.TrPublicInformationSelect;
}

function reportPublicationDto<T extends Parameters<typeof publicationDto>[0] & { caseId?: string | null; privacyReview?: string | null }>(item: T) {
  const value = publicationDto(item);
  return { ...value, privacyReviewed: !!item.privacyReview?.trim() };
}

const caseQueueSelect = {
  id: true,
  number: true,
  title: true,
  verificationStatus: true,
  handlingStatus: true,
  version: true,
  closedAt: true,
  closureReason: true,
  region: { select: { id: true, name: true, timezone: true } },
  perimeter: true,
  perimeterObservedAt: true,
  perimeterSource: true,
  perimeterRevision: true,
  completionFieldUpdate: { select: { findings: true, description: true, source: true, observedAt: true, createdAt: true, attachments: { select: { filename: true, contentType: true, size: true }, orderBy: { createdAt: 'asc' as const } } } },
  reports: { select: { number: true, observationTypes: true, observedAt: true, description: true }, orderBy: { observedAt: 'desc' as const }, take: 10 },
  publications: { where: { OR: [{ caseDraftKey: { not: null } }, { slug: { startsWith: 'completion-' } }, { outcome: 'CONFIRMED' as const }] }, select: reportPublicationSelect(), orderBy: [{ updatedAt: 'desc' as const }, { id: 'desc' as const }], take: 10 },
} satisfies Prisma.TrCaseSelect;

type QueueCase = Prisma.TrCaseGetPayload<{ select: typeof caseQueueSelect }>;

export function assertNewsDraftCase(item: Pick<QueueCase, 'verificationStatus' | 'handlingStatus'>) {
  if (item.verificationStatus !== 'CONFIRMED_FIRE') throw new AppError('Only confirmed cases can prepare News', 409, 'CASE_NOT_CONFIRMED');
}

function queueCaseDto(item: QueueCase) {
  const parsedPerimeter = publicPerimeterSchema.omit({ areaHectares: true }).safeParse({ geometry: item.perimeter, observedAt: item.perimeterObservedAt?.toISOString(), source: item.perimeterSource, revision: item.perimeterRevision });
  const publication = item.publications.find(value => value.status === 'DRAFT') ?? item.publications.find(value => value.status === 'PUBLISHED') ?? item.publications[0];
  return {
    id: item.id,
    number: item.number,
    title: item.title,
    verificationStatus: item.verificationStatus,
    handlingStatus: item.handlingStatus,
    version: item.version,
    closedAt: item.closedAt,
    closureReason: item.closureReason,
    region: item.region,
    perimeter: parsedPerimeter.success ? { ...parsedPerimeter.data, areaHectares: areaHectares(parsedPerimeter.data.geometry) } : null,
    completionEvidence: item.completionFieldUpdate,
    reports: item.reports,
    publication: publication ? reportPublicationDto(publication) : null,
  };
}

export async function listCompletionReports(query: unknown, client: PrismaClient = db()) {
  const { page, pageSize, search, status } = reportQueueQuerySchema.parse(query);
  const publicationFilter: Prisma.TrPublicInformationWhereInput = { OR: [{ caseDraftKey: { not: null } }, { slug: { startsWith: 'completion-' } }, { outcome: 'CONFIRMED' }] };
  const where: Prisma.TrCaseWhereInput = {
    verificationStatus: 'CONFIRMED_FIRE',
    ...(search ? { OR: [{ title: { contains: search, mode: 'insensitive' } }, { number: { contains: search } }] } : {}),
    ...(status === 'QUEUE' ? { publications: { none: { ...publicationFilter, status: { in: [...publishedStatuses, 'DRAFT'] } } } } : status === 'DRAFT' ? { publications: { some: { ...publicationFilter, status: 'DRAFT' } } } : { publications: { some: { ...publicationFilter, status: 'PUBLISHED' } } }),
  };
  const [rows, total] = await client.$transaction([
    client.trCase.findMany({ where, select: caseQueueSelect, orderBy: [{ closedAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }),
    client.trCase.count({ where }),
  ]);
  return { data: rows.map(queueCaseDto), meta: { total, page, pageSize } };
}

export async function getCompletionReport(caseId: string, client: PrismaClient = db()) {
  const item = await client.trCase.findFirst({ where: { id: caseId, verificationStatus: 'CONFIRMED_FIRE' }, select: caseQueueSelect });
  if (!item) throw new AppError('Confirmed case not found', 404, 'NOT_FOUND');
  return queueCaseDto(item);
}

async function validateRegions(tx: Transaction, ids: string[]) {
  for (const id of ids) await verifiedRegion(tx, id);
}

export async function saveCompletionReport(actor: Actor, body: unknown, client: PrismaClient = db()) {
  const input = reportDraftSchema.parse(body);
  const plainBody = richTextToPlainText(input.bodyRich);
  if (plainBody.length < 5) throw new AppError('Report body must contain at least five characters', 400, 'INVALID_BODY');
  return client.$transaction(async tx => {
    await lockedActor(tx, actor, true, 'canPublishInformation');
    await tx.$queryRaw`SELECT id FROM "TrCase" WHERE id = ${input.caseId} FOR UPDATE`;
    const incident = await tx.trCase.findUniqueOrThrow({ where: { id: input.caseId }, select: { id: true, number: true, verificationStatus: true, handlingStatus: true, version: true } });
    assertNewsDraftCase(incident);
    if (incident.version !== input.expectedCaseVersion) throw new AppError('Case changed; reload before saving the report', 409, 'VERSION_CONFLICT');
    await validateRegions(tx, input.regionIds);
    const existing = await tx.trPublicInformation.findFirst({ where: { caseId: input.caseId, status: 'DRAFT', OR: [{ caseDraftKey: draftKey(input.caseId) }, { slug: { startsWith: 'completion-' } }] }, include: { regions: true }, orderBy: { createdAt: 'desc' } });
    const published = await tx.trPublicInformation.findFirst({ where: { caseId: input.caseId, status: 'PUBLISHED', OR: [{ caseDraftKey: { not: null } }, { slug: { startsWith: 'completion-' } }, { outcome: 'CONFIRMED' }] }, select: { id: true, updatedAt: true }, orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }] });
    if (existing && (!input.expectedUpdatedAt || existing.updatedAt.getTime() !== Date.parse(input.expectedUpdatedAt))) throw new AppError('Draft changed; reload before saving', 409, 'PUBLICATION_CONFLICT');
    if (!existing && published && (!input.expectedUpdatedAt || published.updatedAt.getTime() !== Date.parse(input.expectedUpdatedAt))) throw new AppError('Published News changed; reload before creating an update', 409, 'PUBLICATION_CONFLICT');
    if (!existing && !published && input.expectedUpdatedAt) throw new AppError('News state changed; reload before saving', 409, 'PUBLICATION_CONFLICT');
    const validUntil = input.validUntil ? new Date(input.validUntil) : null;
    if (validUntil && validUntil <= new Date()) throw new AppError('Expiry must be in the future', 400, 'INVALID_VALIDITY');
    const data = {
      title: input.title,
      summary: input.summary,
      body: plainBody,
      bodyRich: jsonValue(input.bodyRich),
      type: 'UPDATE' as const,
      outcome: null,
      caseId: input.caseId,
      sources: jsonValue(input.sources),
      validUntil,
      publicLocationMode: input.publicLocationMode,
      privacyReview: input.privacyReview,
      publicLatitude: null,
      publicLongitude: null,
    };
    let item;
    if (existing) {
      await tx.trPublicInformationRegion.deleteMany({ where: { publicInformationId: existing.id } });
      item = await tx.trPublicInformation.update({ where: { id: existing.id, status: 'DRAFT', updatedAt: existing.updatedAt }, data: { ...data, updatedAt: nextPublicationTimestamp(existing.updatedAt), regions: { create: input.regionIds.map(regionId => ({ regionId })) } }, select: reportPublicationSelect() });
    } else {
      item = await tx.trPublicInformation.create({ data: { ...data, slug: `completion-${incident.number.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID()}`, status: 'DRAFT', authorId: actor.id, caseDraftKey: published ? null : draftKey(input.caseId), supersedesId: published?.id, regions: { create: input.regionIds.map(regionId => ({ regionId })) } }, select: reportPublicationSelect() });
    }
    await audit(tx, actor.id, 'CASE_REPORT_DRAFT_SAVED', 'PUBLICATION', item.id, undefined, { caseId: input.caseId, caseVersion: incident.version });
    return reportPublicationDto(item);
  });
}

export async function publishCompletionReport(actor: Actor, id: string, body: unknown, client: PrismaClient = db()) {
  const input = reportPublishSchema.parse(body);
  return client.$transaction(async tx => {
    await lockNearbyWorkflow(tx);
    await lockedActor(tx, actor, true, 'canPublishInformation');
    await tx.$queryRaw`SELECT id FROM "TrPublicInformation" WHERE id = ${id} FOR UPDATE`;
    const item = await tx.trPublicInformation.findUniqueOrThrow({ where: { id }, include: { regions: true } });
    const completionPublication = !!item.caseId && (item.caseDraftKey === draftKey(item.caseId) || item.slug.startsWith('completion-'));
    if (item.status === 'PUBLISHED' && completionPublication) return reportPublicationDto(await tx.trPublicInformation.findUniqueOrThrow({ where: { id }, select: reportPublicationSelect() }));
    if (item.status !== 'DRAFT' || !completionPublication) throw new AppError('Only a case report draft can be published', 409, 'INVALID_PUBLICATION_STATE');
    if (item.updatedAt.getTime() !== Date.parse(input.expectedUpdatedAt)) throw new AppError('Draft changed; reload and review before publishing', 409, 'PUBLICATION_CONFLICT');
    if (!item.bodyRich) throw new AppError('A validated rich-text body is required', 400, 'INVALID_BODY');
    if (!Array.isArray(item.sources) || !item.sources.length) throw new AppError('Add at least one factual HTTPS source before publishing', 400, 'SOURCES_REQUIRED');
    if (!item.privacyReview?.trim()) throw new AppError('Confirm the privacy review before publishing', 400, 'PRIVACY_REVIEW_REQUIRED');
    await validateRegions(tx, item.regions.map(region => region.regionId));
    const caseId = item.caseId;
    if (!caseId) throw new AppError('A linked closed case is required', 409, 'CASE_NOT_CLOSED');
    await tx.$queryRaw`SELECT id FROM "TrCase" WHERE id = ${caseId} FOR UPDATE`;
    const incident = await tx.trCase.findUniqueOrThrow({ where: { id: caseId }, select: { id: true, number: true, version: true, handlingStatus: true, verificationStatus: true, perimeter: true, perimeterObservedAt: true, perimeterSource: true, perimeterRevision: true } });
    if (incident.version !== input.expectedCaseVersion) throw new AppError('Case changed; reload and review before publishing', 409, 'VERSION_CONFLICT');
    if (incident.handlingStatus !== 'CLOSED') throw new AppError('Only a closed case can be published as a completion report', 409, 'CASE_NOT_CLOSED');
    let perimeter;
    if (item.publicLocationMode === 'APPROVED_INCIDENT_PERIMETER') {
      const parsed = publicPerimeterSchema.omit({ areaHectares: true }).safeParse({ geometry: incident.perimeter, observedAt: incident.perimeterObservedAt?.toISOString(), source: incident.perimeterSource, revision: incident.perimeterRevision });
      if (incident.verificationStatus !== 'CONFIRMED_FIRE' || !parsed.success) throw new AppError('A confirmed case with a valid reviewed perimeter is required', 409, 'INVALID_PERIMETER');
      perimeter = { ...parsed.data, areaHectares: areaHectares(parsed.data.geometry) };
    }
    const snapshot = jsonValue({ id: incident.id, number: incident.number, title: item.title, verificationStatus: incident.verificationStatus, handlingStatus: incident.handlingStatus, approvedAt: new Date().toISOString(), ...(perimeter ? { publicPerimeter: perimeter } : {}) });
    if (item.supersedesId) {
      const old = await tx.trPublicInformation.updateMany({ where: { id: item.supersedesId, status: 'PUBLISHED' }, data: { status: 'SUPERSEDED', updatedAt: new Date() } });
      if (!old.count) throw new AppError('The News being updated is no longer current', 409, 'PUBLICATION_CONFLICT');
    }
    const publishedAt = new Date();
    if (item.validUntil && item.validUntil <= publishedAt) throw new AppError('Expiry must be in the future', 400, 'INVALID_VALIDITY');
    const updated = await tx.trPublicInformation.update({ where: { id, status: 'DRAFT', updatedAt: item.updatedAt }, data: { status: 'PUBLISHED', outcome: incident.verificationStatus === 'CONFIRMED_FIRE' ? 'CONFIRMED' : null, publisherId: actor.id, authorityReference: applicationAdminAuthority, publishedAt, updatedAt: nextPublicationTimestamp(item.updatedAt), publicCaseSnapshot: snapshot }, select: reportPublicationSelect() });
    await audit(tx, actor.id, item.supersedesId ? 'CASE_REPORT_UPDATED' : 'CASE_REPORT_PUBLISHED', 'PUBLICATION', id, undefined, { caseId: incident.id, caseVersion: incident.version, reviewedUpdatedAt: item.updatedAt.toISOString(), supersedesId: item.supersedesId, authorityBasis: applicationAdminAuthority });
    await evaluateNearby(tx, undefined, id);
    if (incident.verificationStatus === 'CONFIRMED_FIRE') await notifyNearbyCompletion(tx, incident.id, id, item.summary);
    return reportPublicationDto(updated);
  }, { timeout: 30000 });
}
