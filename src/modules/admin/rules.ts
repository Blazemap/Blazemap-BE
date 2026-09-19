import { AppError } from '../../utils/index.js';
import type { HandlingStatus, VerificationStatus } from '../../generated/prisma/enums.js';

export function effectiveCapabilities(user: { role?: string | null; active?: boolean | null; emailVerified?: boolean }) {
  const authorized = user.role === 'ADMIN' && user.active === true && user.emailVerified === true;
  return { canConfirmIncidents: authorized, canPublishInformation: authorized };
}
export function authorize(user: { role: string; active: boolean; emailVerified?: boolean; canConfirmIncidents?: boolean; canPublishInformation?: boolean } | null, capability?: 'canConfirmIncidents' | 'canPublishInformation') {
  if (!user || !effectiveCapabilities(user)[capability ?? 'canConfirmIncidents']) throw new AppError('Not authorized for this action', 403, 'FORBIDDEN');
}
export function nextPublicationTimestamp(previous: Date, now = Date.now()) {
  return new Date(Math.max(now, previous.getTime() + 1));
}
export function assertPublicationRevision(actual: Date, expected: string) {
  if (actual.getTime() !== Date.parse(expected)) throw new AppError('Publication changed; reload and review it before publishing', 409, 'PUBLICATION_CONFLICT');
}
export function assertVersion(actual: number, expected: number) {
  if (actual !== expected) throw new AppError('Record changed; reload before continuing', 409, 'VERSION_CONFLICT');
}
export function transition(verification: VerificationStatus, handling: HandlingStatus, activeAssignments: number) {
  if (handling === 'RESPONDING' && verification !== 'CONFIRMED_FIRE') throw new AppError('Response requires a confirmed fire', 409, 'INVALID_TRANSITION');
  if (handling === 'CLOSED' && activeAssignments > 0) throw new AppError('Complete or cancel active assignments before closing', 409, 'ACTIVE_ASSIGNMENTS');
}
export function publicPoint(item: { publicLocationMode: string; publicLatitude: number | null; publicLongitude: number | null }) {
  return item.publicLocationMode === 'APPROVED_INCIDENT_POINT' ? { latitude: item.publicLatitude, longitude: item.publicLongitude } : { latitude: null, longitude: null };
}
export function verificationProjection(current: { verificationStatus: 'UNVERIFIED' | 'CONFIRMED_FIRE' | 'NOT_FIRE'; handlingStatus: 'OPEN' | 'CHECK_SCHEDULED' | 'ON_SCENE' | 'RESPONDING' | 'MONITORING' | 'CLOSED'; latitude: number | null; longitude: number | null }, outcome: 'CONFIRMED_FIRE' | 'NOT_FIRE' | 'INCONCLUSIVE', field: { latitude: number | null; longitude: number | null }) {
  if ((field.latitude === null) !== (field.longitude === null) || (field.latitude !== null && field.longitude !== null && (!Number.isFinite(field.latitude) || field.latitude < -90 || field.latitude > 90 || !Number.isFinite(field.longitude) || field.longitude < -180 || field.longitude > 180))) throw new AppError('Field coordinates must be a valid pair', 400, 'INVALID_COORDINATES');
  const verificationStatus = outcome === 'INCONCLUSIVE' ? current.verificationStatus : outcome;
  const handlingStatus = outcome === 'NOT_FIRE' && current.handlingStatus === 'RESPONDING' ? 'MONITORING' : current.handlingStatus;
  return { ...current, verificationStatus, handlingStatus, ...(outcome === 'CONFIRMED_FIRE' && field.latitude !== null ? { latitude: field.latitude, longitude: field.longitude } : {}) };
}
