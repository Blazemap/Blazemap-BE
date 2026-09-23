import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { db } from '../../config/index.js';
import { caseSchema, casePatchSchema, fieldSchema, verificationSchema, reviewSchema, reportActionSchema, paginationSchema, assignmentSchema, assignmentPatchSchema, teamSchema, teamPatchSchema, equipmentSchema, equipmentPatchSchema, operationalSchema, operationalFeatureSchema, adminUserPatchSchema, handlingStatuses, verificationStatuses, priorities, reviewerAssessmentSource, type Actor, type Transaction } from '../../types/index.js';
import { AppError, fingerprint, jsonValue } from '../../utils/index.js';
import { areaHectares, polygonSchema } from '../../utils/geometry.js';
import { attach } from '../uploads/uploads.service.js';
import { loadWindContext } from '../integrations/wind.js';
import { buildExposure } from '../integrations/exposure.js';
import { citationSources } from '../integrations/citations.js';
import { progressSelect, reportDto, reportInclude } from '../reports/reports.service.js';
import { recordCaseProgress } from '../reports/progress.js';
import { createReportNotification } from '../notifications/index.js';
import { evaluateNearby, lockNearbyWorkflow } from '../notifications/nearby.service.js';
import { activeAssignments, audit, bumpContext, lockedActor, verifiedRegion } from './access.js';
import { assertCaseOpen, assertVersion, effectiveCapabilities, transition, verificationProjection } from './rules.js';
import { applicationAdminAuthority, isAssignedConfirmationEvidence, normalizeVerification, recordConfirmedCase } from './confirmation.service.js';

