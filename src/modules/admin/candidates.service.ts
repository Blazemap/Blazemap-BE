import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { caseFromReportsSchema, reasonSchema } from '../../types/index.js';
import { audit, lockedActor, verifiedRegion } from './access.js';
import { db } from '../../config/index.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { Actor } from '../../types/index.js';
import { AppError } from '../../utils/index.js';
import { authorize } from './rules.js';
import { recordCaseProgress } from '../reports/progress.js';

export async function createReportCase(actor: Actor, id: string, body: unknown, client: PrismaClient = db()) {
  const { reason } = z.strictObject({ reason: reasonSchema }).parse(body);
  return client.$transaction(async tx => {
    await lockedActor(tx, actor, true);
    await tx.$queryRaw`SELECT id FROM "TrReport" WHERE id = ${id} FOR UPDATE`;
    const report = await tx.trReport.findUniqueOrThrow({ where: { id } });
    const select = { id: true, number: true } as const;
    if (report.caseId) return tx.trCase.findUniqueOrThrow({ where: { id: report.caseId }, select });
    await verifiedRegion(tx, report.regionId);
    const incident = report.locationMode === 'INCIDENT_ESTIMATE';
    const created = await tx.trCase.create({ data: { number: `C-${randomUUID()}`, title: `Reported observation ${report.number}`, regionId: report.regionId, latitude: incident ? report.latitude : null, longitude: incident ? report.longitude : null }, select });
    await tx.trReport.update({ where: { id }, data: { caseId: created.id } });
    await recordCaseProgress(tx, created.id, actor.id, 'OPEN', reason);
    await audit(tx, actor.id, 'CASE_CREATED', 'CASE', created.id, reason, { reportIds: [id] });
    await audit(tx, actor.id, 'REPORT_LINKED', 'REPORT', id, reason, { caseId: created.id });
    return created;
  });
}

export async function createCaseFromReports(actor: Actor, body: unknown, client: PrismaClient = db()) {
  const input = caseFromReportsSchema.parse(body);
  const reportIds = [...input.reportIds].sort();
  return client.$transaction(async tx => {
    await lockedActor(tx, actor, true);
    await tx.$queryRaw`SELECT id FROM "TrReport" WHERE id = ANY(${reportIds}::text[]) ORDER BY id FOR UPDATE`;
    const reports = await tx.trReport.findMany({ where: { id: { in: reportIds } }, orderBy: { id: 'asc' } });
    if (reports.length !== reportIds.length) throw new AppError('One or more selected reports no longer exist', 404, 'REPORT_NOT_FOUND');
    if (reports.some(report => report.caseId)) throw new AppError('A selected report is already linked to a case', 409, 'REPORT_ALREADY_LINKED');
    const regionIds = [...new Set(reports.map(report => report.regionId).filter((id): id is string => !!id))];
    if (regionIds.length > 1) throw new AppError('Selected reports must use the same verified region', 409, 'REPORT_REGION_CONFLICT');
    await verifiedRegion(tx, regionIds[0] ?? null);
    const points = reports.filter(report => report.locationMode === 'INCIDENT_ESTIMATE' && report.latitude !== null && report.longitude !== null);
    const latitude = points.length ? points.reduce((total, report) => total + report.latitude!, 0) / points.length : null;
    const longitude = points.length ? points.reduce((total, report) => total + report.longitude!, 0) / points.length : null;
    const created = await tx.trCase.create({ data: { number: `C-${randomUUID()}`, title: input.title ?? `Grouped reports ${reports.map(report => report.number).join(', ')}`, regionId: regionIds[0] ?? null, latitude, longitude }, select: { id: true, number: true, title: true } });
    await tx.trReport.updateMany({ where: { id: { in: reportIds }, caseId: null }, data: { caseId: created.id } });
    await recordCaseProgress(tx, created.id, actor.id, 'OPEN', input.reason);
    await audit(tx, actor.id, 'CASE_CREATED', 'CASE', created.id, input.reason, { reportIds });
    for (const reportId of reportIds) await audit(tx, actor.id, 'REPORT_LINKED', 'REPORT', reportId, input.reason, { caseId: created.id });
    return { ...created, reportIds };
  });
}

