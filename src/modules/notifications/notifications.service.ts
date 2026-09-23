import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { db } from '../../config/index.js';
import type { Actor, Transaction } from '../../types/index.js';
import { AppError } from '../../utils/index.js';

const querySchema = z.object({ cursor: z.string().trim().min(1).max(128).optional(), pageSize: z.coerce.number().int().min(1).max(10).default(10) });
const notificationSelect = { id: true, reportId: true, publicationId: true, caseId: true, publication: { select: { slug: true } }, type: true, title: true, message: true, createdAt: true, readAt: true } as const;

function notificationTitle(stage: string) {
  const titles: Record<string, string> = {
    UNDER_REVIEW: 'Report under review',
    NEEDS_DETAILS: 'More details requested',
    REVIEWED: 'Report reviewed',
    CONFIRMED_FIRE: 'Fire confirmed',
    NOT_FIRE: 'Verification completed',
    INCONCLUSIVE: 'Verification inconclusive',
    DECLINED: 'Report declined',
    OPEN: 'Incident handling updated',
    CHECK_SCHEDULED: 'Inspection scheduled',
    ON_SCENE: 'Team on scene',
    RESPONDING: 'Response underway',
    MONITORING: 'Incident monitoring',
    CLOSED: 'Incident handling completed',
  };
  return titles[stage] ?? (stage.startsWith('CORRECTION_') ? 'Verification updated' : 'Report updated');
}

export async function createReportNotification(tx: Transaction, input: { eventKey: string; reportId: string; type: string; stage: string; message: string; userId?: string }) {
  const userId = input.userId ?? (await tx.trReport.findUniqueOrThrow({ where: { id: input.reportId }, select: { reporterId: true } })).reporterId;
  return tx.trNotification.createMany({
    data: [{ userId, reportId: input.reportId, eventKey: input.eventKey, type: input.type, title: notificationTitle(input.stage), message: input.message }],
    skipDuplicates: true,
  });
}

export function adminNotificationRows(adminIds: string[], input: { eventKey: string; reportId: string; type: string; title: string; message: string }) {
  return adminIds.map(userId => ({ userId, reportId: input.reportId, eventKey: `${input.eventKey}:${userId}`, type: input.type, title: input.title, message: input.message }));
}
export async function createAdminNotifications(tx: Transaction, input: { eventKey: string; reportId: string; type: string; title: string; message: string }) {
  const admins = await tx.msUser.findMany({ where: { role: 'ADMIN', active: true, emailVerified: true }, select: { id: true } });
  if (!admins.length) return { count: 0 };
  return tx.trNotification.createMany({ data: adminNotificationRows(admins.map(admin => admin.id), input), skipDuplicates: true });
}

export async function listNotifications(actor: Actor, query: unknown, client: PrismaClient = db()) {
  const { cursor, pageSize } = querySchema.parse(query);
  let cursorRow: { id: string; createdAt: Date } | null = null;
  if (cursor) {
    cursorRow = await client.trNotification.findFirst({ where: { id: cursor, userId: actor.id }, select: { id: true, createdAt: true } });
    if (!cursorRow) throw new AppError('Notification cursor not found', 400, 'INVALID_CURSOR');
  }
  const where = {
    userId: actor.id,
    ...(cursorRow ? { OR: [{ createdAt: { lt: cursorRow.createdAt } }, { createdAt: cursorRow.createdAt, id: { lt: cursorRow.id } }] } : {}),
  };
  const [rows, unreadCount] = await client.$transaction([
    client.trNotification.findMany({ where, select: notificationSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: pageSize + 1 }),
    client.trNotification.count({ where: { userId: actor.id, readAt: null } }),
  ]);
  const hasMore = rows.length > pageSize;
  const data = rows.slice(0, pageSize);
  return { data, meta: { pageSize, unreadCount, nextCursor: hasMore ? data.at(-1)?.id ?? null : null } };
}

export async function markNotificationRead(actor: Actor, id: string, client: PrismaClient = db()) {
  const owned = await client.trNotification.findFirst({ where: { id, userId: actor.id }, select: { id: true, readAt: true } });
  if (!owned) throw new AppError('Notification not found', 404, 'NOT_FOUND');
  if (!owned.readAt) await client.trNotification.updateMany({ where: { id, userId: actor.id, readAt: null }, data: { readAt: new Date() } });
  return { id, read: true };
}

export async function markAllNotificationsRead(actor: Actor, client: PrismaClient = db()) {
  const result = await client.trNotification.updateMany({ where: { userId: actor.id, readAt: null }, data: { readAt: new Date() } });
  return { updated: result.count };
}
