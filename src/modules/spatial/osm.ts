import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
type OsmParser = NodeJS.ReadWriteStream & { destroy(error?: Error): void };
const createOsmParser = require('osm-pbf-parser') as () => OsmParser;

export const spatialKinds = ['SETTLEMENT', 'FACILITY', 'WATER_SOURCE', 'ROAD', 'RIVER'] as const;
export type SpatialKind = typeof spatialKinds[number];
type Tags = Record<string, string>;
type OsmNode = { type: 'node'; id: number; lat: number; lon: number; tags: Tags };
type OsmWay = { type: 'way'; id: number; refs: number[]; tags: Tags };
type OsmItem = OsmNode | OsmWay | { type: string; id?: number; tags?: Tags };
type PointFeature = { sourceId: string; kind: SpatialKind; name: string | null; geometry: { type: 'Point'; coordinates: [number, number] }; attributes: Record<string, string> };
type PendingWay = { sourceId: string; kind: 'ROAD' | 'RIVER'; name: string | null; refs: number[]; attributes: Record<string, string> };
export type OsmFeature = PointFeature | Omit<PendingWay, 'refs'> & { geometry: { type: 'LineString'; coordinates: [number, number][] } };
export type LayerExtraction = { filePath: string; discovered: number; written: number; invalid: number; truncated: boolean };
export type ExtractionResult = { layers: Record<SpatialKind, LayerExtraction>; requiredNodes: number; storedReferences: number };
export type ParseOsmFile = (path: string, receive: (items: OsmItem[]) => Promise<void>) => Promise<void>;

const placeValues = new Set(['city', 'town', 'village', 'hamlet', 'isolated_dwelling', 'suburb', 'neighbourhood']);
const facilityValues = new Set(['hospital', 'clinic', 'doctors', 'fire_station', 'police', 'school', 'community_centre', 'social_facility', 'shelter']);
const waterAmenityValues = new Set(['drinking_water', 'water_point']);
const waterNaturalValues = new Set(['spring']);
const waterManMadeValues = new Set(['water_well', 'water_tower', 'reservoir_covered']);
const waterEmergencyValues = new Set(['fire_hydrant', 'suction_point', 'water_tank']);
const highwayValues = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'service', 'track', 'road']);
const waterwayValues = new Set(['river', 'stream', 'canal', 'drain', 'ditch']);
const commonTags = ['name', 'name:id', 'alt_name', 'operator', 'access'] as const;
const pointTags = [...commonTags, 'place', 'population', 'amenity', 'emergency', 'natural', 'man_made', 'drinking_water', 'water_source'] as const;
const roadTags = [...commonTags, 'highway', 'ref', 'surface', 'smoothness', 'tracktype', 'oneway', 'bridge', 'tunnel', 'width', 'maxspeed', 'lanes'] as const;
const riverTags = [...commonTags, 'waterway', 'intermittent', 'seasonal', 'boat'] as const;

function validId(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function validCoordinate(lon: unknown, lat: unknown): lon is number { return typeof lon === 'number' && typeof lat === 'number' && Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90; }
function safeName(tags: Tags) { const value = tags.name?.trim(); return value ? value.slice(0, 200) : null; }
function attributes(id: number, type: 'node' | 'way', tags: Tags, allowlist: readonly string[]) {
  const result: Record<string, string> = { osmType: type, osmId: String(id) };
  for (const key of allowlist) {
    const value = tags[key];
    if (typeof value === 'string' && value.length) result[key] = value.slice(0, 2000);
  }
  return result;
}
function pointFeature(node: OsmNode, kind: 'SETTLEMENT' | 'FACILITY' | 'WATER_SOURCE'): PointFeature {
  return { sourceId: `node/${node.id}`, kind, name: safeName(node.tags), geometry: { type: 'Point', coordinates: [node.lon, node.lat] }, attributes: attributes(node.id, 'node', node.tags, pointTags) };
}

export function classifyNode(item: OsmItem): PointFeature | null {
  if (item.type !== 'node') return null;
  const node = item as OsmNode;
  if (!validId(node.id) || !validCoordinate(node.lon, node.lat) || !node.tags || typeof node.tags !== 'object') return null;
  if (placeValues.has(node.tags.place ?? '')) return pointFeature(node, 'SETTLEMENT');
  if (waterAmenityValues.has(node.tags.amenity ?? '') || waterNaturalValues.has(node.tags.natural ?? '') || waterManMadeValues.has(node.tags.man_made ?? '') || waterEmergencyValues.has(node.tags.emergency ?? '') || node.tags.water_source === 'yes') return pointFeature(node, 'WATER_SOURCE');
  if (facilityValues.has(node.tags.amenity ?? '')) return pointFeature(node, 'FACILITY');
  return null;
}

export function classifyWay(item: OsmItem): PendingWay | null {
  if (item.type !== 'way') return null;
  const way = item as OsmWay;
  if (!validId(way.id) || !Array.isArray(way.refs) || way.refs.length < 2 || way.refs.length > 10000 || !way.refs.every(validId) || !way.tags || typeof way.tags !== 'object' || way.tags.area === 'yes') return null;
  if (highwayValues.has(way.tags.highway ?? '')) return { sourceId: `way/${way.id}`, kind: 'ROAD', name: safeName(way.tags), refs: way.refs, attributes: attributes(way.id, 'way', way.tags, roadTags) };
  if (waterwayValues.has(way.tags.waterway ?? '')) return { sourceId: `way/${way.id}`, kind: 'RIVER', name: safeName(way.tags), refs: way.refs, attributes: attributes(way.id, 'way', way.tags, riverTags) };
  return null;
}

export function parseOsmPbf(path: string, receive: (items: OsmItem[]) => Promise<void>) {
  const input = createReadStream(path);
  const parser = createOsmParser();
  return new Promise<void>((resolve, reject) => {
    let pending = Promise.resolve();
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      input.destroy();
      parser.destroy();
      reject(error instanceof Error ? error : new Error('OSM parser failed'));
    };
    input.on('error', fail);
    parser.on('error', fail);
    parser.on('data', (value: unknown) => {
      parser.pause();
      pending = pending.then(async () => {
        if (!Array.isArray(value)) throw new Error('Invalid OSM parser output');
        await receive(value as OsmItem[]);
        parser.resume();
      }).catch(fail);
    });
    parser.on('end', () => pending.then(() => { if (!settled) { settled = true; resolve(); } }, fail));
    input.pipe(parser);
  });
}

