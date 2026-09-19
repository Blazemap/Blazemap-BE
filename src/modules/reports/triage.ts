import { z } from 'zod';
import type { PrismaClient, TrReport } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';
import { firmsConfigured } from '../integrations/integrations.service.js';
import { geometryDistanceMeters, prepareGeometryDistance, type Position } from '../../utils/geometry.js';

const ruleVersion = 'report-triage-1';
const bboxSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90), z.number().min(-180).max(180), z.number().min(-90).max(90)]).refine(([w, s, e, n]) => w < e && s < n);
const coverageSchema = z.object({ bbox: bboxSchema, validFrom: z.iso.datetime({ offset: true }), validTo: z.iso.datetime({ offset: true }), complete: z.literal(true) });
const scopeSchema = z.object({ area: z.string().optional(), areas: z.array(z.string()).min(1).max(16).optional(), products: z.array(z.string()).min(1), observedFrom: z.iso.datetime({ offset: true }), observedTo: z.iso.datetime({ offset: true }) }).refine(scope => !!scope.area || !!scope.areas?.length);
type Report = Pick<TrReport, 'id' | 'number' | 'locationMode' | 'latitude' | 'longitude' | 'observedAt'> & Partial<Pick<TrReport, 'description' | 'locationDescription' | 'idempotencyKey'>>;
export type Triage = { level: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'UNKNOWN'; reasonCodes: string[]; missingData: string[]; evaluatedAt: string; ruleVersion: string; satelliteMatch: { distanceMeters: number; acquiredAt: string } | null; settlementMatch: { name: string | null; distanceMeters: number } | null };
export type TriagePolicy = { TRIAGE_HOTSPOT_RADIUS_METERS?: string; TRIAGE_HOTSPOT_WINDOW_HOURS?: string; TRIAGE_SETTLEMENT_RADIUS_METERS?: string };
const sample = (value: unknown) => typeof value === 'string' && value.startsWith('sample-v2-');
const demo = (...values: unknown[]) => values.some(value => /demo|simulated|synthetic/i.test(typeof value === 'string' ? value : JSON.stringify(value) ?? ''));
function incidentPoint(report: Report): Position | null {
  const { latitude, longitude } = report;
  return report.locationMode === 'INCIDENT_ESTIMATE' && latitude != null && longitude != null && Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? [longitude, latitude] : null;
}
function covers(bbox: [number, number, number, number], point: Position, radius: number) {
  const [w, s, e, n] = bbox;
  if (point[0] <= w || point[0] >= e || point[1] <= s || point[1] >= n) return false;
  const lat = radius / 6371008.8 * 180 / Math.PI;
  const cosine = Math.cos((Math.abs(point[1]) + lat) * Math.PI / 180);
  if (Math.abs(point[1]) + lat >= 90 || cosine <= 0) return false;
  const lon = lat / cosine;
  return point[0] - lon >= w && point[0] + lon <= e && point[1] - lat >= s && point[1] + lat <= n;
}
export async function triageReports(reports: Report[], client: PrismaClient, policy: TriagePolicy = env, now = new Date(), sourceConfigured = firmsConfigured()): Promise<Map<string, Triage>> {
  const names = ['TRIAGE_HOTSPOT_RADIUS_METERS', 'TRIAGE_HOTSPOT_WINDOW_HOURS', 'TRIAGE_SETTLEMENT_RADIUS_METERS'] as const;
  const missingPolicy = names.filter(name => !policy[name]?.trim() || !Number.isFinite(Number(policy[name])) || Number(policy[name]) <= 0);
  const radius = Number(policy.TRIAGE_HOTSPOT_RADIUS_METERS), windowMs = Number(policy.TRIAGE_HOTSPOT_WINDOW_HOURS) * 3600000, settlementRadius = Number(policy.TRIAGE_SETTLEMENT_RADIUS_METERS);
  if (!Number.isFinite(windowMs) && !missingPolicy.includes('TRIAGE_HOTSPOT_WINDOW_HOURS')) missingPolicy.push('TRIAGE_HOTSPOT_WINDOW_HOURS');
  const results = new Map<string, Triage>();
  const eligible = reports.filter(report => {
    const value: Triage = { level: 'UNKNOWN', reasonCodes: [], missingData: [...missingPolicy], evaluatedAt: now.toISOString(), ruleVersion, satelliteMatch: null, settlementMatch: null };
    results.set(report.id, value);
    if (missingPolicy.length) value.reasonCodes.push('POLICY_NOT_CONFIGURED');
    if (sample(report.idempotencyKey)) { value.reasonCodes.push('SAMPLE_EXCLUDED'); return false; }
    if (demo(report.number, report.description, report.locationDescription)) { value.reasonCodes.push('DEMO_EXCLUDED'); return false; }
    if (!incidentPoint(report)) { value.reasonCodes.push('INCIDENT_LOCATION_UNKNOWN'); value.missingData.push('INCIDENT_COORDINATES'); return false; }
    if (missingPolicy.length) return false;
    if (!Number.isFinite(report.observedAt.getTime()) || report.observedAt > now || !Number.isFinite(report.observedAt.getTime() - windowMs) || Math.abs(report.observedAt.getTime() - windowMs) > 8640000000000000 || Math.abs(report.observedAt.getTime() + windowMs) > 8640000000000000) { value.reasonCodes.push('OBSERVATION_TIME_INVALID'); value.missingData.push('OBSERVATION_TIME'); return false; }
    return !missingPolicy.length;
  });
  if (!eligible.length) return results;
  const from = new Date(Math.min(...eligible.map(r => r.observedAt.getTime() - windowMs)));
  const to = new Date(Math.min(now.getTime(), Math.max(...eligible.map(r => r.observedAt.getTime() + windowMs))));
  const [hotspots, settlements, layers, latest] = await Promise.all([
    client.trHotspot.findMany({ where: { source: 'NASA FIRMS', acquiredAt: { gte: from, lte: to } }, select: { id: true, source: true, product: true, satellite: true, instrument: true, raw: true, latitude: true, longitude: true, acquiredAt: true }, orderBy: [{ acquiredAt: 'desc' }, { id: 'asc' }], take: 10001 }),
    client.msMapFeature.findMany({ where: { kind: 'SETTLEMENT', layer: { kind: 'SETTLEMENT', verifiedAt: { not: null } } }, select: { id: true, layerId: true, name: true, geometry: true, attributes: true }, orderBy: { id: 'asc' }, take: 10001 }),
    client.msMapLayer.findMany({ where: { kind: 'SETTLEMENT', verifiedAt: { not: null } }, select: { id: true, name: true, provider: true, sourceDate: true, verifiedAt: true, coverage: true }, orderBy: { id: 'asc' }, take: 1001 }),
    client.trIntegrationRun.findFirst({ where: { provider: 'FIRMS', status: { in: ['SUCCEEDED', 'FAILED'] } }, select: { status: true, completedAt: true, scope: true }, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }] }),
  ]);
  const usableLayers = layers.slice(0, 1000).filter(layer => !demo(layer.provider, layer.name) && layer.verifiedAt && layer.verifiedAt <= now && layer.sourceDate <= now);
  const layerIds = new Set(usableLayers.map(layer => layer.id));
  const preparedSettlements = settlements.slice(0, 10000).filter(settlement => layerIds.has(settlement.layerId) && !demo(settlement.name, settlement.attributes)).map(settlement => ({ layerId: settlement.layerId, name: settlement.name, distance: prepareGeometryDistance(settlement.geometry) }));
  const sourceScope = scopeSchema.safeParse(latest?.scope);
  const sourceBoxes = sourceScope.success ? (sourceScope.data.areas ?? [sourceScope.data.area!]).map(area => bboxSchema.safeParse(area.split(',').map(Number))) : [];
  for (const report of eligible) {
    const value = results.get(report.id)!;
    const point = incidentPoint(report)!;
    const time = report.observedAt.getTime();
    for (const hotspot of hotspots.slice(0, 10000)) {
      if (hotspot.source !== 'NASA FIRMS' || demo(hotspot.product, hotspot.satellite, hotspot.instrument, hotspot.raw) || Math.abs(hotspot.acquiredAt.getTime() - time) > windowMs || hotspot.acquiredAt > now) continue;
      const distance = geometryDistanceMeters(point, { type: 'Point', coordinates: [hotspot.longitude, hotspot.latitude] });
      if (distance !== null && distance <= radius && (!value.satelliteMatch || distance < value.satelliteMatch.distanceMeters)) value.satelliteMatch = { distanceMeters: distance, acquiredAt: hotspot.acquiredAt.toISOString() };
    }
    let invalidSettlement = false;
    const datedLayerIds = new Set(usableLayers.filter(layer => layer.sourceDate.getTime() <= time).map(layer => layer.id));
    for (const settlement of preparedSettlements) {
      if (!datedLayerIds.has(settlement.layerId)) continue;
      const distance = settlement.distance?.(point) ?? null;
      if (distance === null) { invalidSettlement = true; continue; }
      if (distance <= settlementRadius && (!value.settlementMatch || distance < value.settlementMatch.distanceMeters)) value.settlementMatch = { name: settlement.name, distanceMeters: distance };
    }
    const sourceCovered = sourceConfigured && latest?.status === 'SUCCEEDED' && latest.completedAt && latest.completedAt <= now && now.getTime() - latest.completedAt.getTime() <= 3600000 && sourceScope.success && sourceBoxes.some(box => box.success && covers(box.data, point, radius)) && !demo(sourceScope.data.products) && Date.parse(sourceScope.data.observedFrom) <= time - windowMs && Date.parse(sourceScope.data.observedTo) >= time + windowMs && Date.parse(sourceScope.data.observedTo) <= latest.completedAt.getTime();
    const settlementCovered = usableLayers.some(layer => {
      let coverage: unknown;
      try { coverage = JSON.parse(layer.coverage); } catch { return false; }
      const parsed = coverageSchema.safeParse(coverage);
      return parsed.success && layer.sourceDate.getTime() <= time && Date.parse(parsed.data.validFrom) <= time && Date.parse(parsed.data.validTo) >= time && Date.parse(parsed.data.validTo) >= now.getTime() && covers(parsed.data.bbox, point, settlementRadius);
    });
    if (!sourceCovered) value.missingData.push('SATELLITE_COVERAGE');
    if (!settlementCovered) value.missingData.push('SETTLEMENT_COVERAGE');
    if (invalidSettlement) value.missingData.push('SETTLEMENT_GEOMETRY');
    if (hotspots.length > 10000 || settlements.length > 10000 || layers.length > 1000) value.missingData.push('TRUNCATED_CONTEXT');
    if (value.satelliteMatch) { value.level = 'CRITICAL'; value.reasonCodes.push('SATELLITE_SPATIOTEMPORAL_MATCH'); }
    else if (value.settlementMatch) { value.level = 'HIGH'; value.reasonCodes.push('SETTLEMENT_NEARBY'); }
    else if (!value.missingData.length) { value.level = 'MEDIUM'; value.reasonCodes.push('COVERED_NO_NEARBY_MATCH'); }
    else value.reasonCodes.push('INSUFFICIENT_COVERAGE');
  }
  return results;
}
