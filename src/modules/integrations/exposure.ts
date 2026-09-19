import { z } from 'zod';
import { geometryDistanceMeters } from '../../utils/geometry.js';

const pointSchema = z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-90).max(90)]);
const featureSchema = z.object({ id: z.string(), name: z.string().nullable(), kind: z.string(), layerId: z.string(), geometry: z.unknown(), attributes: z.record(z.string(), z.unknown()).optional(), layer: z.object({ provider: z.string(), license: z.string(), attribution: z.string(), sourceDate: z.date(), importedAt: z.date(), verifiedAt: z.date().nullable() }) });
type Wind = { status: string; windToDegrees: number | null; usableUntil: string | null; forecast: { id: string } | null };
export function buildExposure(location: { latitude?: number | null; longitude?: number | null }, values: unknown[], updates: { id: string; featureId: string | null; condition: string; source: string; observedAt: Date }[], wind: Wind | null, now = new Date()) {
  const point = pointSchema.safeParse([location.longitude, location.latitude]);
  const items = values.flatMap(value => {
    const parsed = featureSchema.safeParse(value);
    if (!parsed.success) return [];
    const f = parsed.data, l = f.layer;
    const verified = !!l.verifiedAt && l.verifiedAt <= now && l.sourceDate <= now && l.importedAt <= now && !!l.license.trim() && !!l.attribution.trim() && !!l.provider.trim() && !/demo|sample/i.test(l.provider) && f.attributes?.demo !== true && f.attributes?.sample !== true;
    const distance = verified && point.success ? geometryDistanceMeters(point.data, f.geometry) : null;
    const geometry = z.object({ type: z.literal('Point'), coordinates: pointSchema }).safeParse(f.geometry);
    let downwind: true | null = null;
    if (distance !== null && distance > 0 && geometry.success && point.success && wind?.status === 'READY' && wind.windToDegrees !== null && wind.forecast && wind.usableUntil && Date.parse(wind.usableUntil) > now.getTime()) {
      const [lon, lat] = point.data, [otherLon, otherLat] = geometry.data.coordinates, r = Math.PI / 180;
      const bearing = (Math.atan2(Math.sin((otherLon - lon) * r) * Math.cos(otherLat * r), Math.cos(lat * r) * Math.sin(otherLat * r) - Math.sin(lat * r) * Math.cos(otherLat * r) * Math.cos((otherLon - lon) * r)) / r + 360) % 360;
      const difference = Math.abs((bearing - wind.windToDegrees + 540) % 360 - 180);
      if (difference <= 22.5) downwind = true;
    }
    const latest = updates.filter(u => u.featureId === f.id && u.observedAt <= now).sort((a,b) => b.observedAt.getTime() - a.observedAt.getTime())[0];
    const attributes = f.attributes ?? {};
    const designationTime = typeof attributes.designationVerifiedAt === 'string' ? Date.parse(attributes.designationVerifiedAt) : NaN;
    const designation = verified && f.kind === 'DESIGNATED_LOCATION' && typeof attributes.designationAuthority === 'string' && attributes.designationAuthority.trim() && typeof attributes.designationReference === 'string' && attributes.designationReference.trim() && Number.isFinite(designationTime) && designationTime <= now.getTime() ? { authority: attributes.designationAuthority, reference: attributes.designationReference, verifiedAt: new Date(designationTime).toISOString() } : null;
    return [{ id: f.id, name: f.name, kind: f.kind, layerId: f.layerId, sourceId: f.layerId, sourceDate: l.sourceDate.toISOString(), importedAt: l.importedAt.toISOString(), verifiedAt: l.verifiedAt?.toISOString() ?? null, provider: l.provider, license: l.license, attribution: l.attribution, distanceMeters: distance, intersectsPoint: distance === null ? null : distance === 0, downwind, forecastId: downwind ? wind!.forecast!.id : null, relationBasis: distance === null ? 'ADMINISTRATIVE_REGION_ONLY' : downwind ? 'VERIFIED_DOWNWIND' : 'VERIFIED_DISTANCE', computedBy: distance === null ? null : 'BLAZEMAP', unavailableReason: !verified ? 'UNVERIFIED_PROVENANCE' : !point.success ? 'NO_INCIDENT_POINT' : distance === null ? 'UNSUPPORTED_GEOMETRY' : null, designation, condition: latest ? { id: latest.id, condition: latest.condition, source: latest.source, observedAt: latest.observedAt.toISOString(), stale: now.getTime() - latest.observedAt.getTime() >= 86400000 } : null }];
  });
  return { evaluatedAt: now.toISOString(), scope: 'CASE_REGION_ONLY', limited: values.length >= 100, limitation: 'Distances and containment use the recorded incident point, not a predicted fire perimeter. Point downwind uses a 22.5 degree sector and regional forecast only; no plume, arrival time, safe route or evacuation instruction. Coverage may be incomplete. Conditions older than 24 hours are stale; verify all access and designations locally.', items };
}