class NdjsonWriter {
  private readonly stream: WriteStream;
  private failure: Error | null = null;
  constructor(path: string, private readonly reserve: (bytes: number) => void) {
    this.stream = createWriteStream(path, { flags: 'wx' });
    this.stream.on('error', error => { this.failure ??= error; });
  }
  async write(feature: OsmFeature) {
    if (this.failure) throw this.failure;
    const line = `${JSON.stringify(feature)}\n`;
    this.reserve(Buffer.byteLength(line));
    if (!this.stream.write(line)) await once(this.stream, 'drain');
    if (this.failure) throw this.failure;
  }
  async close() {
    if (this.failure) throw this.failure;
    if (this.stream.closed) return;
    this.stream.end();
    await once(this.stream, 'close');
    if (this.failure) throw this.failure;
  }
  async destroy(error: Error) {
    this.failure ??= error;
    if (this.stream.closed) return;
    const closed = once(this.stream, 'close');
    this.stream.destroy();
    await closed;
  }
}

export async function extractOsmFeatures(options: { pbfPath: string; outputDirectory: string; featureLimit: number; maxRequiredNodes: number; maxOutputBytes?: number; parseFile?: ParseOsmFile }): Promise<ExtractionResult> {
  if (!Number.isSafeInteger(options.featureLimit) || options.featureLimit < 1 || options.featureLimit > 50000) throw new Error('Invalid OSM feature limit');
  if (!Number.isSafeInteger(options.maxRequiredNodes) || options.maxRequiredNodes < 1) throw new Error('Invalid OSM node limit');
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024 * 1024;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 2 * 1024 * 1024 * 1024) throw new Error('Invalid OSM output limit');
  const parseFile = options.parseFile ?? parseOsmPbf;
  const layers = Object.fromEntries(spatialKinds.map(kind => [kind, { filePath: join(options.outputDirectory, `${kind.toLowerCase()}.ndjson`), discovered: 0, written: 0, invalid: 0, truncated: false }])) as Record<SpatialKind, LayerExtraction>;
  let outputBytes = 0;
  const reserve = (bytes: number) => { outputBytes += bytes; if (outputBytes > maxOutputBytes) throw new Error('OSM extracted output exceeds configured limit'); };
  const writers = Object.fromEntries(spatialKinds.map(kind => [kind, new NdjsonWriter(layers[kind].filePath, reserve)])) as Record<SpatialKind, NdjsonWriter>;
  const pending: Record<'ROAD' | 'RIVER', PendingWay[]> = { ROAD: [], RIVER: [] };
  const requiredNodes = new Set<number>();
  let storedReferences = 0;
  try {
    await parseFile(options.pbfPath, async items => {
      for (const item of items) {
        const point = classifyNode(item);
        if (point) {
          const layer = layers[point.kind];
          layer.discovered += 1;
          if (layer.written >= options.featureLimit) { layer.truncated = true; continue; }
          await writers[point.kind].write(point);
          layer.written += 1;
          continue;
        }
        const way = classifyWay(item);
        if (!way) continue;
        const layer = layers[way.kind];
        layer.discovered += 1;
        if (pending[way.kind].length >= options.featureLimit) { layer.truncated = true; continue; }
        const additions = new Set(way.refs.filter(ref => !requiredNodes.has(ref))).size;
        if (requiredNodes.size + additions > options.maxRequiredNodes || storedReferences + way.refs.length > options.maxRequiredNodes) { layer.invalid += 1; layer.truncated = true; continue; }
        pending[way.kind].push(way);
        storedReferences += way.refs.length;
        for (const ref of way.refs) requiredNodes.add(ref);
      }
    });
    const coordinates = new Map<number, [number, number]>();
    if (requiredNodes.size) await parseFile(options.pbfPath, async items => {
      for (const item of items) {
        if (item.type !== 'node' || !validId(item.id) || !requiredNodes.has(item.id)) continue;
        const node = item as OsmNode;
        if (validCoordinate(node.lon, node.lat)) coordinates.set(node.id, [node.lon, node.lat]);
      }
    });
    for (const kind of ['ROAD', 'RIVER'] as const) {
      for (const way of pending[kind]) {
        const line = way.refs.map(ref => coordinates.get(ref));
        if (line.some(position => !position)) { layers[kind].invalid += 1; continue; }
        const positions = line as [number, number][];
        if (!positions.some((position, index) => index > 0 && (position[0] !== positions[0]![0] || position[1] !== positions[0]![1]))) { layers[kind].invalid += 1; continue; }
        const { refs: _refs, ...feature } = way;
        await writers[kind].write({ ...feature, geometry: { type: 'LineString', coordinates: positions } });
        layers[kind].written += 1;
      }
    }
    await Promise.all(spatialKinds.map(kind => writers[kind].close()));
    return { layers, requiredNodes: requiredNodes.size, storedReferences };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error('OSM extraction failed');
    await Promise.all(spatialKinds.map(kind => writers[kind].destroy(failure)));
    throw failure;
  }
}
