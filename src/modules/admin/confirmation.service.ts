import { z } from 'zod';
import type { ObservationProvenance, VerificationStatus } from '../../generated/prisma/enums.js';
import { verificationSchema, type Transaction } from '../../types/index.js';
import { AppError, jsonValue } from '../../utils/index.js';
import { areaHectares, polygonSchema } from '../../utils/geometry.js';
import { recordCaseProgress } from '../reports/progress.js';
import { notifyNearbyConfirmation } from '../notifications/nearby.service.js';

export const applicationAdminAuthority = 'APPLICATION_ADMIN_ROLE' as const;
const confirmationResultSelect = { id: true, number: true, title: true, latitude: true, longitude: true, regionId: true, verificationStatus: true, handlingStatus: true, priority: true, priorityReason: true, version: true, contextRevision: true, latestAnalysisId: true, perimeter: true, perimeterObservedAt: true, perimeterSource: true, perimeterRevision: true, openedAt: true, updatedAt: true, closedAt: true, closureReason: true } as const;

type VerificationInput = z.infer<typeof verificationSchema>;
type Polygon = z.infer<typeof polygonSchema>;
export type NormalizedVerification = {
  outcome: 'CONFIRMED_FIRE';
  decisionNote: string;
  privateReason?: string;
  observationId: string;
  version: number;
  perimeter: Polygon;
  boundaryUsesObservationSourceTime: boolean;
  perimeterObservedAt?: string;
  perimeterSource?: string;
} | {
  outcome: 'NOT_FIRE' | 'INCONCLUSIVE';
  decisionNote: string;
  privateReason?: string;
  observationId: string;
  version: number;
};

export function normalizeVerification(input: VerificationInput): NormalizedVerification {
  if ('decisionNote' in input) return input.outcome === 'CONFIRMED_FIRE' ? input : { outcome: input.outcome, decisionNote: input.decisionNote, observationId: input.observationId, version: input.version };
  if (input.outcome !== 'CONFIRMED_FIRE') return { outcome: input.outcome, decisionNote: input.reporterMessage, privateReason: input.reason, observationId: input.fieldUpdateId, version: input.version };
  if (!input.perimeter) throw new AppError('Confirmation requires a closed perimeter', 400, 'INVALID_CONFIRMATION');
  return {
    outcome: 'CONFIRMED_FIRE',
    decisionNote: input.reporterMessage,
    privateReason: input.reason,
    observationId: input.fieldUpdateId,
    version: input.version,
    perimeter: input.perimeter,
    boundaryUsesObservationSourceTime: input.reuseFieldObservation === true,
    perimeterObservedAt: input.perimeterObservedAt,
    perimeterSource: input.perimeterSource,
  };
}

export function isAssignedConfirmationEvidence(observation: { findings: string; latitude: number | null; longitude: number | null; source: string; teamId: string | null; assignment: { caseId: string; teamId: string; status: string } | null }, caseId: string) {
  return observation.findings === 'VISIBLE_FIRE' && observation.latitude !== null && observation.longitude !== null && observation.source.trim().length >= 3 && observation.assignment?.caseId === caseId && observation.assignment.teamId === observation.teamId && ['ACCEPTED', 'IN_PROGRESS', 'COMPLETED'].includes(observation.assignment.status);
}

export type ConfirmationObservation = {
  id: string;
  findings: string;
  source: string;
  observedAt: Date;
  latitude: number | null;
  longitude: number | null;
  provenance: ObservationProvenance;
  sourceReportId: string | null;
};

type CurrentCase = {
  id: string;
  version: number;
  contextRevision: number;
  verificationStatus: VerificationStatus;
  handlingStatus: 'OPEN' | 'CHECK_SCHEDULED' | 'ON_SCENE' | 'RESPONDING' | 'MONITORING' | 'CLOSED';
  latitude: number | null;
  longitude: number | null;
  perimeter: unknown;
  perimeterObservedAt: Date | null;
  perimeterSource: string | null;
  perimeterRevision: number;
};

export async function recordConfirmedCase(tx: Transaction, input: {
  actorId: string;
  current: CurrentCase;
  observation: ConfirmationObservation;
  decisionNote: string;
  privateReason?: string;
  perimeter: Polygon;
  boundaryUsesObservationSourceTime: boolean;
  perimeterObservedAt?: string;
  perimeterSource?: string;
  reportId?: string;
  correction: boolean;
  correctedDecisionId: string | null;
  recordOwnerProgress: boolean;
}) {
  const { current, observation } = input;
  const observedAt = input.boundaryUsesObservationSourceTime ? observation.observedAt : new Date(input.perimeterObservedAt!);
  const source = input.boundaryUsesObservationSourceTime ? observation.source : input.perimeterSource!;
  const reason = input.privateReason ?? input.decisionNote;
  await tx.trVerification.create({ data: { caseId: current.id, decidingAdminId: input.actorId, fieldUpdateId: observation.id, authorityReference: applicationAdminAuthority, outcome: input.correction ? 'CORRECTION' : 'CONFIRMED_FIRE', previousStatus: current.verificationStatus, newStatus: 'CONFIRMED_FIRE', reason, correctedDecisionId: input.correctedDecisionId } });
  const updated = await tx.trCase.update({ where: { id: current.id, version: current.version }, data: { verificationStatus: 'CONFIRMED_FIRE', latitude: observation.latitude, longitude: observation.longitude, perimeter: jsonValue(input.perimeter), perimeterObservedAt: observedAt, perimeterSource: source, perimeterRevision: { increment: 1 }, version: { increment: 1 }, contextRevision: { increment: 1 }, latestAnalysisId: null }, select: confirmationResultSelect });
  const provenance = {
    authorityReference: applicationAdminAuthority,
    authorityBasis: applicationAdminAuthority,
    authorityNoteSource: 'SERVER_DERIVED',
    observationId: observation.id,
    observationProvenance: observation.provenance,
    sourceReportId: observation.sourceReportId,
    independentFieldObservation: observation.provenance === 'FIELD_OBSERVATION',
    reportId: input.reportId ?? null,
  };
  await tx.trAuditLog.create({ data: { actorId: input.actorId, action: input.correction ? 'VERIFICATION_CORRECTED' : 'VERIFICATION_RECORDED', targetType: 'CASE', targetId: current.id, reason, details: jsonValue({ ...provenance, outcome: 'CONFIRMED_FIRE', previousStatus: current.verificationStatus, newStatus: 'CONFIRMED_FIRE' }) } });
  await tx.trAuditLog.create({ data: { actorId: input.actorId, action: 'CASE_PERIMETER_UPDATED', targetType: 'CASE', targetId: current.id, reason, details: jsonValue({ ...provenance, boundaryUsesObservationSourceTime: input.boundaryUsesObservationSourceTime, before: { perimeter: current.perimeter, observedAt: current.perimeterObservedAt, source: current.perimeterSource, revision: current.perimeterRevision }, after: { perimeter: input.perimeter, observedAt, source, revision: current.perimeterRevision + 1 }, areaHectares: areaHectares(input.perimeter) }) } });
  if (input.recordOwnerProgress) await recordCaseProgress(tx, current.id, input.actorId, input.correction ? 'CORRECTION_CONFIRMED_FIRE' : 'CONFIRMED_FIRE', input.decisionNote);
  await notifyNearbyConfirmation(tx, current.id);
  return updated;
}
