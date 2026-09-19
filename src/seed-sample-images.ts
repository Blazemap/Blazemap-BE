import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import sharp from 'sharp';
import { db, disconnect } from './config/db.js';
import { env } from './config/env.js';
import { storage } from './config/storage.js';
import { sampleFlags, samplePayloads, seedSampleReports } from './seed-sample-reports.js';
import { inspectImage } from './modules/uploads/uploads.service.js';
import { fingerprint } from './utils/index.js';
import type { Prisma } from './generated/prisma/client.js';

export const scenarioActor = 'sample-report-image-seeder-v2';
export const photoSources = [
  { pageId: 107639709, author: "Brendan O'Reilly / U.S. Forest Service", title: 'Lick Fire on the Umatilla National Forest burning at night' },
  { pageId: 24922270, author: 'Keith Ramos / U.S. Fish and Wildlife Service', title: 'A large fire in tropical forest trees in the fire' },
] as const;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function requireSafe(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
export function sourceUrl(value: string) {
  const url = new URL(value);
  requireSafe(url.protocol === 'https:' && ['commons.wikimedia.org', 'upload.wikimedia.org'].includes(url.hostname) && !url.username && !url.password, 'Untrusted photo source');
  return url;
}
export function scenarioCopy(index: number) {
  const item = samplePayloads()[index];
  requireSafe(item, 'Unknown fixture index');
  const place = item.payload.locationDescription.match(/in the (.+) area,/)?.[1];
  requireSafe(place, 'Missing scenario place');
  const descriptions = ['Smoke rises above scrub beside a drainage canal.', 'Flames spread along dry vegetation beside an access track.', 'A burning smell is noticed along a plantation road.', 'Smoke drifts across low vegetation near a canal.', 'Dry grass is burning away from nearby buildings.', 'An intermittent burning smell is noticed near a riverbank.', 'A smoke plume rises above roadside scrub.', 'Flames are visible at the edge of a cleared patch.', 'A burning smell is noticed along a rural track.', 'Diffuse smoke hangs above dry vegetation.'];
  return { locationDescription: `${place}, Kalimantan — illustrative location.`, description: `${descriptions[index]} Illustrative scenario — simulated observation. Photograph is a licensed reference, not evidence from this location.`, history: ['Illustrative scenario — initial observation recorded.', 'Illustrative scenario — location context and reference photograph added.'] };
}
async function boundedPhoto(url: URL) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error', headers: { 'User-Agent': 'Blazemap-Illustrative-Fixtures/2.0' } });
  requireSafe(response.ok && response.body, 'Photo download failed');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    requireSafe(size <= 5242880, 'Photo exceeds 5 MiB');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
async function preparePhoto(source: typeof photoSources[number]) {
  const metadataUrl = `https://commons.wikimedia.org/w/api.php?action=query&pageids=${source.pageId}&prop=imageinfo&iiprop=url%7Cextmetadata&format=json`;
  const response = await fetch(metadataUrl, { signal: AbortSignal.timeout(30000), redirect: 'error', headers: { 'User-Agent': 'Blazemap-Illustrative-Fixtures/2.0' } });
  requireSafe(response.ok, 'Commons metadata unavailable');
  const body = await response.json() as { query?: { pages?: Record<string, { imageinfo?: { url: string; descriptionurl: string; extmetadata: Record<string, { value: string }> }[] }> } };
  const info = body.query?.pages?.[source.pageId]?.imageinfo?.[0];
  requireSafe(info && info.extmetadata.LicenseShortName?.value === 'Public domain' && info.extmetadata.Copyrighted?.value === 'False' && !info.extmetadata.Restrictions?.value, 'Source license verification failed');
  const original = await boundedPhoto(sourceUrl(info.url));
  await inspectImage(original, 'image/jpeg', original.length);
  const originalDimensions = await sharp(original).metadata();
  const image = await sharp(original).rotate().resize(1200, 900, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 86 }).toBuffer();
  const dimensions = await sharp(image).metadata();
  const label = Buffer.from(`<svg width="${dimensions.width}" height="48"><rect width="100%" height="48" fill="#152018"/><text x="16" y="31" font-family="sans-serif" font-size="22" fill="white">Illustrative scenario</text></svg>`);
  const processed = await sharp(image).composite([{ input: label, gravity: 'south' }]).webp({ quality: 86 }).toBuffer();
  await inspectImage(processed, 'image/webp', processed.length);
  const provenance = { synthetic: true, source: 'Wikimedia Commons', pageId: source.pageId, title: source.title, author: source.author, license: 'Public domain', sourcePage: sourceUrl(info.descriptionurl).href, originalUrl: sourceUrl(info.url).href, metadataUrl, metadata: info.extmetadata, retrievedAt: new Date().toISOString(), modifications: 'Auto-oriented, resized, metadata stripped, WebP encoded, Illustrative scenario caption added', original: { sha256: digest(original), contentType: 'image/jpeg', size: original.length, width: originalDimensions.width!, height: originalDimensions.height! }, processed: { sha256: digest(processed), contentType: 'image/webp', size: processed.length, width: dimensions.width!, height: dimensions.height! } };
  return { original, processed, provenance };
}
export async function enrichSamples(apply: boolean) {
  const client = db();
  const enriched = await client.trAuditLog.findMany({ where: { systemActor: scenarioActor, action: 'SAMPLE_REPORT_ENRICHED' }, take: 11 });
  if (enriched.length) {
    requireSafe(enriched.length === 10, 'Partial enrichment provenance');
    return client.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('sample-report-seeder'))`;
      const rows = await tx.trReport.findMany({ where: { id: { in: enriched.map(audit => audit.targetId) } }, include: { attachments: true }, orderBy: { idempotencyKey: 'asc' } });
      requireSafe(rows.length === 10, 'Missing enriched fixtures');
      let corrected = 0;
      for (const [index, row] of rows.entries()) {
        const proof = enriched.find(audit => audit.targetId === row.id)?.details as { payloadHash?: string; attachmentId?: string };
        requireSafe(row.idempotencyKey === samplePayloads()[index]!.payload.idempotencyKey && row.attachments.length === 1 && row.attachments[0]!.id === proof.attachmentId && row.attachments[0]!.uploaderId === row.reporterId, 'Enriched ownership mismatch');
        const description = scenarioCopy(index).description;
        if (row.description === description) continue;
        requireSafe(row.payloadHash === proof.payloadHash && row.description === description.replace(' — simulated observation', ''), 'Unexpected enriched content');
        if (!apply) continue;
        const payload = { ...samplePayloads()[index]!.payload, observedAt: row.observedAt.toISOString(), locationDescription: row.locationDescription, description, attachmentIds: [row.attachments[0]!.id] };
        const payloadHash = fingerprint({ ...payload, observationTypes: [...payload.observationTypes].sort(), attachmentIds: [...payload.attachmentIds].sort() });
        await tx.trReport.update({ where: { id: row.id }, data: { description, payloadHash } });
        await tx.trAuditLog.create({ data: { systemActor: scenarioActor, action: 'SAMPLE_TRIAGE_MARKER_RESTORED', targetType: 'REPORT', targetId: row.id, reason: 'Preserve synthetic triage exclusion', details: { synthetic: true, previousPayloadHash: row.payloadHash, payloadHash } } });
        corrected++;
      }
      return { existingEnrichedReports: rows.length, triageMarkersCorrected: corrected, dryRun: !apply };
    }, { isolationLevel: 'Serializable', timeout: 60000 });
  }
  await seedSampleReports(client, false);
  const keys = samplePayloads().map(item => item.payload.idempotencyKey);
  const before = await client.trReport.findMany({ where: { idempotencyKey: { in: keys } }, orderBy: { idempotencyKey: 'asc' } });
  requireSafe(before.length === 10, 'Expected ten proven fixtures');
  const ids = before.map(item => item.id);
  requireSafe(await client.trReportProgress.count({ where: { reportId: { in: ids } } }) === 0, 'Existing progress must be preserved');
  const users = await client.msUser.findMany({ where: { id: { in: before.map(item => item.reporterId) } }, select: { id: true, name: true, role: true, active: true, canConfirmIncidents: true, canPublishInformation: true }, orderBy: { id: 'asc' } });
  const priorAudits = await client.trAuditLog.findMany({ where: { targetId: { in: ids } }, orderBy: { id: 'asc' } });
  const preservedReports = await client.trReport.findMany({ where: { id: { notIn: ids } }, orderBy: { id: 'asc' }, take: 10001 });
  requireSafe(preservedReports.length <= 10000, 'Preservation bound exceeded');
  const preservedCases = await client.trCase.findMany({ orderBy: { id: 'asc' }, take: 10001 });
  requireSafe(preservedCases.length <= 10000, 'Case preservation bound exceeded');
  await storage().send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }), { abortSignal: AbortSignal.timeout(15000) });
  if (!apply) return { dryRun: true, provenReports: 10, plannedImages: 10, plannedHistoryUpdates: 20, plannedPolygons: 0, writes: 0 };
  const photos = await Promise.all(photoSources.map(preparePhoto));
  const uploaded: string[] = [];
  let committed = false;
  try {
    const prepared: { report: typeof before[number]; photo: typeof photos[number]; objectKey: string; originalKey: string; stagingKey: string; index: number }[] = [];
    for (const [index, report] of before.entries()) {
      const photo = photos[index % photos.length]!;
      const root = `illustrative/sample-report-v2/${report.id}/${randomUUID()}`;
      const originalKey = `${root}/original.jpg`;
      const objectKey = `${root}/reference.webp`;
      for (const [key, bytes, contentType] of [[originalKey, photo.original, 'image/jpeg'], [objectKey, photo.processed, 'image/webp']] as const) {
        await storage().send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: bytes, ContentType: contentType, ContentLength: bytes.length, CacheControl: 'private, no-store', IfNoneMatch: '*', Metadata: { sha256: digest(bytes), purpose: 'illustrative-scenario-not-evidence', source: `commons-${photo.provenance.pageId}` } }), { abortSignal: AbortSignal.timeout(15000) });
        uploaded.push(key);
        const head = await storage().send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }), { abortSignal: AbortSignal.timeout(15000) });
        requireSafe(head.ContentLength === bytes.length && head.Metadata?.sha256 === digest(bytes), 'Stored image verification failed');
        const signed = await getSignedUrl(storage(), new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }), { expiresIn: 60 });
        const privateUrl = new URL(signed);
        privateUrl.search = '';
        const anonymous = await fetch(privateUrl, { signal: AbortSignal.timeout(15000), redirect: 'manual' });
        await anonymous.body?.cancel();
        requireSafe([401, 403].includes(anonymous.status), 'Object is not proven private');
        const download = await fetch(signed, { signal: AbortSignal.timeout(15000), redirect: 'error' });
        requireSafe(download.ok && digest(Buffer.from(await download.arrayBuffer())) === digest(bytes), 'Signed download verification failed');
      }
      prepared.push({ report, photo, objectKey, originalKey, stagingKey: `${root}/unused`, index });
    }
    const result = await client.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('sample-report-seeder'))`;
      for (const report of before) await tx.$queryRaw`SELECT id FROM "TrReport" WHERE id = ${report.id} FOR UPDATE`;
      requireSafe(isDeepStrictEqual(before, await tx.trReport.findMany({ where: { id: { in: ids } }, orderBy: { idempotencyKey: 'asc' } })), 'Fixtures changed during preparation');
      requireSafe(isDeepStrictEqual(priorAudits, await tx.trAuditLog.findMany({ where: { targetId: { in: ids } }, orderBy: { id: 'asc' } })), 'Audit provenance changed');
      requireSafe(await tx.trAttachment.count({ where: { reportId: { in: ids } } }) === 0 && await tx.trReportUpdate.count({ where: { reportId: { in: ids } } }) === 0 && await tx.trReportProgress.count({ where: { reportId: { in: ids } } }) === 0, 'Fixture relations changed');
      for (const { report, photo, objectKey, originalKey, stagingKey, index } of prepared) {
        const copy = scenarioCopy(index);
        const attachment = await tx.trAttachment.create({ data: { objectKey, stagingKey, filename: 'illustrative-scenario.webp', contentType: 'image/webp', detectedType: 'image/webp', digest: photo.provenance.processed.sha256, size: photo.processed.length, uploaderId: report.reporterId, reportId: report.id, state: 'ATTACHED', expiresAt: new Date(Date.now() + 3600000) } });
        const payload = { ...samplePayloads()[index]!.payload, observedAt: report.observedAt.toISOString(), locationDescription: copy.locationDescription, description: copy.description, attachmentIds: [attachment.id] };
        const payloadHash = fingerprint({ ...payload, observationTypes: [...payload.observationTypes].sort(), attachmentIds: [...payload.attachmentIds].sort() });
        await tx.trReport.update({ where: { id: report.id }, data: { locationDescription: copy.locationDescription, description: copy.description, payloadHash } });
        const historyIds = [];
        for (const [step, message] of copy.history.entries()) {
          const update = await tx.trReportUpdate.create({ data: { reportId: report.id, authorId: report.reporterId, authorRole: 'USER', kind: 'CLARIFICATION', message, publicToReporter: true, createdAt: new Date(report.createdAt.getTime() + step * 60000) } });
          historyIds.push(update.id);
        }
        await tx.trAuditLog.create({ data: { systemActor: scenarioActor, action: 'SAMPLE_REPORT_ENRICHED', targetType: 'REPORT', targetId: report.id, reason: 'Illustrative scenario; no real observation or government confirmation.', details: { version: 2, synthetic: true, governmentConfirmation: false, idempotencyKey: report.idempotencyKey, previousPayloadHash: report.payloadHash, payloadHash, originalReport: { ...report, observedAt: report.observedAt.toISOString(), createdAt: report.createdAt.toISOString() }, attachmentId: attachment.id, historyIds, originalKey, objectKey, photo: photo.provenance } as Prisma.InputJsonValue } });
      }
      requireSafe(isDeepStrictEqual(users, await tx.msUser.findMany({ where: { id: { in: users.map(user => user.id) } }, select: { id: true, name: true, role: true, active: true, canConfirmIncidents: true, canPublishInformation: true }, orderBy: { id: 'asc' } })), 'User preservation failed');
      requireSafe(isDeepStrictEqual(preservedReports, await tx.trReport.findMany({ where: { id: { notIn: ids } }, orderBy: { id: 'asc' }, take: 10001 })), 'Other report preservation failed');
      requireSafe(isDeepStrictEqual(preservedCases, await tx.trCase.findMany({ orderBy: { id: 'asc' }, take: 10001 })), 'Case preservation failed');
      requireSafe(await tx.trAttachment.count({ where: { reportId: { in: ids }, state: 'ATTACHED' } }) === 10 && await tx.trReportUpdate.count({ where: { reportId: { in: ids } } }) === 20, 'Attachment/history count mismatch');
      return { enrichedReports: 10, imagesAttached: 10, privateObjects: 20, distinctSourcePhotos: photos.length, historyUpdates: 20, progressEntries: 0, polygonsCreated: 0, reportsDeleted: 0, usersUnchanged: true, existingCasesPreserved: preservedCases.length, originalAuditsPreserved: priorAudits.length, firmsWrites: 0 };
    }, { isolationLevel: 'Serializable', timeout: 60000, maxWait: 10000 });
    committed = true;
    return result;
  } catch (error) {
    const linked = await client.trAttachment.count({ where: { objectKey: { in: uploaded } } }).catch(() => null);
    if (!committed && linked === 0) {
      for (const key of uploaded) await storage().send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }), { abortSignal: AbortSignal.timeout(15000) });
    }
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await enrichSamples(sampleFlags(process.argv.slice(2))))); }
  catch (error) { console.error(JSON.stringify({ failed: true, errorType: error instanceof Error ? error.name : 'Unknown', message: 'Image fixture enrichment stopped. No credentials logged; existing fixtures are never deleted.' })); process.exitCode = 1; }
  finally { await disconnect(); storage().destroy(); }
}
