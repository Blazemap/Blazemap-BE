import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'dotenv';

export function demoAreas() {
  return Array.from({ length: 10 }, (_, index) => {
    const longitude = 113.8 + (index % 5) * 0.08;
    const latitude = -2.5 + Math.floor(index / 5) * 0.08;
    const width = 0.006 + index * 0.001;
    const height = width * 0.7;
    const coordinates = [[longitude, latitude], [longitude + width, latitude], [longitude + width, latitude + height], [longitude, latitude + height], [longitude, latitude]];
    const radians = Math.PI / 180;
    const areaHectares = 6371008.8 ** 2 * width * radians * (Math.sin((latitude + height) * radians) - Math.sin(latitude * radians)) / 10000;
    return { type: 'Feature' as const, id: `demo-fire-area-${index + 1}`, geometry: { type: 'Polygon' as const, coordinates: [coordinates] }, properties: { name: `[DEMO] Simulated fire area ${index + 1}`, demo: true, source: 'SIMULATED', verification: 'NOT_VERIFIED', areaHectares: Math.round(areaHectares * 100) / 100, notice: 'Synthetic training geometry; not an actual fire perimeter or satellite footprint.' } };
  });
}

export function demoDatabase(env: NodeJS.ProcessEnv, primary: NodeJS.ProcessEnv) {
  if (!['development', 'test'].includes(env.NODE_ENV ?? '') || env.DEMO_SEED_CONFIRM !== 'ISOLATED_DEMO_ONLY') throw new Error('Require development/test and DEMO_SEED_CONFIRM=ISOLATED_DEMO_ONLY.');
  const name = (value: string) => {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.searchParams.has('options')) throw new Error('Unsupported database URL.');
    return decodeURIComponent(url.pathname.slice(1));
  };
  if (!env.DEMO_DATABASE_URL) throw new Error('DEMO_DATABASE_URL is required.');
  const target = name(env.DEMO_DATABASE_URL);
  const originals = [env.DATABASE_URL, primary.DATABASE_URL, env.DIRECT_URL, primary.DIRECT_URL].filter((value): value is string => !!value);
  if (!/^blazemap_demo_[a-z0-9_]+$/.test(target) || !originals.length || originals.some(value => name(value) === target)) throw new Error('Use a separate blazemap_demo_* database, not the primary database.');
  return target;
}

async function main() {
  const { values } = parseArgs({ options: { apply: { type: 'boolean', default: false } }, allowPositionals: false });
  const features = demoAreas();
  if (!values.apply) {
    console.log(JSON.stringify({ mode: 'DRY_RUN', writes: 0, type: 'FeatureCollection', features }, null, 2));
    return;
  }
  let primary: NodeJS.ProcessEnv = {};
  try { primary = parse(await readFile(new URL('../.env', import.meta.url))); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  const databaseName = demoDatabase(process.env, primary);
  const [{ PrismaClient }, { PrismaPg }] = await Promise.all([import('./generated/prisma/client.js'), import('@prisma/adapter-pg')]);
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DEMO_DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 }), log: [] });
  try {
    await client.$transaction(async tx => {
      const identity = await tx.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
      if (identity[0]?.name !== databaseName) throw new Error('Database identity mismatch.');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(741037, 11)`;
      if (await tx.trHotspot.count() || await tx.trIntegrationRun.count()) throw new Error('Refusing a database containing real integration data.');
      const layer = await tx.msMapLayer.upsert({ where: { provider_name_version: { provider: 'DEMO', name: '[DEMO] Simulated fire areas', version: '1' } }, update: {}, create: { provider: 'DEMO', name: '[DEMO] Simulated fire areas', version: '1', kind: 'DESIGNATED_LOCATION', sourceUrl: 'urn:blazemap:demo:fire-areas:v1', license: 'Synthetic test fixture', attribution: 'Blazemap demo generator; not verified fire evidence', coverage: 'Synthetic locations in Kalimantan; not actual fire perimeters', sourceDate: new Date(), verifiedAt: null } });
      await tx.msMapFeature.createMany({ skipDuplicates: true, data: features.map(feature => ({ layerId: layer.id, sourceId: feature.id, kind: 'DESIGNATED_LOCATION' as const, name: feature.properties.name, geometry: feature.geometry, attributes: feature.properties })) });
      console.log(JSON.stringify({ mode: 'APPLIED', polygons: await tx.msMapFeature.count({ where: { layerId: layer.id } }), demo: true, verified: false }));
    }, { timeout: 30000 });
  } finally { await client.$disconnect(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Demo area seed failed. Check isolated demo configuration and migrated schema; no credentials logged.'); process.exitCode = 1; });
}
