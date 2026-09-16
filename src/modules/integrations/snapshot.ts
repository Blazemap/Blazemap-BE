import { z } from 'zod';
import { featureKinds, fieldFindings, latitudeSchema, longitudeSchema, operationalConditions, verificationStatuses } from '../../types/index.js';

export const privacyLimitation = 'Free-text narratives omitted for privacy; consult field evidence locally';
const id = z.string().min(1).max(128).regex(/^\S+$/);
const point = { latitude: latitudeSchema.nullable(), longitude: longitudeSchema.nullable() };
const report = z.object({ id, observationTypes: z.array(z.enum(['SMOKE', 'FLAME', 'BURNING_SMELL'])).min(1).max(3), observedAt: z.date(), locationMode: z.enum(['INCIDENT_ESTIMATE', 'OBSERVER_POSITION']), ...point, updates: z.array(z.object({ id, kind: z.enum(['CLARIFICATION', 'REQUEST', 'CORRECTION']), createdAt: z.date() })) });
const hotspot = z.object({ id, acquiredAt: z.date(), ...point, product: z.enum(['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT', 'VIIRS_NOAA20_SP', 'VIIRS_SNPP_SP']), confidenceRaw: z.enum(['l', 'n', 'h']), frp: z.number().finite().nonnegative().nullable() });
const field = z.object({ id, findings: z.enum(fieldFindings), observedAt: z.date(), ...point });
const caseSchema = z.object({ id, contextRevision: z.number().int().positive(), verificationStatus: z.enum(verificationStatuses), reports: z.array(report), hotspots: z.array(hotspot), fieldUpdates: z.array(field) });
const weatherSchema = z.object({ id, issuedAt: z.date(), validAt: z.date(), fetchedAt: z.date(), temperature: z.number().finite().nullable(), humidity: z.number().min(0).max(100).nullable(), windSpeed: z.number().finite().nonnegative().nullable(), windFromDegrees: z.number().min(0).lt(360).nullable() });
const spatialSchema = z.object({ id, name: z.string().max(200).nullable(), kind: z.enum(featureKinds), regionId: id.nullable(), layerId: id, layer: z.object({ sourceDate: z.date(), importedAt: z.date() }) });
const operationalSchema = z.object({ id, subjectType: z.enum(['TEAM', 'EQUIPMENT', 'FEATURE']), teamId: id.nullable(), equipmentId: id.nullable(), featureId: id.nullable(), condition: z.string(), observedAt: z.date() }).refine(v => (operationalConditions[v.subjectType] as readonly string[]).includes(v.condition)).refine(v => [v.teamId, v.equipmentId, v.featureId].filter(Boolean).length === 1 && !!(v.subjectType === 'TEAM' ? v.teamId : v.subjectType === 'EQUIPMENT' ? v.equipmentId : v.featureId));
export function buildAnalysisContext(caseValue: unknown, forecastValue: unknown, spatialValues: unknown[], operationalValues: unknown[]) {
  const c = caseSchema.parse(caseValue);
  const forecast = forecastValue == null ? null : weatherSchema.parse(forecastValue);
  const spatial = spatialValues.map(value => spatialSchema.parse(value));
  const operational = operationalValues.map(value => operationalSchema.parse(value));
  const facts = (value: object) => JSON.stringify({ ...value, limitations: [privacyLimitation] });
  const observations = [
    ...c.reports.map(r => ({ id: r.id, kind: 'COMMUNITY_REPORT', observedAt: r.observedAt.toISOString(), description: facts({ observationTypes: r.observationTypes, locationMode: r.locationMode }), latitude: r.locationMode === 'INCIDENT_ESTIMATE' ? r.latitude : null, longitude: r.locationMode === 'INCIDENT_ESTIMATE' ? r.longitude : null })),
    ...c.reports.flatMap(r => r.updates.map(u => ({ id: u.id, kind: 'REPORT_UPDATE', observedAt: u.createdAt.toISOString(), description: facts({ updateKind: u.kind, reportId: r.id, timestampBasis: 'RECORDED_AT' }), latitude: null, longitude: null }))),
    ...c.hotspots.map(h => ({ id: h.id, kind: 'SATELLITE_HOTSPOT', observedAt: h.acquiredAt.toISOString(), description: facts({ provider: 'NASA FIRMS', product: h.product, confidence: h.confidenceRaw, confidenceScale: 'VIIRS_SENSOR', frp: h.frp, frpUnit: 'MW', indicationType: 'THERMAL_ANOMALY' }), latitude: h.latitude, longitude: h.longitude })),
    ...c.fieldUpdates.map(f => ({ id: f.id, kind: 'FIELD_UPDATE', observedAt: f.observedAt.toISOString(), description: facts({ findings: f.findings }), latitude: f.latitude, longitude: f.longitude })),
  ];
  const from = forecast?.windSpeed != null && forecast.windSpeed > 0 ? forecast.windFromDegrees : null;
  return {
    caseId: c.id, contextRevision: c.contextRevision, verificationStatus: c.verificationStatus, observations,
    weather: forecast ? { id: forecast.id, provider: 'BMKG', issuedAt: forecast.issuedAt.toISOString(), validAt: forecast.validAt.toISOString(), fetchedAt: forecast.fetchedAt.toISOString(), temperature: forecast.temperature, humidity: forecast.humidity, windSpeed: forecast.windSpeed, windSpeedUnit: 'km/h', windFromDegrees: from, windToDegrees: from == null ? null : (from + 180) % 360, directionPrecision: 'CARDINAL', measurementType: 'FORECAST' } : null,
    spatialContext: spatial.map(s => ({ id: s.id, name: ['FACILITY', 'SETTLEMENT', 'DESIGNATED_LOCATION'].includes(s.kind) ? s.name?.trim() || null : null, kind: s.kind, regionId: s.regionId, layerId: s.layerId, sourceDate: s.layer.sourceDate.toISOString(), importedAt: s.layer.importedAt.toISOString(), relationBasis: 'ADMINISTRATIVE_REGION_ONLY', distanceMeters: null, downwind: null })),
    operationalContext: operational.map(o => ({ id: o.id, subjectType: o.subjectType, subjectId: o.subjectType === 'TEAM' ? o.teamId : o.subjectType === 'EQUIPMENT' ? o.equipmentId : o.featureId, condition: o.condition, observedAt: o.observedAt.toISOString() })),
  };
}
