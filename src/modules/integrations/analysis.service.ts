import { db, env, reevaluationAllowed } from '../../config/index.js';
import type { Actor } from '../../types/index.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { AppError, boundedText, jsonValue, unavailable } from '../../utils/index.js';
import { audit, lockedActor } from '../admin/access.js';
import { analysisSchema, validateAnalysisReferences, validateAnalysisSafety } from './parsing.js';
import { buildAnalysisContext, privacyLimitation } from './snapshot.js';
import { loadWindContext } from './wind.js';

export async function analyzeCase(actor: Actor, id: string) {
  return runAnalysis(actor, id);
}
export async function analyzeSourceCase(id: string, contextRevision: number, client?: PrismaClient) {
  if (!reevaluationAllowed()) throw new AppError('Automatic analysis is not enabled', 403, 'FORBIDDEN');
  return runAnalysis(null, id, contextRevision, client);
}
async function runAnalysis(actor: Actor | null, id: string, expectedRevision?: number, client: PrismaClient = db()) {
  if (!env.AI_SERVICE_URL || !env.AI_SERVICE_TOKEN) throw unavailable('AI analysis');
  const prepared = await client.$transaction(async tx => {
    if (actor) await lockedActor(tx, actor, true);
    else if (!reevaluationAllowed()) throw new AppError('Automatic analysis is not enabled', 403, 'FORBIDDEN');
    await tx.$queryRaw`SELECT id FROM "TrCase" WHERE id = ${id} FOR UPDATE`;
    const c = await tx.trCase.findUniqueOrThrow({ where: { id }, select: {
      id: true, latitude: true, longitude: true, contextRevision: true, verificationStatus: true, handlingStatus: true, latestAnalysisId: true, regionId: true,
      latestAnalysis: { select: { contextRevision: true, status: true } },
      region: { select: { id: true, name: true, level: true, bmkgAdm4: true, verifiedAt: true } },
      reports: { select: { id: true, observationTypes: true, observedAt: true, locationMode: true, latitude: true, longitude: true, updates: { select: { id: true, kind: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 20 } }, take: 100, orderBy: { observedAt: 'desc' } },
      hotspots: { select: { id: true, acquiredAt: true, latitude: true, longitude: true, product: true, confidenceRaw: true, frp: true }, take: 200, orderBy: { acquiredAt: 'desc' } },
      fieldUpdates: { select: { id: true, findings: true, source: true, observedAt: true, latitude: true, longitude: true }, take: 100, orderBy: { observedAt: 'desc' } },
    } });
    if (!actor) {
      const attempts = await tx.trAnalysis.count({ where: { caseId: id, contextRevision: c.contextRevision } });
      const hasCurrent = c.latestAnalysis?.status === 'SUCCEEDED' && c.latestAnalysis.contextRevision >= c.contextRevision;
      if (c.contextRevision !== expectedRevision || c.handlingStatus === 'CLOSED' || hasCurrent || attempts >= 3) throw new AppError('Case analysis is no longer eligible', 409, 'ANALYSIS_NOT_ELIGIBLE');
      const completed = await tx.trAnalysis.findFirst({ where: { caseId: id, contextRevision: c.contextRevision, status: 'SUCCEEDED' }, select: { id: true } });
      if (completed) throw new AppError('Context was already analyzed', 409, 'ANALYSIS_NOT_ELIGIBLE');
    }
    await tx.trAnalysis.updateMany({ where: { caseId: id, status: 'RUNNING', startedAt: { lt: new Date(Date.now() - 180000) } }, data: { status: 'FAILED', completedAt: new Date(), failureCode: 'RUN_EXPIRED' } });
    const existing = await tx.trAnalysis.findFirst({ where: { caseId: id, status: 'RUNNING' } });
    if (existing) throw new AppError('Analysis already running for this context', 409, 'ANALYSIS_RUNNING');
    const recent = await tx.trAnalysis.findFirst({ where: { caseId: id, startedAt: { gt: new Date(Date.now() - (actor ? 60000 : 900000)) } } });
    if (recent) throw new AppError('Analysis recently requested; retry later', 429, 'ANALYSIS_RATE_LIMIT');
    const now = new Date();
    const wind = await loadWindContext(tx, c.region, now);
    const forecast = ['READY', 'CALM', 'MISSING_WIND'].includes(wind.windContext.status) ? wind.forecast : null;
    const spatial = c.regionId ? await tx.msMapFeature.findMany({ where: { regionId: c.regionId, layer: { verifiedAt: { not: null } } }, select: { id: true, name: true, kind: true, regionId: true, layerId: true, geometry: true, attributes: true, layer: { select: { sourceDate: true, importedAt: true, provider: true, license: true, attribution: true, verifiedAt: true } } }, take: 100 }) : [];
    const operational = await tx.trOperationalUpdate.findMany({ where: { observedAt: { gt: new Date(now.getTime() - 86400000), lte: now }, OR: [{ team: { assignments: { some: { caseId: id, status: { in: ['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS'] } } } } }, { equipment: { team: { assignments: { some: { caseId: id, status: { in: ['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS'] } } } } } }, ...(c.regionId ? [{ feature: { regionId: c.regionId } }] : [])] }, select: { id: true, subjectType: true, teamId: true, equipmentId: true, featureId: true, condition: true, observedAt: true }, take: 100, orderBy: { observedAt: 'desc' } });
    let context: ReturnType<typeof buildAnalysisContext>;
    try {
      context = buildAnalysisContext(c, forecast, spatial, operational, wind.windContext);
      if (!context.observations.length) throw new AppError('Analysis requires observations', 409, 'NO_OBSERVATIONS');
      if (context.observations.length + spatial.length + operational.length + (forecast ? 1 : 0) > 50) throw new AppError('Case context exceeds the AI service limit of 50 sources', 409, 'CONTEXT_TOO_LARGE');
      if (Buffer.byteLength(JSON.stringify(context)) > 128 * 1024) throw new AppError('Case context exceeds the AI service limit of 128 KiB', 409, 'CONTEXT_TOO_LARGE');
    } catch (error) {
      await tx.trAnalysis.create({ data: { caseId: id, contextRevision: c.contextRevision, status: 'FAILED', failureCode: 'CONTEXT_INVALID', completedAt: new Date(), input: jsonValue({ caseId: id, contextRevision: c.contextRevision, limitations: [privacyLimitation] }) } });
      return { error: error instanceof AppError ? error : new AppError('Structured analysis context is invalid', 409, 'CONTEXT_INVALID') };
    }
    const run = await tx.trAnalysis.create({ data: { caseId: id, contextRevision: c.contextRevision, input: jsonValue(context) } });
    return { run, context, ids: new Set([...context.observations.map(o => o.id), ...context.spatialContext.map(s => s.id), ...context.operationalContext.map(o => o.id), ...(context.weather ? [context.weather.id] : [])]) };
  });
  if ('error' in prepared) throw prepared.error;
  try {
    const response = await fetch(`${env.AI_SERVICE_URL.replace(/\/$/, '')}/analyze`, { method: 'POST', headers: { Authorization: `Bearer ${env.AI_SERVICE_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(prepared.context), signal: AbortSignal.timeout(90000), redirect: 'error' });
    const output = analysisSchema.parse(JSON.parse(await boundedText(response, 1000000)));
    if (output.caseId !== id || output.contextRevision !== prepared.context.contextRevision || Date.parse(output.generatedAt) > Date.now() + 300000) throw unavailable('AI context validation');
    validateAnalysisReferences(output, prepared.ids);
    validateAnalysisSafety(output, prepared.context);
    output.limitations = [...new Set([...output.limitations, privacyLimitation])];
    const schemaVersion = response.headers.get('X-AI-Schema-Version');
    const promptVersion = response.headers.get('X-AI-Prompt-Version');
    const ruleVersion = response.headers.get('X-AI-Rule-Version');
    if (schemaVersion !== '2' || [promptVersion, ruleVersion].some(v => v === null || !/^[a-zA-Z0-9._-]{1,100}$/.test(v))) throw unavailable('AI version validation');
    return await client.$transaction(async tx => {
      if (actor) await lockedActor(tx, actor, true);
      else if (!reevaluationAllowed()) throw new AppError('Automatic analysis is not enabled', 403, 'FORBIDDEN');
      await tx.$queryRaw`SELECT id FROM "TrCase" WHERE id = ${id} FOR UPDATE`;
      const c = await tx.trCase.findUniqueOrThrow({ where: { id }, select: { contextRevision: true, handlingStatus: true } });
      const current = c.contextRevision === prepared.context.contextRevision && (!!actor || c.handlingStatus !== 'CLOSED');
      const run = await tx.trAnalysis.update({ where: { id: prepared.run.id, status: 'RUNNING' }, data: { status: current ? 'SUCCEEDED' : 'OBSOLETE', output: jsonValue(output), evidenceLevel: output.evidenceLevel, impactLevel: output.impactLevel, suggestedPriority: output.suggestedPriority, model: output.model, schemaVersion, promptVersion, ruleVersion: ruleVersion!, completedAt: new Date() }, select: { id: true, status: true, contextRevision: true, output: true, startedAt: true, completedAt: true } });
      if (current) await tx.trCase.update({ where: { id, contextRevision: prepared.context.contextRevision }, data: { latestAnalysisId: run.id } });
      if (actor) await audit(tx, actor.id, current ? 'ANALYSIS_COMPLETED' : 'ANALYSIS_OBSOLETE', 'CASE', id, undefined, { analysisId: run.id });
      else await tx.trAuditLog.create({ data: { systemActor: 'source-worker', action: current ? 'ANALYSIS_COMPLETED' : 'ANALYSIS_OBSOLETE', targetType: 'CASE', targetId: id, details: { analysisId: run.id, contextRevision: prepared.context.contextRevision } } });
      return { ...output, id: run.id, status: run.status, current };
    });
  } catch (error) {
    await client.trAnalysis.updateMany({ where: { id: prepared.run.id, status: 'RUNNING' }, data: { status: 'FAILED', completedAt: new Date(), failureCode: 'AI_UNAVAILABLE' } });
    if (error instanceof AppError && error.status === 403) throw error;
    throw unavailable('AI analysis');
  }
}
