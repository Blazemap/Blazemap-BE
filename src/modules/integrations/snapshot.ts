import { z } from 'zod';
import { buildExposure } from './exposure.js';
import type { buildWindContext } from './wind.js';
import { env } from '../../config/env.js';
import { featureKinds, fieldFindings, latitudeSchema, longitudeSchema, operationalConditions, reviewerAssessmentSource, verificationStatuses } from '../../types/index.js';

export const privacyLimitation = 'Free-text narratives and exact observation coordinates omitted for privacy; supplied coordinates are rounded as declared in coordinatePrecision';
export function coarsenCoordinate(value: number | null, decimalPlaces = env.AI_COORDINATE_PRECISION_DECIMALS) {
  if (value === null) return null;
  const factor = 10 ** decimalPlaces;
  const rounded = Math.sign(value) * Math.round(Math.abs(value) * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}
const id = z.string().min(1).max(128).regex(/^\S+$/);
const point = { latitude: latitudeSchema.nullable(), longitude: longitudeSchema.nullable() };
const report = z.object({ id, observationTypes: z.array(z.enum(['SMOKE', 'FLAME', 'BURNING_SMELL'])).min(1).max(3), observedAt: z.date(), locationMode: z.enum(['INCIDENT_ESTIMATE', 'OBSERVER_POSITION']), ...point, updates: z.array(z.object({ id, kind: z.enum(['CLARIFICATION', 'REQUEST', 'CORRECTION']), createdAt: z.date() })) });
const hotspot = z.object({ id, acquiredAt: z.date(), ...point, product: z.enum(['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT', 'VIIRS_NOAA20_SP', 'VIIRS_SNPP_SP']), confidenceRaw: z.enum(['l', 'n', 'h']), frp: z.number().finite().nonnegative().nullable() });
const field = z.object({ id, findings: z.enum(fieldFindings), source: z.string().min(1).max(300), observedAt: z.date(), ...point });
const caseSchema = z.object({ id, contextRevision: z.number().int().positive(), verificationStatus: z.enum(verificationStatuses), reports: z.array(report), hotspots: z.array(hotspot), fieldUpdates: z.array(field) });
const weatherSchema = z.object({ id, issuedAt: z.date(), validAt: z.date(), fetchedAt: z.date(), temperature: z.number().finite().nullable(), humidity: z.number().min(0).max(100).nullable(), windSpeed: z.number().finite().nonnegative().nullable(), windFromDegrees: z.number().min(0).lt(360).nullable() });
const spatialSchema = z.object({ id, name: z.string().max(200).nullable(), kind: z.enum(featureKinds), regionId: id.nullable(), layerId: id, layer: z.object({ sourceDate: z.date(), importedAt: z.date() }) });
const operationalSchema = z.object({ id, subjectType: z.enum(['TEAM', 'EQUIPMENT', 'FEATURE']), teamId: id.nullable(), equipmentId: id.nullable(), featureId: id.nullable(), condition: z.string(), observedAt: z.date() }).refine(v => (operationalConditions[v.subjectType] as readonly string[]).includes(v.condition)).refine(v => [v.teamId, v.equipmentId, v.featureId].filter(Boolean).length === 1 && !!(v.subjectType === 'TEAM' ? v.teamId : v.subjectType === 'EQUIPMENT' ? v.equipmentId : v.featureId));
export function buildAnalysisContext(caseValue: unknown, forecastValue: unknown, spatialValues: unknown[], operationalValues: unknown[], windContext: ReturnType<typeof buildWindContext> | null = null) {
  const c = caseSchema.parse(caseValue);
  const forecast = forecastValue == null ? null : weatherSchema.parse(forecastValue);
  const spatial = spatialValues.map(value => spatialSchema.parse(value));
  const operational = operationalValues.map(value => operationalSchema.parse(value));
  const location = z.object({ latitude: latitudeSchema.nullish(), longitude: longitudeSchema.nullish() }).parse(caseValue);
  const exposure = buildExposure(location, spatialValues, [], windContext);
  const precision = env.AI_COORDINATE_PRECISION_DECIMALS;
  const facts = (value: object) => JSON.stringify({ ...value, limitations: [privacyLimitation] });
  const coordinate = (value: number | null) => coarsenCoordinate(value, precision);
  const observations = [
    ...c.reports.map(r => ({ id: r.id, kind: 'COMMUNITY_REPORT', observedAt: r.observedAt.toISOString(), description: facts({ observationTypes: r.observationTypes, locationMode: r.locationMode }), latitude: r.locationMode === 'INCIDENT_ESTIMATE' ? coordinate(r.latitude) : null, longitude: r.locationMode === 'INCIDENT_ESTIMATE' ? coordinate(r.longitude) : null })),
    ...c.reports.flatMap(r => r.updates.map(u => ({ id: u.id, kind: 'REPORT_UPDATE', observedAt: u.createdAt.toISOString(), description: facts({ updateKind: u.kind, reportId: r.id, timestampBasis: 'RECORDED_AT' }), latitude: null, longitude: null }))),
    ...c.hotspots.map(h => ({ id: h.id, kind: 'SATELLITE_HOTSPOT', observedAt: h.acquiredAt.toISOString(), description: facts({ provider: 'NASA FIRMS', product: h.product, confidence: h.confidenceRaw, confidenceScale: 'VIIRS_SENSOR', frp: h.frp, frpUnit: 'MW', indicationType: 'THERMAL_ANOMALY' }), latitude: coordinate(h.latitude), longitude: coordinate(h.longitude) })),
    ...c.fieldUpdates.map(f => ({ id: f.id, kind: f.source === reviewerAssessmentSource ? 'REVIEWER_ASSESSMENT' : 'FIELD_UPDATE', observedAt: f.observedAt.toISOString(), description: facts({ findings: f.findings, verificationBasis: f.source === reviewerAssessmentSource ? 'OPERATOR_ASSESSMENT' : 'FIELD_OBSERVATION', independentFieldObservation: f.source !== reviewerAssessmentSource }), latitude: coordinate(f.latitude), longitude: coordinate(f.longitude) })),
  ];
  const from = forecast?.windSpeed != null && forecast.windSpeed > 0 ? forecast.windFromDegrees : null;
  return {
    caseId: c.id, contextRevision: c.contextRevision, verificationStatus: c.verificationStatus, coordinatePrecision: { decimalPlaces: precision, method: 'DECIMAL_ROUNDING', exactCoordinatesShared: false }, observations, windContext,
    weather: forecast ? { id: forecast.id, provider: 'BMKG', issuedAt: forecast.issuedAt.toISOString(), validAt: forecast.validAt.toISOString(), fetchedAt: forecast.fetchedAt.toISOString(), temperature: forecast.temperature, humidity: forecast.humidity, windSpeed: forecast.windSpeed, windSpeedUnit: 'km/h', windFromDegrees: from, windToDegrees: from == null ? null : (from + 180) % 360, directionPrecision: 'CARDINAL', measurementType: 'FORECAST' } : null,
    spatialContext: spatial.map(s => ({ id: s.id, name: ['FACILITY', 'SETTLEMENT', 'DESIGNATED_LOCATION'].includes(s.kind) ? s.name?.trim() || null : null, kind: s.kind, regionId: s.regionId, layerId: s.layerId, sourceDate: s.layer.sourceDate.toISOString(), importedAt: s.layer.importedAt.toISOString(), ...(() => { const e = exposure.items.find(e => e.id === s.id); return e?.distanceMeters != null ? { relationBasis: e.relationBasis, computedBy: 'BLAZEMAP', sourceId: e.sourceId, distanceMeters: Math.round(e.distanceMeters / 100) * 100, downwind: e.downwind, forecastId: e.forecastId, limitations: ['Distance rounded to 100 m; incident point, not perimeter; directional advisory only'] } : { relationBasis: 'ADMINISTRATIVE_REGION_ONLY', distanceMeters: null, downwind: null }; })() })),
    operationalContext: operational.map(o => ({ id: o.id, subjectType: o.subjectType, subjectId: o.subjectType === 'TEAM' ? o.teamId : o.subjectType === 'EQUIPMENT' ? o.equipmentId : o.featureId, condition: o.condition, observedAt: o.observedAt.toISOString() })),
  };
}
