import { setTimeout as sleep } from 'node:timers/promises';
import { evaluateNearby } from '../notifications/nearby.service.js';
import { deliverNotificationEmails } from '../notifications/email.service.js';
import { db, env, pollIntervals, reevaluationAllowed } from '../../config/index.js';
import { syncSource, firmsConfigured } from './integrations.service.js';
import { analyzeSourceCase } from './analysis.service.js';
import type { PrismaClient } from '../../generated/prisma/client.js';

export { pollIntervals, reevaluationAllowed } from '../../config/index.js';
export async function pollSources(schedule: { FIRMS: number }, intervals: { FIRMS: number }, configured: boolean, run: (source: 'FIRMS') => Promise<void>, now = Date.now()) {
  if (!configured || now < schedule.FIRMS) return;
  schedule.FIRMS = now + intervals.FIRMS;
  try { await run('FIRMS'); } catch { return; }
}
export async function pendingAnalysisRevisions(client: PrismaClient = db()) {
  return client.$queryRaw<{ id: string; contextRevision: number }[]>`
    SELECT c.id, c."contextRevision" FROM "TrCase" c
    LEFT JOIN "TrAnalysis" latest ON latest.id = c."latestAnalysisId"
    WHERE c."handlingStatus" != 'CLOSED'
      AND (latest.id IS NULL OR latest."contextRevision" < c."contextRevision" OR latest.status != 'SUCCEEDED')
      AND (EXISTS (SELECT 1 FROM "TrReport" r WHERE r."caseId" = c.id)
        OR EXISTS (SELECT 1 FROM "TrFieldUpdate" f WHERE f."caseId" = c.id))
      AND NOT EXISTS (SELECT 1 FROM "TrAnalysis" a WHERE a."caseId" = c.id
        AND (a."startedAt" > now() - interval '15 minutes' OR (a."contextRevision" = c."contextRevision" AND a.status = 'SUCCEEDED')))
      AND (SELECT count(*) FROM "TrAnalysis" a WHERE a."caseId" = c.id AND a."contextRevision" = c."contextRevision") < 3
    ORDER BY c."updatedAt", c.id LIMIT 10`;
}
export async function reanalyzeSourceChanges(signal?: AbortSignal) {
  if (!reevaluationAllowed()) return;
  const changes = await pendingAnalysisRevisions();
  for (const item of changes) {
    if (signal?.aborted || !reevaluationAllowed()) break;
    try { await analyzeSourceCase(item.id, item.contextRevision); }
    catch { console.error('Case reevaluation unavailable or no longer eligible'); }
  }
}
export async function runSourcesWatch(signal: AbortSignal) {
  const intervals = pollIntervals(env);
  const schedule = { FIRMS: 0 };
  while (!signal.aborted) {
    await pollSources(schedule, intervals, firmsConfigured(), async source => {
      if (signal.aborted) return;
      try { await syncSource(source, {}); }
      catch { console.error(`${source} polling unavailable or already coordinated elsewhere`); }
    });
    if (!signal.aborted) {
      try { await db().$transaction(tx => evaluateNearby(tx), { timeout: 30000 }); }
      catch { console.error('Nearby notification evaluation unavailable'); }
      try { await deliverNotificationEmails(); }
      catch { console.error('Notification email delivery unavailable'); }
      try { await reanalyzeSourceChanges(signal); }
      catch { console.error('Case reevaluation queue unavailable'); }
    }
    try { await sleep(60000, undefined, { signal }); }
    catch (error) { if (!signal.aborted) throw error; }
  }
}
