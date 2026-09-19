import { setTimeout as sleep } from 'node:timers/promises';
import { db, env, pollIntervals, reevaluationAllowed } from '../../config/index.js';
import { syncSource, firmsConfigured } from './integrations.service.js';
import { analyzeSourceCase } from './analysis.service.js';
import type { PrismaClient } from '../../generated/prisma/client.js';

export { pollIntervals, reevaluationAllowed } from '../../config/index.js';
export async function pollSources(schedule: { FIRMS: number }, interval: number, configured: boolean, run: (source: 'FIRMS') => Promise<void>, now = Date.now()) {
  if (!configured || now < schedule.FIRMS) return;
  schedule.FIRMS = now + interval;
  try { await run('FIRMS'); } catch { return; }
}
export async function pendingAnalysisRevisions(client: PrismaClient = db()) {
  return client.$queryRaw<{ id: string; contextRevision: number }[]>`
    SELECT c.id, c."contextRevision" FROM "TrCase" c
    LEFT JOIN "TrAnalysis" latest ON latest.id = c."latestAnalysisId"
    WHERE c."handlingStatus" != 'CLOSED'
      AND (latest.id IS NULL OR latest."contextRevision" < c."contextRevision" OR latest.status != 'SUCCEEDED')
      AND (EXISTS (SELECT 1 FROM "TrReport" r WHERE r."caseId" = c.id)
        OR EXISTS (SELECT 1 FROM "TrFieldUpdate" f WHERE f."caseId" = c.id)
        OR EXISTS (SELECT 1 FROM "TrHotspot" h WHERE h."caseId" = c.id))
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
  let nextFirms = 0;
  while (!signal.aborted) {
    if (firmsConfigured() && Date.now() >= nextFirms) {
      nextFirms = Date.now() + intervals.FIRMS;
      try { await syncSource('FIRMS', {}); }
      catch { console.error('FIRMS polling unavailable or already coordinated elsewhere'); }
    }
    if (!signal.aborted) {
      try { await reanalyzeSourceChanges(signal); }
      catch { console.error('Case reevaluation queue unavailable'); }
    }
    try { await sleep(60000, undefined, { signal }); }
    catch (error) { if (!signal.aborted) throw error; }
  }
}