export const candidateQuerySchema = z.strictObject({ maxDistanceMeters: z.coerce.number().int().min(1).max(100000), hours: z.coerce.number().positive().max(168) });
export function haversineMeters(latitude: number, longitude: number, otherLatitude: number, otherLongitude: number) {
  const radians = Math.PI / 180;
  const a = Math.sin((otherLatitude - latitude) * radians / 2) ** 2 + Math.cos(latitude * radians) * Math.cos(otherLatitude * radians) * Math.sin((otherLongitude - longitude) * radians / 2) ** 2;
  return 6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}
export async function reportCandidates(actor: Actor, id: string, query: unknown, client: PrismaClient = db()) {
  authorize(actor);
  candidateQuerySchema.parse(query);
  const report = await client.trReport.findUniqueOrThrow({ where: { id }, select: { caseId: true, locationMode: true, latitude: true, longitude: true, observedAt: true } });
  return findCandidates(report, query, client);
}
async function findCandidates(report: { caseId: string | null; locationMode: string; latitude: number | null; longitude: number | null; observedAt: Date }, query: unknown, client: PrismaClient) {
  const { maxDistanceMeters, hours } = candidateQuerySchema.parse(query);
  const meta = { eligible: true, reason: null as string | null, maxDistanceMeters, hours, automaticAssociation: false, basis: 'OPERATOR_ENTERED_DISTANCE_AND_OBSERVATION_TIME', limitation: 'Suggestions compare estimated points and evidence times; thresholds are not approved association rules.' };
  if (report.locationMode !== 'INCIDENT_ESTIMATE' || report.latitude == null || report.longitude == null) return { data: [], meta: { ...meta, eligible: false, reason: 'INCIDENT_ESTIMATE_REQUIRED' } };
  const range = { gte: new Date(report.observedAt.getTime() - hours * 3600000), lte: new Date(report.observedAt.getTime() + hours * 3600000) };
  const cases = await client.trCase.findMany({
    where: { ...(report.caseId ? { id: { not: report.caseId } } : {}), handlingStatus: { not: 'CLOSED' }, verificationStatus: { not: 'NOT_FIRE' }, latitude: { not: null }, longitude: { not: null }, OR: [
      { reports: { some: { locationMode: 'INCIDENT_ESTIMATE', latitude: { not: null }, longitude: { not: null }, observedAt: range } } },
      { fieldUpdates: { some: { observedAt: range } } },
    ] },
    select: { id: true, number: true, title: true, latitude: true, longitude: true, verificationStatus: true, handlingStatus: true,
      reports: { where: { locationMode: 'INCIDENT_ESTIMATE', latitude: { not: null }, longitude: { not: null }, observedAt: range }, select: { id: true, observedAt: true }, orderBy: [{ observedAt: 'desc' }, { id: 'asc' }], take: 1 },
      fieldUpdates: { where: { observedAt: range }, select: { id: true, observedAt: true }, orderBy: [{ observedAt: 'desc' }, { id: 'asc' }], take: 1 },
    }, orderBy: { id: 'asc' }, take: 501,
  });
  if (cases.length > 500) throw new AppError('Narrow the time window before requesting candidates', 400, 'CANDIDATE_LIMIT');
  const data = cases.flatMap(c => {
    const distanceMeters = haversineMeters(report.latitude!, report.longitude!, c.latitude!, c.longitude!);
    if (distanceMeters > maxDistanceMeters) return [];
    const evidence = [...c.reports, ...c.fieldUpdates].sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime() || a.id.localeCompare(b.id))[0];
    if (!evidence) return [];
    return [{ id: c.id, number: c.number, title: c.title, latitude: c.latitude, longitude: c.longitude, verificationStatus: c.verificationStatus, handlingStatus: c.handlingStatus, distanceMeters, matchedObservationId: evidence.id, matchedObservedAt: evidence.observedAt, timeDifferenceHours: Math.abs(evidence.observedAt.getTime() - report.observedAt.getTime()) / 3600000 }];
  }).sort((a, b) => a.distanceMeters - b.distanceMeters || a.timeDifferenceHours - b.timeDifferenceHours || a.id.localeCompare(b.id));
  return { data, meta };
}
