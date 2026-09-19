import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
process.env.DATABASE_URL = '';
const { classifyNode, classifyWay, extractOsmFeatures, parseOsmPbf } = await import('./src/modules/spatial/osm.ts');
const { downloadVerifiedExtract, parseMd5 } = await import('./src/modules/spatial/download.ts');
const { importOsmLayers, osmLayerDefinitions, osmVersionImported } = await import('./src/modules/spatial/import.ts');
const { claimOsmRun } = await import('./src/modules/spatial/service.ts');

const settlement = classifyNode({ type: 'node', id: 1, lat: -1.2, lon: 116.8, tags: { place: 'village', name: 'Desa Aman', population: '1200', building: 'yes', landuse: 'forest' } });
assert.equal(settlement?.kind, 'SETTLEMENT');
assert.deepEqual(settlement?.geometry, { type: 'Point', coordinates: [116.8, -1.2] });
assert.equal(settlement?.attributes.place, 'village');
assert.equal(settlement?.attributes.population, '1200');
assert.equal('building' in settlement.attributes, false);
assert.equal('landuse' in settlement.attributes, false);
assert.equal(classifyNode({ type: 'node', id: 2, lat: 0, lon: 110, tags: { building: 'yes' } }), null);
assert.equal(classifyNode({ type: 'node', id: 3, lat: 0, lon: 110, tags: { natural: 'wood' } }), null);
assert.equal(classifyNode({ type: 'node', id: 4, lat: 0, lon: 110, tags: { landuse: 'peat_cutting' } }), null);
assert.equal(classifyNode({ type: 'node', id: 5, lat: -0.1, lon: 111, tags: { amenity: 'hospital', name: 'RS Kalimantan' } })?.kind, 'FACILITY');
assert.equal(classifyNode({ type: 'node', id: 6, lat: -0.2, lon: 112, tags: { emergency: 'fire_hydrant' } })?.kind, 'WATER_SOURCE');
assert.equal(classifyNode({ type: 'node', id: 7, lat: 95, lon: 112, tags: { place: 'village' } }), null);
const road = classifyWay({ type: 'way', id: 10, refs: [100, 101], tags: { highway: 'primary', name: 'Jalan Utama', building: 'yes' } });
assert.equal(road?.kind, 'ROAD');
assert.deepEqual(road?.refs, [100, 101]);
assert.equal('building' in road.attributes, false);
assert.equal(classifyWay({ type: 'way', id: 11, refs: [101, 102], tags: { waterway: 'river', name: 'Sungai Aman' } })?.kind, 'RIVER');
assert.equal(classifyWay({ type: 'way', id: 12, refs: [101, 102], tags: { building: 'yes' } }), null);
assert.equal(parseMd5('0123456789abcdef0123456789abcdef  kalimantan-latest.osm.pbf\n', 'kalimantan-latest.osm.pbf'), '0123456789abcdef0123456789abcdef');
assert.throws(() => parseMd5('0123456789abcdef0123456789abcdef  other.osm.pbf', 'kalimantan-latest.osm.pbf'));

const require = createRequire(import.meta.url);
const parsers = require('osm-pbf-parser/lib/parsers.js');
const fileBlock = (type, data) => {
  const compressed = deflateSync(data);
  const blob = parsers.file.Blob.encode({ raw_size: data.length, zlib_data: compressed });
  const header = parsers.file.BlobHeader.encode({ type, datasize: blob.length });
  const size = Buffer.alloc(4);
  size.writeUInt32BE(header.length);
  return Buffer.concat([size, header, blob]);
};
const pbfRoot = await mkdtemp(join(tmpdir(), 'blazemap-osm-pbf-test-'));
const pbfPath = join(pbfRoot, 'fixture.osm.pbf');
const headerBlock = parsers.osm.HeaderBlock.encode({ required_features: ['OsmSchema-V0.6', 'DenseNodes'], writingprogram: 'Blazemap test' });
const primitiveBlock = parsers.osm.PrimitiveBlock.encode({
  stringtable: { s: ['', 'place', 'village', 'name', 'Desa PBF', 'highway', 'primary', 'Jalan PBF'].map(value => Buffer.from(value)) },
  primitivegroup: [{
    dense: { id: [1, 1], lat: [-12000000, 1000000], lon: [1168000000, 1000000], keys_vals: [1, 2, 3, 4, 0, 0] },
    ways: [{ id: 10, keys: [5, 3], vals: [6, 7], refs: [1, 1] }],
    nodes: [], relations: [], changesets: [],
  }],
  granularity: 100,
});
await writeFile(pbfPath, Buffer.concat([fileBlock('OSMHeader', headerBlock), fileBlock('OSMData', primitiveBlock)]));
const parsed = [];
await parseOsmPbf(pbfPath, async items => parsed.push(...items));
assert.equal(parsed.find(item => item.type === 'node' && item.id === 1)?.tags.name, 'Desa PBF');
assert.deepEqual(parsed.find(item => item.type === 'way' && item.id === 10)?.refs, [1, 2]);
await rm(pbfRoot, { recursive: true, force: true });

