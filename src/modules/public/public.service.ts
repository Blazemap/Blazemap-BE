import { z } from 'zod';
import { db, databaseAvailable, emailAvailable, uploadsAvailable, env } from '../../config/index.js';
import { googleAvailable } from '../../config/env.js';
import { AppError } from '../../utils/index.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { Actor } from '../../types/index.js';
import { firmsConfigured } from '../integrations/integrations.service.js';
import { publicPoint } from '../admin/rules.js';
import { reportDto, reportInclude, ownerReportDto, ownerReportInclude } from '../reports/reports.service.js';
import { triageReports } from '../reports/triage.js';
import { polygonSchema, publicPerimeter } from '../../utils/geometry.js';
import { geometrySchema } from '../admin/datasets.service.js';

export function firmsSourceStatus(configured: boolean, latest: string | null, lastSuccess: Date | null, now = Date.now()): { status: 'AVAILABLE' | 'STALE' | 'NOT_CONFIGURED' | 'NOT_SYNCED' | 'UNAVAILABLE'; message?: string; lastSuccessAt?: string } {
  const lastSuccessAt = lastSuccess ? { lastSuccessAt: lastSuccess.toISOString() } : {};
  if (!configured) return { status: 'NOT_CONFIGURED', message: 'FIRMS is not configured. Any retained observations are stale; an empty cache is not a successful source query.', ...lastSuccessAt };
  if (latest === 'FAILED') return { status: 'UNAVAILABLE', message: 'Latest FIRMS request failed. Any retained observations are stale; an empty cache does not establish no detections.', ...lastSuccessAt };
  if (!lastSuccess) return { status: 'NOT_SYNCED', message: 'No successful FIRMS sync recorded. Any retained observations are stale; detection coverage is unknown.' };
  if (now - lastSuccess.getTime() > 3600000) return { status: 'STALE', message: 'FIRMS has not refreshed within one hour. Retained observations are stale.', ...lastSuccessAt };
  return { status: 'AVAILABLE', message: 'FIRMS last sync succeeded. Detections shown are limited to the requested window and configured source coverage.', ...lastSuccessAt };
}

export function weatherSourceStatus(configured = !!env.GOOGLE_MAPS_SERVER_KEY) {
  return configured ? { status: 'ON_DEMAND', message: 'Google Weather current conditions are requested for case coordinates on demand. This does not indicate live provider availability.' } : { status: 'NOT_CONFIGURED', message: 'Google Weather server key is not configured; case weather is unavailable.' };
}

