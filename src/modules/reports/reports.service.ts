import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Prisma, PrismaClient, TrReport } from '../../generated/prisma/client.js';
import { db } from '../../config/index.js';
import { reportSchema, paginationSchema, progressSchema, updateSchema, reviewStatuses, type Actor } from '../../types/index.js';
import { AppError, fingerprint } from '../../utils/index.js';
import { audit, lockedActor, verifiedRegion, bumpContext } from '../admin/access.js';
import { attach } from '../uploads/uploads.service.js';
import { triageReports } from './triage.js';
import { createAdminNotifications, createReportNotification } from '../notifications/index.js';
import { polygonSchema, areaHectares } from '../../utils/geometry.js';
import { loadWindContext } from '../integrations/wind.js';
export { triageReports } from './triage.js';

export const reportInclude = {
  case: { select: { id: true, number: true, title: true, verificationStatus: true, handlingStatus: true, version: true, priority: true, priorityReason: true, _count: { select: { reports: true } } } },
  region: { select: { id: true, name: true, timezone: true } },
  attachments: { select: { id: true, filename: true, contentType: true, size: true, createdAt: true }, where: { state: 'ATTACHED' as const, revokedAt: null } },
} satisfies Prisma.TrReportInclude;
export const ownerReportInclude = { ...reportInclude, case: { select: { ...reportInclude.case.select, perimeter: true, perimeterObservedAt: true, perimeterRevision: true } } } satisfies Prisma.TrReportInclude;
export const reportCardInclude = {
  case: ownerReportInclude.case,
  region: reportInclude.region,
  attachments: { select: { id: true, filename: true }, where: { state: 'ATTACHED' as const, revokedAt: null }, orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }], take: 1 },
} satisfies Prisma.TrReportInclude;
type OwnerReportSource = TrReport & { case?: { number: string; title: string; verificationStatus: string; handlingStatus: string; perimeter: Prisma.JsonValue | null; perimeterObservedAt: Date | null; perimeterRevision: number } | null; region?: unknown; reporter?: unknown; attachments?: unknown; updates?: unknown; progress?: { id: string; stage: string; description: string; createdAt: Date; attachments?: unknown }[] };
export function ownerReportDto(r: OwnerReportSource) {
  const perimeter = polygonSchema.safeParse(r.case?.perimeter);
  const linked = r.case;
  return { ...reportDto(r), case: linked ? { number: linked.number, title: linked.title, verificationStatus: linked.verificationStatus, handlingStatus: linked.handlingStatus, perimeter: linked.verificationStatus === 'CONFIRMED_FIRE' && perimeter.success && linked.perimeterObservedAt ? { geometry: perimeter.data, observedAt: linked.perimeterObservedAt, source: 'Government-reviewed mapped area', areaHectares: areaHectares(perimeter.data), revision: linked.perimeterRevision } : null } : null };
}
export function reportCardDto(r: Prisma.TrReportGetPayload<{ include: typeof reportCardInclude }>, admin = false) {
  const item = admin
    ? reportDto({ ...r, case: r.case ? { id: r.case.id, number: r.case.number, title: r.case.title, verificationStatus: r.case.verificationStatus, handlingStatus: r.case.handlingStatus, version: r.case.version, priority: r.case.priority, priorityReason: r.case.priorityReason, reportCount: r.case._count.reports } : null })
    : ownerReportDto(r);
  const { attachments: _attachments, ...safe } = item;
  return { ...safe, attachments: [], coverAttachment: r.attachments[0] ?? null };
}
export const progressSelect = { id: true, stage: true, description: true, createdAt: true, attachments: { where: { state: 'ATTACHED', revokedAt: null }, select: { id: true, filename: true, contentType: true, size: true } } } as const;
export function reportDto(r: TrReport & { case?: unknown; region?: unknown; reporter?: unknown; attachments?: unknown; updates?: unknown; progress?: { id: string; stage: string; description: string; createdAt: Date; attachments?: unknown }[] }) {
  return { id: r.id, number: r.number, observationTypes: r.observationTypes, observedAt: r.observedAt, createdAt: r.createdAt, locationMode: r.locationMode, latitude: r.latitude, longitude: r.longitude, accuracyMeters: r.accuracyMeters, regionId: r.regionId, region: r.region, reporter: r.reporter, locationDescription: r.locationDescription, description: r.description, reviewStatus: r.reviewStatus, case: r.case, attachments: r.attachments, ...(r.updates ? { updates: r.updates } : {}), ...(r.progress ? { progress: r.progress.map(({ id, stage, description, createdAt, attachments }) => ({ id, stage, description, createdAt, attachments: attachments ?? [], actorDisplay: 'Government reviewer' })) } : {}) };
}
export async function listReports(actor: Actor, query: unknown, admin = false, client: PrismaClient = db()) {
  return client.$transaction(tx => listReportsSnapshot(actor, query, admin, tx), { isolationLevel: 'RepeatableRead', maxWait: 10000, timeout: 30000 });
}
async function listReportsSnapshot(actor: Actor, query: unknown, admin: boolean, client: Prisma.TransactionClient) {
  const { page, pageSize, search, reviewStatus, regionId, workflowStatus } = paginationSchema.extend({ reviewStatus: z.enum(reviewStatuses).optional(), workflowStatus: z.enum(['REVIEWED', 'IN_PROGRESS', 'CONFIRMED', 'DECLINED']).optional() }).parse(query);
  if (admin && actor.role !== 'ADMIN') throw new AppError('Administrator access required', 403, 'FORBIDDEN');
  const workflow: Prisma.TrReportWhereInput = workflowStatus === 'DECLINED' ? { reviewStatus: 'DECLINED' } : workflowStatus === 'CONFIRMED' ? { reviewStatus: { not: 'DECLINED' }, case: { verificationStatus: 'CONFIRMED_FIRE' } } : workflowStatus ? { reviewStatus: workflowStatus === 'REVIEWED' ? 'REVIEWED' : { in: ['UNDER_REVIEW', 'NEEDS_DETAILS'] }, OR: [{ caseId: null }, { case: { verificationStatus: { not: 'CONFIRMED_FIRE' } } }] } : {};
  const where: Prisma.TrReportWhereInput = { ...(admin ? {} : { reporterId: actor.id }), reviewStatus, regionId, AND: [workflow], ...(search ? { OR: [{ number: { contains: search } }, { description: { contains: search, mode: 'insensitive' as const } }] } : {}) };
  let rankedIds: string[] | undefined;
  let triage: Awaited<ReturnType<typeof triageReports>> | null = null;
  if (admin) {
    const candidates = await client.trReport.findMany({ where, select: { id: true, number: true, description: true, locationDescription: true, idempotencyKey: true, locationMode: true, latitude: true, longitude: true, observedAt: true, createdAt: true, case: { select: { priority: true } } }, orderBy: { id: 'asc' }, take: 10001 });
    if (candidates.length > 10000) throw new AppError('Priority evaluation exceeds 10000 reports. Narrow the filters; no partial priority queue is returned.', 422, 'PRIORITY_SCOPE_TOO_LARGE');
    triage = await triageReports(candidates, client);
    const rank: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, UNASSESSED: 4, UNKNOWN: 4 };
    const level = (report: typeof candidates[number]) => report.case && report.case.priority !== 'UNASSESSED' ? report.case.priority : triage!.get(report.id)!.level;
    const ids = candidates.map(report => report.id);
    const ranks = candidates.map(report => rank[level(report)]!);
    const dates = candidates.map(report => report.createdAt.toISOString());
    const ordered = await client.$queryRaw<{ id: string }[]>`SELECT id FROM unnest(${ids}::text[], ${ranks}::int[], ${dates}::timestamptz[]) AS ranking(id, priority, created) ORDER BY priority ASC, created DESC, id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
    rankedIds = ordered.map(report => report.id);
  }
  const [rows, total] = await Promise.all([client.trReport.findMany({ where: rankedIds ? { ...where, id: { in: rankedIds } } : where, include: reportCardInclude, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], ...(rankedIds ? {} : { skip: (page - 1) * pageSize, take: pageSize }) }), client.trReport.count({ where })]);
  if (rankedIds) {
    const positions = new Map(rankedIds.map((id, index) => [id, index]));
    rows.sort((a, b) => positions.get(a.id)! - positions.get(b.id)!);
  }
  return { data: rows.map(row => ({ ...reportCardDto(row, admin), ...(triage ? { triage: triage.get(row.id)! } : {}) })), meta: { total, page, pageSize } };
}
export async function getReport(actor: Actor, id: string, admin = false, client: PrismaClient = db()) {
  if (admin && actor.role !== 'ADMIN') throw new AppError('Administrator access required', 403, 'FORBIDDEN');
  const report = await client.trReport.findFirst({ where: { id, ...(admin ? {} : { reporterId: actor.id }) }, include: { ...ownerReportInclude, ...(admin ? { reporter: { select: { id: true, name: true, email: true } } } : {}), progress: { select: progressSelect, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }, updates: { where: admin ? {} : { publicToReporter: true }, orderBy: { createdAt: 'asc' }, select: { id: true, message: true, kind: true, authorRole: true, createdAt: true, attachments: { where: { state: 'ATTACHED', revokedAt: null }, select: { id: true, filename: true, contentType: true, size: true } } } } } });
  if (!report) throw new AppError('Report not found', 404, 'NOT_FOUND');
  const triage = admin ? await triageReports([report], client) : null;
  let windContext = null;
  if (report.caseId) {
    const incident = await client.trCase.findUnique({ where: { id: report.caseId }, select: { latitude: true, longitude: true } });
    windContext = (await loadWindContext(client, incident, new Date())).windContext;
  }
  return { ...(admin ? reportDto({ ...report, case: report.case ? { id: report.case.id, number: report.case.number, title: report.case.title, verificationStatus: report.case.verificationStatus, handlingStatus: report.case.handlingStatus, version: report.case.version, priority: report.case.priority, priorityReason: report.case.priorityReason, reportCount: report.case._count.reports } : null }) : ownerReportDto(report)), windContext, ...(triage ? { triage: triage.get(report.id)! } : {}) };
}
export async function createReport(actor: Actor, body: unknown) {
  const data = reportSchema.parse(body);
  const hash = fingerprint({ ...data, observationTypes: [...data.observationTypes].sort(), attachmentIds: [...data.attachmentIds].sort() });
  return db().$transaction(async tx => {
    await lockedActor(tx, actor);
    const existing = await tx.trReport.findUnique({ where: { reporterId_idempotencyKey: { reporterId: actor.id, idempotencyKey: data.idempotencyKey } }, include: reportInclude });
    if (existing) {
      if (existing.payloadHash !== hash) throw new AppError('Submission key was already used for different content', 409, 'IDEMPOTENCY_CONFLICT');
      return reportDto(existing);
    }
    await verifiedRegion(tx, data.regionId);
    const { attachmentIds, ...fields } = data;
    const report = await tx.trReport.create({ data: { ...fields, observedAt: new Date(data.observedAt), reporterId: actor.id, payloadHash: hash, number: `R-${randomUUID()}` } });
    await attach(tx, actor, attachmentIds, { reportId: report.id });
    await audit(tx, actor.id, 'REPORT_CREATED', 'REPORT', report.id);
    await createAdminNotifications(tx, { eventKey: `report-created:${report.id}`, reportId: report.id, type: 'ADMIN_NEW_REPORT', title: 'New citizen report', message: `${report.number} requires review.` });
    return reportDto(await tx.trReport.findUniqueOrThrow({ where: { id: report.id }, include: reportInclude }));
  });
}
export async function addReportProgress(actor: Actor, id: string, body: unknown, client: PrismaClient = db()) {
  const input = progressSchema.parse(body);
  const hash = fingerprint({ reportId: id, ...input, attachmentIds: [...input.attachmentIds].sort() });
  return client.$transaction(async tx => {
    await lockedActor(tx, actor, true);
    await tx.$queryRaw`SELECT id FROM "TrReport" WHERE id = ${id} FOR UPDATE`;
    const report = await tx.trReport.findUniqueOrThrow({ where: { id } });
    const existing = await tx.trReportProgress.findUnique({ where: { actorId_idempotencyKey: { actorId: actor.id, idempotencyKey: input.idempotencyKey } }, select: { ...progressSelect, payloadHash: true, reportId: true } });
    if (existing) {
      if (existing.payloadHash !== hash || existing.reportId !== id) throw new AppError('Progress key already used for different content', 409, 'IDEMPOTENCY_CONFLICT');
      const { payloadHash: _hash, reportId: _reportId, ...safe } = existing;
      return safe;
    }
    const progress = await tx.trReportProgress.create({ data: { reportId: id, actorId: actor.id, stage: report.reviewStatus, description: input.description, idempotencyKey: input.idempotencyKey, payloadHash: hash } });
    await attach(tx, actor, input.attachmentIds, { reportProgressId: progress.id });
    await createReportNotification(tx, { eventKey: `progress:${progress.id}`, reportId: id, userId: report.reporterId, type: 'REPORT_PROGRESS', stage: report.reviewStatus, message: input.description });
    await audit(tx, actor.id, 'REPORT_PROGRESS_ADDED', 'REPORT', id, undefined, { progressId: progress.id });
    return tx.trReportProgress.findUniqueOrThrow({ where: { id: progress.id }, select: progressSelect });
  });
}
export async function addReportUpdate(actor: Actor, id: string, body: unknown, client: PrismaClient = db()) {
  const input = updateSchema.parse(body);
  return client.$transaction(async tx => {
    const user = await lockedActor(tx, actor);
    await tx.$queryRaw`SELECT id FROM "TrReport" WHERE id = ${id} FOR UPDATE`;
    const report = await tx.trReport.findFirst({ where: { id, ...(user.role === 'ADMIN' ? {} : { reporterId: user.id }) } });
    if (!report) throw new AppError('Report not found', 404, 'NOT_FOUND');
    if (input.kind === 'REQUEST' && user.role !== 'ADMIN') throw new AppError('Only administrators may request details', 403, 'FORBIDDEN');
    const { attachmentIds, ...updateInput } = input;
    const update = await tx.trReportUpdate.create({ data: { reportId: id, authorId: actor.id, authorRole: user.role, kind: updateInput.kind ?? 'CLARIFICATION', message: updateInput.message }, select: { id: true, message: true, kind: true, authorRole: true, createdAt: true } });
    await attach(tx, actor, attachmentIds, { reportUpdateId: update.id });
    if (input.kind === 'REQUEST') {
      await tx.trReport.update({ where: { id }, data: { reviewStatus: 'NEEDS_DETAILS' } });
      if (report.reviewStatus !== 'NEEDS_DETAILS') await createReportNotification(tx, { eventKey: `update:${update.id}`, reportId: id, userId: report.reporterId, type: 'REPORT_STATUS', stage: 'NEEDS_DETAILS', message: input.message });
    }
    if (user.role === 'USER') await createAdminNotifications(tx, { eventKey: `report-update:${update.id}`, reportId: id, type: 'ADMIN_REPORT_FEEDBACK', title: 'New report follow-up', message: `${report.number} received new information${attachmentIds.length ? ` with ${attachmentIds.length} photo${attachmentIds.length === 1 ? '' : 's'}` : ''}.` });
    if (report.caseId) await bumpContext(tx, report.caseId);
    await audit(tx, actor.id, 'REPORT_UPDATE_ADDED', 'REPORT', id);
    return update;
  });
}