export const caseSelect = { id: true, number: true, title: true, latitude: true, longitude: true, regionId: true, verificationStatus: true, handlingStatus: true, priority: true, priorityReason: true, version: true, contextRevision: true, latestAnalysisId: true, openedAt: true, updatedAt: true, closedAt: true, closureReason: true, completionFieldUpdateId: true } as const;
export async function listCases(query: unknown) {
  const { page, pageSize, search, handlingStatus, verificationStatus, priority, regionId } = paginationSchema.extend({ handlingStatus: z.enum(handlingStatuses).optional(), verificationStatus: z.enum(verificationStatuses).optional(), priority: z.enum(priorities).optional() }).parse(query);
  const where = { handlingStatus: handlingStatus ?? { not: 'CLOSED' as const }, verificationStatus, priority, regionId, ...(search ? { OR: [{ title: { contains: search, mode: 'insensitive' as const } }, { number: { contains: search } }] } : {}) };
  const [rows, total] = await db().$transaction([db().trCase.findMany({ where, select: { ...caseSelect, perimeter: true, perimeterRevision: true }, orderBy: [{ priority: 'asc' }, { updatedAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }), db().trCase.count({ where })]);
  const data = rows.map(row => {
    const perimeter = row.verificationStatus === 'CONFIRMED_FIRE' ? polygonSchema.safeParse(row.perimeter) : null;
    return { ...row, perimeter: perimeter?.success ? perimeter.data : null };
  });
  return { data, meta: { total, page, pageSize } };
}
export async function getCase(id: string, actor?: Actor) {
  const c = await db().trCase.findUnique({ where: { id }, select: { ...caseSelect, perimeter: true, perimeterObservedAt: true, perimeterSource: true, perimeterRevision: true,
    region: { select: { id: true, name: true, timezone: true, level: true, verifiedAt: true } },
    reports: { include: reportInclude, orderBy: { observedAt: 'desc' }, take: 100 },
    fieldUpdates: { select: { id: true, findings: true, description: true, source: true, provenance: true, sourceReportId: true, teamId: true, assignmentId: true, assignment: { select: { id: true, status: true, team: { select: { id: true, name: true } } } }, observedAt: true, createdAt: true, latitude: true, longitude: true, attachments: { select: { id: true, filename: true, contentType: true, size: true } } }, take: 100, orderBy: { observedAt: 'desc' } },
    verifications: { select: { id: true, outcome: true, previousStatus: true, newStatus: true, reason: true, authorityReference: true, fieldUpdateId: true, correctedDecisionId: true, createdAt: true }, take: 100, orderBy: { createdAt: 'desc' } },
    analyses: { select: { id: true, input: true, contextRevision: true, status: true, output: true, evidenceLevel: true, impactLevel: true, suggestedPriority: true, model: true, schemaVersion: true, promptVersion: true, ruleVersion: true, failureCode: true, startedAt: true, completedAt: true }, take: 20, orderBy: { startedAt: 'desc' } },
    assignments: { select: { id: true, caseId: true, teamId: true, status: true, notes: true, acceptedAt: true, startedAt: true, completedAt: true, cancelledAt: true, createdAt: true, updatedAt: true, team: { select: { id: true, name: true } } }, take: 100, orderBy: { createdAt: 'desc' } },
    publications: { where: { type: 'UPDATE', outcome: null, status: { in: ['DRAFT', 'PUBLISHED'] }, caseDraftKey: null }, select: { id: true, slug: true, title: true, summary: true, body: true, bodyRich: true, updatedAt: true, publishedAt: true, validUntil: true, status: true, sources: true, publicLocationMode: true, privacyReview: true, supersedesId: true, regions: { select: { region: { select: { id: true, name: true, timezone: true } } } } }, take: 1, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }] },
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
  const { forecast, windContext, weather: weatherResolution } = await loadWindContext(db(), c, new Date());
  const weather = forecast && windContext.forecast ? [{ ...windContext.forecast, temperature: forecast.temperature, humidity: forecast.humidity, windSpeed: windContext.windSpeedKmh, windSpeedUnit: 'km/h', windFromDegrees: windContext.windFromDegrees, windToDegrees: windContext.windToDegrees, directionPrecision: 'DEGREES', measurementType: 'CURRENT_CONDITIONS', attribution: forecast.attribution, stale: windContext.stale }] : [];
  const spatialContext = c.regionId ? await db().msMapFeature.findMany({ where: { regionId: c.regionId, layer: { verifiedAt: { not: null } } }, select: { id: true, name: true, kind: true, layerId: true, geometry: true, attributes: true, layer: { select: { provider: true, license: true, attribution: true, sourceDate: true, importedAt: true, verifiedAt: true, version: true } } }, take: 100 }) : [];
  const conditions = spatialContext.length ? await db().trOperationalUpdate.findMany({ where: { featureId: { in: spatialContext.map(f => f.id) }, observedAt: { lte: new Date() } }, distinct: ['featureId'], orderBy: [{ featureId: 'asc' }, { observedAt: 'desc' }], select: { id: true, featureId: true, condition: true, source: true, observedAt: true }, take: 100 }) : [];
  const exposure = buildExposure(c, spatialContext, conditions, windContext);
  const perimeter = polygonSchema.safeParse(c.perimeter);
  const currentActor = actor ? await db().msUser.findUnique({ where: { id: actor.id }, select: { role: true, active: true, emailVerified: true } }) : null;
  const activeAssignmentCount = await db().trAssignment.count({ where: { caseId: id, status: { in: [...activeAssignments] } } });
  const { publications, ...caseDetail } = c;
  const publication = publications[0];
  const activePublication = publication ? (() => { const { privacyReview, regions, ...value } = publication; return { ...value, privacyReviewed: !!privacyReview?.trim(), regions: regions.map(item => item.region) }; })() : null;
  return { ...caseDetail, activePublication, analyses: c.analyses.map(({ input, ...analysis }) => ({ ...analysis, sources: citationSources(input) })), operatorAuthorityConfigured: !!currentActor && effectiveCapabilities(currentActor).canConfirmIncidents, activeAssignmentCount, areaHectares: perimeter.success ? areaHectares(perimeter.data) : null, reports: c.reports.map(reportDto), priorityHistory, timeline: timeline.map(({ actor: _actor, ...entry }) => entry), weather, weatherResolution, windContext, spatialContext, exposure };
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
    await lockNearbyWorkflow(tx);
    const user = await lockedActor(tx, actor, true, 'perimeter' in input ? 'canConfirmIncidents' : undefined);
    if ('perimeter' in input) {
      const verified = await tx.msUser.findUnique({ where: { id: user.id }, select: { emailVerified: true } });
      if (!verified?.emailVerified) throw new AppError('Verified administrator required', 403, 'FORBIDDEN');
    }
    await tx.$queryRaw`SELECT id FROM "TrCase" WHERE id = ${id} FOR UPDATE`;
    const c = await tx.trCase.findUniqueOrThrow({ where: { id } });
    assertVersion(c.version, input.version);
    assertCaseOpen(c);
    if ('perimeter' in input) {
      if (c.verificationStatus !== 'CONFIRMED_FIRE') throw new AppError('Perimeter requires a confirmed fire', 409, 'INVALID_TRANSITION');
      const data = await tx.trCase.update({ where: { id, version: input.version }, data: { perimeter: jsonValue(input.perimeter), perimeterObservedAt: new Date(input.perimeterObservedAt), perimeterSource: input.perimeterSource, perimeterRevision: { increment: 1 }, version: { increment: 1 }, contextRevision: { increment: 1 }, latestAnalysisId: null }, select: { ...caseSelect, perimeter: true, perimeterObservedAt: true, perimeterSource: true, perimeterRevision: true } });
      await audit(tx, actor.id, 'CASE_PERIMETER_UPDATED', 'CASE', id, input.reason, { authorityReference: input.authorityReference, authorityBasis: 'APPLICATION_ADMIN_ROLE', authorityNoteSource: 'OPERATOR_SUPPLIED', before: { perimeter: c.perimeter, observedAt: c.perimeterObservedAt, source: c.perimeterSource, revision: c.perimeterRevision }, after: { perimeter: data.perimeter, observedAt: data.perimeterObservedAt, source: data.perimeterSource, revision: data.perimeterRevision }, areaHectares: areaHectares(input.perimeter) });
      await recordCaseProgress(tx, id, actor.id, 'CASE_REVISION', input.reporterMessage);
      return { ...data, areaHectares: areaHectares(input.perimeter) };
    }
    const handling = input.handlingStatus ?? c.handlingStatus;
    const count = await tx.trAssignment.count({ where: { caseId: id, status: { in: [...activeAssignments] } } });
    transition(c.verificationStatus, handling, count);
    if (handling === 'CLOSED' && c.handlingStatus !== 'CLOSED') {
      if (!input.completionFieldUpdateId) throw new AppError('Select recorded completion evidence', 400, 'INVALID_COMPLETION_EVIDENCE');
      const evidence = await tx.trFieldUpdate.findFirst({ where: { id: input.completionFieldUpdateId, caseId: id }, select: { id: true, source: true, description: true, observedAt: true } });
      if (!evidence || evidence.source === reviewerAssessmentSource || evidence.source.trim().length < 3 || evidence.description.trim().length < 5 || evidence.observedAt > new Date()) throw new AppError('Select actual recorded completion evidence from this case', 400, 'INVALID_COMPLETION_EVIDENCE');
      await audit(tx, actor.id, 'CASE_COMPLETION_EVIDENCE', 'CASE', id, input.reason, { fieldUpdateId: evidence.id, source: evidence.source, observedAt: evidence.observedAt });
    }
    const data = await tx.trCase.update({ where: { id, version: input.version }, data: { priority: input.priority, priorityReason: input.priority ? input.reason : undefined, handlingStatus: handling, closedAt: handling === 'CLOSED' ? c.closedAt ?? new Date() : null, closureReason: handling === 'CLOSED' ? c.handlingStatus === 'CLOSED' ? c.closureReason : input.reason : null, completionFieldUpdateId: handling === 'CLOSED' ? c.handlingStatus === 'CLOSED' ? c.completionFieldUpdateId : input.completionFieldUpdateId : null, version: { increment: 1 }, contextRevision: { increment: 1 }, latestAnalysisId: null }, select: caseSelect });
    if (handling !== c.handlingStatus) await recordCaseProgress(tx, id, actor.id, handling, input.reporterMessage);
    if (input.priority && input.priority !== c.priority && input.reporterMessage) await recordCaseProgress(tx, id, actor.id, 'CASE_REVISION', input.reporterMessage);
    if (input.priority && priorities.indexOf(input.priority) < priorities.indexOf(c.priority) && c.priority !== 'UNASSESSED') await evaluateNearby(tx, undefined, undefined, { caseId: id, version: data.version });
    await audit(tx, actor.id, 'CASE_UPDATED', 'CASE', id, input.reason, { before: { priority: c.priority, handlingStatus: c.handlingStatus }, after: { priority: data.priority, handlingStatus: data.handlingStatus } });
    return data;
  }, { maxWait: 10000, timeout: 30000 });
}
export async function addFieldUpdate(actor: Actor, id: string, body: unknown, client: PrismaClient = db()) {
  const { attachmentIds, ...input } = fieldSchema.parse(body);
  return client.$transaction(async tx => {
    await lockedActor(tx, actor, true);
    const c = await tx.trCase.findUniqueOrThrow({ where: { id }, select: { handlingStatus: true } });
    assertCaseOpen(c);
    let assignedTeamId = input.teamId ?? null;
    if (input.assignmentId) {
      await tx.$queryRaw`SELECT id FROM "TrAssignment" WHERE id = ${input.assignmentId} FOR SHARE`;
      const assignment = await tx.trAssignment.findFirst({ where: { id: input.assignmentId, caseId: id, status: { in: ['ACCEPTED', 'IN_PROGRESS', 'COMPLETED'] } }, select: { teamId: true } });
      if (!assignment || input.teamId && input.teamId !== assignment.teamId) throw new AppError('Field result must reference an eligible assignment from this case', 409, 'INVALID_ASSIGNMENT_EVIDENCE');
      if (await sampleTarget(tx, 'TEAM', assignment.teamId)) throw new AppError('Sample teams cannot provide operational evidence', 409, 'SAMPLE_DATA');
      assignedTeamId = assignment.teamId;
    }
    const item = await tx.trFieldUpdate.create({ data: { ...input, teamId: assignedTeamId, observedAt: new Date(input.observedAt), caseId: id, recorderId: actor.id }, select: { id: true, findings: true, description: true, source: true, observedAt: true, createdAt: true, latitude: true, longitude: true, teamId: true, assignmentId: true } });
    await attach(tx, actor, attachmentIds, { fieldUpdateId: item.id });
    await bumpContext(tx, id);
    await audit(tx, actor.id, 'FIELD_UPDATE_ADDED', 'CASE', id, undefined, { fieldUpdateId: item.id });
    return item;
  });
}
export async function verifyCase(actor: Actor, id: string, body: unknown, client: PrismaClient = db()) {
  const input = normalizeVerification(verificationSchema.parse(body));
  return client.$transaction(async tx => {
    await lockNearbyWorkflow(tx);
    await lockedActor(tx, actor, true, 'canConfirmIncidents');
    await tx.$queryRaw`SELECT id FROM "TrCase" WHERE id = ${id} FOR UPDATE`;
    const c = await tx.trCase.findUniqueOrThrow({ where: { id } });
    assertVersion(c.version, input.version);
    assertCaseOpen(c);
    const observation = await tx.trFieldUpdate.findFirst({ where: { id: input.observationId, caseId: id }, include: { assignment: { select: { id: true, caseId: true, teamId: true, status: true } } } });
    if (!observation) throw new AppError('Verification requires a reviewed observation from this case', 400, 'INVALID_EVIDENCE');
    if (input.outcome === 'CONFIRMED_FIRE' && (observation.source === reviewerAssessmentSource || !isAssignedConfirmationEvidence(observation, id))) throw new AppError('Confirmation requires a coordinate-backed visible-fire result from an assigned team', 409, 'INSUFFICIENT_EVIDENCE');
    if (input.outcome === 'NOT_FIRE' && (observation.findings !== 'NO_INDICATION' || observation.latitude === null || observation.longitude === null || observation.source === reviewerAssessmentSource)) throw new AppError('Rejection requires a coordinate-backed no-indication observation', 409, 'INSUFFICIENT_EVIDENCE');
    if (!Number.isFinite(observation.observedAt.getTime()) || observation.observedAt > new Date() || observation.source.trim().length < 3) throw new AppError('Actual past observation time and source are required', 400, 'INVALID_EVIDENCE');
    const next = input.outcome === 'INCONCLUSIVE' ? c.verificationStatus : input.outcome;
    const correction = c.verificationStatus !== 'UNVERIFIED' && next !== c.verificationStatus;
    if (correction) {
      const publications = await tx.trPublicInformation.count({ where: { caseId: id, status: 'PUBLISHED' } });
      if (publications) throw new AppError('Withdraw existing public case claims before correcting verification', 409, 'PUBLICATION_REVIEW_REQUIRED');
    }
    const prior = correction ? await tx.trVerification.findFirst({ where: { caseId: id, outcome: { not: 'INCONCLUSIVE' } }, orderBy: { createdAt: 'desc' } }) : null;
    if (input.outcome === 'CONFIRMED_FIRE') return recordConfirmedCase(tx, {
      actorId: actor.id,
      current: c,
      observation,
      decisionNote: input.decisionNote,
      privateReason: input.privateReason,
      perimeter: input.perimeter,
      boundaryUsesObservationSourceTime: input.boundaryUsesObservationSourceTime,
      perimeterObservedAt: input.perimeterObservedAt,
      perimeterSource: input.perimeterSource,
      correction,
      correctedDecisionId: prior?.id ?? null,
      recordOwnerProgress: true,
    });
    await tx.trVerification.create({ data: { caseId: id, decidingAdminId: actor.id, fieldUpdateId: observation.id, authorityReference: applicationAdminAuthority, outcome: correction ? 'CORRECTION' : input.outcome, previousStatus: c.verificationStatus, newStatus: next, reason: input.privateReason ?? input.decisionNote, correctedDecisionId: prior?.id } });
    const projected = verificationProjection({ verificationStatus: c.verificationStatus, handlingStatus: c.handlingStatus, latitude: c.latitude, longitude: c.longitude }, input.outcome, { latitude: observation.latitude, longitude: observation.longitude });
    const result = await tx.trCase.update({ where: { id, version: input.version }, data: { verificationStatus: projected.verificationStatus, handlingStatus: projected.handlingStatus, latitude: projected.latitude, longitude: projected.longitude, version: { increment: 1 }, contextRevision: { increment: 1 }, latestAnalysisId: null }, select: caseSelect });
    if (input.outcome === 'INCONCLUSIVE' || next !== c.verificationStatus) await recordCaseProgress(tx, id, actor.id, correction ? `CORRECTION_${next}` : input.outcome, input.decisionNote);
    await audit(tx, actor.id, correction ? 'VERIFICATION_CORRECTED' : 'VERIFICATION_RECORDED', 'CASE', id, input.privateReason ?? input.decisionNote, { outcome: input.outcome, previousStatus: c.verificationStatus, newStatus: next, authorityReference: applicationAdminAuthority, authorityBasis: applicationAdminAuthority, authorityNoteSource: 'SERVER_DERIVED', observationId: observation.id, observationProvenance: observation.provenance, sourceReportId: observation.sourceReportId, independentFieldObservation: observation.provenance === 'FIELD_OBSERVATION' });
    return result;
  }, { maxWait: 10000, timeout: 30000 });
}
export async function reviewReport(actor: Actor, id: string, body: unknown, client: PrismaClient = db()) {
  const input = reviewSchema.parse(body);
  return client.$transaction(async tx => {
    await lockedActor(tx, actor, true);
    await tx.$queryRaw`SELECT id FROM "TrReport" WHERE id = ${id} FOR UPDATE`;
    const report = await tx.trReport.findUniqueOrThrow({ where: { id } });
    if (input.reviewStatus && report.caseId && await tx.trReport.count({ where: { caseId: report.caseId } }) > 1) throw new AppError('This report belongs to a grouped case; edit the case instead', 409, 'EDIT_CASE_REQUIRED');
    const caseIds = [...new Set([report.caseId, input.caseId].filter((v): v is string => !!v))].sort();
    for (const caseId of caseIds) await tx.$queryRaw`SELECT id FROM "TrCase" WHERE id = ${caseId} FOR UPDATE`;
    for (const caseId of caseIds) assertCaseOpen(await tx.trCase.findUniqueOrThrow({ where: { id: caseId }, select: { handlingStatus: true } }));
    if (input.caseId && input.caseId !== report.caseId) {
      const target = await tx.trCase.findUniqueOrThrow({ where: { id: input.caseId } });
      if (target.verificationStatus === 'NOT_FIRE') throw new AppError('Correct the case before linking new evidence', 409, 'CASE_REVIEW_REQUIRED');
    }
    if (input.reviewStatus === 'UNDER_REVIEW' && report.reviewStatus === 'UNDER_REVIEW') throw new AppError('Review has already started or finished', 409, 'INVALID_TRANSITION');
    const item = await tx.trReport.update({ where: { id }, data: { reviewStatus: input.reviewStatus, caseId: input.caseId }, include: reportInclude });
    if (input.caseId && input.caseId !== report.caseId && input.reviewStatus === undefined) {
      const progressId = randomUUID();
      await tx.trReportProgress.create({ data: { id: progressId, reportId: id, actorId: actor.id, stage: 'OPEN', description: input.reason } });
      await createReportNotification(tx, { eventKey: `progress:${progressId}`, reportId: id, userId: item.reporterId, type: 'REPORT_HANDLING', stage: 'OPEN', message: input.reason });
    }
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
    await lockedActor(tx, actor, true);
    await tx.$queryRaw`SELECT id FROM "TrReport" WHERE id = ${id} FOR UPDATE`;
    const report = await tx.trReport.findUniqueOrThrow({ where: { id } });
    if (report.caseId) {
      await tx.$queryRaw`SELECT id FROM "TrCase" WHERE id = ${report.caseId} FOR UPDATE`;
      assertCaseOpen(await tx.trCase.findUniqueOrThrow({ where: { id: report.caseId }, select: { handlingStatus: true } }));
      if (await tx.trReport.count({ where: { caseId: report.caseId } }) > 1) throw new AppError('This report belongs to a grouped case; edit the case instead', 409, 'EDIT_CASE_REQUIRED');
    }
    const existing = await tx.trReportProgress.findUnique({ where: { actorId_idempotencyKey: { actorId: actor.id, idempotencyKey: input.idempotencyKey } }, select: { ...progressSelect, payloadHash: true, reportId: true } });
    if (existing) {
      if (existing.payloadHash !== hash || existing.reportId !== id) throw new AppError('Action key already used for different content', 409, 'IDEMPOTENCY_CONFLICT');
      const { payloadHash: _hash, reportId: _reportId, ...safe } = existing;
      return safe;
    }
    const reviewStatus = input.status === 'IN_PROGRESS' ? 'UNDER_REVIEW' : input.status;
    const progress = await tx.trReportProgress.create({ data: { reportId: id, actorId: actor.id, stage: reviewStatus, description: input.description, idempotencyKey: input.idempotencyKey, payloadHash: hash } });
    await attach(tx, actor, input.attachmentIds, { reportProgressId: progress.id });
    await tx.trReport.update({ where: { id }, data: { reviewStatus } });
    if (report.caseId && reviewStatus !== report.reviewStatus) await bumpContext(tx, report.caseId);
    await createReportNotification(tx, { eventKey: `progress:${progress.id}`, reportId: id, type: 'REPORT_STATUS', stage: reviewStatus, message: input.description });
    await audit(tx, actor.id, 'REPORT_ACTION_RECORDED', 'REPORT', id, input.description, { status: input.status, progressId: progress.id, caseId: report.caseId, attachmentCount: input.attachmentIds.length });
    return tx.trReportProgress.findUniqueOrThrow({ where: { id: progress.id }, select: progressSelect });
  }, { maxWait: 2000, timeout: 15000 });
}
const assignmentSelect = { id: true, caseId: true, teamId: true, status: true, notes: true, version: true, acceptedAt: true, startedAt: true, completedAt: true, cancelledAt: true, createdAt: true, updatedAt: true } as const;
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
    assertCaseOpen(c);
    if (c.verificationStatus === 'NOT_FIRE') throw new AppError('Case must be open for investigation or response', 409, 'INVALID_TRANSITION');
    const team = await tx.msTeam.findFirst({ where: { id: input.teamId, active: true } });
    if (!team) throw new AppError('Team not available', 400, 'INVALID_TEAM');
    const sample = await tx.trAuditLog.findFirst({ where: { systemActor: 'sample-operations-v1', action: 'SAMPLE_OPERATION_CREATED', targetType: 'TEAM', targetId: team.id }, select: { id: true } });
    if (sample) throw new AppError('Sample teams cannot be assigned to operational cases', 409, 'SAMPLE_DATA');
    if (await tx.trAssignment.count({ where: { teamId: team.id, status: { in: [...activeAssignments] } } })) throw new AppError('Team already has an active assignment; complete or cancel it first', 409, 'TEAM_BUSY');
    const latest = await tx.trOperationalUpdate.findFirst({ where: { teamId: team.id }, orderBy: [{ observedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }] });
    if (!latest || latest.condition !== 'AVAILABLE' || !fresh(latest.observedAt, new Date())) throw new AppError('Record a current team availability update before assigning', 409, 'TEAM_STATUS_UNKNOWN');
    const { reason, idempotencyKey, version: _version, ...data } = input;
    const item = await tx.trAssignment.create({ data: { ...data, caseId: id, assigningAdminId: actor.id, idempotencyKey, payloadHash }, select: assignmentSelect });
    await tx.trOperationalUpdate.create({ data: { recorderId: actor.id, subjectType: 'TEAM', teamId: team.id, condition: 'DEPLOYED', source: `Assignment ${item.id} to ${c.number}`, observedAt: new Date(), notes: input.notes, idempotencyKey: `assignment:${item.id}:deployed`, payloadHash } });
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
    assertCaseOpen(await tx.trCase.findUniqueOrThrow({ where: { id: item.caseId }, select: { handlingStatus: true } }));
    if (await sampleTarget(tx, 'TEAM', item.teamId)) throw new AppError('Sample assignments are read-only', 409, 'SAMPLE_DATA');
    const allowed: Record<string, readonly string[]> = { ASSIGNED: ['ACCEPTED', 'CANCELLED'], ACCEPTED: ['IN_PROGRESS', 'CANCELLED'], IN_PROGRESS: ['COMPLETED', 'CANCELLED'] };
    if (!allowed[item.status]?.includes(input.status)) throw new AppError('Only the next assignment stage or cancellation is allowed', 409, 'INVALID_TRANSITION');
    if (input.status === 'COMPLETED') {
      const result = await tx.trFieldUpdate.findFirst({ where: { id: input.fieldUpdateId, assignmentId: id, caseId: item.caseId, teamId: item.teamId }, select: { id: true } });
      if (!result) throw new AppError('Completion requires a field result from this assignment', 409, 'ASSIGNMENT_RESULT_REQUIRED');
    }
    const now = new Date();
    const timestamps = input.status === 'ACCEPTED' ? { acceptedAt: now } : input.status === 'IN_PROGRESS' ? { startedAt: now } : input.status === 'COMPLETED' ? { completedAt: now } : input.status === 'CANCELLED' ? { cancelledAt: now } : {};
    const changed = await tx.trAssignment.updateMany({ where: { id, version: input.version }, data: { status: input.status, ...timestamps, version: { increment: 1 } } });
    if (!changed.count) throw new AppError('Record changed; reload before continuing', 409, 'VERSION_CONFLICT');
    const updated = await tx.trAssignment.findUniqueOrThrow({ where: { id }, select: assignmentSelect });
    await bumpContext(tx, item.caseId);
    await audit(tx, actor.id, 'ASSIGNMENT_UPDATED', 'CASE', item.caseId, input.reason, { assignmentId: id, before: { status: item.status, version: item.version }, after: { status: updated.status, version: updated.version } });
    return updated;
  });
}
const adminUserSelect = { id: true, name: true, email: true, image: true, emailVerified: true, role: true, active: true, createdAt: true, updatedAt: true } as const;
const adminUserDto = (user: { id: string; name: string; email: string; image: string | null; emailVerified: boolean; role: string; active: boolean; createdAt: Date; updatedAt: Date }) => ({ ...user, ...effectiveCapabilities(user) });
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
  const byPriority = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNASSESSED: 0 };
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
    tx.trAssignment.findMany({ select: { ...assignmentSelect, fieldUpdates: { select: { id: true, findings: true, observedAt: true }, orderBy: { observedAt: 'desc' }, take: 1 }, case: { select: { number: true, title: true, verificationStatus: true, handlingStatus: true } }, team: { select: { name: true } } }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }] }),
    tx.msMapFeature.findMany({ where: { kind: { in: ['ROAD', 'RIVER', 'WATER_SOURCE', 'DESIGNATED_LOCATION'] } }, select: { id: true, name: true, kind: true, geometry: true, layer: { select: { provider: true, verifiedAt: true } } }, take: 300, orderBy: { name: 'asc' } }),
    tx.trAuditLog.findMany({ where: { systemActor: sampleActor, action: 'SAMPLE_OPERATION_CREATED', targetType: { in: ['TEAM', 'EQUIPMENT', 'FEATURE', 'OPERATIONAL_UPDATE'] } }, select: { targetType: true, targetId: true } }),
  ]), { isolationLevel: 'RepeatableRead', maxWait: 10000, timeout: 30000 });
  const sampleKeys = new Set(sampleAudits.map(item => `${item.targetType}:${item.targetId}`));
  const updates = rawUpdates.flatMap(value => sampleKeys.has(`OPERATIONAL_UPDATE:${value.id}`) ? [] : [{ ...value, subjectId: value.teamId ?? value.equipmentId ?? value.featureId!, sample: false }]);
  const assignmentRows = assignments.flatMap(({ case: incident, team, fieldUpdates, ...item }) => sampleKeys.has(`TEAM:${item.teamId}`) ? [] : [{ ...item, sample: false, result: fieldUpdates[0] ?? null, caseNumber: incident.number, caseTitle: incident.title, caseVerification: incident.verificationStatus, caseHandling: incident.handlingStatus, teamName: team.name }]);
  const teamRows = teams.flatMap(({ updates: history, _count, ...item }) => {
    if (sampleKeys.has(`TEAM:${item.id}`)) return [];
    const latest = history[0], historyAssignments = assignmentRows.filter(assignment => assignment.teamId === item.id);
    const completed = historyAssignments.filter(assignment => assignment.status === 'COMPLETED');
    const durations = completed.flatMap(assignment => assignment.startedAt && assignment.completedAt ? [assignment.completedAt.getTime() - assignment.startedAt.getTime()] : []);
    return [{ ...item, sample: false, activeAssignmentCount: _count.assignments, latestCondition: latest?.condition ?? null, latestObservedAt: latest?.observedAt ?? null, performance: { totalAssignments: historyAssignments.length, completedAssignments: completed.length, cancelledAssignments: historyAssignments.filter(assignment => assignment.status === 'CANCELLED').length, fieldResults: historyAssignments.filter(assignment => assignment.result).length, averageCompletionMinutes: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length / 60000) : null } }];
  });
  const equipmentRows = equipment.flatMap(item => {
    if (sampleKeys.has(`EQUIPMENT:${item.id}`)) return [];
    const latest = currentCondition(updates, item.id), currentAssignment = item.teamId ? assignmentRows.find(assignment => assignment.teamId === item.teamId && activeAssignments.includes(assignment.status as typeof activeAssignments[number])) : undefined;
    return [{ ...item, sample: false, latestCondition: latest?.condition ?? null, latestObservedAt: latest?.observedAt ?? null, currentAssignment: currentAssignment ? { id: currentAssignment.id, caseId: currentAssignment.caseId, caseNumber: currentAssignment.caseNumber, caseTitle: currentAssignment.caseTitle, status: currentAssignment.status } : null }];
  });
  const features = rawFeatures.flatMap(item => {
    const latest = currentCondition(updates, item.id), sample = sampleKeys.has(`FEATURE:${item.id}`) || item.layer.provider === 'SAMPLE';
    if (sample) return [];
    const point = z.object({ type: z.literal('Point'), coordinates: z.tuple([z.number().finite(), z.number().finite()]) }).safeParse(item.geometry);
    const line = z.object({ type: z.literal('LineString'), coordinates: z.array(z.tuple([z.number().finite(), z.number().finite()])).min(2) }).safeParse(item.geometry);
    const coordinates = point.success ? point.data.coordinates : line.success ? line.data.coordinates[Math.floor(line.data.coordinates.length / 2)]! : null;
    return coordinates ? [{ id: item.id, name: item.name, kind: item.kind, latitude: coordinates[1], longitude: coordinates[0], provider: item.layer.provider, verifiedAt: item.layer.verifiedAt, authoritative: item.layer.verifiedAt !== null, sample: false, latestCondition: latest?.condition ?? null, latestObservedAt: latest?.observedAt ?? null }] : [];
  });
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
function operationalUpdateDto(item: { id: string; subjectType: string; teamId: string | null; equipmentId: string | null; featureId: string | null; condition: string; source: string; observedAt: Date; notes: string | null; createdAt: Date }) {
  return { ...item, subjectType: item.subjectType as 'TEAM' | 'EQUIPMENT' | 'FEATURE', subjectId: item.teamId ?? item.equipmentId ?? item.featureId!, sample: false };
}
export async function getTeam(id: string, client: PrismaClient = db()) {
  const [item, assignments, updates, sample] = await Promise.all([
    client.msTeam.findUnique({ where: { id }, select: { ...teamSelect, _count: { select: { assignments: { where: { status: { in: [...activeAssignments] } } } } } } }),
    client.trAssignment.findMany({ where: { teamId: id }, select: { status: true, startedAt: true, completedAt: true, fieldUpdates: { select: { id: true }, take: 1 } } }),
    client.trOperationalUpdate.findMany({ where: { teamId: id }, select: updateSelect, take: 100, orderBy: [{ observedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }] }),
    client.trAuditLog.findFirst({ where: { systemActor: sampleActor, action: 'SAMPLE_OPERATION_CREATED', targetType: 'TEAM', targetId: id }, select: { id: true } }),
  ]);
  if (!item || sample) throw new AppError('Team not found', 404, 'NOT_FOUND');
  const completed = assignments.filter(value => value.status === 'COMPLETED');
  const durations = completed.flatMap(value => value.startedAt && value.completedAt ? [value.completedAt.getTime() - value.startedAt.getTime()] : []);
  const latest = updates[0];
  return { item: { ...item, _count: undefined, sample: false, activeAssignmentCount: item._count.assignments, latestCondition: latest?.condition ?? null, latestObservedAt: latest?.observedAt ?? null, performance: { totalAssignments: assignments.length, completedAssignments: completed.length, cancelledAssignments: assignments.filter(value => value.status === 'CANCELLED').length, fieldResults: assignments.filter(value => value.fieldUpdates.length).length, averageCompletionMinutes: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length / 60000) : null } }, updates: updates.map(operationalUpdateDto) };
}
export async function getEquipment(id: string, client: PrismaClient = db()) {
  const [item, updates, teams, sample] = await Promise.all([
    client.msEquipment.findUnique({ where: { id }, select: equipmentSelect }),
    client.trOperationalUpdate.findMany({ where: { equipmentId: id }, select: updateSelect, take: 100, orderBy: [{ observedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }] }),
    client.msTeam.findMany({ where: { active: true }, select: { id: true, name: true, active: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
    client.trAuditLog.findFirst({ where: { systemActor: sampleActor, action: 'SAMPLE_OPERATION_CREATED', targetType: 'EQUIPMENT', targetId: id }, select: { id: true } }),
  ]);
  if (!item || sample) throw new AppError('Equipment not found', 404, 'NOT_FOUND');
  const assignment = item.teamId ? await client.trAssignment.findFirst({ where: { teamId: item.teamId, status: { in: [...activeAssignments] } }, select: { id: true, caseId: true, status: true, case: { select: { number: true, title: true } } }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }] }) : null;
  const latest = updates[0];
  return { item: { ...item, sample: false, latestCondition: latest?.condition ?? null, latestObservedAt: latest?.observedAt ?? null, currentAssignment: assignment ? { id: assignment.id, caseId: assignment.caseId, caseNumber: assignment.case.number, caseTitle: assignment.case.title, status: assignment.status } : null }, teams, updates: updates.map(operationalUpdateDto) };
}
export async function getAssignment(id: string, client: PrismaClient = db()) {
  const item = await client.trAssignment.findUnique({ where: { id }, select: { ...assignmentSelect, fieldUpdates: { select: { id: true, findings: true, observedAt: true }, orderBy: { observedAt: 'desc' }, take: 1 }, case: { select: { number: true, title: true, verificationStatus: true, handlingStatus: true } }, team: { select: { name: true } } } });
  if (!item || await client.trAuditLog.findFirst({ where: { systemActor: sampleActor, action: 'SAMPLE_OPERATION_CREATED', targetType: 'TEAM', targetId: item.teamId }, select: { id: true } })) throw new AppError('Assignment not found', 404, 'NOT_FOUND');
  const { case: incident, team, fieldUpdates, ...fields } = item;
  return { ...fields, sample: false, result: fieldUpdates[0] ?? null, caseNumber: incident.number, caseTitle: incident.title, caseVerification: incident.verificationStatus, caseHandling: incident.handlingStatus, teamName: team.name };
}
export async function getOperationalFeature(id: string, client: PrismaClient = db()) {
  const [item, updates, sample] = await Promise.all([
    client.msMapFeature.findFirst({ where: { id, kind: { in: ['ROAD', 'RIVER', 'WATER_SOURCE', 'DESIGNATED_LOCATION'] } }, select: { id: true, name: true, kind: true, geometry: true, layer: { select: { provider: true, verifiedAt: true } } } }),
    client.trOperationalUpdate.findMany({ where: { featureId: id }, select: updateSelect, take: 100, orderBy: [{ observedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }] }),
    client.trAuditLog.findFirst({ where: { systemActor: sampleActor, action: 'SAMPLE_OPERATION_CREATED', targetType: 'FEATURE', targetId: id }, select: { id: true } }),
  ]);
  if (!item || sample || item.layer.provider === 'SAMPLE') throw new AppError('Operational feature not found', 404, 'NOT_FOUND');
  const point = z.object({ type: z.literal('Point'), coordinates: z.tuple([z.number().finite(), z.number().finite()]) }).safeParse(item.geometry);
  const line = z.object({ type: z.literal('LineString'), coordinates: z.array(z.tuple([z.number().finite(), z.number().finite()])).min(2) }).safeParse(item.geometry);
  const coordinates = point.success ? point.data.coordinates : line.success ? line.data.coordinates[Math.floor(line.data.coordinates.length / 2)]! : null;
  if (!coordinates) throw new AppError('Operational feature location unavailable', 404, 'NOT_FOUND');
  const latest = updates[0];
  return { item: { id: item.id, name: item.name, kind: item.kind, latitude: coordinates[1], longitude: coordinates[0], provider: item.layer.provider, verifiedAt: item.layer.verifiedAt, authoritative: item.layer.verifiedAt !== null, sample: false, latestCondition: latest?.condition ?? null, latestObservedAt: latest?.observedAt ?? null }, updates: updates.map(operationalUpdateDto) };
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
export async function createOperationalFeature(actor: Actor, body: unknown, client: PrismaClient = db()) {
  const input = operationalFeatureSchema.parse(body);
  const payloadHash = fingerprint({ actorId: actor.id, ...input });
  return client.$transaction(async tx => {
    await lockedActor(tx, actor, true);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.idempotencyKey}, 0))`;
    const existing = await tx.trAuditLog.findFirst({ where: { actorId: actor.id, action: 'OPERATIONAL_FEATURE_CREATED', details: { path: ['idempotencyKey'], equals: input.idempotencyKey } }, select: { targetId: true, details: true } });
    if (existing) {
      const details = existing.details as Record<string, unknown> | null;
      if (details?.payloadHash !== payloadHash) throw new AppError('Feature key already used for different content', 409, 'IDEMPOTENCY_CONFLICT');
      return tx.msMapFeature.findUniqueOrThrow({ where: { id: existing.targetId }, select: { id: true, name: true, kind: true, geometry: true } });
    }
    const now = new Date();
    const layer = await tx.msMapLayer.upsert({ where: { provider_name_version: { provider: 'Blazemap', name: 'Operator operational points', version: '1' } }, update: { verifiedAt: now }, create: { provider: 'Blazemap', name: 'Operator operational points', version: '1', kind: 'DESIGNATED_LOCATION', sourceUrl: 'urn:blazemap:operator-operational-points', license: 'Restricted operational data', attribution: 'Blazemap authorized operators', coverage: 'Operator-recorded access and water points; point records do not establish full route usability', sourceDate: now, verifiedAt: now } });
    const feature = await tx.msMapFeature.create({ data: { layerId: layer.id, sourceId: `operator:${input.idempotencyKey}`, kind: input.kind, name: input.name, geometry: jsonValue({ type: 'Point', coordinates: [input.longitude, input.latitude] }), attributes: jsonValue({ source: input.source, observedAt: input.observedAt, pointMeaning: input.kind === 'ROAD' ? 'ACCESS_POINT' : 'WATER_SOURCE_POINT' }) }, select: { id: true, name: true, kind: true, geometry: true } });
    await tx.trOperationalUpdate.create({ data: { recorderId: actor.id, subjectType: 'FEATURE', featureId: feature.id, condition: input.condition, source: input.source, observedAt: new Date(input.observedAt), notes: input.reason, idempotencyKey: input.idempotencyKey, payloadHash }, select: updateSelect });
    await audit(tx, actor.id, 'OPERATIONAL_FEATURE_CREATED', 'FEATURE', feature.id, input.reason, { idempotencyKey: input.idempotencyKey, payloadHash, latitude: input.latitude, longitude: input.longitude, kind: input.kind });
    return feature;
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
      await tx.$queryRaw`SELECT id FROM "MsMapFeature" WHERE id = ${input.subjectId} FOR UPDATE`;
      const feature = await tx.msMapFeature.findUniqueOrThrow({ where: { id: input.subjectId }, include: { layer: { select: { provider: true, verifiedAt: true } } } });
      const road = ['PASSABLE', 'RESTRICTED', 'IMPASSABLE'];
      const water = ['WATER_AVAILABLE', 'WATER_UNAVAILABLE'];
      if (['AVAILABLE', 'UNAVAILABLE'].includes(input.condition) && feature.kind !== 'DESIGNATED_LOCATION') throw new AppError('Availability applies only to designated locations', 400, 'INVALID_CONDITION');
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