async function sourceStatus() {
  const connected = await databaseAvailable();
  const sources = [];
  for (const [id, name, configured] of [
    ['FIRMS', 'NASA FIRMS', firmsConfigured()],
    ['GOOGLE_WEATHER', 'Google Weather', !!env.GOOGLE_MAPS_SERVER_KEY],
    ['AI', 'AI analysis', !!(env.AI_SERVICE_URL && env.AI_SERVICE_TOKEN)],
  ] as const) {
    if (id === 'GOOGLE_WEATHER') { sources.push({ id, name, ...weatherSourceStatus(configured) }); continue; }
    if (!connected) { sources.push({ id, name, status: 'UNAVAILABLE', message: 'Database unavailable' }); continue; }
    if (!configured && id !== 'FIRMS') { sources.push({ id, name, status: 'NOT_CONFIGURED', message: `${name} is not configured` }); continue; }
    if (id === 'AI') {
      const latest = await db().trAnalysis.findFirst({ orderBy: { startedAt: 'desc' }, select: { status: true, completedAt: true } });
      sources.push({ id, name, status: latest?.status === 'FAILED' ? 'UNAVAILABLE' : latest ? latest.status : 'NOT_SYNCED', ...(latest?.status === 'SUCCEEDED' ? { lastSuccessAt: latest.completedAt } : {}) });
      continue;
    }
    const [last, success] = await Promise.all([db().trIntegrationRun.findFirst({ where: { provider: id, status: { in: ['SUCCEEDED', 'FAILED'] } }, orderBy: { startedAt: 'desc' }, select: { status: true } }), db().trIntegrationRun.findFirst({ where: { provider: id, status: 'SUCCEEDED' }, orderBy: { completedAt: 'desc' }, select: { completedAt: true } })]);
    sources.push({ id, name, ...firmsSourceStatus(configured, last?.status ?? null, success?.completedAt ?? null) });
  }
  return { database: connected ? 'connected' : 'unavailable', sources, uploadsAvailable, emailAvailable, googleAvailable };
}
export async function status() {
  try { return await sourceStatus(); }
  catch { return { database: 'unavailable', sources: [{ id: 'FIRMS', name: 'NASA FIRMS', status: 'UNAVAILABLE', message: 'Database unavailable' }, { id: 'GOOGLE_WEATHER', name: 'Google Weather', ...weatherSourceStatus() }, { id: 'AI', name: 'AI analysis', status: 'UNAVAILABLE', message: 'Database unavailable' }], uploadsAvailable, emailAvailable, googleAvailable }; }
}
export async function regions(query: unknown) {
  const { search } = z.object({ search: z.string().trim().max(200).optional() }).parse(query);
  return db().msRegion.findMany({ where: { verifiedAt: { not: null }, ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}) }, select: { id: true, name: true, level: true, code: true, timezone: true, parentId: true }, orderBy: { name: 'asc' }, take: 100 });
}
export function activeIncidentPublishedAtWhere(to: Date) {
  return { lte: to };
}
export async function publicMap(query: unknown, client: PrismaClient = db(), configured = firmsConfigured()) {
  const input = z.object({ from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional() }).parse(query);
  const to = input.to ? new Date(input.to) : new Date();
  const from = input.from ? new Date(input.from) : new Date(to.getTime() - 172800000);
  if (from > to || to.getTime() - from.getTime() > 2678400000 || to.getTime() > Date.now() + 300000) throw new AppError('Map range must be ordered and no longer than 31 days', 400, 'INVALID_TIME_RANGE');
  const last = await client.trIntegrationRun.findFirst({ where: { provider: 'FIRMS', status: 'SUCCEEDED' }, orderBy: { completedAt: 'desc' }, select: { completedAt: true } });
  const latest = await client.trIntegrationRun.findFirst({ where: { provider: 'FIRMS', status: { in: ['SUCCEEDED', 'FAILED'] } }, orderBy: { startedAt: 'desc' }, select: { status: true } });
  const sourceStatus = firmsSourceStatus(configured, latest?.status ?? null, last?.completedAt ?? null);
  const hotspots = await client.trHotspot.findMany({ where: { acquiredAt: { gte: from, lte: to } }, select: { id: true, source: true, product: true, satellite: true, instrument: true, latitude: true, longitude: true, acquiredAt: true, confidenceRaw: true, frp: true, version: true, fetchedAt: true }, orderBy: { acquiredAt: 'desc' }, take: 2001 });
  if (hotspots.length > 2000) sourceStatus.message = `${sourceStatus.message ?? ''} Only the latest 2,000 detections are shown; narrow the time range for more detail.`;
  const publications = await client.trPublicInformation.findMany({ where: { status: 'PUBLISHED', caseId: { not: null }, case: { is: { verificationStatus: 'CONFIRMED_FIRE', handlingStatus: { not: 'CLOSED' } } }, privacyReview: { not: null }, publicLocationMode: { in: ['APPROVED_INCIDENT_POINT', 'APPROVED_INCIDENT_PERIMETER'] }, publishedAt: activeIncidentPublishedAtWhere(to), AND: [{ OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }] }, { publicCaseSnapshot: { path: ['verificationStatus'], equals: 'CONFIRMED_FIRE' } }] }, select: { id: true, slug: true, title: true, publicCaseSnapshot: true, publicLocationMode: true, publicLatitude: true, publicLongitude: true, publishedAt: true, regions: { select: { region: { select: { id: true, name: true } } } } }, orderBy: { publishedAt: 'desc' } });
  const snapshotSchema = z.object({ id: z.string(), number: z.string(), verificationStatus: z.enum(['UNVERIFIED', 'CONFIRMED_FIRE', 'NOT_FIRE']), handlingStatus: z.enum(['OPEN', 'CHECK_SCHEDULED', 'ON_SCENE', 'RESPONDING', 'MONITORING', 'CLOSED']) });
  const cases = publications.flatMap(p => {
    const value = snapshotSchema.safeParse(p.publicCaseSnapshot);
    if (!value.success || value.data.handlingStatus === 'CLOSED') return [];
    return [{ ...value.data, title: p.title, publicationId: p.id, slug: p.slug, publishedAt: p.publishedAt, publicLocationMode: p.publicLocationMode, ...publicPoint(p), ...publicPerimeter(p), regions: p.regions.map(r => r.region) }];
  });
  const demoFeatures = await client.msMapFeature.findMany({ where: { layer: { provider: 'DEMO', name: '[DEMO] Simulated confirmed case areas', version: '1' } }, take: 10, select: { id: true, name: true, geometry: true, attributes: true } });
  const demoAreas = demoFeatures.flatMap(feature => {
    const geometry = geometrySchema.safeParse(feature.geometry);
    const attributes = z.object({ demo: z.literal(true), source: z.literal('SIMULATED'), areaHectares: z.number().positive().finite(), generatedAt: z.iso.datetime(), scenarioStatus: z.literal('SIMULATED_CONFIRMED_FIRE') }).safeParse(feature.attributes);
    if (!geometry.success || geometry.data.type !== 'Polygon' || !attributes.success || !feature.name?.startsWith('[DEMO]')) return [];
    return [{ id: feature.id, name: feature.name, geometry: geometry.data, areaHectares: attributes.data.areaHectares, generatedAt: attributes.data.generatedAt, demo: true as const }];
  });
  return { demoAreas, hotspots: hotspots.slice(0, 2000).map(h => ({ ...h, frpUnit: 'MW', indicationType: 'THERMAL_ANOMALY', stale: sourceStatus.status !== 'AVAILABLE' })), cases: cases.filter((c, i) => cases.findIndex(other => other.id === c.id) === i), updatedAt: last?.completedAt?.toISOString() ?? null, sourceStatus };
}

