import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'dotenv';
import { demoAreas, demoDatabase } from './seed-areas.js';

async function main() {
  const { values } = parseArgs({ options: { apply: { type: 'boolean', default: false }, 'confirm-demo-database': { type: 'boolean', default: false } }, allowPositionals: false });
  const features = demoAreas();
  if (!values.apply) { console.log(JSON.stringify({ mode: 'DRY_RUN', cases: 10, polygons: 10, demo: true, writes: 0 })); return; }
  if (!values['confirm-demo-database']) throw new Error('Explicit isolated demo database confirmation required.');
  let primary: NodeJS.ProcessEnv = {};
  try { primary = parse(await readFile(new URL('../.env', import.meta.url))); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  const databaseName = demoDatabase(process.env, primary);
  const [{ PrismaClient }, { PrismaPg }] = await Promise.all([import('./generated/prisma/client.js'), import('@prisma/adapter-pg')]);
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DEMO_DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 }), log: [] });
  try {
    const result = await client.$transaction(async tx => {
      const identity = await tx.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
      if (identity[0]?.name !== databaseName) throw new Error('Database identity mismatch.');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(741037, 12)`;
      if (await tx.trHotspot.count() || await tx.trIntegrationRun.count() || await tx.trPublicInformation.count()) throw new Error('Refusing a database containing operational data.');
      if (await tx.trCase.count({ where: { NOT: { number: { startsWith: 'DEMO-FIRE-V1-' } } } })) throw new Error('Refusing non-demo cases.');
      const layer = await tx.msMapLayer.upsert({ where: { provider_name_version: { provider: 'DEMO', name: '[DEMO] Simulated confirmed case areas', version: '1' } }, update: {}, create: { provider: 'DEMO', name: '[DEMO] Simulated confirmed case areas', version: '1', kind: 'DESIGNATED_LOCATION', sourceUrl: 'urn:blazemap:demo:confirmed-areas:v1', license: 'Synthetic test fixture', attribution: 'DEMO simulation, not government verification', coverage: 'Simulated Kalimantan areas; not actual fire boundaries', sourceDate: new Date(), verifiedAt: null } });
      let created = 0;
      for (const [index, feature] of features.entries()) {
        const number = `DEMO-FIRE-V1-${String(index + 1).padStart(2, '0')}`;
        const existing = await tx.trCase.findUnique({ where: { number } });
        const title = `[DEMO] Simulated confirmed fire ${index + 1}`;
        if (existing && (existing.title !== title || existing.priorityReason !== 'DEMO simulation; not a real government confirmation.')) throw new Error('Case identity collision; refusing changes.');
        const ring = feature.geometry.coordinates[0]!;
        const first = ring[0]!;
        const opposite = ring[2]!;
        const item = existing ?? await tx.trCase.create({ data: { number, title, verificationStatus: 'CONFIRMED_FIRE', handlingStatus: 'MONITORING', priorityReason: 'DEMO simulation; not a real government confirmation.', latitude: (first[1]! + opposite[1]!) / 2, longitude: (first[0]! + opposite[0]!) / 2 } });
        const stored = await tx.msMapFeature.findUnique({ where: { layerId_sourceId: { layerId: layer.id, sourceId: feature.id } } });
        if (stored && (stored.name !== feature.properties.name || JSON.stringify(stored.geometry) !== JSON.stringify(feature.geometry))) throw new Error('Polygon identity collision; refusing changes.');
        if (!stored) await tx.msMapFeature.create({ data: { layerId: layer.id, sourceId: feature.id, kind: 'DESIGNATED_LOCATION', name: feature.properties.name, geometry: feature.geometry, attributes: { ...feature.properties, caseId: item.id, scenarioStatus: 'SIMULATED_CONFIRMED_FIRE', generatedAt: new Date().toISOString() } } });
        if (!existing) {
          created++;
          await tx.trAuditLog.create({ data: { systemActor: 'demo-case-seeder-v1', action: 'DEMO_CASE_CREATED', targetType: 'CASE', targetId: item.id, reason: 'Isolated DEMO fixtures. Confirmation and polygon are simulated, not government evidence.' } });
        }
      }
      return { created, cases: await tx.trCase.count({ where: { number: { startsWith: 'DEMO-FIRE-V1-' }, priorityReason: 'DEMO simulation; not a real government confirmation.' } }), polygons: await tx.msMapFeature.count({ where: { layerId: layer.id } }) };
    }, { timeout: 120000, maxWait: 15000 });
    console.log(JSON.stringify({ mode: 'APPLIED', ...result, demo: true, publiclyPublished: false }));
  } finally { await client.$disconnect(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error('Demo case seed failed; transaction rolled back.', { code: error && typeof error === 'object' && 'code' in error ? error.code : 'UNKNOWN', transactionTimeout: error instanceof Error && /expired|timeout/i.test(error.message) }); process.exitCode = 1; });
}
