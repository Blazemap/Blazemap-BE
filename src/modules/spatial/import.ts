import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { jsonValue } from '../../utils/index.js';
import { spatialKinds, type LayerExtraction, type OsmFeature, type SpatialKind } from './osm.js';

export const osmLayerDefinitions: readonly { kind: SpatialKind; name: string }[] = [
  { kind: 'SETTLEMENT', name: 'OSM Kalimantan settlements' },
  { kind: 'FACILITY', name: 'OSM Kalimantan facilities' },
  { kind: 'WATER_SOURCE', name: 'OSM Kalimantan water sources' },
  { kind: 'ROAD', name: 'OSM Kalimantan roads' },
  { kind: 'RIVER', name: 'OSM Kalimantan rivers' },
];
const provider = 'OpenStreetMap';
const license = 'ODbL 1.0';
const attribution = '© OpenStreetMap contributors';
type ExtractionLayers = Record<SpatialKind, LayerExtraction>;
type SourceMetadata = { checksum: string; sourceUrl: string; sourceDate: Date };

function coverage(layer: LayerExtraction, importComplete: boolean, kind: SpatialKind) {
  return JSON.stringify({ complete: false, importComplete, geometryScope: ['SETTLEMENT', 'FACILITY', 'WATER_SOURCE'].includes(kind) ? 'tagged-nodes-only' : 'tagged-ways-only', discovered: layer.discovered, imported: importComplete ? layer.written : 0, invalid: layer.invalid, truncated: layer.truncated, featureLimitApplied: layer.truncated });
}
function validPoint(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every(Number.isFinite) && Math.abs(value[0] as number) <= 180 && Math.abs(value[1] as number) <= 90;
}
function validateFeature(value: unknown, kind: SpatialKind): OsmFeature {
  if (!value || typeof value !== 'object') throw new Error('Invalid extracted OSM feature');
  const item = value as Partial<OsmFeature>;
  if (item.kind !== kind || typeof item.sourceId !== 'string' || !/^(node|way)\/\d+$/.test(item.sourceId) || item.sourceId.length > 128 || item.name !== null && (typeof item.name !== 'string' || item.name.length > 200) || !item.attributes || typeof item.attributes !== 'object' || Array.isArray(item.attributes)) throw new Error('Invalid extracted OSM feature');
  if (kind === 'ROAD' || kind === 'RIVER') {
    if (item.geometry?.type !== 'LineString' || !Array.isArray(item.geometry.coordinates) || item.geometry.coordinates.length < 2 || item.geometry.coordinates.length > 10000 || !item.geometry.coordinates.every(validPoint)) throw new Error('Invalid extracted OSM line');
  } else if (item.geometry?.type !== 'Point' || !validPoint(item.geometry.coordinates)) throw new Error('Invalid extracted OSM point');
  return item as OsmFeature;
}
async function *readFeatures(path: string, kind: SpatialKind) {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error('Invalid extracted OSM JSON'); }
    yield validateFeature(value, kind);
  }
}
function completeLayer(layer: { name: string; version: string; coverage: string; _count: { features: number } }, checksum: string, expected?: LayerExtraction) {
  if (layer.version !== checksum) return false;
  let metadata: unknown;
  try { metadata = JSON.parse(layer.coverage); } catch { return false; }
  const value = metadata as { complete?: unknown; importComplete?: unknown; imported?: unknown };
  return value.complete === false && value.importComplete === true && typeof value.imported === 'number' && value.imported === layer._count.features && (!expected || value.imported === expected.written);
}

export async function osmVersionImported(client: Pick<PrismaClient, 'msMapLayer'>, checksum: string, layers?: ExtractionLayers) {
  const existing = await client.msMapLayer.findMany({ where: { provider, version: checksum }, select: { name: true, version: true, coverage: true, _count: { select: { features: true } } } });
  return osmLayerDefinitions.every(definition => {
    const layer = existing.find(item => item.name === definition.name);
    return !!layer && completeLayer(layer, checksum, layers?.[definition.kind]);
  });
}

export async function importOsmLayers(client: PrismaClient, layers: ExtractionLayers, metadata: SourceMetadata, batchSize: number) {
  if (!/^[a-f\d]{32}$/.test(metadata.checksum) || !Number.isFinite(metadata.sourceDate.getTime()) || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 2000 || !spatialKinds.every(kind => layers[kind]?.filePath)) throw new Error('Invalid OSM import metadata');
  if (await osmVersionImported(client, metadata.checksum, layers)) return { skipped: true, imported: 0, layers: osmLayerDefinitions.map(item => ({ ...item, imported: layers[item.kind].written })) };
  return client.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('spatial:osm:kalimantan'))`;
    if (await osmVersionImported(tx as PrismaClient, metadata.checksum, layers)) return { skipped: true, imported: 0, layers: osmLayerDefinitions.map(item => ({ ...item, imported: layers[item.kind].written })) };
    const results: { kind: SpatialKind; name: string; imported: number }[] = [];
    for (const definition of osmLayerDefinitions) {
      const extracted = layers[definition.kind];
      const data = { name: definition.name, kind: definition.kind, provider, sourceUrl: metadata.sourceUrl, license, attribution, coverage: coverage(extracted, false, definition.kind), version: metadata.checksum, sourceDate: metadata.sourceDate, verifiedAt: null };
      const existing = await tx.msMapLayer.findFirst({ where: { provider, name: definition.name }, select: { id: true } });
      const layer = existing ? await tx.msMapLayer.update({ where: { id: existing.id }, data }) : await tx.msMapLayer.create({ data, select: { id: true } });
      await tx.msMapFeature.deleteMany({ where: { layerId: layer.id } });
      let batch: { layerId: string; sourceId: string; kind: SpatialKind; name: string | null; geometry: ReturnType<typeof jsonValue>; attributes: ReturnType<typeof jsonValue> }[] = [];
      let imported = 0;
      const flush = async () => {
        if (!batch.length) return;
        const result = await tx.msMapFeature.createMany({ data: batch, skipDuplicates: true });
        imported += result.count;
        batch = [];
      };
      for await (const feature of readFeatures(extracted.filePath, definition.kind)) {
        batch.push({ layerId: layer.id, sourceId: feature.sourceId, kind: definition.kind, name: feature.name, geometry: jsonValue(feature.geometry), attributes: jsonValue(feature.attributes) });
        if (batch.length >= batchSize) await flush();
      }
      await flush();
      if (imported !== extracted.written) throw new Error(`OSM ${definition.kind} import count mismatch`);
      await tx.msMapLayer.update({ where: { id: layer.id }, data: { coverage: coverage(extracted, true, definition.kind) } });
      results.push({ ...definition, imported });
    }
    return { skipped: false, imported: results.reduce((total, item) => total + item.imported, 0), layers: results };
  }, { maxWait: 10000, timeout: 30 * 60 * 1000 });
}
