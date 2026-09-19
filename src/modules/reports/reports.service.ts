import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Prisma, PrismaClient, TrReport } from '../../generated/prisma/client.js';
import { db } from '../../config/index.js';
import { reportSchema, paginationSchema, progressSchema, updateSchema, reviewStatuses, type Actor } from '../../types/index.js';
import { AppError, fingerprint } from '../../utils/index.js';
import { audit, lockedActor, verifiedRegion, bumpContext } from '../admin/access.js';
import { attach } from '../uploads/uploads.service.js';
import { triageReports } from './triage.js';
import { createReportNotification } from '../notifications/index.js';
import { loadWindContext } from '../integrations/wind.js';
export { triageReports } from './triage.js';

export const reportInclude = {
  case: { select: { id: true, number: true, verificationStatus: true, handlingStatus: true, version: true } },
  region: { select: { id: true, name: true, timezone: true } },
  attachments: { select: { id: true, filename: true, contentType: true, size: true, createdAt: true }, where: { state: 'ATTACHED' as const, revokedAt: null } },
} satisfies Prisma.TrReportInclude;
export const progressSelect = { id: true, stage: true, description: true, createdAt: true, attachments: { where: { state: 'ATTACHED', revokedAt: null }, select: { id: true, filename: true, contentType: true, size: true } } } as const;
export function reportDto(r: TrReport & { case?: unknown; region?: unknown; reporter?: unknown; attachments?: unknown; updates?: unknown; progress?: { id: string; stage: string; description: string; createdAt: Date; attachments?: unknown }[] }) {
  return { id: r.id, number: r.number, observationTypes: r.observationTypes, observedAt: r.observedAt, createdAt: r.createdAt, locationMode: r.locationMode, latitude: r.latitude, longitude: r.longitude, accuracyMeters: r.accuracyMeters, regionId: r.regionId, region: r.region, reporter: r.reporter, locationDescription: r.locationDescription, description: r.description, reviewStatus: r.reviewStatus, case: r.case, attachments: r.attachments, ...(r.updates ? { updates: r.updates } : {}), ...(r.progress ? { progress: r.progress.map(({ id, stage, description, createdAt, attachments }) => ({ id, stage, description, createdAt, attachments: attachments ?? [], actorDisplay: 'Government reviewer' })) } : {}) };
}
export async function listReports(actor: Actor, query: unknown, admin = false, client: PrismaClient = db()) {
  const { page, pageSize, search, reviewStatus, regionId, workflowStatus } = paginationSchema.extend({ reviewStatus: z.enum(reviewStatuses).optional(), workflowStatus: z.enum(['REVIEWED', 'IN_PROGRESS', 'CONFIRMED', 'DECLINED']).optional() }).parse(query);
  if (admin && actor.role !== 'ADMIN') throw new AppError('Administrator access required', 403, 'FORBIDDEN');
  const workflow: Prisma.TrReportWhereInput = workflowStatus === 'DECLINED' ? { reviewStatus: 'DECLINED' } : workflowStatus === 'CONFIRMED' ? { reviewStatus: { not: 'DECLINED' }, case: { verificationStatus: 'CONFIRMED_FIRE' } } : workflowStatus ? { reviewStatus: workflowStatus === 'REVIEWED' ? 'REVIEWED' : { in: ['UNDER_REVIEW', 'NEEDS_DETAILS'] }, OR: [{ caseId: null }, { case: { verificationStatus: { not: 'CONFIRMED_FIRE' } } }] } : {};
  const where: Prisma.TrReportWhereInput = { ...(admin ? {} : { reporterId: actor.id }), reviewStatus, regionId, AND: [workflow], ...(search ? { OR: [{ number: { contains: search } }, { description: { contains: search, mode: 'insensitive' as const } }] } : {}) };
  const [rows, total] = await client.$transaction([client.trReport.findMany({ where, include: reportInclude, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }), client.trReport.count({ where })]);
  const triage = admin ? await triageReports(rows, client) : null;
  return { data: rows.map(row => ({ ...reportDto(row), ...(triage ? { triage: triage.get(row.id)! } : {}) })), meta: { total, page, pageSize } };
}
export async function getReport(actor: Actor, id: string, admin = false, client: PrismaClient = db()) {
  if (admin && actor.role !== 'ADMIN') throw new AppError('Administrator access required', 403, 'FORBIDDEN');
  const report = await client.trReport.findFirst({ where: { id, ...(admin ? {} : { reporterId: actor.id }) }, include: { ...reportInclude, ...(admin ? { reporter: { select: { id: true, name: true, email: true } } } : {}), progress: { select: progressSelect, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }, updates: { where: admin ? {} : { publicToReporter: true }, orderBy: { createdAt: 'asc' }, select: { id: true, message: true, kind: true, authorRole: true, createdAt: true } } } });
  if (!report) throw new AppError('Report not found', 404, 'NOT_FOUND');
  const triage = admin ? await triageReports([report], client) : null;
  let windContext = null;
  if (report.caseId) {
    const incident = await client.trCase.findUnique({ where: { id: report.caseId }, select: { region: { select: { id: true, name: true, level: true, bmkgAdm4: true, verifiedAt: true } } } });
    windContext = (await loadWindContext(client, incident?.region ?? null)).windContext;
  }
  return { ...reportDto(report), windContext, ...(triage ? { triage: triage.get(report.id)! } : {}) };
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
    const update = await tx.trReportUpdate.create({ data: { reportId: id, authorId: actor.id, authorRole: user.role, kind: input.kind ?? 'CLARIFICATION', message: input.message }, select: { id: true, message: true, kind: true, authorRole: true, createdAt: true } });
    if (input.kind === 'REQUEST') {
      await tx.trReport.update({ where: { id }, data: { reviewStatus: 'NEEDS_DETAILS' } });
      if (report.reviewStatus !== 'NEEDS_DETAILS') await createReportNotification(tx, { eventKey: `update:${update.id}`, reportId: id, userId: report.reporterId, type: 'REPORT_STATUS', stage: 'NEEDS_DETAILS', message: input.message });
    }
    if (report.caseId) await bumpContext(tx, report.caseId);
    await audit(tx, actor.id, 'REPORT_UPDATE_ADDED', 'REPORT', id);
    return update;
  });
}
