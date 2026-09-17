import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { db } from '../../config/index.js';
import { caseSchema, casePatchSchema, fieldSchema, verificationSchema, reviewSchema, paginationSchema, assignmentSchema, assignmentPatchSchema, teamSchema, equipmentSchema, operationalSchema, handlingStatuses, verificationStatuses, priorities, type Actor } from '../../types/index.js';
import { AppError, jsonValue } from '../../utils/index.js';
import { areaHectares, polygonSchema } from '../../utils/geometry.js';
import { attach } from '../uploads/uploads.service.js';
import { loadWindContext } from '../integrations/wind.js';
import { reportDto, reportInclude } from '../reports/reports.service.js';
import { activeAssignments, audit, bumpContext, lockedActor, verifiedRegion } from './access.js';
import { assertVersion, transition, verificationProjection } from './rules.js';

export const caseSelect = { id: true, number: true, title: true, latitude: true, longitude: true, regionId: true, verificationStatus: true, handlingStatus: true, priority: true, priorityReason: true, version: true, contextRevision: true, latestAnalysisId: true, openedAt: true, updatedAt: true, closedAt: true, closureReason: true } as const;
export async function listCases(query: unknown) {
  const { page, pageSize, search, handlingStatus, verificationStatus, priority, regionId } = paginationSchema.extend({ handlingStatus: z.enum(handlingStatuses).optional(), verificationStatus: z.enum(verificationStatuses).optional(), priority: z.enum(priorities).optional() }).parse(query);
  const where = { handlingStatus, verificationStatus, priority, regionId, ...(search ? { OR: [{ title: { contains: search, mode: 'insensitive' as const } }, { number: { contains: search } }] } : {}) };
  const [data, total] = await db().$transaction([db().trCase.findMany({ where, select: caseSelect, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }), db().trCase.count({ where })]);
  return { data, meta: { total, page, pageSize } };
}
export async function getCase(id: string) {
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
  const timeline = await db().trAuditLog.findMany({ where: { targetType: 'CASE', targetId: id }, select: { id: true, action: true, reason: true, details: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 200 });
  const { forecast, windContext } = await loadWindContext(db(), c.region);
  const weather = forecast && windContext.forecast ? [{ ...windContext.forecast, temperature: forecast.temperature, humidity: forecast.humidity, windSpeed: windContext.windSpeedKmh, windSpeedUnit: 'km/h', windFromDegrees: windContext.windFromDegrees, windToDegrees: windContext.windToDegrees, directionPrecision: 'CARDINAL', measurementType: 'FORECAST', stale: !['READY', 'CALM', 'MISSING_WIND'].includes(windContext.status) }] : [];
  const spatialContext = c.regionId ? await db().msMapFeature.findMany({ where: { regionId: c.regionId, layer: { verifiedAt: { not: null } } }, select: { id: true, name: true, kind: true, layer: { select: { provider: true, attribution: true, sourceDate: true, version: true } } }, take: 100 }) : [];
  const perimeter = polygonSchema.safeParse(c.perimeter);
  return { ...c, areaHectares: perimeter.success ? areaHectares(perimeter.data) : null, reports: c.reports.map(reportDto), timeline, weather, windContext, spatialContext };
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
      await audit(tx, actor.id, 'CASE_PERIMETER_UPDATED', 'CASE', id, input.reason, { authorityReference: input.authorityReference, before: { perimeter: c.perimeter, observedAt: c.perimeterObservedAt, source: c.perimeterSource, revision: c.perimeterRevision }, after: { perimeter: data.perimeter, observedAt: data.perimeterObservedAt, source: data.perimeterSource, revision: data.perimeterRevision }, areaHectares: areaHectares(input.perimeter) });
      return { ...data, areaHectares: areaHectares(input.perimeter) };
    }
    const handling = input.handlingStatus ?? c.handlingStatus;
    const count = await tx.trAssignment.count({ where: { caseId: id, status: { in: [...activeAssignments] } } });
    transition(c.verificationStatus, handling, count);
    const data = await tx.trCase.update({ where: { id, version: input.version }, data: { priority: input.priority, priorityReason: input.priority ? input.reason : undefined, handlingStatus: handling, closedAt: handling === 'CLOSED' ? c.closedAt ?? new Date() : null, closureReason: handling === 'CLOSED' ? input.reason : null, version: { increment: 1 }, contextRevision: { increment: 1 }, latestAnalysisId: null }, select: caseSelect });
    await audit(tx, actor.id, 'CASE_UPDATED', 'CASE', id, input.reason, { before: { priority: c.priority, handlingStatus: c.handlingStatus }, after: { priority: data.priority, handlingStatus: data.handlingStatus } });
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
    await tx.$queryRaw`SELECT id FROM "TrCase" WHERE id = ${id} FOR UPDATE`;
    const c = await tx.trCase.findUniqueOrThrow({ where: { id } });
    assertVersion(c.version, input.version);
    const field = await tx.trFieldUpdate.findFirst({ where: { id: input.fieldUpdateId, caseId: id } });
    if (!field) throw new AppError('Verification requires field evidence from this case', 400, 'INVALID_EVIDENCE');
    if (input.outcome === 'CONFIRMED_FIRE' && field.findings !== 'VISIBLE_FIRE') throw new AppError('Confirmation requires a visible-fire field finding', 409, 'INSUFFICIENT_EVIDENCE');
    if (input.outcome === 'NOT_FIRE' && field.findings !== 'NO_INDICATION') throw new AppError('Rejection requires relevant inspection findings and an explicit basis', 409, 'INSUFFICIENT_EVIDENCE');
    const next = input.outcome === 'INCONCLUSIVE' ? c.verificationStatus : input.outcome;
    const correction = c.verificationStatus !== 'UNVERIFIED' && next !== c.verificationStatus;
    if (correction) {
      const publications = await tx.trPublicInformation.count({ where: { caseId: id, status: 'PUBLISHED' } });
      if (publications) throw new AppError('Withdraw existing public case claims before correcting verification', 409, 'PUBLICATION_REVIEW_REQUIRED');
    }
    const prior = correction ? await tx.trVerification.findFirst({ where: { caseId: id, outcome: { not: 'INCONCLUSIVE' } }, orderBy: { createdAt: 'desc' } }) : null;
    await tx.trVerification.create({ data: { caseId: id, decidingAdminId: actor.id, fieldUpdateId: field.id, authorityReference: input.authorityReference, outcome: correction ? 'CORRECTION' : input.outcome, previousStatus: c.verificationStatus, newStatus: next, reason: input.reason, correctedDecisionId: prior?.id } });
    const projected = verificationProjection({ verificationStatus: c.verificationStatus, handlingStatus: c.handlingStatus, latitude: c.latitude, longitude: c.longitude }, input.outcome, { latitude: field.latitude, longitude: field.longitude });
    const result = await tx.trCase.update({ where: { id, version: input.version }, data: { verificationStatus: projected.verificationStatus, handlingStatus: projected.handlingStatus, latitude: projected.latitude, longitude: projected.longitude, version: { increment: 1 }, contextRevision: { increment: 1 }, latestAnalysisId: null }, select: caseSelect });
    await audit(tx, actor.id, correction ? 'VERIFICATION_CORRECTED' : 'VERIFICATION_RECORDED', 'CASE', id, input.reason, { outcome: input.outcome, previousStatus: c.verificationStatus, newStatus: next, authorityReference: input.authorityReference, positionSourceFieldUpdateId: input.outcome === 'CONFIRMED_FIRE' && field.latitude !== null ? field.id : null });
    return result;
  });
}
export async function reviewReport(actor: Actor, id: string, body: unknown) {
  const input = reviewSchema.parse(body);
  return db().$transaction(async tx => {
    await lockedActor(tx, actor, true);
    await tx.$queryRaw`SELECT id FROM "TrReport" WHERE id = ${id} FOR UPDATE`;
    const report = await tx.trReport.findUniqueOrThrow({ where: { id } });
    for (const caseId of [...new Set([report.caseId, input.caseId].filter((v): v is string => !!v))].sort()) await tx.$queryRaw`SELECT id FROM "TrCase" WHERE id = ${caseId} FOR UPDATE`;
    if (input.caseId && input.caseId !== report.caseId) {
      const target = await tx.trCase.findUniqueOrThrow({ where: { id: input.caseId } });
      if (target.handlingStatus === 'CLOSED' || target.verificationStatus === 'NOT_FIRE') throw new AppError('Reopen or correct the case before linking new evidence', 409, 'CASE_REVIEW_REQUIRED');
    }
    const item = await tx.trReport.update({ where: { id }, data: { reviewStatus: input.reviewStatus, caseId: input.caseId }, include: reportInclude });
    for (const caseId of [...new Set([report.caseId, item.caseId].filter((v): v is string => !!v))].sort()) {
      await bumpContext(tx, caseId);
      await audit(tx, actor.id, 'REPORT_REVIEWED', 'CASE', caseId, input.reason, { reportId: id, previousCaseId: report.caseId, caseId: item.caseId });
    }
    await audit(tx, actor.id, 'REPORT_REVIEWED', 'REPORT', id, input.reason, { reviewStatus: item.reviewStatus });
    return reportDto(item);
  });
}
export async function assignTeam(actor: Actor, id: string, body: unknown) {
  const input = assignmentSchema.parse(body);
  return db().$transaction(async tx => {
    await lockedActor(tx, actor, true);
    await tx.$queryRaw`SELECT id FROM "TrCase" WHERE id = ${id} FOR UPDATE`;
    const c = await tx.trCase.findUniqueOrThrow({ where: { id } });
    if (c.handlingStatus === 'CLOSED' || c.verificationStatus === 'NOT_FIRE') throw new AppError('Case must be open for investigation or response', 409, 'INVALID_TRANSITION');
    await tx.$queryRaw`SELECT id FROM "MsTeam" WHERE id = ${input.teamId} FOR UPDATE`;
    const team = await tx.msTeam.findFirst({ where: { id: input.teamId, active: true } });
    if (!team) throw new AppError('Team not available', 400, 'INVALID_TEAM');
    const latest = await tx.trOperationalUpdate.findFirst({ where: { teamId: team.id }, orderBy: { observedAt: 'desc' } });
    if (!latest || latest.condition !== 'AVAILABLE' || Date.now() - latest.observedAt.getTime() > 86400000) throw new AppError('Record a current team availability update before assigning', 409, 'TEAM_STATUS_UNKNOWN');
    const item = await tx.trAssignment.create({ data: { caseId: id, teamId: input.teamId, assigningAdminId: actor.id, notes: input.notes }, select: { id: true, caseId: true, teamId: true, status: true, notes: true, createdAt: true, updatedAt: true } });
    await bumpContext(tx, id);
    await audit(tx, actor.id, 'TEAM_ASSIGNED', 'CASE', id, input.notes ?? undefined, { assignmentId: item.id, teamId: team.id });
    return item;
  });
}
export async function updateAssignment(actor: Actor, id: string, body: unknown) {
  const input = assignmentPatchSchema.parse(body);
  return db().$transaction(async tx => {
    await lockedActor(tx, actor, true);
    const item = await tx.trAssignment.findUniqueOrThrow({ where: { id } });
    if (['COMPLETED', 'CANCELLED'].includes(item.status)) throw new AppError('Completed assignments are immutable', 409, 'INVALID_TRANSITION');
    const updated = await tx.trAssignment.update({ where: { id, status: item.status }, data: { status: input.status }, select: { id: true, caseId: true, teamId: true, status: true, notes: true, createdAt: true, updatedAt: true } });
    await bumpContext(tx, item.caseId);
    await audit(tx, actor.id, 'ASSIGNMENT_UPDATED', 'CASE', item.caseId, input.reason, { assignmentId: id, status: input.status });
    return updated;
  });
}
export async function operations() {
  const [teams, equipment, updates, assignments] = await db().$transaction([
    db().msTeam.findMany({ select: { id: true, name: true, organization: true, active: true }, take: 200, orderBy: { name: 'asc' } }),
    db().msEquipment.findMany({ select: { id: true, name: true, kind: true, teamId: true, active: true }, take: 300, orderBy: { name: 'asc' } }),
    db().trOperationalUpdate.findMany({ select: { id: true, subjectType: true, teamId: true, equipmentId: true, featureId: true, condition: true, source: true, observedAt: true, notes: true, createdAt: true }, take: 300, orderBy: { observedAt: 'desc' } }),
    db().trAssignment.findMany({ select: { id: true, caseId: true, teamId: true, status: true, notes: true, createdAt: true, updatedAt: true }, take: 200, orderBy: { updatedAt: 'desc' } }),
  ]);
  return { teams, equipment, updates: updates.map(v => ({ ...v, subjectId: v.teamId ?? v.equipmentId ?? v.featureId })), assignments };
}
export async function createTeam(actor: Actor, body: unknown) {
  const data = teamSchema.parse(body);
  return db().$transaction(async tx => { await lockedActor(tx, actor, true); const item = await tx.msTeam.create({ data }); await audit(tx, actor.id, 'TEAM_CREATED', 'TEAM', item.id); return { id: item.id, name: item.name, organization: item.organization, active: item.active }; });
}
export async function createEquipment(actor: Actor, body: unknown) {
  const data = equipmentSchema.parse(body);
  return db().$transaction(async tx => { await lockedActor(tx, actor, true); const item = await tx.msEquipment.create({ data }); await audit(tx, actor.id, 'EQUIPMENT_CREATED', 'EQUIPMENT', item.id); return { id: item.id, name: item.name, kind: item.kind, teamId: item.teamId, active: item.active }; });
}
export async function addOperationalUpdate(actor: Actor, body: unknown, client: PrismaClient = db()) {
  const { subjectId, ...input } = operationalSchema.parse(body);
  return client.$transaction(async tx => {
    await lockedActor(tx, actor, true);
    if (input.subjectType === 'FEATURE') {
      const feature = await tx.msMapFeature.findUniqueOrThrow({ where: { id: subjectId } });
      const road = ['PASSABLE', 'RESTRICTED', 'IMPASSABLE'];
      const water = ['WATER_AVAILABLE', 'WATER_UNAVAILABLE'];
      if ((road.includes(input.condition) && feature.kind !== 'ROAD') || (water.includes(input.condition) && !['WATER_SOURCE', 'RIVER'].includes(feature.kind))) throw new AppError('Condition does not apply to this feature', 400, 'INVALID_CONDITION');
    }
    if (input.subjectType === 'TEAM') await tx.$queryRaw`SELECT id FROM "MsTeam" WHERE id = ${subjectId} FOR UPDATE`;
    const item = await tx.trOperationalUpdate.create({ data: { ...input, observedAt: new Date(input.observedAt), recorderId: actor.id, teamId: input.subjectType === 'TEAM' ? subjectId : undefined, equipmentId: input.subjectType === 'EQUIPMENT' ? subjectId : undefined, featureId: input.subjectType === 'FEATURE' ? subjectId : undefined } });
    await tx.trCase.updateMany({ where: { handlingStatus: { not: 'CLOSED' } }, data: { contextRevision: { increment: 1 }, version: { increment: 1 }, latestAnalysisId: null, updatedAt: new Date() } });
    await audit(tx, actor.id, 'OPERATIONAL_UPDATE_ADDED', input.subjectType, subjectId);
    return { id: item.id, subjectType: item.subjectType, subjectId, condition: item.condition, source: item.source, observedAt: item.observedAt, notes: item.notes, createdAt: item.createdAt };
  });
}
