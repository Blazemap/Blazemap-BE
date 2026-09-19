import { randomUUID } from 'node:crypto';
import type { Transaction } from '../../types/index.js';
import { createReportNotification } from '../notifications/index.js';

export async function recordCaseProgress(tx: Transaction, caseId: string, actorId: string, stage: string, description: string | undefined) {
  if (!description) return;
  const reports = await tx.trReport.findMany({ where: { caseId }, select: { id: true, reporterId: true }, orderBy: { id: 'asc' } });
  const progress = reports.map(report => ({ id: randomUUID(), reportId: report.id, reporterId: report.reporterId }));
  if (!progress.length) return;
  await tx.trReportProgress.createMany({ data: progress.map(item => ({ id: item.id, reportId: item.reportId, actorId, stage, description })) });
  for (const item of progress) await createReportNotification(tx, { eventKey: `progress:${item.id}`, reportId: item.reportId, userId: item.reporterId, type: stage === 'CLOSED' || ['OPEN', 'CHECK_SCHEDULED', 'ON_SCENE', 'RESPONDING', 'MONITORING'].includes(stage) ? 'REPORT_HANDLING' : 'REPORT_VERIFICATION', stage, message: description });
}
