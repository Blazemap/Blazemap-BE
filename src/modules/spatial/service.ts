import { dirname } from 'node:path';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { jsonValue } from '../../utils/index.js';
import { defaultGeofabrikUrl, downloadVerifiedExtract, inspectRemoteExtract } from './download.js';
import { importOsmLayers, osmVersionImported } from './import.js';
import { extractOsmFeatures } from './osm.js';

const downloadLimit = 2 * 1024 * 1024 * 1024;
const outputLimit = 1024 * 1024 * 1024;
const featureLimit = 50000;
const requiredNodeLimit = 2000000;
const batchSize = 1000;
type SpatialEnvironment = { SPATIAL_IMPORT_USER_AGENT?: string; OSM_GEOFABRIK_URL?: string };

function settings(environment: SpatialEnvironment) {
  const userAgent = environment.SPATIAL_IMPORT_USER_AGENT?.trim();
  if (!userAgent) throw new Error('SPATIAL_IMPORT_USER_AGENT is required');
  return { sourceUrl: environment.OSM_GEOFABRIK_URL?.trim() || defaultGeofabrikUrl, userAgent, maxBytes: downloadLimit };
}
export async function inspectOsmSource(environment: SpatialEnvironment) {
  const remote = await inspectRemoteExtract(settings(environment));
  return { mode: 'DRY_RUN' as const, ...remote, limits: { downloadBytes: downloadLimit, extractedBytes: outputLimit, featuresPerLayer: featureLimit, requiredNodes: requiredNodeLimit } };
}
export async function claimOsmRun(client: PrismaClient, scope: { sourceUrl: string; checksum: string }) {
  return client.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('spatial:osm:kalimantan:run'))`;
    await tx.trIntegrationRun.updateMany({ where: { provider: 'OSM_GEOFABRIK', status: 'RUNNING', startedAt: { lt: new Date(Date.now() - 2 * 60 * 60 * 1000) } }, data: { status: 'FAILED', completedAt: new Date(), failureCode: 'RUN_EXPIRED' } });
    const active = await tx.trIntegrationRun.findFirst({ where: { provider: 'OSM_GEOFABRIK', status: 'RUNNING' }, select: { id: true } });
    if (active) throw new Error('OSM spatial import is already running');
    return tx.trIntegrationRun.create({ data: { provider: 'OSM_GEOFABRIK', scope: jsonValue({ ...scope, maxBytes: downloadLimit, featureLimit }), status: 'RUNNING' }, select: { id: true } });
  }, { maxWait: 10000, timeout: 30000 });
}
export async function runOsmImport(client: PrismaClient, environment: SpatialEnvironment) {
  const configuration = settings(environment);
  const remote = await inspectRemoteExtract(configuration);
  if (await osmVersionImported(client, remote.checksum)) return { mode: 'SKIPPED' as const, checksum: remote.checksum, sourceDate: remote.sourceDate, imported: 0 };
  const run = await claimOsmRun(client, { sourceUrl: remote.sourceUrl, checksum: remote.checksum });
  let received = 0;
  let extracted: Awaited<ReturnType<typeof extractOsmFeatures>> | undefined;
  try {
    const download = await downloadVerifiedExtract(configuration);
    received = download.bytes;
    try {
      if (download.checksum !== remote.checksum || download.sourceDate.getTime() !== remote.sourceDate.getTime()) throw new Error('Geofabrik extract changed during import; retry the next run');
      extracted = await extractOsmFeatures({ pbfPath: download.filePath, outputDirectory: dirname(download.filePath), featureLimit, maxRequiredNodes: requiredNodeLimit, maxOutputBytes: outputLimit });
      const result = await importOsmLayers(client, extracted.layers, download, batchSize);
      await client.trIntegrationRun.update({ where: { id: run.id }, data: { status: 'SUCCEEDED', completedAt: new Date(), received, imported: result.imported, deduplicated: result.skipped ? result.layers.reduce((total, item) => total + item.imported, 0) : 0, scope: jsonValue({ sourceUrl: download.sourceUrl, checksum: download.checksum, sourceDate: download.sourceDate.toISOString(), maxBytes: downloadLimit, featureLimit, requiredNodes: extracted.requiredNodes, storedReferences: extracted.storedReferences, layers: result.layers.map(item => ({ ...item, ...extracted!.layers[item.kind] })) }) } });
      return { mode: result.skipped ? 'SKIPPED' as const : 'IMPORTED' as const, checksum: download.checksum, sourceDate: download.sourceDate, imported: result.imported, requiredNodes: extracted.requiredNodes, storedReferences: extracted.storedReferences, layers: result.layers.map(item => ({ ...item, ...extracted!.layers[item.kind] })) };
    } finally { await download.cleanup(); }
  } catch (error) {
    await client.trIntegrationRun.update({ where: { id: run.id }, data: { status: 'FAILED', completedAt: new Date(), received: received || null, imported: 0, deduplicated: 0, failureCode: error instanceof Error && /checksum/i.test(error.message) ? 'CHECKSUM_FAILED' : error instanceof Error && /limit|exceed|large/i.test(error.message) ? 'RESOURCE_LIMIT' : 'IMPORT_FAILED' } }).catch(() => undefined);
    throw error;
  }
}
