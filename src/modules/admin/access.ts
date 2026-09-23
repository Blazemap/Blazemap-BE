import type { Actor, Transaction } from '../../types/index.js';
import { AppError, jsonValue } from '../../utils/index.js';
import { authorize, effectiveCapabilities } from './rules.js';

export async function lockedActor(tx: Transaction, actor: Pick<Actor, 'id'>, admin = false, capability?: 'canConfirmIncidents' | 'canPublishInformation') {
  await tx.$queryRaw`SELECT id FROM "MsUser" WHERE id = ${actor.id} FOR UPDATE`;
  const user = await tx.msUser.findUnique({ where: { id: actor.id }, select: { id: true, role: true, active: true, emailVerified: true, canConfirmIncidents: true, canPublishInformation: true } });
  if (!user?.active) throw new AppError('Account unavailable', 401, 'UNAUTHORIZED');
  if (admin) authorize(user, capability);
  return { ...user, ...effectiveCapabilities(user) };
}
export async function audit(tx: Transaction, actorId: string, action: string, targetType: string, targetId: string, reason?: string, details?: unknown) {
  await tx.trAuditLog.create({ data: { actorId, action, targetType, targetId, reason, ...(details === undefined ? {} : { details: jsonValue(details) }) } });
}
export async function verifiedRegion(tx: Transaction, id?: string | null) {
  if (id && !(await tx.msRegion.findFirst({ where: { id, verifiedAt: { not: null } }, select: { id: true } }))) throw new AppError('A verified region is required', 400, 'INVALID_REGION');
}
export async function bumpContext(tx: Transaction, id: string) {
  await tx.trCase.updateMany({ where: { id, handlingStatus: { not: 'CLOSED' } }, data: { contextRevision: { increment: 1 }, version: { increment: 1 }, latestAnalysisId: null } });
}
export const activeAssignments = ['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS'] as const;
