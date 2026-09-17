import { z } from 'zod';
import { polygonSchema } from '../utils/geometry.js';

export const idSchema = z.string().trim().min(1).max(128);
export const reasonSchema = z.string().trim().min(5).max(2000);
export const timeSchema = z.iso.datetime({ offset: true }).refine(v => Date.parse(v) <= Date.now() + 300000, 'Time cannot be in the future');
export const latitudeSchema = z.number().finite().min(-90).max(90);
export const longitudeSchema = z.number().finite().min(-180).max(180);
export const roles = ['USER', 'ADMIN'] as const;
export const reviewStatuses = ['NEW', 'NEEDS_DETAILS', 'REVIEWED'] as const;
export const verificationStatuses = ['UNVERIFIED', 'CONFIRMED_FIRE', 'NOT_FIRE'] as const;
export const handlingStatuses = ['OPEN', 'CHECK_SCHEDULED', 'ON_SCENE', 'RESPONDING', 'MONITORING', 'CLOSED'] as const;
export const priorities = ['HIGH', 'MEDIUM', 'LOW', 'UNASSESSED'] as const;
export const fieldFindings = ['VISIBLE_FIRE', 'SMOKE_ONLY', 'NO_INDICATION', 'INCONCLUSIVE', 'UNREACHABLE'] as const;
export const assignmentStatuses = ['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const;
export const publicationTypes = ['UPDATE', 'ANNOUNCEMENT', 'WARNING', 'EDUCATION'] as const;
export const publicationStatuses = ['DRAFT', 'PUBLISHED', 'SUPERSEDED', 'WITHDRAWN'] as const;
export const featureKinds = ['BOUNDARY', 'FOREST', 'PEATLAND', 'SETTLEMENT', 'FACILITY', 'ROAD', 'RIVER', 'WATER_SOURCE', 'DESIGNATED_LOCATION'] as const;
const coords = { latitude: latitudeSchema.nullish(), longitude: longitudeSchema.nullish() };
export const pairedCoordinates = (v: { latitude?: number | null; longitude?: number | null }) => (v.latitude == null) === (v.longitude == null);
export const reportSchema = z.strictObject({
  observationTypes: z.array(z.enum(['SMOKE', 'FLAME', 'BURNING_SMELL'])).min(1).max(3).refine(v => new Set(v).size === v.length),
  observedAt: timeSchema,
  locationMode: z.enum(['INCIDENT_ESTIMATE', 'OBSERVER_POSITION']),
  latitude: latitudeSchema.nullable(), longitude: longitudeSchema.nullable(),
  accuracyMeters: z.number().nonnegative().max(100000).nullish(),
  regionId: idSchema.nullish(), locationDescription: z.string().trim().max(1000).default(''),
  description: z.string().trim().min(5).max(2000),
  attachmentIds: z.array(idSchema).max(5).refine(v => new Set(v).size === v.length).default([]),
  idempotencyKey: z.string().min(16).max(128),
}).refine(pairedCoordinates, 'Latitude and longitude must be provided together').refine(v => v.latitude !== null || !!v.regionId, 'Coordinates or a verified region are required')
  .refine(v => v.latitude !== null || v.locationDescription.length >= 5, { message: 'Without coordinates, describe the location using at least 5 characters', path: ['locationDescription'] });
export const uploadSchema = z.strictObject({
  filename: z.string().min(1).max(180).regex(/^[^/\\]+\.(jpe?g|png|webp)$/i).refine(v => [...v].every(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  size: z.number().int().positive().max(5 * 1024 * 1024),
}).refine(v => ({ 'image/jpeg': /\.jpe?g$/i, 'image/png': /\.png$/i, 'image/webp': /\.webp$/i }[v.contentType]).test(v.filename), 'File extension must match content type');
export const caseSchema = z.strictObject({ title: z.string().trim().min(3).max(200), ...coords, regionId: idSchema.nullish(), reason: reasonSchema }).refine(pairedCoordinates);
export const fieldSchema = z.strictObject({ findings: z.enum(fieldFindings), description: reasonSchema, source: z.string().trim().min(3).max(300), observedAt: timeSchema, ...coords, teamId: idSchema.nullish(), attachmentIds: z.array(idSchema).max(5).default([]) }).refine(pairedCoordinates);
export const verificationSchema = z.strictObject({ outcome: z.enum(['CONFIRMED_FIRE', 'NOT_FIRE', 'INCONCLUSIVE']), reason: reasonSchema, authorityReference: z.string().trim().min(3).max(500), fieldUpdateId: idSchema, version: z.number().int().positive() });
export const perimeterPatchSchema = z.strictObject({ version: z.number().int().positive(), perimeter: polygonSchema, perimeterObservedAt: timeSchema, perimeterSource: z.string().trim().min(3).max(300), reason: reasonSchema, authorityReference: z.string().trim().min(3).max(500) });
export const casePatchSchema = z.union([perimeterPatchSchema, z.strictObject({ priority: z.enum(priorities).optional(), handlingStatus: z.enum(handlingStatuses).optional(), reason: reasonSchema, version: z.number().int().positive() }).refine(v => !!v.priority || !!v.handlingStatus, 'A change is required')]);
export const reviewSchema = z.strictObject({ reviewStatus: z.enum(reviewStatuses).optional(), caseId: idSchema.nullable().optional(), reason: reasonSchema }).refine(v => v.reviewStatus !== undefined || v.caseId !== undefined);
export const updateSchema = z.strictObject({ message: reasonSchema, kind: z.enum(['CLARIFICATION', 'REQUEST', 'CORRECTION']).optional() });
export const teamSchema = z.strictObject({ name: z.string().trim().min(2).max(200), organization: z.string().trim().min(2).max(200).nullish() });
export const equipmentSchema = z.strictObject({ name: z.string().trim().min(2).max(200), kind: z.string().trim().min(2).max(100), teamId: idSchema.nullish() });
export const operationalConditions = { TEAM: ['AVAILABLE', 'DEPLOYED', 'UNAVAILABLE', 'UNKNOWN'], EQUIPMENT: ['AVAILABLE', 'IN_USE', 'DAMAGED', 'UNAVAILABLE', 'UNKNOWN'], FEATURE: ['PASSABLE', 'RESTRICTED', 'IMPASSABLE', 'WATER_AVAILABLE', 'WATER_UNAVAILABLE', 'UNKNOWN'] } as const;
export const operationalSchema = z.strictObject({ subjectType: z.enum(['TEAM', 'EQUIPMENT', 'FEATURE']), subjectId: idSchema, condition: z.string().max(40), source: z.string().trim().min(3).max(300), observedAt: timeSchema, notes: z.string().trim().max(2000).nullish() }).refine(v => (operationalConditions[v.subjectType] as readonly string[]).includes(v.condition), 'Condition is invalid for subject');
export const assignmentSchema = z.strictObject({ teamId: idSchema, notes: z.string().trim().max(2000).nullish() });
export const assignmentPatchSchema = z.strictObject({ status: z.enum(assignmentStatuses), reason: reasonSchema });
const safeUrl = z.url({ protocol: /^https?$/ }).max(2000);
export const publicationSchema = z.strictObject({
  title: z.string().trim().min(3).max(200), summary: z.string().trim().min(5).max(600), body: z.string().trim().min(5).max(40000).refine(v => !/<\/?[a-z][^>]*>/i.test(v), 'Publication body must be plain text or Markdown without HTML'),
  type: z.enum(publicationTypes), sources: z.array(z.strictObject({ title: z.string().trim().min(2).max(200), url: safeUrl })).max(30),
  regionIds: z.array(idSchema).max(30).default([]), caseId: idSchema.nullish(), validUntil: z.iso.datetime({ offset: true }).nullish(),
  publicLocationMode: z.enum(['NONE', 'REGION_ONLY', 'APPROVED_INCIDENT_POINT', 'APPROVED_INCIDENT_PERIMETER']).default('NONE'),
  publicLatitude: latitudeSchema.nullish(), publicLongitude: longitudeSchema.nullish(), privacyReview: reasonSchema.nullish(),
}).refine(v => v.publicLocationMode !== 'APPROVED_INCIDENT_POINT' || (v.publicLatitude != null && v.publicLongitude != null && !!v.privacyReview && !!v.caseId), 'An approved point requires coordinates, case and privacy review')
  .refine(v => v.publicLocationMode !== 'APPROVED_INCIDENT_PERIMETER' || (!!v.caseId && !!v.privacyReview), 'An approved perimeter requires a case and privacy review')
  .refine(v => v.publicLocationMode !== 'REGION_ONLY' || v.regionIds.length > 0, 'Region-only projection requires a region');
export const publishSchema = z.strictObject({ authorityReference: z.string().trim().min(3).max(500), expectedUpdatedAt: z.iso.datetime({ offset: true }) });
export const withdrawalSchema = z.strictObject({ reason: reasonSchema });
export const settingsSchema = z.strictObject({ name: z.string().trim().min(2).max(200).nullish(), operator: z.string().trim().min(2).max(200).nullish(), email: z.email().nullish(), phone: z.string().trim().min(5).max(50).nullish(), address: z.string().trim().max(1000).nullish(), hours: z.string().trim().max(500).nullish(), source: z.string().trim().min(3).max(1000), verifiedAt: timeSchema });
export const paginationSchema = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20), search: z.string().trim().max(200).optional(), type: z.enum(publicationTypes).optional(), regionId: idSchema.optional() });
export const informationQuerySchema = paginationSchema.extend({ active: z.enum(['true', 'false']).default('false').transform(value => value === 'true') });
export type Actor = { id: string; role: 'USER' | 'ADMIN'; active: boolean; canConfirmIncidents: boolean; canPublishInformation: boolean };
export type Transaction = import('../generated/prisma/client.js').Prisma.TransactionClient;
export const enums = { roles, reviewStatuses, verificationStatuses, handlingStatuses, priorities, fieldFindings, assignmentStatuses, publicationTypes, publicationStatuses, featureKinds, operationalConditions, observationTypes: ['SMOKE', 'FLAME', 'BURNING_SMELL'], locationModes: ['INCIDENT_ESTIMATE', 'OBSERVER_POSITION'], verificationOutcomes: ['CONFIRMED_FIRE', 'NOT_FIRE', 'INCONCLUSIVE'] };
