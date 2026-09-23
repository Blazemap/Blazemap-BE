import { db, emailAvailable, env, sendEmail } from '../../config/index.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { Transaction } from '../../types/index.js';

export async function lockNotificationEmailWorkflow(tx: Transaction) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(724819321)`;
}

export async function deliverNotificationEmails(client: PrismaClient = db()) {
  if (!emailAvailable || !env.FRONTEND_URL) return { delivered: 0, failed: 0 };
  const claimed = await client.$transaction(async tx => {
    await lockNotificationEmailWorkflow(tx);
    const now = new Date();
    const staleClaim = new Date(now.getTime() - 10 * 60_000);
    const rows = await tx.trNotification.findMany({ where: { emailRequested: true, emailSentAt: null, emailAttempts: { lt: 5 }, OR: [{ emailClaimedAt: null }, { emailClaimedAt: { lt: staleClaim } }], user: { active: true, emailVerified: true } }, select: { id: true, title: true, message: true, caseId: true, publication: { select: { slug: true } }, user: { select: { email: true } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 20 });
    if (rows.length) await tx.trNotification.updateMany({ where: { id: { in: rows.map(row => row.id) }, emailSentAt: null }, data: { emailClaimedAt: now, lastEmailAttemptAt: now, emailAttempts: { increment: 1 } } });
    return rows;
  });
  let delivered = 0, failed = 0;
  for (const item of claimed) {
    const path = item.caseId ? `/dashboard?observation=${encodeURIComponent(`case:${item.caseId}`)}` : item.publication ? `/publications/${encodeURIComponent(item.publication.slug)}` : '/dashboard';
    const url = new URL(path, env.FRONTEND_URL).href;
    try {
      const sent = await sendEmail(item.user.email, item.title, `${item.message}\n\nOpen Blazemap: ${url}`);
      if (sent) { await client.trNotification.updateMany({ where: { id: item.id, emailSentAt: null }, data: { emailSentAt: new Date(), emailClaimedAt: null } }); delivered++; }
      else { await client.trNotification.updateMany({ where: { id: item.id, emailSentAt: null }, data: { emailClaimedAt: null } }); failed++; }
    } catch {
      await client.trNotification.updateMany({ where: { id: item.id, emailSentAt: null }, data: { emailClaimedAt: null } });
      failed++;
    }
  }
  return { delivered, failed };
}
