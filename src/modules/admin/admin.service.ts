import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { db } from '../../config/index.js';
import { caseSchema, casePatchSchema, caseRegionSchema, fieldSchema, verificationSchema, reviewSchema, reportActionSchema, paginationSchema, assignmentSchema, assignmentPatchSchema, teamSchema, teamPatchSchema, equipmentSchema, equipmentPatchSchema, operationalSchema, adminUserPatchSchema, handlingStatuses, verificationStatuses, priorities, reviewerAssessmentSource, type Actor, type Transaction } from '../../types/index.js';
import { AppError, fingerprint, jsonValue } from '../../utils/index.js';
import { areaHectares, polygonSchema } from '../../utils/geometry.js';
import { attach } from '../uploads/uploads.service.js';
import { loadWindContext } from '../integrations/wind.js';
import { progressSelect, reportDto, reportInclude } from '../reports/reports.service.js';
import { recordCaseProgress } from '../reports/progress.js';
import { createReportNotification } from '../notifications/index.js';
import { activeAssignments, audit, bumpContext, lockedActor, verifiedRegion } from './access.js';
import { assertVersion, effectiveCapabilities, transition, verificationProjection } from './rules.js';

export const caseSelect = { id: true, number: true, title: true, latitude: true, longitude: true, regionId: true, verificationStatus: true, handlingStatus: true, priority: true, priorityReason: true, version: true, contextRevision: true, latestAnalysisId: true, openedAt: true, updatedAt: true, closedAt: true, closureReason: true } as const;
export async function listCases(query: unknown) {
  const { page, pageSize, search, handlingStatus, verificationStatus, priority, regionId } = paginationSchema.extend({ handlingStatus: z.enum(handlingStatuses).optional(), verificationStatus: z.enum(verificationStatuses).optional(), priority: z.enum(priorities).optional() }).parse(query);
  const where = { handlingStatus, verificationStatus, priority, regionId, ...(search ? { OR: [{ title: { contains: search, mode: 'insensitive' as const } }, { number: { contains: search } }] } : {}) };
  const [rows, total] = await db().$transaction([db().trCase.findMany({ where, select: { ...caseSelect, perimeter: true, perimeterRevision: true }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }), db().trCase.count({ where })]);
  const data = rows.map(row => {
    const perimeter = row.verificationStatus === 'CONFIRMED_FIRE' ? polygonSchema.safeParse(row.perimeter) : null;
    return { ...row, perimeter: perimeter?.success ? perimeter.data : null };
  });
  return { data, meta: { total, page, pageSize } };
}
export async function getCase(id: string, actor?: Actor) {
  const c = await db().trCase.findUnique({ where: { id }, select: { ...caseSelect, perimeter: true, perimeterObservedAt: true, perimeterSource: true, perimeterRevision: true,
    region: { select: { id: true, name: true, timezone: true, level: true, bmkgAdm4: true, verifiedAt: true } },
    reports: { include: reportInclude, orderBy: { observedAt: 'desc' }, take: 100 },
    hotspots: { select: { id: true, source: true, product: true, latitude: true, longitude: true, acquiredAt: true, confidenceRaw: true, frp: true, satellite: true, instrument: true, version: true, fetchedAt: true }, take: 300, orderBy: { acquiredAt: 'desc' } },
    fieldUpdates: { select: { id: true, findings: true, description: true, source: true, teamId: true, observedAt: true, createdAt: true, latitude: true, longitude: true, attachments: { select: { id: true, filename: true, contentType: true, size: true } } }, take: 100, orderBy: { observedAt: 'desc' } },
    verifications: { select: { id: true, outcome: true, previousStatus: true, newStatus: true, reason: true, authorityReference: true, fieldUpdateId: true, correctedDecisionId: true, createdAt: true }, take: 100, orderBy: { createdAt: 'desc' } },
    analyses: { select: { id: true, contextRevision: true, status: true, output: true, evidenceLevel: true, impactLevel: true, suggestedPriority: true, model: true, schemaVersion: true, promptVersion: true, ruleVersion: true, failureCode: true, startedAt: true, completedAt: true }, take: 20, orderBy: { startedAt: 'desc' } },
    assignments: { select: { id: true, caseId: true, teamId: true, status: true, notes: true, createdAt: true, updatedAt: true, team: { select: { id: true, name: true } } }, take: 100, orderBy: { createdAt: 'desc' } },
  } });
  if (!c) throw new AppError('Case not found', 404, 'NOT_FOUND');
  const timeline = await db().trAuditLog.findMany({ where: { targetType: 'CASE', targetId: id }, select: { id: true, action: true, reason: true, details: true, createdAt: true, actor: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 200 });
  const priorityHistory = timeline.flatMap(entry => {
    if (entry.action !== 'CASE_UPDATED' || !entry.details || typeof entry.details !== 'object' || Array.isArray(entry.details)) return [];
    const details = entry.details as Record<string, unknown>;
    const before = details.before && typeof details.before === 'object' && !Array.isArray(details.before) ? details.before as Record<string, unknown> : null;
    const after = details.after && typeof details.after === 'object' && !Array.isArray(details.after) ? details.after as Record<string, unknown> : null;
    const from = before?.priority, to = after?.priority;
    if (typeof from !== 'string' || typeof to !== 'string' || !priorities.includes(from as typeof priorities[number]) || !priorities.includes(to as typeof priorities[number]) || from === to) return [];
    return [{ id: entry.id, from, to, reason: entry.reason, changedAt: entry.createdAt, changedBy: entry.actor?.name ?? 'Government administrator' }];
  });
  const { forecast, windContext } = await loadWindContext(db(), c.region);
  const weather = forecast && windContext.forecast ? [{ ...windContext.forecast, temperature: forecast.temperature, humidity: forecast.humidity, windSpeed: windContext.windSpeedKmh, windSpeedUnit: 'km/h', windFromDegrees: windContext.windFromDegrees, windToDegrees: windContext.windToDegrees, directionPrecision: 'CARDINAL', measurementType: 'FORECAST', stale: !['READY', 'CALM', 'MISSING_WIND'].includes(windContext.status) }] : [];
  const spatialContext = c.regionId ? await db().msMapFeature.findMany({ where: { regionId: c.regionId, layer: { verifiedAt: { not: null } } }, select: { id: true, name: true, kind: true, layer: { select: { provider: true, attribution: true, sourceDate: true, version: true } } }, take: 100 }) : [];
  const perimeter = polygonSchema.safeParse(c.perimeter);
  const currentActor = actor ? await db().msUser.findUnique({ where: { id: actor.id }, select: { role: true, active: true, emailVerified: true } }) : null;
  const activeAssignmentCount = await db().trAssignment.count({ where: { caseId: id, status: { in: [...activeAssignments] } } });
  return { ...c, operatorAuthorityConfigured: !!currentActor && effectiveCapabilities(currentActor).canConfirmIncidents, activeAssignmentCount, areaHectares: perimeter.success ? areaHectares(perimeter.data) : null, reports: c.reports.map(reportDto), priorityHistory, timeline: timeline.map(({ actor: _actor, ...entry }) => entry), weather, windContext, spatialContext };
}
export async function createCase(actor: Actor, body: unknown) {
  const { reason, ...data } = caseSchema.parse(body);
  return db().$transaction(async tx => {
    await lockedActor(tx, actor, true);
    await verifiedRegion(tx, data.regionId);
    const c = await tx.trCase.create({ data: { ...data, number: `C-${randomUUID()}` }, select: caseSelect });
    await audit(tx, actor.id, 'CASE_CREATED', 'CASE', c.id, reason);
    return c;
  });
}
export async function updateCase(actor: Actor, id: string, body: unknown, client: PrismaClient = db()) {
  const input = casePatchSchema.parse(body);
  return client.$transaction(async tx => {
    const user = await lockedActor(tx, actor, true, 'perimeter' in input ? 'canConfirmIncidents' : undefined);
    if ('perimeter' in input) {
      const verified = await tx.msUser.findUnique({ where: { id: user.id }, select: { emailVerified: true } });
      if (!verified?.emailVerified) throw new AppError('Verified administrator required', 403, 'FORBIDDEN');
    }
    await tx.$queryRaw`SELECT id FROM "TrCase" WHERE id = ${id} FOR UPDATE`;
    const c = await tx.trCase.findUniqueOrThrow({ where: { id } });
    assertVersion(c.version, input.version);
    if ('perimeter' in input) {
      if (c.verificationStatus !== 'CONFIRMED_FIRE') throw new AppError('Perimeter requires a confirmed fire', 409, 'INVALID_TRANSITION');
      const data = await tx.trCase.update({ where: { id, version: input.version }, data: { perimeter: jsonValue(input.perimeter), perimeterObservedAt: new Date(input.perimeterObservedAt), perimeterSource: input.perimeterSource, perimeterRevision: { increment: 1 }, version: { increment: 1 }, contextRevision: { increment: 1 }, latestAnalysisId: null }, select: { ...caseSelect, perimeter: true, perimeterObservedAt: true, perimeterSource: true, perimeterRevision: true } });
      await audit(tx, actor.id, 'CASE_PERIMETER_UPDATED', 'CASE', id, input.reason, { authorityReference: input.authorityReference, authorityBasis: 'APPLICATION_ADMIN_ROLE', authorityNoteSource: 'OPERATOR_SUPPLIED', before: { perimeter: c.perimeter, observedAt: c.perimeterObservedAt, source: c.perimeterSource, revision: c.perimeterRevision }, after: { perimeter: data.perimeter, observedAt: data.perimeterObservedAt, source: data.perimeterSource, revision: data.perimeterRevision }, areaHectares: areaHectares(input.perimeter) });
      return { ...data, areaHectares: areaHectares(input.perimeter) };
    }
    const handling = input.handlingStatus ?? c.handlingStatus;
    const count = await tx.trAssignment.count({ where: { caseId: id, status: { in: [...activeAssignments] } } });
    transition(c.verificationStatus, handling, count);
    const data = await tx.trCase.update({ where: { id, version: input.version }, data: { priority: input.priority, priorityReason: input.priority ? input.reason : undefined, handlingStatus: handling, closedAt: handling === 'CLOSED' ? c.closedAt ?? new Date() : null, closureReason: handling === 'CLOSED' ? input.reason : null, version: { increment: 1 }, contextRevision: { increment: 1 }, latestAnalysisId: null }, select: caseSelect });
    if (handling !== c.handlingStatus) await recordCaseProgress(tx, id, actor.id, handling, input.reporterMessage);
    await audit(tx, actor.id, 'CASE_UPDATED', 'CASE', id, input.reason, { before: { priority: c.priority, handlingStatus: c.handlingStatus }, after: { priority: data.priority, handlingStatus: data.handlingStatus } });
    return data;
  });
}
export async function updateCaseRegion(actor: Actor, id: string, body: unknown, client: PrismaClient = db()) {
  const input = caseRegionSchema.parse(body);
  return client.$transaction(async tx => {
    await lockedActor(tx, actor, true);
    await tx.$queryRaw`SELECT id FROM "TrCase" WHERE id = ${id} FOR UPDATE`;
    const c = await tx.trCase.findUniqueOrThrow({ where: { id } });
    assertVersion(c.version, input.version);
    if (input.regionId && !(await tx.msRegion.findFirst({ where: { id: input.regionId, verifiedAt: { not: null }, level: 4, bmkgAdm4: { not: null } }, select: { id: true } }))) throw new AppError('A verified administrative level IV BMKG region mapping is required', 400, 'INVALID_REGION');
    const data = await tx.trCase.update({ where: { id, version: input.version }, data: { regionId: input.regionId, version: { increment: 1 }, contextRevision: { increment: 1 }, latestAnalysisId: null }, select: caseSelect });
    await audit(tx, actor.id, 'CASE_FORECAST_REGION_CHANGED', 'CASE', id, input.reason, { before: { regionId: c.regionId }, after: { regionId: data.regionId } });
    return data;
  });
}
export async function addFieldUpdate(actor: Actor, id: string, body: unknown, client: PrismaClient = db()) {
  const { attachmentIds, ...input } = fieldSchema.parse(body);
  return client.$transaction(async tx => {
    await lockedActor(tx, actor, true);
    await tx.trCase.findUniqueOrThrow({ where: { id }, select: { id: true } });
    const item = await tx.trFieldUpdate.create({ data: { ...input, observedAt: new Date(input.observedAt), caseId: id, recorderId: actor.id }, select: { id: true, findings: true, description: true, source: true, observedAt: true, createdAt: true, latitude: true, longitude: true, teamId: true } });
    await attach(tx, actor, attachmentIds, { fieldUpdateId: item.id });
    await bumpContext(tx, id);
    await audit(tx, actor.id, 'FIELD_UPDATE_ADDED', 'CASE', id, undefined, { fieldUpdateId: item.id });
    return item;
  });
}
export async function verifyCase(actor: Actor, id: string, body: unknown, client: PrismaClient = db()) {
  const input = verificationSchema.parse(body);
  return client.$transaction(async tx => {
    await lockedActor(tx, actor, true, 'canConfirmIncidents');
    const authorityReference = input.authorityReference!;
    await tx.$queryRaw`SELECT id FROM "TrCase" WHERE id = ${id} FOR UPDATE`;
    const c = await tx.trCase.findUniqueOrThrow({ where: { id } });
    assertVersion(c.version, input.version);
    const field = await tx.trFieldUpdate.findFirst({ where: { id: input.fieldUpdateId, caseId: id } });
    if (!field) throw new AppError('Verification requires field evidence from this case', 400, 'INVALID_EVIDENCE');
    if (input.outcome === 'CONFIRMED_FIRE' && (field.findings !== 'VISIBLE_FIRE' || field.latitude === null || field.longitude === null || field.source === reviewerAssessmentSource)) throw new AppError('Confirmation requires a coordinate-backed visible-fire field observation', 409, 'INSUFFICIENT_EVIDENCE');
    if (input.outcome === 'NOT_FIRE' && (field.findings !== 'NO_INDICATION' || field.latitude === null || field.longitude === null || field.source === reviewerAssessmentSource)) throw new AppError('Rejection requires a coordinate-backed no-indication field observation', 409, 'INSUFFICIENT_EVIDENCE');
    const next = input.outcome === 'INCONCLUSIVE' ? c.verificationStatus : input.outcome;
    const correction = c.verificationStatus !== 'UNVERIFIED' && next !== c.verificationStatus;
    if (correction) {
      const publications = await tx.trPublicInformation.count({ where: { caseId: id, status: 'PUBLISHED' } });
      if (publications) throw new AppError('Withdraw existing public case claims before correcting verification', 409, 'PUBLICATION_REVIEW_REQUIRED');
    }
    const prior = correction ? await tx.trVerification.findFirst({ where: { caseId: id, outcome: { not: 'INCONCLUSIVE' } }, orderBy: { createdAt: 'desc' } }) : null;
    await tx.trVerification.create({ data: { caseId: id, decidingAdminId: actor.id, fieldUpdateId: field.id, authorityReference, outcome: correction ? 'CORRECTION' : input.outcome, previousStatus: c.verificationStatus, newStatus: next, reason: input.reason, correctedDecisionId: prior?.id } });
    const projected = verificationProjection({ verificationStatus: c.verificationStatus, handlingStatus: c.handlingStatus, latitude: c.latitude, longitude: c.longitude }, input.outcome, { latitude: field.latitude, longitude: field.longitude });
    const result = await tx.trCase.update({ where: { id, version: input.version }, data: { verificationStatus: projected.verificationStatus, handlingStatus: projected.handlingStatus, latitude: projected.latitude, longitude: projected.longitude, ...(input.perimeter ? { perimeter: jsonValue(input.perimeter), perimeterObservedAt: new Date(input.perimeterObservedAt!), perimeterSource: input.perimeterSource!, perimeterRevision: { increment: 1 } } : {}), version: { increment: 1 }, contextRevision: { increment: 1 }, latestAnalysisId: null }, select: caseSelect });
    if (input.outcome === 'INCONCLUSIVE' || next !== c.verificationStatus) await recordCaseProgress(tx, id, actor.id, correction ? `CORRECTION_${next}` : input.outcome, input.reporterMessage);
    await audit(tx, actor.id, correction ? 'VERIFICATION_CORRECTED' : 'VERIFICATION_RECORDED', 'CASE', id, input.reason, { outcome: input.outcome, previousStatus: c.verificationStatus, newStatus: next, authorityReference, authorityBasis: 'APPLICATION_ADMIN_ROLE', authorityNoteSource: 'OPERATOR_SUPPLIED', positionSourceFieldUpdateId: input.outcome === 'CONFIRMED_FIRE' && field.latitude !== null ? field.id : null });
    if (input.perimeter) await audit(tx, actor.id, 'CASE_PERIMETER_UPDATED', 'CASE', id, input.reason, { authorityReference, authorityBasis: 'APPLICATION_ADMIN_ROLE', authorityNoteSource: 'OPERATOR_SUPPLIED', fieldUpdateId: field.id, before: { perimeter: c.perimeter, observedAt: c.perimeterObservedAt, source: c.perimeterSource, revision: c.perimeterRevision }, after: { perimeter: input.perimeter, observedAt: input.perimeterObservedAt, source: input.perimeterSource, revision: c.perimeterRevision + 1 }, areaHectares: areaHectares(input.perimeter) });
    return result;
  });
}
export async function reviewReport(actor: Actor, id: string, body: unknown, client: PrismaClient = db()) {
  const input = reviewSchema.parse(body);
  return client.$transaction(async tx => {
    await lockedActor(tx, actor, true);
    await tx.$queryRaw`SELECT id FROM "TrReport" WHERE id = ${id} FOR UPDATE`;
    const report = await tx.trReport.findUniqueOrThrow({ where: { id } });
    for (const caseId of [...new Set([report.caseId, input.caseId].filter((v): v is string => !!v))].sort()) await tx.$queryRaw`SELECT id FROM "TrCase" WHERE id = ${caseId} FOR UPDATE`;
    if (input.caseId && input.caseId !== report.caseId) {
      const target = await tx.trCase.findUniqueOrThrow({ where: { id: input.caseId } });
      if (target.handlingStatus === 'CLOSED' || target.verificationStatus === 'NOT_FIRE') throw new AppError('Reopen or correct the case before linking new evidence', 409, 'CASE_REVIEW_REQUIRED');
    }
    if (input.reviewStatus === 'UNDER_REVIEW' && report.reviewStatus === 'UNDER_REVIEW') throw new AppError('Review has already started or finished', 409, 'INVALID_TRANSITION');
    const item = await tx.trReport.update({ where: { id }, data: { reviewStatus: input.reviewStatus, caseId: input.caseId }, include: reportInclude });
    if (input.reporterMessage && item.reviewStatus !== report.reviewStatus) {
      const progressId = randomUUID();
      await tx.trReportProgress.create({ data: { id: progressId, reportId: id, actorId: actor.id, stage: item.reviewStatus, description: input.reporterMessage } });
      await createReportNotification(tx, { eventKey: `progress:${progressId}`, reportId: id, userId: item.reporterId, type: 'REPORT_STATUS', stage: item.reviewStatus, message: input.reporterMessage });
    }
    const action = input.reviewStatus === 'UNDER_REVIEW' ? 'REPORT_REVIEW_STARTED' : input.reviewStatus !== undefined ? 'REPORT_REVIEWED' : 'REPORT_LINKED';
    for (const caseId of [...new Set([report.caseId, item.caseId].filter((v): v is string => !!v))].sort()) {
      await bumpContext(tx, caseId);
      await audit(tx, actor.id, action, 'CASE', caseId, input.reason, { reportId: id, previousCaseId: report.caseId, caseId: item.caseId });
    }
    await audit(tx, actor.id, action, 'REPORT', id, input.reason, { reviewStatus: item.reviewStatus });
    return reportDto(item);
  });
}
export async function submitReportAction(actor: Actor, id: string, body: unknown, client: PrismaClient = db()) {
  const input = reportActionSchema.parse(body);
  const hash = fingerprint({ reportId: id, ...input, attachmentIds: [...input.attachmentIds].sort() });
  return client.$transaction(async tx => {
    const confirming = input.status === 'CONFIRMED_FIRE';
    await lockedActor(tx, actor, true, confirming ? 'canConfirmIncidents' : undefined);
    await tx.$queryRaw`SELECT id FROM "TrReport" WHERE id = ${id} FOR UPDATE`;
    const report = await tx.trReport.findUniqueOrThrow({ where: { id } });
    const existing = await tx.trReportProgress.findUnique({ where: { actorId_idempotencyKey: { actorId: actor.id, idempotencyKey: input.idempotencyKey } }, select: { ...progressSelect, payloadHash: true, reportId: true } });
    if (existing) {
      if (existing.payloadHash !== hash || existing.reportId !== id) throw new AppError('Action key already used for different content', 409, 'IDEMPOTENCY_CONFLICT');
      const { payloadHash: _hash, reportId: _reportId, ...safe } = existing;
      return safe;
    }
    let caseId = report.caseId;
    let stage: string = input.status;
    let fieldUpdateId: string | undefined;
    let progressId: string;
    if (confirming) {
      let incident;
      if (caseId) {
        await tx.$queryRaw`SELECT id FROM "TrCase" WHERE id = ${caseId} FOR UPDATE`;
        incident = await tx.trCase.findUniqueOrThrow({ where: { id: caseId } });
        if (incident.verificationStatus === 'CONFIRMED_FIRE') throw new AppError('This case is already confirmed. Use Revise boundary for an audited perimeter revision.', 409, 'INVALID_TRANSITION');
        if (input.confirmed.expectedCaseVersion === undefined) throw new AppError('Case version is required; reload and review before confirming', 409, 'VERSION_CONFLICT');
        assertVersion(incident.version, input.confirmed.expectedCaseVersion);
      } else {
        await verifiedRegion(tx, report.regionId);
        incident = await tx.trCase.create({ data: { number: `C-${randomUUID()}`, title: `Reported observation ${report.number}`, latitude: report.locationMode === 'INCIDENT_ESTIMATE' ? report.latitude : null, longitude: report.locationMode === 'INCIDENT_ESTIMATE' ? report.longitude : null, regionId: report.regionId } });
        caseId = incident.id;
      }
      if (incident.verificationStatus === 'CONFIRMED_FIRE') throw new AppError('This case is already confirmed. Use Revise boundary for an audited perimeter revision.', 409, 'INVALID_TRANSITION');
      if (incident.verificationStatus !== 'UNVERIFIED') {
        const publications = await tx.trPublicInformation.count({ where: { caseId: incident.id, status: 'PUBLISHED' } });
        if (publications) throw new AppError('Withdraw existing public case claims before correcting verification', 409, 'PUBLICATION_REVIEW_REQUIRED');
      }
      const progress = await tx.trReportProgress.create({ data: { reportId: id, actorId: actor.id, stage, description: input.description, idempotencyKey: input.idempotencyKey, payloadHash: hash } });
      progressId = progress.id;
      const observedAt = new Date();
      const field = await tx.trFieldUpdate.create({ data: { caseId: incident.id, recorderId: actor.id, findings: 'VISIBLE_FIRE', description: input.description, source: reviewerAssessmentSource, observedAt } });
      fieldUpdateId = field.id;
      await attach(tx, actor, input.attachmentIds, { reportProgressId: progress.id, fieldUpdateId: field.id });
      const correction = incident.verificationStatus !== 'UNVERIFIED';
      const prior = correction ? await tx.trVerification.findFirst({ where: { caseId: incident.id, outcome: { not: 'INCONCLUSIVE' } }, orderBy: { createdAt: 'desc' } }) : null;
      const authorityReference = 'APPLICATION_ADMIN_ROLE';
      await tx.trVerification.create({ data: { caseId: incident.id, decidingAdminId: actor.id, fieldUpdateId: field.id, authorityReference, outcome: correction ? 'CORRECTION' : 'CONFIRMED_FIRE', previousStatus: incident.verificationStatus, newStatus: 'CONFIRMED_FIRE', reason: input.description, correctedDecisionId: prior?.id } });
      const perimeterSource = reviewerAssessmentSource;
      const updatedCase = await tx.trCase.update({ where: { id: incident.id, version: incident.version }, data: { verificationStatus: 'CONFIRMED_FIRE', perimeter: jsonValue(input.confirmed.perimeter), perimeterObservedAt: observedAt, perimeterSource, perimeterRevision: { increment: 1 }, version: { increment: 1 }, contextRevision: { increment: 1 }, latestAnalysisId: null } });
      await tx.trReport.update({ where: { id }, data: { reviewStatus: 'REVIEWED', caseId: incident.id } });
      await audit(tx, actor.id, 'REVIEWER_ASSESSMENT_RECORDED', 'CASE', incident.id, undefined, { fieldUpdateId: field.id, reportId: id, source: reviewerAssessmentSource, verificationBasis: 'OPERATOR_ASSESSMENT', independentFieldObservation: false, observationTimeBasis: 'RECORDED_AT', locationSource: 'OPERATOR_MAPPED_BOUNDARY' });
      await audit(tx, actor.id, correction ? 'VERIFICATION_CORRECTED' : 'VERIFICATION_RECORDED', 'CASE', incident.id, input.description, { outcome: 'CONFIRMED_FIRE', previousStatus: incident.verificationStatus, newStatus: 'CONFIRMED_FIRE', authorityReference, authorityBasis: 'APPLICATION_ADMIN_ROLE', verificationBasis: 'OPERATOR_ASSESSMENT', independentFieldObservation: false, positionSourceFieldUpdateId: null, reportId: id });
      await audit(tx, actor.id, 'CASE_PERIMETER_UPDATED', 'CASE', incident.id, input.description, { authorityReference, authorityBasis: 'APPLICATION_ADMIN_ROLE', verificationBasis: 'OPERATOR_ASSESSMENT', fieldUpdateId: field.id, reportId: id, before: { perimeter: incident.perimeter, observedAt: incident.perimeterObservedAt, source: incident.perimeterSource, revision: incident.perimeterRevision }, after: { perimeter: input.confirmed.perimeter, observedAt, source: perimeterSource, revision: updatedCase.perimeterRevision }, areaHectares: areaHectares(input.confirmed.perimeter) });
    } else {
      const reviewStatus = input.status === 'IN_PROGRESS' ? 'UNDER_REVIEW' : input.status;
      stage = reviewStatus;
      const progress = await tx.trReportProgress.create({ data: { reportId: id, actorId: actor.id, stage: reviewStatus, description: input.description, idempotencyKey: input.idempotencyKey, payloadHash: hash } });
      progressId = progress.id;
      await attach(tx, actor, input.attachmentIds, { reportProgressId: progress.id });
      await tx.trReport.update({ where: { id }, data: { reviewStatus } });
      if (caseId && reviewStatus !== report.reviewStatus) await bumpContext(tx, caseId);
    }
    await createReportNotification(tx, { eventKey: `progress:${progressId}`, reportId: id, type: input.status === 'CONFIRMED_FIRE' ? 'REPORT_VERIFICATION' : 'REPORT_STATUS', stage, message: input.description });
    await audit(tx, actor.id, 'REPORT_ACTION_RECORDED', 'REPORT', id, input.description, { status: input.status, progressId, caseId, fieldUpdateId, attachmentCount: input.attachmentIds.length });
    return tx.trReportProgress.findUniqueOrThrow({ where: { id: progressId }, select: progressSelect });
  }, { maxWait: 2000, timeout: 15000 });
}
const assignmentSelect = { id: true, caseId: true, teamId: true, status: true, notes: true, version: true, createdAt: true, updatedAt: true } as const;
export async function assignTeam(actor: Actor, id: string, body: unknown, client: PrismaClient = db()) {
  const input = assignmentSchema.parse(body);
  const payloadHash = fingerprint({ caseId: id, ...input });
  return client.$transaction(async tx => {
    await lockedActor(tx, actor, true);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.idempotencyKey}, 0))`;
    const existing = await tx.trAssignment.findUnique({ where: { idempotencyKey: input.idempotencyKey }, select: { ...assignmentSelect, payloadHash: true, assigningAdminId: true } });
    if (existing) {
      if (existing.payloadHash !== payloadHash || existing.assigningAdminId !== actor.id) throw new AppError('Assignment key already used for different content', 409, 'IDEMPOTENCY_CONFLICT');
      const { payloadHash: _hash, assigningAdminId: _actor, ...safe } = existing;
      return safe;
    }
    await tx.$queryRaw`SELECT id FROM "MsTeam" WHERE id = ${input.teamId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "TrCase" WHERE id = ${id} FOR UPDATE`;
    const c = await tx.trCase.findUniqueOrThrow({ where: { id } });
    assertVersion(c.version, input.version);
    if (c.handlingStatus === 'CLOSED' || c.verificationStatus === 'NOT_FIRE') throw new AppError('Case must be open for investigation or response', 409, 'INVALID_TRANSITION');
    const team = await tx.msTeam.findFirst({ where: { id: input.teamId, active: true } });
    if (!team) throw new AppError('Team not available', 400, 'INVALID_TEAM');
    const sample = await tx.trAuditLog.findFirst({ where: { systemActor: 'sample-operations-v1', action: 'SAMPLE_OPERATION_CREATED', targetType: 'TEAM', targetId: team.id }, select: { id: true } });
    if (sample) throw new AppError('Sample teams cannot be assigned to operational cases', 409, 'SAMPLE_DATA');
    if (await tx.trAssignment.count({ where: { teamId: team.id, status: { in: [...activeAssignments] } } })) throw new AppError('Team already has an active assignment; complete or cancel it first', 409, 'TEAM_BUSY');
    const latest = await tx.trOperationalUpdate.findFirst({ where: { teamId: team.id }, orderBy: [{ observedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }] });
    if (!latest || latest.condition !== 'AVAILABLE' || !fresh(latest.observedAt, new Date())) throw new AppError('Record a current team availability update before assigning', 409, 'TEAM_STATUS_UNKNOWN');
    const { reason, idempotencyKey, version: _version, ...data } = input;
    const item = await tx.trAssignment.create({ data: { ...data, caseId: id, assigningAdminId: actor.id, idempotencyKey, payloadHash }, select: assignmentSelect });
    await bumpContext(tx, id);
    await audit(tx, actor.id, 'TEAM_ASSIGNED', 'CASE', id, reason, { assignmentId: item.id, teamId: team.id, idempotencyKey, payloadHash });
    return item;
  });
}
export async function updateAssignment(actor: Actor, id: string, body: unknown, client: PrismaClient = db()) {
  const input = assignmentPatchSchema.parse(body);
  return client.$transaction(async tx => {
    await lockedActor(tx, actor, true);
    const reference = await tx.trAssignment.findUniqueOrThrow({ where: { id } });
    await tx.$queryRaw`SELECT id FROM "MsTeam" WHERE id = ${reference.teamId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "TrCase" WHERE id = ${reference.caseId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "TrAssignment" WHERE id = ${id} FOR UPDATE`;
    const item = await tx.trAssignment.findUniqueOrThrow({ where: { id } });
    assertVersion(item.version, input.version);
    if (await sampleTarget(tx, 'TEAM', item.teamId)) throw new AppError('Sample assignments are read-only', 409, 'SAMPLE_DATA');
    const allowed: Record<string, readonly string[]> = { ASSIGNED: ['ACCEPTED', 'CANCELLED'], ACCEPTED: ['IN_PROGRESS', 'CANCELLED'], IN_PROGRESS: ['COMPLETED', 'CANCELLED'] };
    if (!allowed[item.status]?.includes(input.status)) throw new AppError('Only the next assignment stage or cancellation is allowed', 409, 'INVALID_TRANSITION');
    const changed = await tx.trAssignment.updateMany({ where: { id, version: input.version }, data: { status: input.status, version: { increment: 1 } } });
    if (!changed.count) throw new AppError('Record changed; reload before continuing', 409, 'VERSION_CONFLICT');
    const updated = await tx.trAssignment.findUniqueOrThrow({ where: { id }, select: assignmentSelect });
    await bumpContext(tx, item.caseId);
    await audit(tx, actor.id, 'ASSIGNMENT_UPDATED', 'CASE', item.caseId, input.reason, { assignmentId: id, before: { status: item.status, version: item.version }, after: { status: updated.status, version: updated.version } });
    return updated;
  });
}
const adminUserSelect = { id: true, name: true, email: true, emailVerified: true, role: true, active: true, createdAt: true, updatedAt: true } as const;
const adminUserDto = (user: { id: string; name: string; email: string; emailVerified: boolean; role: string; active: boolean; createdAt: Date; updatedAt: Date }) => ({ ...user, ...effectiveCapabilities(user) });
export async function listUsers(query: unknown) {
  const { page, pageSize, search, role, active, emailVerified } = paginationSchema.extend({ role: z.enum(['USER', 'ADMIN']).optional(), active: z.enum(['true', 'false']).transform(value => value === 'true').optional(), emailVerified: z.enum(['true', 'false']).transform(value => value === 'true').optional() }).parse(query);
  const where = { role, active, emailVerified, ...(search ? { OR: [{ name: { contains: search, mode: 'insensitive' as const } }, { email: { contains: search, mode: 'insensitive' as const } }] } : {}) };
  const [rows, total] = await db().$transaction([
    db().msUser.findMany({ where, select: adminUserSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }),
    db().msUser.count({ where }),
  ]);
  return { data: rows.map(adminUserDto), meta: { total, page, pageSize } };
}
export async function getUser(id: string) {
  return adminUserDto(await db().msUser.findUniqueOrThrow({ where: { id }, select: adminUserSelect }));
}
export async function updateUser(actor: Actor, id: string, body: unknown) {
  const input = adminUserPatchSchema.parse(body);
  return db().$transaction(async tx => {
    await lockedActor(tx, actor, true);
    await tx.$queryRaw`SELECT id FROM "MsUser" WHERE id = ${id} FOR UPDATE`;
    const current = await tx.msUser.findUniqueOrThrow({ where: { id }, select: adminUserSelect });
    if (current.updatedAt.getTime() !== Date.parse(input.expectedUpdatedAt)) throw new AppError('User changed; reload before continuing', 409, 'USER_CONFLICT');
    const nextRole = input.role ?? current.role;
    const nextActive = input.active ?? current.active;
    if (id === actor.id && (nextRole !== 'ADMIN' || !nextActive)) throw new AppError('You cannot remove your own administrator access', 409, 'SELF_LOCKOUT');
    if (current.role === 'ADMIN' && current.active && current.emailVerified && (nextRole !== 'ADMIN' || !nextActive)) {
      const administrators = await tx.msUser.count({ where: { role: 'ADMIN', active: true, emailVerified: true } });
      if (administrators <= 1) throw new AppError('At least one active verified administrator is required', 409, 'LAST_ADMIN');
    }
    const authorityChanged = nextRole !== current.role || nextActive !== current.active;
    const updated = await tx.msUser.update({ where: { id, updatedAt: current.updatedAt }, data: { ...(input.name === undefined ? {} : { name: input.name }), ...(input.role === undefined ? {} : { role: input.role }), ...(input.active === undefined ? {} : { active: input.active }), canConfirmIncidents: nextRole === 'ADMIN' && nextActive && current.emailVerified, canPublishInformation: nextRole === 'ADMIN' && nextActive && current.emailVerified }, select: adminUserSelect });
    const revokedSessions = authorityChanged ? (await tx.trSession.deleteMany({ where: { userId: id } })).count : 0;
    await audit(tx, actor.id, 'USER_UPDATED', 'USER', id, input.reason, { before: { name: current.name, role: current.role, active: current.active }, after: { name: updated.name, role: updated.role, active: updated.active }, mandate: input.mandate ?? null, revokedSessions });
    return adminUserDto(updated);
  });
}
export async function monitoringSummary() {
  const [totalCases, openUnverifiedCases, openConfirmedCases, activeHandlingCases, highPriorityOpenCases, caseVerificationGroups, caseHandlingGroups, openCasePriorityGroups, totalReports, awaitingReviewReports, inProgressReports, reportReviewGroups, activeTeams, activeAssignments, draftPublications] = await db().$transaction([
    db().trCase.count(),
    db().trCase.count({ where: { verificationStatus: 'UNVERIFIED', handlingStatus: { not: 'CLOSED' } } }),
    db().trCase.count({ where: { verificationStatus: 'CONFIRMED_FIRE', handlingStatus: { not: 'CLOSED' } } }),
    db().trCase.count({ where: { handlingStatus: { in: ['ON_SCENE', 'RESPONDING', 'MONITORING'] } } }),
    db().trCase.count({ where: { priority: 'HIGH', handlingStatus: { not: 'CLOSED' } } }),
    db().trCase.groupBy({ by: ['verificationStatus'], _count: { _all: true } }),
    db().trCase.groupBy({ by: ['handlingStatus'], _count: { _all: true } }),
    db().trCase.groupBy({ by: ['priority'], where: { handlingStatus: { not: 'CLOSED' } }, _count: { _all: true } }),
    db().trReport.count(),
    db().trReport.count({ where: { reviewStatus: 'NEW' } }),
    db().trReport.count({ where: { reviewStatus: { in: ['UNDER_REVIEW', 'NEEDS_DETAILS'] } } }),
    db().trReport.groupBy({ by: ['reviewStatus'], _count: { _all: true } }),
    db().msTeam.count({ where: { active: true } }),
    db().trAssignment.count({ where: { status: { in: ['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS'] } } }),
    db().trPublicInformation.count({ where: { status: 'DRAFT' } }),
  ]);
  const byVerification = { UNVERIFIED: 0, CONFIRMED_FIRE: 0, NOT_FIRE: 0 };
  const byHandling = { OPEN: 0, CHECK_SCHEDULED: 0, ON_SCENE: 0, RESPONDING: 0, MONITORING: 0, CLOSED: 0 };
  const byPriority = { HIGH: 0, MEDIUM: 0, LOW: 0, UNASSESSED: 0 };
  const byReviewStatus = { NEW: 0, UNDER_REVIEW: 0, NEEDS_DETAILS: 0, REVIEWED: 0, DECLINED: 0 };
  for (const item of caseVerificationGroups) byVerification[item.verificationStatus] = item._count._all;
  for (const item of caseHandlingGroups) byHandling[item.handlingStatus] = item._count._all;
  for (const item of openCasePriorityGroups) byPriority[item.priority] = item._count._all;
  for (const item of reportReviewGroups) byReviewStatus[item.reviewStatus] = item._count._all;
  return {
    asOf: new Date().toISOString(),
    cases: { total: totalCases, openUnverified: openUnverifiedCases, openConfirmed: openConfirmedCases, activeHandling: activeHandlingCases, highPriorityOpen: highPriorityOpenCases, byVerification, byHandling, byPriority },
    reports: { total: totalReports, awaitingReview: awaitingReviewReports, inProgress: inProgressReports, byReviewStatus },
    operations: { activeTeams, activeAssignments },
    publications: { drafts: draftPublications },
  };
}
const teamSelect = { id: true, name: true, organization: true, active: true, version: true, createdAt: true, updatedAt: true } as const;
const equipmentSelect = { id: true, name: true, kind: true, teamId: true, active: true, version: true, createdAt: true, updatedAt: true } as const;
const updateSelect = { id: true, subjectType: true, teamId: true, equipmentId: true, featureId: true, condition: true, source: true, observedAt: true, notes: true, createdAt: true } as const;
const sampleActor = 'sample-operations-v1';
const currentCondition = (updates: { subjectId: string; condition: string; observedAt: Date }[], subjectId: string) => updates.find(update => update.subjectId === subjectId);
const fresh = (date: Date | undefined, now: Date) => !!date && date.getTime() <= now.getTime() && now.getTime() - date.getTime() <= 86400000;
async function sampleTarget(tx: Transaction, targetType: string, targetId: string) {
  return !!await tx.trAuditLog.findFirst({ where: { systemActor: sampleActor, action: 'SAMPLE_OPERATION_CREATED', targetType, targetId }, select: { id: true } });
}
export async function operations() {
  const now = new Date();
  const [teams, equipment, rawUpdates, assignments, rawFeatures, sampleAudits] = await db().$transaction(async tx => Promise.all([
    tx.msTeam.findMany({ select: { ...teamSelect, updates: { select: updateSelect, take: 1, orderBy: [{ observedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }] }, _count: { select: { assignments: { where: { status: { in: [...activeAssignments] } } } } } }, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
    tx.msEquipment.findMany({ select: equipmentSelect, take: 300, orderBy: { name: 'asc' } }),
    tx.trOperationalUpdate.findMany({ select: updateSelect, take: 1000, orderBy: [{ observedAt: 'desc' }, { id: 'desc' }] }),
    tx.trAssignment.findMany({ select: { ...assignmentSelect, case: { select: { number: true, title: true, verificationStatus: true, handlingStatus: true } }, team: { select: { name: true } } }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }] }),
    tx.msMapFeature.findMany({ where: { kind: { in: ['ROAD', 'RIVER', 'WATER_SOURCE'] } }, select: { id: true, name: true, kind: true, layer: { select: { provider: true, verifiedAt: true } } }, take: 300, orderBy: { name: 'asc' } }),
    tx.trAuditLog.findMany({ where: { systemActor: sampleActor, action: 'SAMPLE_OPERATION_CREATED', targetType: { in: ['TEAM', 'EQUIPMENT', 'FEATURE', 'OPERATIONAL_UPDATE'] } }, select: { targetType: true, targetId: true } }),
  ]), { isolationLevel: 'RepeatableRead', maxWait: 10000, timeout: 30000 });
  const sampleKeys = new Set(sampleAudits.map(item => `${item.targetType}:${item.targetId}`));
  const updates = rawUpdates.map(value => ({ ...value, subjectId: value.teamId ?? value.equipmentId ?? value.featureId!, sample: sampleKeys.has(`OPERATIONAL_UPDATE:${value.id}`) }));
  const teamRows = teams.map(({ updates: history, _count, ...item }) => { const latest = history[0]; return { ...item, activeAssignmentCount: _count.assignments, sample: sampleKeys.has(`TEAM:${item.id}`), latestCondition: latest?.condition ?? null, latestObservedAt: latest?.observedAt ?? null }; });
  const equipmentRows = equipment.map(item => { const latest = currentCondition(updates, item.id); return { ...item, sample: sampleKeys.has(`EQUIPMENT:${item.id}`), latestCondition: latest?.condition ?? null, latestObservedAt: latest?.observedAt ?? null }; });
  const features = rawFeatures.map(item => { const latest = currentCondition(updates, item.id); const sample = sampleKeys.has(`FEATURE:${item.id}`) || item.layer.provider === 'SAMPLE'; return { id: item.id, name: item.name, kind: item.kind, provider: item.layer.provider, verifiedAt: item.layer.verifiedAt, authoritative: !sample && item.layer.verifiedAt !== null, sample, latestCondition: latest?.condition ?? null, latestObservedAt: latest?.observedAt ?? null }; });
  const assignmentRows = assignments.map(({ case: incident, team, ...item }) => ({ ...item, caseNumber: incident.number, caseTitle: incident.title, caseVerification: incident.verificationStatus, caseHandling: incident.handlingStatus, teamName: team.name, sample: sampleKeys.has(`TEAM:${item.teamId}`) }));
  return {
    asOf: now,
    teams: teamRows,
    equipment: equipmentRows,
    features,
    updates,
    assignments: assignmentRows,
    counts: {
      teams: teamRows.length,
      availableTeams: teamRows.filter(item => item.active && !item.sample && item.activeAssignmentCount === 0 && item.latestCondition === 'AVAILABLE' && fresh(item.latestObservedAt ?? undefined, now)).length,
      equipment: equipmentRows.length,
      availableEquipment: equipmentRows.filter(item => item.active && !item.sample && item.latestCondition === 'AVAILABLE' && fresh(item.latestObservedAt ?? undefined, now)).length,
      activeAssignments: assignmentRows.filter(item => ['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS'].includes(item.status) && !item.sample).length,
      access: features.filter(item => item.kind === 'ROAD').length,
      passableAccess: features.filter(item => item.kind === 'ROAD' && item.authoritative && item.latestCondition === 'PASSABLE' && fresh(item.latestObservedAt ?? undefined, now)).length,
      water: features.filter(item => ['RIVER', 'WATER_SOURCE'].includes(item.kind)).length,
      availableWater: features.filter(item => ['RIVER', 'WATER_SOURCE'].includes(item.kind) && item.authoritative && item.latestCondition === 'WATER_AVAILABLE' && fresh(item.latestObservedAt ?? undefined, now)).length,
    },
  };
}
export async function createTeam(actor: Actor, body: unknown, client: PrismaClient = db()) {
  const input = teamSchema.parse(body);
  const payloadHash = fingerprint({ actorId: actor.id, ...input });
  return client.$transaction(async tx => {
    await lockedActor(tx, actor, true);
    const existing = await tx.msTeam.findUnique({ where: { idempotencyKey: input.idempotencyKey }, select: { ...teamSelect, payloadHash: true } });
    if (existing) {
      if (existing.payloadHash !== payloadHash) throw new AppError('Team key already used for different content', 409, 'IDEMPOTENCY_CONFLICT');
      const { payloadHash: _hash, ...safe } = existing;
      return safe;
    }
    const { reason, idempotencyKey, ...data } = input;
    const item = await tx.msTeam.create({ data: { ...data, idempotencyKey, payloadHash }, select: teamSelect });
    await audit(tx, actor.id, 'TEAM_CREATED', 'TEAM', item.id, reason, { idempotencyKey, payloadHash });
    return item;
  });
}
export async function updateTeam(actor: Actor, id: string, body: unknown, client: PrismaClient = db()) {
  const input = teamPatchSchema.parse(body);
  return client.$transaction(async tx => {
    await lockedActor(tx, actor, true);
    await tx.$queryRaw`SELECT id FROM "MsTeam" WHERE id = ${id} FOR UPDATE`;
    const current = await tx.msTeam.findUniqueOrThrow({ where: { id }, select: teamSelect });
    assertVersion(current.version, input.version);
    if (await sampleTarget(tx, 'TEAM', id)) throw new AppError('Sample master records are read-only', 409, 'SAMPLE_DATA');
    if (input.active === false && await tx.trAssignment.count({ where: { teamId: id, status: { in: [...activeAssignments] } } })) throw new AppError('Complete or cancel active assignments before deactivating the team', 409, 'ACTIVE_ASSIGNMENTS');
    const { version, reason, ...data } = input;
    const changed = await tx.msTeam.updateMany({ where: { id, version }, data: { ...data, version: { increment: 1 }, updatedAt: new Date() } });
    if (!changed.count) throw new AppError('Record changed; reload before continuing', 409, 'VERSION_CONFLICT');
    const updated = await tx.msTeam.findUniqueOrThrow({ where: { id }, select: teamSelect });
    await audit(tx, actor.id, 'TEAM_UPDATED', 'TEAM', id, reason, { before: current, after: updated });
    return updated;
  });
}
export async function createEquipment(actor: Actor, body: unknown, client: PrismaClient = db()) {
  const input = equipmentSchema.parse(body);
  const payloadHash = fingerprint({ actorId: actor.id, ...input });
  return client.$transaction(async tx => {
    await lockedActor(tx, actor, true);
    const existing = await tx.msEquipment.findUnique({ where: { idempotencyKey: input.idempotencyKey }, select: { ...equipmentSelect, payloadHash: true } });
    if (existing) {
      if (existing.payloadHash !== payloadHash) throw new AppError('Equipment key already used for different content', 409, 'IDEMPOTENCY_CONFLICT');
      const { payloadHash: _hash, ...safe } = existing;
      return safe;
    }
    if (input.teamId && !await tx.msTeam.findFirst({ where: { id: input.teamId, active: true }, select: { id: true } })) throw new AppError('Team not available', 400, 'INVALID_TEAM');
    const { reason, idempotencyKey, ...data } = input;
    const item = await tx.msEquipment.create({ data: { ...data, idempotencyKey, payloadHash }, select: equipmentSelect });
    await audit(tx, actor.id, 'EQUIPMENT_CREATED', 'EQUIPMENT', item.id, reason, { idempotencyKey, payloadHash });
    return item;
  });
}
export async function updateEquipment(actor: Actor, id: string, body: unknown, client: PrismaClient = db()) {
  const input = equipmentPatchSchema.parse(body);
  return client.$transaction(async tx => {
    await lockedActor(tx, actor, true);
    await tx.$queryRaw`SELECT id FROM "MsEquipment" WHERE id = ${id} FOR UPDATE`;
    const current = await tx.msEquipment.findUniqueOrThrow({ where: { id }, select: equipmentSelect });
    assertVersion(current.version, input.version);
    if (await sampleTarget(tx, 'EQUIPMENT', id)) throw new AppError('Sample master records are read-only', 409, 'SAMPLE_DATA');
    if (input.teamId && !await tx.msTeam.findFirst({ where: { id: input.teamId, active: true }, select: { id: true } })) throw new AppError('Team not available', 400, 'INVALID_TEAM');
    const { version, reason, ...data } = input;
    const changed = await tx.msEquipment.updateMany({ where: { id, version }, data: { ...data, version: { increment: 1 }, updatedAt: new Date() } });
    if (!changed.count) throw new AppError('Record changed; reload before continuing', 409, 'VERSION_CONFLICT');
    const updated = await tx.msEquipment.findUniqueOrThrow({ where: { id }, select: equipmentSelect });
    await audit(tx, actor.id, 'EQUIPMENT_UPDATED', 'EQUIPMENT', id, reason, { before: current, after: updated });
    return updated;
  });
}
export async function addOperationalUpdate(actor: Actor, body: unknown, client: PrismaClient = db()) {
  const input = operationalSchema.parse(body);
  const payloadHash = fingerprint({ actorId: actor.id, ...input });
  return client.$transaction(async tx => {
    await lockedActor(tx, actor, true);
    const existing = await tx.trOperationalUpdate.findUnique({ where: { idempotencyKey: input.idempotencyKey }, select: { ...updateSelect, payloadHash: true } });
    if (existing) {
      if (existing.payloadHash !== payloadHash) throw new AppError('Operational update key already used for different content', 409, 'IDEMPOTENCY_CONFLICT');
      const { payloadHash: _hash, ...item } = existing;
      return { ...item, subjectId: item.teamId ?? item.equipmentId ?? item.featureId! };
    }
    let authoritative = true;
    if (input.subjectType === 'FEATURE') {
      const feature = await tx.msMapFeature.findUniqueOrThrow({ where: { id: input.subjectId }, include: { layer: { select: { provider: true, verifiedAt: true } } } });
      const road = ['PASSABLE', 'RESTRICTED', 'IMPASSABLE'];
      const water = ['WATER_AVAILABLE', 'WATER_UNAVAILABLE'];
      if ((road.includes(input.condition) && feature.kind !== 'ROAD') || (water.includes(input.condition) && !['WATER_SOURCE', 'RIVER'].includes(feature.kind))) throw new AppError('Condition does not apply to this feature', 400, 'INVALID_CONDITION');
      authoritative = feature.layer.provider !== 'SAMPLE' && feature.layer.verifiedAt !== null;
      if (!authoritative && (feature.layer.provider !== 'SAMPLE' || input.condition !== 'UNKNOWN')) throw new AppError('Unverified map features cannot provide operational routing status', 409, 'UNVERIFIED_FEATURE');
    } else {
      const targetType = input.subjectType;
      if (targetType === 'TEAM') {
        await tx.$queryRaw`SELECT id FROM "MsTeam" WHERE id = ${input.subjectId} FOR UPDATE`;
        if (!await tx.msTeam.findFirst({ where: { id: input.subjectId, active: true }, select: { id: true } })) throw new AppError('Team not available', 400, 'INVALID_TEAM');
      } else {
        await tx.$queryRaw`SELECT id FROM "MsEquipment" WHERE id = ${input.subjectId} FOR UPDATE`;
        if (!await tx.msEquipment.findFirst({ where: { id: input.subjectId, active: true }, select: { id: true } })) throw new AppError('Equipment not available', 400, 'INVALID_EQUIPMENT');
      }
      if (await sampleTarget(tx, targetType, input.subjectId)) {
        authoritative = false;
        if (input.condition !== 'UNKNOWN') throw new AppError('Sample records cannot claim operational availability', 409, 'SAMPLE_DATA');
      }
    }
    const { subjectId, reason, idempotencyKey, ...data } = input;
    const item = await tx.trOperationalUpdate.create({ data: { ...data, observedAt: new Date(data.observedAt), recorderId: actor.id, idempotencyKey, payloadHash, teamId: data.subjectType === 'TEAM' ? subjectId : undefined, equipmentId: data.subjectType === 'EQUIPMENT' ? subjectId : undefined, featureId: data.subjectType === 'FEATURE' ? subjectId : undefined }, select: updateSelect });
    if (authoritative) await tx.trCase.updateMany({ where: { handlingStatus: { not: 'CLOSED' } }, data: { contextRevision: { increment: 1 }, version: { increment: 1 }, latestAnalysisId: null, updatedAt: new Date() } });
    await audit(tx, actor.id, 'OPERATIONAL_UPDATE_ADDED', data.subjectType, subjectId, reason, { operationalUpdateId: item.id, idempotencyKey, payloadHash, authoritative });
    return { ...item, subjectId };
  });
}