export async function roleMap(actor: Actor, query: unknown, client: PrismaClient = db(), configured = firmsConfigured()) {
  const { caseStatus } = z.object({ caseStatus: z.enum(['active', 'closed', 'all']).default('active') }).parse(query);
  if (actor.role !== 'ADMIN' && caseStatus !== 'active') throw new AppError('Closed map filters require administrator access', 403, 'FORBIDDEN');
  const publicData = await publicMap(query, client, configured);
  if (actor.role === 'USER') {
    const reports = await client.trReport.findMany({ where: { reporterId: actor.id, OR: [{ caseId: null }, { case: { handlingStatus: { not: 'CLOSED' } } }] }, include: ownerReportInclude, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    const ownCaseIds = new Set(reports.flatMap(report => report.caseId ? [report.caseId] : []));
    return { ...publicData, cases: publicData.cases.filter(item => !ownCaseIds.has(item.id)), nearbyCases: [], ownReports: reports.map(ownerReportDto) };
  }
  const handlingStatus = caseStatus === 'all' ? undefined : caseStatus === 'closed' ? 'CLOSED' as const : { not: 'CLOSED' as const };
  const reports = await client.trReport.findMany({ where: caseStatus === 'all' ? {} : caseStatus === 'closed' ? { case: { handlingStatus: 'CLOSED' } } : { OR: [{ caseId: null }, { case: { handlingStatus: { not: 'CLOSED' } } }] }, include: reportInclude, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  const triage = await triageReports(reports, client);
  const rows = await client.trCase.findMany({ where: { verificationStatus: 'CONFIRMED_FIRE', handlingStatus }, select: { id: true, number: true, title: true, latitude: true, longitude: true, verificationStatus: true, handlingStatus: true, priority: true, priorityReason: true, version: true, openedAt: true, updatedAt: true, perimeter: true, perimeterRevision: true }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }] });
  const privateCases = rows.flatMap(row => {
    const perimeter = polygonSchema.safeParse(row.perimeter);
    return perimeter.success ? [{ ...row, perimeter: perimeter.data }] : [];
  });
  const privateCaseIds = new Set(privateCases.map(item => item.id));
  const operationRows = await client.msMapFeature.findMany({ where: { kind: { in: ['ROAD', 'WATER_SOURCE'] }, layer: { verifiedAt: { not: null } } }, select: { id: true, name: true, kind: true, geometry: true, updates: { where: { observedAt: { lte: new Date() } }, select: { condition: true, observedAt: true }, orderBy: [{ observedAt: 'desc' }, { createdAt: 'desc' }], take: 1 } }, take: 500, orderBy: { name: 'asc' } });
  const operationalFeatures = operationRows.flatMap(row => {
    const point = z.object({ type: z.literal('Point'), coordinates: z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-90).max(90)]) }).safeParse(row.geometry);
    const line = z.object({ type: z.literal('LineString'), coordinates: z.array(z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-90).max(90)])).min(2) }).safeParse(row.geometry);
    const coordinates = point.success ? point.data.coordinates : line.success ? line.data.coordinates[Math.floor(line.data.coordinates.length / 2)]! : null;
    if (!coordinates) return [];
    return [{ id: row.id, name: row.name ?? (row.kind === 'ROAD' ? 'Access point' : 'Water source'), kind: row.kind as 'ROAD' | 'WATER_SOURCE', longitude: coordinates[0], latitude: coordinates[1], condition: row.updates[0]?.condition ?? null, observedAt: row.updates[0]?.observedAt ?? null }];
  });
  return {
    ...publicData,
    cases: caseStatus === 'closed' ? [] : publicData.cases.filter(item => !privateCaseIds.has(item.id)),
    privateReports: reports.map(report => ({ ...reportDto(report), case: report.case ? { ...report.case, reportCount: report.case._count.reports } : null, triage: triage.get(report.id)! })),
    privateCases,
    operationalFeatures,
    privateLimited: false,
  };
}
