import { z } from 'zod';
import { db } from '../../config/index.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { Actor } from '../../types/index.js';
import { AppError } from '../../utils/index.js';
import { authorize } from './rules.js';

export const candidateQuerySchema = z.strictObject({ maxDistanceMeters: z.coerce.number().int().min(1).max(100000), hours: z.coerce.number().positive().max(168) });
export function haversineMeters(latitude: number, longitude: number, otherLatitude: number, otherLongitude: number) {
  const radians = Math.PI / 180;
  const a = Math.sin((otherLatitude - latitude) * radians / 2) ** 2 + Math.cos(latitude * radians) * Math.cos(otherLatitude * radians) * Math.sin((otherLongitude - longitude) * radians / 2) ** 2;
  return 6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}
export async function reportCandidates(actor: Actor, id: string, query: unknown, client: PrismaClient = db()) {
  authorize(actor);
  const { maxDistanceMeters, hours } = candidateQuerySchema.parse(query);
  const report = await client.trReport.findUniqueOrThrow({ where: { id }, select: { caseId: true, locationMode: true, latitude: true, longitude: true, observedAt: true } });
  const meta = { eligible: true, reason: null as string | null, maxDistanceMeters, hours, automaticAssociation: false, basis: 'OPERATOR_ENTERED_DISTANCE_AND_OBSERVATION_TIME', limitation: 'Suggestions compare estimated points and evidence times; thresholds are not approved association rules.' };
  if (report.locationMode !== 'INCIDENT_ESTIMATE' || report.latitude == null || report.longitude == null) return { data: [], meta: { ...meta, eligible: false, reason: 'INCIDENT_ESTIMATE_REQUIRED' } };
  const range = { gte: new Date(report.observedAt.getTime() - hours * 3600000), lte: new Date(report.observedAt.getTime() + hours * 3600000) };
  const cases = await client.trCase.findMany({
    where: { ...(report.caseId ? { id: { not: report.caseId } } : {}), handlingStatus: { not: 'CLOSED' }, verificationStatus: { not: 'NOT_FIRE' }, latitude: { not: null }, longitude: { not: null }, OR: [
      { reports: { some: { locationMode: 'INCIDENT_ESTIMATE', latitude: { not: null }, longitude: { not: null }, observedAt: range } } },
      { hotspots: { some: { acquiredAt: range } } }, { fieldUpdates: { some: { observedAt: range } } },
    ] },
    select: { id: true, number: true, title: true, latitude: true, longitude: true, verificationStatus: true, handlingStatus: true,
      reports: { where: { locationMode: 'INCIDENT_ESTIMATE', latitude: { not: null }, longitude: { not: null }, observedAt: range }, select: { id: true, observedAt: true }, orderBy: [{ observedAt: 'desc' }, { id: 'asc' }], take: 1 },
      hotspots: { where: { acquiredAt: range }, select: { id: true, acquiredAt: true }, orderBy: [{ acquiredAt: 'desc' }, { id: 'asc' }], take: 1 },
      fieldUpdates: { where: { observedAt: range }, select: { id: true, observedAt: true }, orderBy: [{ observedAt: 'desc' }, { id: 'asc' }], take: 1 },
    }, orderBy: { id: 'asc' }, take: 501,
  });
  if (cases.length > 500) throw new AppError('Narrow the time window before requesting candidates', 400, 'CANDIDATE_LIMIT');
  const data = cases.flatMap(c => {
    const distanceMeters = haversineMeters(report.latitude!, report.longitude!, c.latitude!, c.longitude!);
    if (distanceMeters > maxDistanceMeters) return [];
    const evidence = [...c.reports, ...c.fieldUpdates, ...c.hotspots.map(h => ({ id: h.id, observedAt: h.acquiredAt }))].sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime() || a.id.localeCompare(b.id))[0];
    if (!evidence) return [];
    return [{ id: c.id, number: c.number, title: c.title, latitude: c.latitude, longitude: c.longitude, verificationStatus: c.verificationStatus, handlingStatus: c.handlingStatus, distanceMeters, matchedObservationId: evidence.id, matchedObservedAt: evidence.observedAt, timeDifferenceHours: Math.abs(evidence.observedAt.getTime() - report.observedAt.getTime()) / 3600000 }];
  }).sort((a, b) => a.distanceMeters - b.distanceMeters || a.timeDifferenceHours - b.timeDifferenceHours || a.id.localeCompare(b.id));
  return { data, meta };
}