const extractionRoot = await mkdtemp(join(tmpdir(), 'blazemap-osm-extract-test-'));
let pass = 0;
const parseFixture = async (_path, receive) => {
  pass += 1;
  if (pass === 1) await receive([
    { type: 'node', id: 1, lat: -1.2, lon: 116.8, tags: { place: 'village', name: 'Desa Aman' } },
    { type: 'node', id: 2, lat: -1.3, lon: 116.9, tags: { amenity: 'hospital', name: 'RS Aman' } },
    { type: 'node', id: 3, lat: -1.4, lon: 117, tags: { natural: 'spring' } },
    { type: 'way', id: 10, refs: [100, 101], tags: { highway: 'primary', name: 'Jalan Satu' } },
    { type: 'way', id: 11, refs: [101, 102], tags: { highway: 'secondary', name: 'Jalan Dua' } },
    { type: 'way', id: 12, refs: [102, 103], tags: { waterway: 'river', name: 'Sungai Satu' } },
  ]);
  else await receive([
    { type: 'node', id: 100, lat: -1, lon: 116, tags: {} },
    { type: 'node', id: 101, lat: -1.1, lon: 116.1, tags: {} },
    { type: 'node', id: 102, lat: -1.2, lon: 116.2, tags: {} },
    { type: 'node', id: 103, lat: -1.3, lon: 116.3, tags: {} },
  ]);
};
const extracted = await extractOsmFeatures({ pbfPath: 'fixture.osm.pbf', outputDirectory: extractionRoot, featureLimit: 1, maxRequiredNodes: 10, parseFile: parseFixture });
assert.equal(pass, 2);
assert.equal(extracted.layers.SETTLEMENT.written, 1);
assert.equal(extracted.layers.FACILITY.written, 1);
assert.equal(extracted.layers.WATER_SOURCE.written, 1);
assert.equal(extracted.layers.ROAD.discovered, 2);
assert.equal(extracted.layers.ROAD.written, 1);
assert.equal(extracted.layers.ROAD.truncated, true);
assert.equal(extracted.layers.RIVER.written, 1);
const roadRows = (await readFile(extracted.layers.ROAD.filePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
assert.deepEqual(roadRows[0].geometry, { type: 'LineString', coordinates: [[116, -1], [116.1, -1.1]] });
await rm(extractionRoot, { recursive: true, force: true });
const extractionFailureRoot = await mkdtemp(join(tmpdir(), 'blazemap-osm-extract-failure-test-'));
pass = 0;
await assert.rejects(extractOsmFeatures({ pbfPath: 'fixture.osm.pbf', outputDirectory: extractionFailureRoot, featureLimit: 1, maxRequiredNodes: 10, maxOutputBytes: 1, parseFile: parseFixture }), /output exceeds/);
await rm(extractionFailureRoot, { recursive: true, force: false });

const payload = Buffer.from('safe fixture payload');
const digest = createHash('md5').update(payload).digest('hex');
const downloadRoot = await mkdtemp(join(tmpdir(), 'blazemap-osm-download-test-'));
const responses = new Map([
  ['https://example.test/kalimantan-latest.osm.pbf.md5', new Response(`${digest}  kalimantan-latest.osm.pbf\n`)],
  ['https://example.test/kalimantan-latest.osm.pbf', new Response(payload, { headers: { 'content-length': String(payload.length), 'last-modified': 'Fri, 18 Sep 2026 20:21:10 GMT' } })],
]);
const downloaded = await downloadVerifiedExtract({ sourceUrl: 'https://example.test/kalimantan-latest.osm.pbf', userAgent: 'Blazemap/1.0 (+https://blazemap.my.id)', maxBytes: 1024, temporaryRoot: downloadRoot, fetchImpl: async url => responses.get(String(url)) ?? new Response('', { status: 404 }) });
assert.equal(downloaded.checksum, digest);
assert.equal((await readFile(downloaded.filePath)).toString(), payload.toString());
assert.equal(downloaded.sourceDate.toISOString(), '2026-09-18T20:21:10.000Z');
await downloaded.cleanup();
assert.deepEqual(await readdir(downloadRoot), []);
const oversized = async url => String(url).endsWith('.md5') ? new Response(`${digest}  kalimantan-latest.osm.pbf\n`) : new Response(payload, { headers: { 'content-length': '2048', 'last-modified': 'Fri, 18 Sep 2026 20:21:10 GMT' } });
await assert.rejects(downloadVerifiedExtract({ sourceUrl: 'https://example.test/kalimantan-latest.osm.pbf', userAgent: 'Blazemap/1.0 (+https://blazemap.my.id)', maxBytes: 1024, temporaryRoot: downloadRoot, fetchImpl: oversized }));
assert.deepEqual(await readdir(downloadRoot), []);
await rm(downloadRoot, { recursive: true, force: true });

const importRoot = await mkdtemp(join(tmpdir(), 'blazemap-osm-import-test-'));
const files = {};
for (const [index, definition] of osmLayerDefinitions.entries()) {
  const filePath = join(importRoot, `${definition.kind}.ndjson`);
  const linear = definition.kind === 'ROAD' || definition.kind === 'RIVER';
  const count = definition.kind === 'SETTLEMENT' ? 3 : 1;
  const rows = Array.from({ length: count }, (_, row) => JSON.stringify({ sourceId: `${linear ? 'way' : 'node'}/${(index + 1) * 10 + row}`, kind: definition.kind, name: definition.name, geometry: linear ? { type: 'LineString', coordinates: [[116, -1], [116.1, -1.1]] } : { type: 'Point', coordinates: [116, -1] }, attributes: { osmType: linear ? 'way' : 'node', osmId: String((index + 1) * 10 + row) } })).join('\n');
  await writeFile(filePath, `${rows}\n`);
  files[definition.kind] = { filePath, discovered: count, written: count, invalid: 0, truncated: false };
}
const state = { layers: [], features: [], creates: 0, batches: 0 };
const tx = {
  $executeRaw: async () => 1,
  msMapLayer: {
    findMany: async () => state.layers.map(layer => ({ ...layer, _count: { features: state.features.filter(feature => feature.layerId === layer.id).length } })),
    findFirst: async ({ where }) => state.layers.find(layer => layer.provider === where.provider && layer.name === where.name) ?? null,
    create: async ({ data }) => { const layer = { ...data, id: `layer-${state.layers.length + 1}`, importedAt: new Date() }; state.layers.push(layer); return layer; },
    update: async ({ where, data }) => { const layer = state.layers.find(item => item.id === where.id); Object.assign(layer, data); return layer; },
  },
  msMapFeature: {
    findMany: async () => [],
    deleteMany: async ({ where }) => { state.features = state.features.filter(feature => feature.layerId !== where.layerId); return { count: 0 }; },
    createMany: async ({ data }) => { state.batches++; state.creates += data.length; state.features.push(...data); return { count: data.length }; },
    update: async () => { throw new Error('Unexpected retained feature update'); },
  },
};
const client = { $transaction: async callback => callback(tx), msMapLayer: tx.msMapLayer };
const metadata = { checksum: digest, sourceUrl: 'https://example.test/kalimantan-latest.osm.pbf', sourceDate: new Date('2026-09-18T20:21:10Z') };
assert.equal(await osmVersionImported(client, digest), false);
const imported = await importOsmLayers(client, files, metadata, 2);
assert.equal(imported.skipped, false);
assert.equal(state.layers.length, osmLayerDefinitions.length);
assert.equal(state.creates, osmLayerDefinitions.length + 2);
assert.equal(state.batches, osmLayerDefinitions.length + 1);
assert.equal(await osmVersionImported(client, digest), true);
const rerun = await importOsmLayers(client, files, metadata, 2);
assert.equal(rerun.skipped, true);
assert.equal(state.creates, osmLayerDefinitions.length + 2);
assert.ok(state.layers.every(layer => layer.provider === 'OpenStreetMap' && layer.license === 'ODbL 1.0' && layer.attribution === '© OpenStreetMap contributors' && layer.verifiedAt === null));
assert.ok(state.layers.every(layer => JSON.parse(layer.coverage).complete === false && JSON.parse(layer.coverage).importComplete === true));
await rm(importRoot, { recursive: true, force: true });
let activeRun = { id: 'active-run' };
const claimTx = {
  $executeRaw: async () => 1,
  trIntegrationRun: {
    updateMany: async () => ({ count: 0 }),
    findFirst: async () => activeRun,
    create: async () => ({ id: 'new-run' }),
  },
};
const claimClient = { $transaction: async callback => callback(claimTx) };
await assert.rejects(claimOsmRun(claimClient, { sourceUrl: metadata.sourceUrl, checksum: digest }), /already running/);
activeRun = null;
assert.deepEqual(await claimOsmRun(claimClient, { sourceUrl: metadata.sourceUrl, checksum: digest }), { id: 'new-run' });
console.log('Spatial classification, allowlists, bounded extraction, checksum download cleanup, metadata, batching, concurrency and checksum idempotency passed.');
