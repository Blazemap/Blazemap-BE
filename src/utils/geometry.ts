import { z } from 'zod';

export type Position = [number, number];
export type Polygon = { type: 'Polygon'; coordinates: Position[][] };
const earthRadius = 6371008.8;
const radians = Math.PI / 180;
const positionSchema = z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-90).max(90)]);
const cross = (a: Position, b: Position, c: Position) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const same = (a: Position, b: Position) => a[0] === b[0] && a[1] === b[1];
function onSegment(p: Position, a: Position, b: Position) {
  return Math.abs(cross(a, b, p)) <= 1e-12 && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
}
function intersects(a: Position, b: Position, c: Position, d: Position) {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  return ((abC > 0) !== (abD > 0) && (cdA > 0) !== (cdB > 0)) || onSegment(c, a, b) || onSegment(d, a, b) || onSegment(a, c, d) || onSegment(b, c, d);
}
function inRing(p: Position, ring: Position[]) {
  let inside = false;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i]!, b = ring[i + 1]!;
    if (onSegment(p, a, b)) return true;
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function ringArea(ring: Position[]) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i]!, b = ring[i + 1]!;
    sum += (b[0] - a[0]) * radians * (2 + Math.sin(a[1] * radians) + Math.sin(b[1] * radians));
  }
  return Math.abs(sum) * earthRadius ** 2 / 2;
}
export function areaHectares(polygon: Polygon) {
  return (ringArea(polygon.coordinates[0]!) - polygon.coordinates.slice(1).reduce((sum, ring) => sum + ringArea(ring), 0)) / 10000;
}
function validTopology(polygon: Polygon) {
  const rings = polygon.coordinates;
  if (!rings.length || rings.some(ring => ring.length < 4) || rings.reduce((count, ring) => count + ring.length, 0) > 1000) return false;
  const longitudes = rings.flatMap(ring => ring.map(p => p[0]));
  if (Math.max(...longitudes) - Math.min(...longitudes) >= 180) return false;
  for (const ring of rings) {
    const vertices = ring.slice(0, -1);
    const planarArea = vertices.reduce((sum, a, i) => sum + cross(vertices[0]!, a, vertices[(i + 1) % vertices.length]!), 0);
    if (!same(ring[0]!, ring.at(-1)!) || new Set(vertices.map(p => p.join(','))).size !== vertices.length || Math.abs(planarArea) <= Number.EPSILON || ringArea(ring) <= 0) return false;
    for (let i = 0; i < vertices.length; i++) {
      const a = vertices[i]!, b = vertices[(i + 1) % vertices.length]!, c = vertices[(i + 2) % vertices.length]!;
      if (Math.abs(cross(a, b, c)) <= 1e-12 && (onSegment(c, a, b) || onSegment(a, b, c))) return false;
      for (let j = i + 2; j < vertices.length; j++) {
        if (i === 0 && j === vertices.length - 1) continue;
        if (intersects(a, b, vertices[j]!, vertices[(j + 1) % vertices.length]!)) return false;
      }
    }
  }
  for (let i = 0; i < rings.length; i++) {
    for (let j = i + 1; j < rings.length; j++) {
      const a = rings[i]!, b = rings[j]!;
      for (let k = 0; k < a.length - 1; k++) for (let l = 0; l < b.length - 1; l++) if (intersects(a[k]!, a[k + 1]!, b[l]!, b[l + 1]!)) return false;
      if (i > 0 && (inRing(a[0]!, b) || inRing(b[0]!, a))) return false;
    }
    if (i > 0 && !inRing(rings[i]![0]!, rings[0]!)) return false;
  }
  return areaHectares(polygon) > 0;
}
export const polygonSchema = z.strictObject({ type: z.literal('Polygon'), coordinates: z.array(z.array(positionSchema).min(4).max(1000)).min(1).max(250) }).refine(validTopology, 'Polygon must have closed, nonintersecting, nonzero-area rings, unique vertices, contained disjoint holes, longitude span below 180 degrees and at most 1000 total positions');
export function distanceMeters(a: Position, b: Position) {
  const h = Math.sin((b[1] - a[1]) * radians / 2) ** 2 + Math.cos(a[1] * radians) * Math.cos(b[1] * radians) * Math.sin((b[0] - a[0]) * radians / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}
function bearing(a: Position, b: Position) {
  const delta = (b[0] - a[0]) * radians;
  return Math.atan2(Math.sin(delta) * Math.cos(b[1] * radians), Math.cos(a[1] * radians) * Math.sin(b[1] * radians) - Math.sin(a[1] * radians) * Math.cos(b[1] * radians) * Math.cos(delta));
}
function segmentDistance(p: Position, a: Position, b: Position) {
  if (onSegment(p, a, b)) return 0;
  const length = distanceMeters(a, b) / earthRadius;
  const delta = distanceMeters(a, p) / earthRadius;
  const angle = bearing(a, p) - bearing(a, b);
  const along = Math.atan2(Math.sin(delta) * Math.cos(angle), Math.cos(delta));
  if (along < 0 || along > length) return Math.min(distanceMeters(p, a), distanceMeters(p, b));
  return Math.abs(Math.asin(Math.max(-1, Math.min(1, Math.sin(delta) * Math.sin(angle))))) * earthRadius;
}
export function prepareGeometryDistance(geometry: unknown): ((point: Position) => number) | null {
  const parsedPoint = z.strictObject({ type: z.literal('Point'), coordinates: positionSchema }).safeParse(geometry);
  if (parsedPoint.success) return point => distanceMeters(point, parsedPoint.data.coordinates);
  const line = z.strictObject({ type: z.literal('LineString'), coordinates: z.array(positionSchema).min(2).max(10000) }).safeParse(geometry);
  if (line.success) {
    const points = line.data.coordinates;
    if (points.some((p, i) => i > 0 && Math.abs(p[0] - points[i - 1]![0]) >= 180)) return null;
    return point => points.slice(1).reduce((distance, p, i) => Math.min(distance, segmentDistance(point, points[i]!, p)), Infinity);
  }
  const multi = z.strictObject({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(z.array(positionSchema))).min(1).max(100) }).safeParse(geometry);
  if (multi.success) {
    if (multi.data.coordinates.flat(2).length > 10000) return null;
    const distances = multi.data.coordinates.map(coordinates => prepareGeometryDistance({ type: 'Polygon', coordinates }));
    if (distances.some(distance => !distance)) return null;
    return point => Math.min(...distances.map(distance => distance!(point)));
  }
  const parsed = polygonSchema.safeParse(geometry);
  if (!parsed.success) return null;
  const rings = parsed.data.coordinates;
  return point => {
    if (inRing(point, rings[0]!) && !rings.slice(1).some(ring => inRing(point, ring))) return 0;
    let distance = Infinity;
    for (const ring of rings) for (let i = 0; i < ring.length - 1; i++) distance = Math.min(distance, segmentDistance(point, ring[i]!, ring[i + 1]!));
    return distance;
  };
}
export function geometryDistanceMeters(point: Position, geometry: unknown): number | null {
  if (!positionSchema.safeParse(point).success) return null;
  return prepareGeometryDistance(geometry)?.(point) ?? null;
}
export const publicPerimeterSchema = z.strictObject({ geometry: polygonSchema, observedAt: z.iso.datetime({ offset: true }), source: z.string().trim().min(3).max(300), areaHectares: z.number().finite().positive(), revision: z.number().int().positive() });
export function publicPerimeter(item: { publicLocationMode: string; publicCaseSnapshot: unknown }) {
  if (item.publicLocationMode !== 'APPROVED_INCIDENT_PERIMETER') return {};
  const snapshot = z.object({ verificationStatus: z.literal('CONFIRMED_FIRE'), publicPerimeter: publicPerimeterSchema }).safeParse(item.publicCaseSnapshot);
  if (!snapshot.success) return {};
  const perimeter = snapshot.data.publicPerimeter;
  const computed = areaHectares(perimeter.geometry);
  if (Math.abs(computed - perimeter.areaHectares) > Math.max(1e-8, computed * 1e-9)) return {};
  return { publicPerimeter: perimeter };
}
