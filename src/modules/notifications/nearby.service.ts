import { z } from 'zod';
import { db } from '../../config/index.js';
import type { Actor, Transaction } from '../../types/index.js';
import { lockedActor } from '../admin/access.js';
import { geometryDistanceMeters, publicPerimeter } from '../../utils/geometry.js';
import { fingerprint } from '../../utils/index.js';

export async function lockNearbyWorkflow(tx: Transaction) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(724819320)`;
}

export const nearbyLocationSchema = z.discriminatedUnion('enabled', [
  z.strictObject({ enabled: z.literal(false) }),
  z.strictObject({ enabled: z.literal(true), emailEnabled: z.boolean().default(false), latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180), accuracyMeters: z.number().finite().min(0).max(1000), capturedAt: z.iso.datetime({ offset: true }).refine(value => Date.parse(value) <= Date.now() && Date.now() - Date.parse(value) <= 300000, 'Refresh your location; it must be captured within five minutes') }),
]);
export async function nearbyPreferences(actor: Actor) {
  await db().trUserLocation.deleteMany({ where: { expiresAt: { lte: new Date() } } });
  const location = await db().trUserLocation.findUnique({ where: { userId: actor.id }, select: { capturedAt: true, consentAt: true, expiresAt: true, accuracyMeters: true, emailEnabled: true } });
  return { enabled: !!location, location, radiusMeters: 2000, ttlHours: 24, maxAccuracyMeters: 1000 };
}
export async function saveNearbyLocation(actor: Actor, body: unknown) {
  const input = nearbyLocationSchema.parse(body);
  return db().$transaction(async tx => {
    await lockNearbyWorkflow(tx);
    await lockedActor(tx, actor);
    await tx.$queryRaw`SELECT id FROM "MsUser" WHERE id = ${actor.id} FOR UPDATE`;
    if (!input.enabled) {
      await tx.trUserLocation.deleteMany({ where: { userId: actor.id } });
      return { enabled: false };
    }
    const now = new Date();
    const data = { latitude: input.latitude, longitude: input.longitude, accuracyMeters: input.accuracyMeters, capturedAt: new Date(input.capturedAt), consentAt: now, emailEnabled: input.emailEnabled, expiresAt: new Date(now.getTime() + 86400000) };
    await tx.trUserLocation.upsert({ where: { userId: actor.id }, create: { userId: actor.id, ...data }, update: data });
    await evaluateNearby(tx, actor.id);
    return { enabled: true, expiresAt: data.expiresAt };
  }, { maxWait: 10000, timeout: 30000 });
}
export async function evaluateNearby(tx: Transaction, userId?: string, publicationId?: string, escalation?: { caseId: string; version: number }) {
  await lockNearbyWorkflow(tx);
  const now = new Date();
  await tx.trUserLocation.deleteMany({ where: { expiresAt: { lte: now } } });
  const eligible = await tx.$queryRaw<{ id: string }[]>`SELECT p.id FROM "TrPublicInformation" p JOIN "TrCase" c ON c.id = p."caseId" WHERE p.status = 'PUBLISHED' AND p."publicLocationMode" = 'APPROVED_INCIDENT_PERIMETER' AND p."privacyReview" IS NOT NULL AND p."publishedAt" <= ${now} AND (p."validUntil" IS NULL OR p."validUntil" > ${now}) AND c."verificationStatus" = 'CONFIRMED_FIRE' AND c."handlingStatus" != 'CLOSED' AND (${publicationId ?? null}::text IS NULL OR p.id = ${publicationId ?? null}) AND (${escalation?.caseId ?? null}::text IS NULL OR c.id = ${escalation?.caseId ?? null}) ORDER BY c.id, p.id FOR SHARE OF p, c`;
  const publications = await tx.trPublicInformation.findMany({ where: { id: { in: eligible.map(item => item.id) }, caseId: escalation?.caseId, status: 'PUBLISHED', privacyReview: { not: null }, publishedAt: { lte: now }, publicLocationMode: 'APPROVED_INCIDENT_PERIMETER', case: { verificationStatus: 'CONFIRMED_FIRE', handlingStatus: { not: 'CLOSED' } }, OR: [{ validUntil: null }, { validUntil: { gt: now } }] }, select: { id: true, caseId: true, publicLocationMode: true, publicCaseSnapshot: true, title: true, summary: true, body: true, updatedAt: true } });
  let cursor: string | undefined;
  do {
    const locations = await tx.trUserLocation.findMany({ where: { userId, expiresAt: { gt: now }, accuracyMeters: { lte: 1000 }, user: { active: true } }, orderBy: { userId: 'asc' }, take: 250, ...(cursor ? { cursor: { userId: cursor }, skip: 1 } : {}) });
    const lockedLocations = locations.length ? await tx.$queryRaw<{ userId: string; latitude: number; longitude: number }[]>`SELECT "userId", latitude, longitude FROM "TrUserLocation" WHERE "userId" = ANY(${locations.map(item => item.userId)}::text[]) AND "expiresAt" > ${now} ORDER BY "userId" FOR UPDATE` : [];
    for (const publication of publications) {
      const perimeter = publicPerimeter(publication).publicPerimeter;
      const snapshot = z.object({ handlingStatus: z.string() }).safeParse(publication.publicCaseSnapshot);
      if (!perimeter || !snapshot.success || snapshot.data.handlingStatus === 'CLOSED') continue;
      const revision = fingerprint({ geometry: perimeter.geometry, observedAt: perimeter.observedAt, title: publication.title, summary: publication.summary, body: publication.body });
      const recipients = lockedLocations.filter(location => {
        const distance = geometryDistanceMeters([location.longitude, location.latitude], perimeter.geometry);
        return distance !== null && distance <= 2000;
      });
      if (recipients.length) await tx.trNotification.createMany({ data: recipients.map(location => ({ userId: location.userId, publicationId: publication.id, caseId: publication.caseId, eventKey: escalation ? `nearby:${location.userId}:${publication.id}:${escalation.version}:NEARBY_PRIORITY` : `nearby:${location.userId}:${publication.caseId}:${revision}:NEARBY_PUBLICATION`, type: escalation ? 'NEARBY_PRIORITY' : 'NEARBY_PUBLICATION', title: escalation ? 'Nearby incident priority increased' : 'Confirmed incident nearby', message: 'Your saved location is within 2 km of a published confirmed incident boundary. Location accuracy affects this estimate. Review the published update; this is not a spread prediction or evacuation instruction.' })), skipDuplicates: true });
    }
    cursor = locations.length === 250 ? locations.at(-1)!.userId : undefined;
  } while (cursor);
}
export async function notifyNearbyConfirmation(tx: Transaction, caseId: string) {
  await lockNearbyWorkflow(tx);
  const now = new Date();
  await tx.trUserLocation.deleteMany({ where: { expiresAt: { lte: now } } });
  const incident = await tx.trCase.findFirst({ where: { id: caseId, verificationStatus: 'CONFIRMED_FIRE', handlingStatus: { not: 'CLOSED' } }, select: { id: true, number: true, title: true, perimeter: true, perimeterRevision: true } });
  if (!incident) return 0;
  const perimeter = z.object({ type: z.literal('Polygon'), coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))) }).safeParse(incident.perimeter);
  if (!perimeter.success) return 0;
  let created = 0, cursor: string | undefined;
  do {
    const locations = await tx.trUserLocation.findMany({ where: { expiresAt: { gt: now }, accuracyMeters: { lte: 1000 }, user: { active: true } }, select: { userId: true, latitude: true, longitude: true, emailEnabled: true }, orderBy: { userId: 'asc' }, take: 250, ...(cursor ? { cursor: { userId: cursor }, skip: 1 } : {}) });
    const recipients = locations.filter(location => {
      const distance = geometryDistanceMeters([location.longitude, location.latitude], perimeter.data);
      return distance !== null && distance <= 2000;
    });
    if (recipients.length) {
      const result = await tx.trNotification.createMany({ data: recipients.map(location => ({ userId: location.userId, caseId: incident.id, eventKey: `nearby:${location.userId}:${incident.id}:${incident.perimeterRevision}:CONFIRMED_FIRE`, type: 'NEARBY_CONFIRMED_FIRE', title: 'Confirmed fire nearby', message: `A fire has been confirmed within 2 km of your saved location. Its precise boundary is not public until a separate privacy review and publication. This is not a spread prediction or evacuation instruction.`, emailRequested: location.emailEnabled })), skipDuplicates: true });
      created += result.count;
    }
    cursor = locations.length === 250 ? locations.at(-1)!.userId : undefined;
  } while (cursor);
  return created;
}

export async function notifyNearbyCompletion(tx: Transaction, caseId: string, publicationId: string, message: string) {
  const prior = await tx.trNotification.findMany({ where: { caseId, type: { in: ['NEARBY_CONFIRMED_FIRE', 'NEARBY_PUBLICATION', 'NEARBY_PRIORITY'] } }, distinct: ['userId'], select: { userId: true } });
  if (prior.length) await tx.trNotification.createMany({ data: prior.map(({ userId }) => ({ userId, caseId, publicationId, eventKey: `completion:${userId}:${publicationId}`, type: 'NEARBY_COMPLETION', title: 'Incident handling completed', message })), skipDuplicates: true });
}
