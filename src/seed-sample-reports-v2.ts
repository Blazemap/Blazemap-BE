import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import sharp from 'sharp';
import type { Prisma, PrismaClient } from './generated/prisma/client.js';
import { db, disconnect } from './config/db.js';
import { env } from './config/env.js';
import { storage } from './config/storage.js';
import { roleMap } from './modules/public/public.service.js';
import { listInformation } from './modules/admin/information.service.js';
import { triageReports } from './modules/reports/triage.js';
import { inspectImage } from './modules/uploads/uploads.service.js';
import { reportSchema } from './types/index.js';
import { areaHectares, polygonSchema, publicPerimeter } from './utils/geometry.js';
import { fingerprint, jsonValue } from './utils/index.js';
import { testIdentities } from './seed-test-accounts.js';

export const sampleReportV2Provenance = 'sample-report-v2';
export const sampleReportV2Notice = 'Illustrative scenario; not verified real incident.';
export const sampleReportV2Prefix = 'sample-v2-report-';
const priorPrefix = 'sample-report-v1-';
const priorReportActor = 'sample-report-seeder';
const priorImageActor = 'sample-report-image-seeder-v2';
const replacementTarget = 'sample-report-v2-batch';
const replacementAction = 'SAMPLE_REPORT_BATCH_REPLACED';
const allowedSourceHosts = new Set(['commons.wikimedia.org', 'upload.wikimedia.org', 'thumb.wikimedia.org']);

export const photoSources = [
  { pageId: 15854791, author: 'U.S. Forest Service', title: 'Tumblebug Complex Fire smoke' },
  { pageId: 18058491, author: 'Superior National Forest', title: 'Pagami Creek smoke plume' },
  { pageId: 24922320, author: 'Karen Murphy / U.S. Fish and Wildlife Service', title: 'Black Forest fire smoke rising to sky' },
  { pageId: 24922651, author: 'U.S. Fish and Wildlife Service', title: 'Forest fire with smoke near a lake' },
  { pageId: 24922654, author: 'U.S. Fish and Wildlife Service', title: 'Smoke rising from a forest fire' },
  { pageId: 24922658, author: 'U.S. Fish and Wildlife Service', title: 'White and gray smoke rising from a forest fire' },
  { pageId: 37517084, author: 'U.S. Department of Agriculture', title: 'Little Queens Fire, Boise National Forest' },
  { pageId: 93957393, author: 'U.S. Forest Service', title: 'East Fork fire in Ashley National Forest' },
  { pageId: 150875795, author: 'Bureau of Land Management', title: 'Durkee Fire smoke seen from Bald Mountain' },
  { pageId: 158885883, author: 'U.S. Forest Service Region 5', title: 'Hughes Fire response' },
] as const;

const sites = [
  { place: 'Kubu Raya', latitude: -0.32, longitude: 109.48, types: ['SMOKE'] as const, location: 'Canal-side scrub near Kubu Raya, Kalimantan.', description: 'A narrow smoke column is visible above low vegetation beside a drainage canal.', status: 'NEW' as const, progress: [] },
  { place: 'Ketapang', latitude: -1.82, longitude: 110.18, types: ['FLAME'] as const, location: 'Dry roadside vegetation near Ketapang, Kalimantan.', description: 'Small flames are visible along dry vegetation beside an unpaved access track.', status: 'NEW' as const, progress: [] },
  { place: 'Sintang', latitude: 0.12, longitude: 111.48, types: ['BURNING_SMELL'] as const, location: 'Plantation access road near Sintang, Kalimantan.', description: 'A persistent burning smell is noticeable along the access road, without a visible source.', status: 'NEW' as const, progress: [] },
  { place: 'Pulang Pisau', latitude: -2.78, longitude: 114.08, types: ['SMOKE'] as const, location: 'Low vegetation near a canal in Pulang Pisau, Kalimantan.', description: 'Light smoke is drifting across low vegetation near the canal edge.', status: 'UNDER_REVIEW' as const, progress: ['UNDER_REVIEW'] },
  { place: 'Banjar', latitude: -3.28, longitude: 115.08, types: ['SMOKE'] as const, location: 'Roadside scrub near Banjar, Kalimantan.', description: 'A compact smoke plume is rising above roadside scrub.', status: 'UNDER_REVIEW' as const, progress: ['UNDER_REVIEW', 'NEEDS_DETAILS', 'UNDER_REVIEW'] },
  { place: 'Paser', latitude: -1.72, longitude: 116.08, types: ['FLAME'] as const, location: 'Cleared vegetation near Paser, Kalimantan.', description: 'Flames are visible at the edge of a cleared patch away from structures.', status: 'UNDER_REVIEW' as const, progress: ['UNDER_REVIEW'] },
  { place: 'Kutai Kartanegara', latitude: -0.32, longitude: 116.78, types: ['BURNING_SMELL'] as const, location: 'Rural access track in Kutai Kartanegara, Kalimantan.', description: 'A burning smell is noticeable along the rural track without visible flames.', status: 'REVIEWED' as const, progress: ['UNDER_REVIEW', 'REVIEWED'] },
  { place: 'Katingan', latitude: -1.82, longitude: 113.28, types: ['SMOKE', 'FLAME'] as const, location: 'Riverbank vegetation near Katingan, Kalimantan.', description: 'Smoke and small flames are visible across a patch of dry riverbank vegetation.', status: 'REVIEWED' as const, progress: ['UNDER_REVIEW', 'REVIEWED', 'CONFIRMED_FIRE', 'CLOSED'], caseIndex: 0 },
  { place: 'Bulungan', latitude: 2.62, longitude: 117.18, types: ['SMOKE'] as const, location: 'Dry vegetation near Bulungan, Kalimantan.', description: 'Diffuse haze is visible above dry vegetation from the nearby access path.', status: 'DECLINED' as const, progress: ['UNDER_REVIEW', 'DECLINED'] },
  { place: 'Kapuas', latitude: -2.62, longitude: 114.32, types: ['SMOKE', 'FLAME'] as const, location: 'Canal-side grassland near Kapuas, Kalimantan.', description: 'Smoke and scattered flames are visible in dry grass near the canal.', status: 'REVIEWED' as const, progress: ['UNDER_REVIEW', 'REVIEWED', 'CONFIRMED_FIRE', 'MONITORING'], caseIndex: 1 },
] as const;

const owners = [0, 0, 1, 1, 2, 2, 3, 3, 4, 5] as const;
const caseDefinitions = [
  {
    id: 'sample-v2-case-01',
    number: 'C-20000000-0000-4000-8000-000000000001',
    reportIndex: 7,
    title: 'Katingan Fire Response Exercise',
    handlingStatus: 'CLOSED' as const,
    priority: 'MEDIUM' as const,
    perimeter: { type: 'Polygon' as const, coordinates: [[[113.268, -1.812], [113.284, -1.808], [113.291, -1.817], [113.282, -1.821], [113.288, -1.832], [113.271, -1.835], [113.264, -1.824], [113.268, -1.812]]] },
  },
  {
    id: 'sample-v2-case-02',
    number: 'C-20000000-0000-4000-8000-000000000002',
    reportIndex: 9,
    title: 'Kapuas Fire Response Exercise',
    handlingStatus: 'MONITORING' as const,
    priority: 'LOW' as const,
    perimeter: { type: 'Polygon' as const, coordinates: [[[114.305, -2.612], [114.323, -2.607], [114.336, -2.618], [114.326, -2.625], [114.333, -2.638], [114.314, -2.641], [114.302, -2.629], [114.305, -2.612]]] },
  },
] as const;

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function requireSafe(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const uuid = (index: number) => `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const reportId = (index: number) => `sample-v2-report-record-${String(index + 1).padStart(2, '0')}`;
const attachmentId = (index: number) => `sample-v2-attachment-${String(index + 1).padStart(2, '0')}`;
const fieldId = (index: number) => `sample-v2-field-${String(index + 1).padStart(2, '0')}`;
const verificationId = (index: number) => `sample-v2-verification-${String(index + 1).padStart(2, '0')}`;
const publicationId = (index: number) => `sample-v2-publication-${String(index + 1).padStart(2, '0')}`;
const progressId = (reportIndex: number, step: number) => `sample-v2-progress-${String(reportIndex + 1).padStart(2, '0')}-${String(step + 1).padStart(2, '0')}`;
const progressKey = (reportIndex: number, step: number) => `sample-v2-progress-key-${String(reportIndex + 1).padStart(2, '0')}-${String(step + 1).padStart(2, '0')}`;
const iso = (value: Date) => value.toISOString();

export function trustedPhotoUrl(value: string) {
  const url = new URL(value);
  requireSafe(url.protocol === 'https:' && allowedSourceHosts.has(url.hostname) && !url.username && !url.password, 'Untrusted photo URL');
  return url;
}

export function sampleReportV2Flags(args: string[]) {
  const { values } = parseArgs({ args, options: { apply: { type: 'boolean', default: false }, 'replace-sample-reports': { type: 'boolean', default: false } }, allowPositionals: false });
  if (!!values.apply !== !!values['replace-sample-reports']) throw new Error('Apply requires both write flags');
  return !!values.apply;
}

function progressDescription(stage: string) {
  const descriptions: Record<string, string> = {
    UNDER_REVIEW: 'The submitted details and reference image are being reviewed.',
    NEEDS_DETAILS: 'Additional location context is requested before review continues.',
    REVIEWED: 'The submitted information has completed its initial review.',
    DECLINED: 'The scenario was closed without creating a confirmed incident.',
    CONFIRMED_FIRE: 'The exercise boundary was recorded for workflow validation.',
    MONITORING: 'The exercise area remains in the monitoring stage.',
    CLOSED: 'The exercise response workflow is complete.',
  };
  return `${descriptions[stage] ?? 'The report workflow was updated.'} ${sampleReportV2Notice}`;
}

export function sampleReportV2Plan(now = new Date()) {
  const citizens = testIdentities.filter(identity => identity.role === 'USER');
  const reports = sites.map((site, index) => {
    const observedAt = new Date(now.getTime() - (20 + index * 17) * 60000);
    const createdAt = new Date(observedAt.getTime() + 60000);
    const key = `${sampleReportV2Prefix}${String(index + 1).padStart(2, '0')}`;
    const attachment = attachmentId(index);
    const payload = reportSchema.parse({
      observationTypes: [...site.types],
      observedAt: iso(observedAt),
      locationMode: 'INCIDENT_ESTIMATE',
      latitude: site.latitude,
      longitude: site.longitude,
      accuracyMeters: null,
      regionId: null,
      locationDescription: site.location,
      description: `${site.description} Reference photograph is not evidence from this location. ${sampleReportV2Notice}`,
      attachmentIds: [attachment],
      idempotencyKey: key,
    });
    return {
      id: reportId(index),
      number: `R-${uuid(index + 1)}`,
      email: citizens[owners[index]!]!.email,
      place: site.place,
      reviewStatus: site.status,
      caseId: 'caseIndex' in site ? caseDefinitions[site.caseIndex].id : null,
      createdAt,
      payload,
      payloadHash: fingerprint({ ...payload, observationTypes: [...payload.observationTypes].sort(), attachmentIds: [...payload.attachmentIds].sort() }),
      progress: site.progress.map((stage, step) => ({ id: progressId(index, step), idempotencyKey: progressKey(index, step), stage, description: progressDescription(stage), createdAt: new Date(createdAt.getTime() + (step + 1) * 60000) })),
      source: photoSources[index]!,
      attachmentId: attachment,
    };
  });
  const cases = caseDefinitions.map((definition, index) => {
    const report = reports[definition.reportIndex]!;
    const observedAt = new Date(report.createdAt.getTime() + 180000);
    const closedAt = definition.handlingStatus === 'CLOSED' ? new Date(now.getTime() - 180000) : null;
    const publication = {
      id: publicationId(index),
      slug: index === 0 ? 'katingan-fire-response-exercise-2026' : 'kapuas-fire-response-exercise-2026',
      title: definition.title,
      summary: `${sampleReportV2Notice} This exercise record demonstrates a reviewed response perimeter and status history.`,
      body: `This training fixture demonstrates how a reviewed citizen report, mapped perimeter, and response status appear in the public experience. The attached report image is a public-domain reference and is not evidence from the mapped location.\n\n${sampleReportV2Notice}`,
      type: 'UPDATE' as const,
      outcome: index === 0 ? 'CONFIRMED' as const : null,
      publishedAt: new Date(now.getTime() - (index + 1) * 60000),
    };
    return {
      ...definition,
      perimeter: polygonSchema.parse(definition.perimeter),
      latitude: report.payload.latitude!,
      longitude: report.payload.longitude!,
      observedAt,
      openedAt: new Date(report.createdAt.getTime() + 120000),
      closedAt,
      closureReason: closedAt ? `Exercise workflow completed. ${sampleReportV2Notice}` : null,
      fieldId: fieldId(index),
      verificationId: verificationId(index),
      publication,
    };
  });
  for (const item of cases) polygonSchema.parse(item.perimeter);
  return { now, reports, cases };
}

type PreparedPhoto = {
  bytes: Buffer;
  objectKey: string;
  stagingKey: string;
  digest: string;
  provenance: {
    pageId: number;
    title: string;
    author: string;
    sourcePage: string;
    originalUrl: string;
    cachedInputUrl: string;
    metadataUrl: string;
    license: string;
    retrievedAt: string;
    input: { digest: string; size: number; width: number; height: number };
    processed: { digest: string; size: number; width: number; height: number };
  };
};

async function boundedBytes(url: URL) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error', headers: { 'User-Agent': 'Blazemap-Illustrative-Fixtures/3.0' } });
  requireSafe(response.ok && response.body, 'Photo download failed');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    requireSafe(size <= 8 * 1024 * 1024, 'Photo exceeded download bound');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function preparePhoto(source: typeof photoSources[number], report: ReturnType<typeof sampleReportV2Plan>['reports'][number]) {
  const metadataUrl = new URL('https://commons.wikimedia.org/w/api.php');
  metadataUrl.searchParams.set('action', 'query');
  metadataUrl.searchParams.set('pageids', String(source.pageId));
  metadataUrl.searchParams.set('prop', 'imageinfo');
  metadataUrl.searchParams.set('iiprop', 'url|mime|size|extmetadata');
  metadataUrl.searchParams.set('iiurlwidth', '1600');
  metadataUrl.searchParams.set('format', 'json');
  const response = await fetch(metadataUrl, { signal: AbortSignal.timeout(30000), redirect: 'error', headers: { 'User-Agent': 'Blazemap-Illustrative-Fixtures/3.0' } });
  requireSafe(response.ok, 'Commons metadata unavailable');
  const body = await response.json() as { query?: { pages?: Record<string, { imageinfo?: { url: string; descriptionurl: string; thumburl?: string; mime: string; width: number; height: number; thumbwidth?: number; thumbheight?: number; extmetadata: Record<string, { value: string }> }[] }> } };
  const info = body.query?.pages?.[source.pageId]?.imageinfo?.[0];
  requireSafe(info && info.mime === 'image/jpeg' && info.extmetadata.LicenseShortName?.value === 'Public domain' && info.extmetadata.Copyrighted?.value === 'False' && !info.extmetadata.Restrictions?.value && info.thumburl, 'Public-domain source verification failed');
  const inputUrl = trustedPhotoUrl(info.thumburl);
  const input = await boundedBytes(inputUrl);
  await inspectImage(input, 'image/jpeg', input.length);
  const inputMetadata = await sharp(input).metadata();
  const resized = await sharp(input, { limitInputPixels: 20000000, failOn: 'warning' }).rotate().resize(1200, 900, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 86 }).toBuffer();
  const dimensions = await sharp(resized).metadata();
  requireSafe(dimensions.width && dimensions.height, 'Processed image dimensions unavailable');
  const footerHeight = 52;
  const footer = Buffer.from(`<svg width="${dimensions.width}" height="${footerHeight}"><rect width="100%" height="100%" fill="#152018"/><text x="18" y="34" font-family="sans-serif" font-size="${Math.min(21, Math.floor((dimensions.width - 36) / 26))}" fill="white">Illustrative scenario; not verified real incident.</text></svg>`);
  const bytes = await sharp(resized).composite([{ input: footer, gravity: 'south' }]).webp({ quality: 86 }).toBuffer();
  await inspectImage(bytes, 'image/webp', bytes.length);
  const digest = hash(bytes);
  const objectKey = `illustrative/sample-report-v2/${report.id}/${digest.slice(0, 24)}.webp`;
  return {
    bytes,
    objectKey,
    stagingKey: `${objectKey}.unused`,
    digest,
    provenance: {
      pageId: source.pageId,
      title: source.title,
      author: source.author,
      sourcePage: trustedPhotoUrl(info.descriptionurl).href,
      originalUrl: trustedPhotoUrl(info.url).href,
      cachedInputUrl: inputUrl.href,
      metadataUrl: metadataUrl.href,
      license: 'Public domain',
      retrievedAt: new Date().toISOString(),
      input: { digest: hash(input), size: input.length, width: inputMetadata.width!, height: inputMetadata.height! },
      processed: { digest, size: bytes.length, width: dimensions.width, height: dimensions.height },
    },
  } satisfies PreparedPhoto;
}

async function verifyPrivateObject(item: Pick<PreparedPhoto, 'bytes' | 'objectKey' | 'digest'>) {
  const s3 = storage();
  const head = await s3.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: item.objectKey }), { abortSignal: AbortSignal.timeout(15000) });
  requireSafe(head.ContentLength === item.bytes.length && head.ContentType?.split(';')[0] === 'image/webp' && head.Metadata?.sha256 === item.digest, 'Stored image metadata mismatch');
  const signed = await getSignedUrl(s3, new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: item.objectKey }), { expiresIn: 60 });
  const privateUrl = new URL(signed);
  privateUrl.search = '';
  const anonymous = await fetch(privateUrl, { signal: AbortSignal.timeout(15000), redirect: 'manual' });
  await anonymous.body?.cancel();
  requireSafe([401, 403].includes(anonymous.status), 'Stored image is not private');
  const download = await fetch(signed, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  requireSafe(download.ok && hash(Buffer.from(await download.arrayBuffer())) === item.digest, 'Signed image verification failed');
}

async function uploadPhotos(plan: ReturnType<typeof sampleReportV2Plan>) {
  await storage().send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }), { abortSignal: AbortSignal.timeout(15000) });
  const prepared: PreparedPhoto[] = [];
  try {
    for (const report of plan.reports) {
      const photo = await preparePhoto(report.source, report);
      await storage().send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: photo.objectKey, Body: photo.bytes, ContentType: 'image/webp', ContentLength: photo.bytes.length, CacheControl: 'private, no-store', IfNoneMatch: '*', Metadata: { sha256: photo.digest, purpose: 'illustrative-scenario-not-evidence', source: `commons-${photo.provenance.pageId}` } }), { abortSignal: AbortSignal.timeout(15000) });
      prepared.push(photo);
      await verifyPrivateObject(photo);
    }
    return prepared;
  } catch (error) {
    for (const photo of prepared) await storage().send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: photo.objectKey }), { abortSignal: AbortSignal.timeout(15000) }).catch(() => undefined);
    throw error;
  }
}

async function fixtureUsers(client: PrismaClient | Prisma.TransactionClient) {
  const identities = testIdentities;
  const users = await client.msUser.findMany({ where: { email: { in: identities.map(identity => identity.email) } }, select: { id: true, email: true, name: true, role: true, active: true, emailVerified: true, canConfirmIncidents: true, canPublishInformation: true, accounts: { select: { accountId: true, providerId: true } } }, orderBy: { email: 'asc' }, take: 8 });
  requireSafe(users.length === 7, 'Expected seven fictional fixture accounts');
  const audits = await client.trAuditLog.findMany({ where: { systemActor: 'test-account-seeder', action: 'TEST_ACCOUNT_CREATED', targetType: 'USER', targetId: { in: users.map(user => user.id) } }, select: { targetId: true, details: true }, take: 8 });
  for (const identity of identities) {
    const user = users.find(item => item.email === identity.email);
    const proof = audits.filter(item => item.targetId === user?.id);
    requireSafe(user && user.name === identity.name && user.role === identity.role && user.active && user.emailVerified && (user.role === 'ADMIN' || !user.canConfirmIncidents && !user.canPublishInformation) && user.accounts.length === 1 && user.accounts[0]?.providerId === 'credential' && user.accounts[0]?.accountId === user.id && proof.length === 1, 'Fixture account mismatch');
    const details = proof[0]!.details as Record<string, unknown>;
    requireSafe(details.fictionalIdentity === true && details.verificationBasis === 'EXPLICIT_TEST_FIXTURE_BYPASS', 'Fixture account provenance mismatch');
  }
  return users;
}

async function protectedTables(client: PrismaClient | Prisma.TransactionClient, excluded: Record<string, string[]>) {
  const tables = await client.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY tablename`;
  requireSafe(tables.length < 100, 'Table preservation bound exceeded');
  const result: Record<string, { count: number; hash: string }> = {};
  for (const { tablename } of tables) {
    requireSafe(/^[A-Za-z0-9_]+$/.test(tablename), 'Unexpected database table name');
    const predicate = tablename === 'TrAuditLog' ? `WHERE "systemActor" IS DISTINCT FROM $1` : excluded[tablename]?.length ? `WHERE NOT (id = ANY($1::text[]))` : '';
    const args = tablename === 'TrAuditLog' ? [sampleReportV2Provenance] : excluded[tablename]?.length ? [excluded[tablename]] : [];
    const [row] = await client.$queryRawUnsafe<{ count: bigint; hash: string }[]>(`SELECT count(*) AS count, md5(COALESCE(string_agg(to_jsonb(record)::text, '' ORDER BY to_jsonb(record)::text), '')) AS hash FROM public."${tablename}" record ${predicate}`, ...args);
    requireSafe(row && row.count <= 1000000n, 'Protected table row bound exceeded');
    result[tablename] = { count: Number(row.count), hash: row.hash };
  }
  return result;
}

async function preservationSnapshot(client: PrismaClient | Prisma.TransactionClient, excludedCaseIds: string[], excluded: Record<string, string[]>) {
  const genuineReports = await client.trReport.findMany({ where: { NOT: [{ idempotencyKey: { startsWith: priorPrefix } }, { idempotencyKey: { startsWith: sampleReportV2Prefix } }] }, include: { attachments: { orderBy: { id: 'asc' } }, progress: { orderBy: { id: 'asc' } }, updates: { orderBy: { id: 'asc' } }, publications: { orderBy: { id: 'asc' } } }, orderBy: { id: 'asc' }, take: 1001 });
  const protectedCases = await client.trCase.findMany({ where: { id: { notIn: [...excludedCaseIds, ...caseDefinitions.map(item => item.id)] } }, include: { reports: { select: { id: true }, orderBy: { id: 'asc' } }, hotspots: { select: { id: true }, orderBy: { id: 'asc' } }, fieldUpdates: { select: { id: true }, orderBy: { id: 'asc' } }, verifications: { select: { id: true }, orderBy: { id: 'asc' } }, assignments: { select: { id: true }, orderBy: { id: 'asc' } }, analyses: { select: { id: true }, orderBy: { id: 'asc' } }, publications: { select: { id: true }, orderBy: { id: 'asc' } } }, orderBy: { id: 'asc' }, take: 1001 });
  requireSafe(genuineReports.length <= 1000 && protectedCases.length <= 1000, 'Preservation bound exceeded');
  const [firms] = await client.$queryRaw<{ hotspots: bigint; hotspotHash: string; runs: bigint; runHash: string }[]>`
    SELECT
      (SELECT count(*) FROM "TrHotspot") AS hotspots,
      (SELECT md5(COALESCE(string_agg(row_to_json(record)::text, '' ORDER BY record.id), '')) FROM "TrHotspot" record) AS "hotspotHash",
      (SELECT count(*) FROM "TrIntegrationRun" WHERE provider = 'FIRMS') AS runs,
      (SELECT md5(COALESCE(string_agg(row_to_json(record)::text, '' ORDER BY record.id), '')) FROM "TrIntegrationRun" record WHERE provider = 'FIRMS') AS "runHash"
  `;
  requireSafe(firms && Number(firms.hotspots) <= 1000000 && Number(firms.runs) <= 10000, 'FIRMS preservation bound exceeded');
  return {
    genuineReports: { count: genuineReports.length, hash: fingerprint(genuineReports) },
    protectedCases: { count: protectedCases.length, hash: fingerprint(protectedCases) },
    firms: { hotspots: Number(firms.hotspots), hotspotHash: firms.hotspotHash, runs: Number(firms.runs), runHash: firms.runHash },
    tables: await protectedTables(client, excluded),
  };
}

async function priorSurface(client: PrismaClient | Prisma.TransactionClient) {
  const reports = await client.trReport.findMany({ where: { idempotencyKey: { startsWith: priorPrefix } }, include: { attachments: { include: { derivatives: { select: { id: true } }, sourceAttachment: { select: { id: true } } } }, updates: true, progress: { include: { attachments: true } }, publications: true }, orderBy: { idempotencyKey: 'asc' }, take: 11 });
  requireSafe(reports.length === 10 && reports.every((report, index) => report.idempotencyKey === `${priorPrefix}${String(index + 1).padStart(2, '0')}`), 'Expected exact v1 sample report set');
  const users = await fixtureUsers(client);
  const fixtureUserIds = new Set(users.map(user => user.id));
  const reportIds = reports.map(report => report.id);
  const reportAudits = await client.trAuditLog.findMany({ where: { targetType: 'REPORT', targetId: { in: reportIds } }, orderBy: { id: 'asc' }, take: 101 });
  requireSafe(reportAudits.length <= 100, 'Prior report audit bound exceeded');
  const oldObjectKeys = new Set<string>();
  for (const report of reports) {
    const created = reportAudits.filter(audit => audit.targetId === report.id && audit.systemActor === priorReportActor && audit.action === 'SAMPLE_REPORT_CREATED');
    const enriched = reportAudits.filter(audit => audit.targetId === report.id && audit.systemActor === priorImageActor && audit.action === 'SAMPLE_REPORT_ENRICHED');
    requireSafe(created.length === 1 && enriched.length === 1 && fixtureUserIds.has(report.reporterId) && ['NEW', 'UNDER_REVIEW'].includes(report.reviewStatus), 'Prior report provenance mismatch');
    requireSafe(report.attachments.length === 1 && !report.attachments[0]!.derivatives.length && !report.attachments[0]!.sourceAttachment && report.attachments[0]!.reportId === report.id && report.attachments[0]!.objectKey.startsWith('illustrative/sample-report-v2/'), 'Prior attachment graph mismatch');
    requireSafe(report.updates.length === 2 && report.updates.every(update => update.authorId === report.reporterId && update.message.startsWith('Illustrative scenario')), 'Prior history mismatch');
    requireSafe(!report.publications.length && report.progress.every(progress => fixtureUserIds.has(progress.actorId) && !progress.attachments.length), 'Prior report has unsupported dependents');
    const creation = created[0]!.details as Record<string, unknown>;
    const details = enriched[0]!.details as Record<string, unknown>;
    const original = details.originalReport as Record<string, unknown>;
    const photo = details.photo as { processed: { sha256: string; size: number }; original: { sha256: string }; license: string };
    const restored = reportAudits.filter(audit => audit.targetId === report.id && audit.systemActor === priorImageActor && audit.action === 'SAMPLE_TRIAGE_MARKER_RESTORED');
    const restoration = restored[0]?.details as Record<string, unknown> | undefined;
    requireSafe(creation.synthetic === true && creation.fictionalIdentity === true && creation.idempotencyKey === report.idempotencyKey && details.synthetic === true && original.reporterId === report.reporterId && original.number === report.number && original.latitude === report.latitude && original.longitude === report.longitude && original.observedAt === report.observedAt.toISOString() && original.createdAt === report.createdAt.toISOString(), 'Prior immutable report fields changed');
    requireSafe(restored.length === 1 && restoration?.synthetic === true && restoration.previousPayloadHash === details.payloadHash && restoration.payloadHash === report.payloadHash && photo.license === 'Public domain' && photo.processed.sha256 === report.attachments[0]!.digest && photo.processed.size === report.attachments[0]!.size && report.attachments[0]!.uploaderId === report.reporterId, 'Prior image or restored payload changed');
    const priorPayload = reportSchema.parse({ observationTypes: report.observationTypes, observedAt: report.observedAt.toISOString(), locationMode: report.locationMode, latitude: report.latitude, longitude: report.longitude, accuracyMeters: report.accuracyMeters, regionId: report.regionId, locationDescription: report.locationDescription, description: report.description, attachmentIds: [report.attachments[0]!.id], idempotencyKey: report.idempotencyKey });
    requireSafe(fingerprint({ ...priorPayload, observationTypes: [...priorPayload.observationTypes].sort(), attachmentIds: [...priorPayload.attachmentIds].sort() }) === report.payloadHash && isDeepStrictEqual([...report.updates.map(update => update.id)].sort(), [...details.historyIds as string[]].sort()), 'Prior content no longer matches provenance');
    requireSafe(report.progress.length <= 1 && report.progress.every(progress => progress.stage === 'UNDER_REVIEW' && reportAudits.some(audit => audit.targetId === report.id && audit.action === 'REPORT_REVIEW_STARTED' && audit.actorId === progress.actorId && audit.reason === progress.description)), 'Prior progress lacks bounded audit provenance');
    requireSafe(details.attachmentId === report.attachments[0]!.id && details.objectKey === report.attachments[0]!.objectKey && typeof details.originalKey === 'string' && details.originalKey.startsWith('illustrative/sample-report-v2/'), 'Prior image provenance mismatch');
    oldObjectKeys.add(details.objectKey as string);
    oldObjectKeys.add(details.originalKey as string);
  }
  const notifications = await client.trNotification.findMany({ where: { reportId: { in: reportIds } }, select: { id: true }, take: 2 });
  requireSafe(!notifications.length, 'Prior reports have notifications that require manual review');
  const caseIds = [...new Set(reports.flatMap(report => report.caseId ? [report.caseId] : []))];
  const cases = await client.trCase.findMany({ where: { id: { in: caseIds } }, include: { reports: { select: { id: true, number: true } }, hotspots: { select: { id: true } }, fieldUpdates: { select: { id: true } }, verifications: { select: { id: true } }, assignments: { select: { id: true } }, analyses: { select: { id: true } }, publications: { select: { id: true } } }, orderBy: { id: 'asc' } });
  requireSafe(cases.length === caseIds.length, 'Prior linked case missing');
  for (const item of cases) {
    requireSafe(item.reports.length > 0 && item.reports.every(report => reportIds.includes(report.id)) && item.title === `Reported observation ${item.reports[0]!.number}` && item.verificationStatus === 'UNVERIFIED' && item.perimeter === null && item.latestAnalysisId === null && !item.hotspots.length && !item.fieldUpdates.length && !item.verifications.length && !item.assignments.length && !item.analyses.length && !item.publications.length, 'Prior linked case is not isolated to sample reports');
    const audits = await client.trAuditLog.findMany({ where: { targetType: 'CASE', targetId: item.id }, select: { action: true, details: true }, take: 11 });
    requireSafe(audits.length <= 10 && audits.every(audit => ['CASE_CREATED', 'REPORT_LINKED', 'REPORT_REVIEW_STARTED'].includes(audit.action) && (!audit.details || reportIds.some(id => JSON.stringify(audit.details).includes(id)))), 'Prior linked case audit mismatch');
  }
  return { reports, reportIds, cases, caseIds, oldObjectKeys: [...oldObjectKeys].sort(), reportAudits };
}

function expectedWorkflow(plan: ReturnType<typeof sampleReportV2Plan>) {
  return {
    new: plan.reports.filter(report => report.reviewStatus === 'NEW').length,
    underReview: plan.reports.filter(report => report.reviewStatus === 'UNDER_REVIEW').length,
    reviewed: plan.reports.filter(report => report.reviewStatus === 'REVIEWED' && !report.caseId).length,
    declined: plan.reports.filter(report => report.reviewStatus === 'DECLINED').length,
    confirmed: plan.reports.filter(report => report.caseId).length,
  };
}

async function verifyDatabaseV2(client: PrismaClient | Prisma.TransactionClient, plan: ReturnType<typeof sampleReportV2Plan>) {
  const reports = await client.trReport.findMany({ where: { idempotencyKey: { startsWith: sampleReportV2Prefix } }, include: { attachments: true, progress: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }, updates: true }, orderBy: { idempotencyKey: 'asc' }, take: 11 });
  requireSafe(reports.length === 10, 'Expected ten v2 reports');
  const sourceIds = new Set<number>();
  for (const [index, expected] of plan.reports.entries()) {
    const report = reports[index]!;
    requireSafe(report.id === expected.id && report.number === expected.number && report.idempotencyKey === expected.payload.idempotencyKey && report.reviewStatus === expected.reviewStatus && report.caseId === expected.caseId && report.payloadHash === expected.payloadHash && report.description === expected.payload.description && report.locationDescription === expected.payload.locationDescription && report.attachments.length === 1 && report.attachments[0]!.id === expected.attachmentId && report.attachments[0]!.state === 'ATTACHED' && report.progress.length === expected.progress.length && !report.updates.length, 'V2 report mismatch');
    for (const [step, progress] of expected.progress.entries()) {
      const actual = report.progress[step]!;
      requireSafe(actual.id === progress.id && actual.idempotencyKey === progress.idempotencyKey && actual.stage === progress.stage && actual.description === progress.description, 'V2 progress mismatch');
    }
    const auditRows = await client.trAuditLog.findMany({ where: { systemActor: sampleReportV2Provenance, action: 'SAMPLE_REPORT_CREATED', targetType: 'REPORT', targetId: report.id }, select: { details: true }, take: 2 });
    requireSafe(auditRows.length === 1, 'V2 report audit mismatch');
    const details = auditRows[0]!.details as Record<string, unknown>;
    const photo = details.photo as Record<string, unknown>;
    requireSafe(details.isSynthetic === true && details.notice === sampleReportV2Notice && photo.license === 'Public domain' && typeof photo.pageId === 'number', 'V2 report provenance mismatch');
    sourceIds.add(photo.pageId as number);
  }
  requireSafe(sourceIds.size === 10, 'Expected ten distinct image sources');
  const cases = await client.trCase.findMany({ where: { id: { in: plan.cases.map(item => item.id) } }, include: { reports: { select: { id: true } }, fieldUpdates: true, verifications: true, publications: true }, orderBy: { id: 'asc' } });
  requireSafe(cases.length === 2, 'Expected two v2 cases');
  for (const expected of plan.cases) {
    const item = cases.find(value => value.id === expected.id)!;
    requireSafe(item.number === expected.number && item.title === expected.title && item.verificationStatus === 'CONFIRMED_FIRE' && item.handlingStatus === expected.handlingStatus && item.perimeterRevision === 1 && polygonSchema.safeParse(item.perimeter).success && isDeepStrictEqual(item.perimeter, expected.perimeter) && item.reports.length === 1 && item.fieldUpdates.length === 1 && item.verifications.length === 1 && item.publications.length === 1, 'V2 case mismatch');
    const publication = item.publications[0]!;
    requireSafe(publication.status === 'PUBLISHED' && publication.publicLocationMode === 'APPROVED_INCIDENT_PERIMETER' && publication.privacyReview?.includes(sampleReportV2Notice) && publicPerimeter(publication).publicPerimeter, 'V2 public perimeter mismatch');
  }
  const triage = await triageReports(reports, client as PrismaClient);
  for (const report of reports) {
    const value = triage.get(report.id)!;
    requireSafe(value.level === 'UNKNOWN' && value.reasonCodes.includes('SAMPLE_EXCLUDED') && !value.satelliteMatch && !value.settlementMatch, 'V2 triage exclusion failed');
  }
  return { reports, cases, workflow: expectedWorkflow(plan), progressEntries: reports.reduce((sum, report) => sum + report.progress.length, 0) };
}

async function verifyObjectsFromDatabase(client: PrismaClient, rows: Awaited<ReturnType<typeof verifyDatabaseV2>>['reports']) {
  for (const row of rows) {
    const attachment = row.attachments[0]!;
    const head = await storage().send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: attachment.objectKey }), { abortSignal: AbortSignal.timeout(15000) });
    requireSafe(head.ContentLength === attachment.size && head.ContentType?.split(';')[0] === attachment.contentType && head.Metadata?.sha256 === attachment.digest, 'Existing v2 image metadata mismatch');
    const signed = await getSignedUrl(storage(), new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: attachment.objectKey }), { expiresIn: 60 });
    const response = await fetch(signed, { signal: AbortSignal.timeout(15000), redirect: 'error' });
    requireSafe(response.ok && hash(Buffer.from(await response.arrayBuffer())) === attachment.digest, 'Existing v2 signed image mismatch');
  }
}

async function verifyPublicV2(client: PrismaClient, plan: ReturnType<typeof sampleReportV2Plan>, citizen: { id: string; role: 'USER'; active: boolean; emailVerified: boolean; canConfirmIncidents: boolean; canPublishInformation: boolean }) {
  const map = await roleMap(citizen, { from: iso(new Date(plan.now.getTime() - 172800000)), to: iso(plan.now) }, client, false);
  const publicIds = new Set(map.cases.map(item => item.id));
  requireSafe(plan.cases.every(item => publicIds.has(item.id)), 'Citizen map is missing an illustrative perimeter');
  const news = await listInformation({ news: 'true', pageSize: '100' }, false, client);
  const closed = plan.cases.find(item => item.handlingStatus === 'CLOSED')!;
  requireSafe(news.data.some(item => item.id === closed.publication.id && item.title === 'Katingan Fire Response Exercise' && item.summary.includes(sampleReportV2Notice)), 'Illustrative closed exercise is missing from News');
  return { citizenVisiblePerimeters: plan.cases.length, newsItems: 1 };
}

async function objectMissing(key: string) {
  try {
    await storage().send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }), { abortSignal: AbortSignal.timeout(15000) });
    return false;
  } catch (error) {
    const status = error && typeof error === 'object' && '$metadata' in error ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode : undefined;
    return status === 404 || error instanceof Error && ['NotFound', 'NoSuchKey'].includes(error.name);
  }
}

async function deleteOldObjects(keys: string[]) {
  let deleted = 0;
  for (const key of keys) {
    requireSafe(/^illustrative\/sample-report-v2\/[^/]+\/[0-9a-f-]+\/(original\.jpg|reference\.webp)$/.test(key), 'Old object cleanup key outside allowed scope');
    if (await objectMissing(key)) continue;
    await storage().send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }), { abortSignal: AbortSignal.timeout(15000) });
    deleted++;
  }
  const remaining = [];
  for (const key of keys) if (!await objectMissing(key)) remaining.push(key);
  requireSafe(!remaining.length, 'Old object cleanup verification failed');
  return deleted;
}

function batchDetails(value: unknown) {
  requireSafe(value && typeof value === 'object' && !Array.isArray(value), 'Replacement batch provenance missing');
  const details = value as Record<string, unknown>;
  requireSafe(typeof details.baseTime === 'string' && Array.isArray(details.oldObjectKeys) && details.oldObjectKeys.every(item => typeof item === 'string'), 'Replacement batch provenance invalid');
  return { baseTime: new Date(details.baseTime), oldObjectKeys: details.oldObjectKeys as string[] };
}

export async function seedSampleReportsV2(client: PrismaClient, apply = false, requestedNow = new Date()) {
  const batch = await client.trAuditLog.findFirst({ where: { systemActor: sampleReportV2Provenance, action: replacementAction, targetType: 'SEED_BATCH', targetId: replacementTarget }, select: { details: true }, orderBy: { createdAt: 'desc' } });
  const existingV2 = await client.trReport.count({ where: { idempotencyKey: { startsWith: sampleReportV2Prefix } } });
  if (existingV2 || batch) {
    requireSafe(existingV2 === 10 && batch, 'Partial v2 replacement detected');
    const details = batchDetails(batch.details);
    const plan = sampleReportV2Plan(details.baseTime);
    const verified = await verifyDatabaseV2(client, plan);
    await verifyObjectsFromDatabase(client, verified.reports);
    const users = await fixtureUsers(client);
    const citizen = users.find(user => user.role === 'USER')! as typeof users[number] & { role: 'USER' };
    const publicVisibility = await verifyPublicV2(client, plan, citizen);
    const oldObjectsDeleted = apply ? await deleteOldObjects(details.oldObjectKeys) : 0;
    return { mode: apply ? 'VERIFIED' : 'DRY_RUN_EXISTING', provenance: sampleReportV2Provenance, created: { reports: 0, attachments: 0, progress: 0, cases: 0, fields: 0, verifications: 0, publications: 0 }, deleted: { reports: 0, attachments: 0, progress: 0, updates: 0, cases: 0 }, existing: { reports: 10, cases: 2, publications: 2 }, objects: { signedImagesVerified: 10, oldObjectsDeleted }, workflow: verified.workflow, publicVisibility, limitations: ['Images are public-domain references, not location evidence.', 'Confirmed cases and publications are clearly labelled training exercises.', 'No operational alert or citizen notification was created.'] };
  }

  const prior = await priorSurface(client);
  const plan = sampleReportV2Plan(requestedNow);
  const excluded = {
    TrReport: [...prior.reportIds, ...plan.reports.map(item => item.id)],
    TrAttachment: [...prior.reports.flatMap(item => item.attachments.map(row => row.id)), ...plan.reports.map(item => item.attachmentId)],
    TrReportUpdate: prior.reports.flatMap(item => item.updates.map(row => row.id)),
    TrReportProgress: [...prior.reports.flatMap(item => item.progress.map(row => row.id)), ...plan.reports.flatMap(item => item.progress.map(row => row.id))],
    TrCase: [...prior.caseIds, ...plan.cases.map(item => item.id)],
    TrFieldUpdate: plan.cases.map(item => item.fieldId),
    TrVerification: plan.cases.map(item => item.verificationId),
    TrPublicInformation: plan.cases.map(item => item.publication.id),
  };
  const preservationBefore = await preservationSnapshot(client, prior.caseIds, excluded);
  if (!apply) {
    return { mode: 'DRY_RUN', provenance: sampleReportV2Provenance, planned: { reports: 10, images: 10, progress: plan.reports.reduce((sum, report) => sum + report.progress.length, 0), cases: 2, perimeters: 2, publications: 2 }, replace: { reports: prior.reports.length, attachments: prior.reports.reduce((sum, report) => sum + report.attachments.length, 0), updates: prior.reports.reduce((sum, report) => sum + report.updates.length, 0), progress: prior.reports.reduce((sum, report) => sum + report.progress.length, 0), isolatedCases: prior.cases.length, oldPrivateObjects: prior.oldObjectKeys.length }, preserved: preservationBefore, workflow: expectedWorkflow(plan), writes: 0 };
  }

  const photos = await uploadPhotos(plan);
  let committed = false;
  let transactionResult: { deleted: Record<string, number>; created: Record<string, number>; auditsCreated: number } | undefined;
  try {
    transactionResult = await client.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('sample-report-v2-replacement'))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('sample-report-seeder'))`;
      await tx.$executeRaw`SET LOCAL lock_timeout = '10s'`;
      await tx.$executeRaw`LOCK TABLE "TrReport", "TrAttachment", "TrReportUpdate", "TrReportProgress", "TrNotification", "TrCase", "TrPublicInformation", "TrFieldUpdate", "TrVerification", "TrAssignment", "TrAnalysis", "TrAuditLog" IN SHARE ROW EXCLUSIVE MODE`;
      const currentPrior = await priorSurface(tx);
      requireSafe(isDeepStrictEqual(currentPrior, prior), 'Prior fixtures changed during image preparation');
      requireSafe(await tx.trReport.count({ where: { idempotencyKey: { startsWith: sampleReportV2Prefix } } }) === 0, 'V2 report collision');
      for (const item of plan.cases) {
        requireSafe(!await tx.trCase.findFirst({ where: { OR: [{ id: item.id }, { number: item.number }] }, select: { id: true } }), 'V2 case collision');
        requireSafe(!await tx.trPublicInformation.findFirst({ where: { OR: [{ id: item.publication.id }, { slug: item.publication.slug }] }, select: { id: true } }), 'V2 publication collision');
      }
      const users = await fixtureUsers(tx);
      const admin = users.find(user => user.role === 'ADMIN')!;
      const userByEmail = new Map(users.map(user => [user.email, user]));
      for (const item of plan.cases) {
        await tx.trCase.create({ data: {
          id: item.id,
          number: item.number,
          title: item.title,
          latitude: item.latitude,
          longitude: item.longitude,
          verificationStatus: 'CONFIRMED_FIRE',
          handlingStatus: item.handlingStatus,
          priority: item.priority,
          priorityReason: `Exercise priority for interface review. ${sampleReportV2Notice}`,
          version: 2,
          contextRevision: 2,
          perimeter: jsonValue(item.perimeter),
          perimeterObservedAt: item.observedAt,
          perimeterSource: 'Training fixture',
          perimeterRevision: 1,
          openedAt: item.openedAt,
          updatedAt: item.closedAt ?? item.observedAt,
          closedAt: item.closedAt,
          closureReason: item.closureReason,
        } });
      }
      let auditsCreated = 0;
      for (const [index, item] of plan.reports.entries()) {
        const reporter = userByEmail.get(item.email)!;
        const { attachmentIds: _attachmentIds, ...fields } = item.payload;
        await tx.trReport.create({ data: { id: item.id, number: item.number, reporterId: reporter.id, ...fields, observedAt: new Date(fields.observedAt), createdAt: item.createdAt, reviewStatus: item.reviewStatus, caseId: item.caseId, payloadHash: item.payloadHash } });
        const photo = photos[index]!;
        await tx.trAttachment.create({ data: { id: item.attachmentId, objectKey: photo.objectKey, stagingKey: photo.stagingKey, filename: `${item.place.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-reference.webp`, contentType: 'image/webp', detectedType: 'image/webp', size: photo.bytes.length, digest: photo.digest, uploaderId: reporter.id, state: 'ATTACHED', expiresAt: new Date(plan.now.getTime() + 3600000), reportId: item.id } });
        for (const progress of item.progress) {
          const payloadHash = fingerprint({ reportId: item.id, stage: progress.stage, description: progress.description, attachmentIds: [] });
          await tx.trReportProgress.create({ data: { ...progress, reportId: item.id, actorId: admin.id, payloadHash } });
        }
        await tx.trAuditLog.create({ data: { systemActor: sampleReportV2Provenance, action: 'SAMPLE_REPORT_CREATED', targetType: 'REPORT', targetId: item.id, reason: sampleReportV2Notice, details: jsonValue({ version: 2, isSynthetic: true, fictionalReporter: true, governmentConfirmation: false, notice: sampleReportV2Notice, idempotencyKey: item.payload.idempotencyKey, payloadHash: item.payloadHash, attachmentId: item.attachmentId, progressIds: item.progress.map(progress => progress.id), photo: photo.provenance }) } });
        auditsCreated++;
      }
      for (const item of plan.cases) {
        await tx.trFieldUpdate.create({ data: { id: item.fieldId, caseId: item.id, recorderId: admin.id, findings: 'VISIBLE_FIRE', description: `Coordinate-backed observation created only for the training workflow. ${sampleReportV2Notice}`, source: 'Training fixture', observedAt: item.observedAt, latitude: item.latitude, longitude: item.longitude } });
        await tx.trVerification.create({ data: { id: item.verificationId, caseId: item.id, decidingAdminId: admin.id, fieldUpdateId: item.fieldId, authorityReference: 'Training fixture', outcome: 'CONFIRMED_FIRE', previousStatus: 'UNVERIFIED', newStatus: 'CONFIRMED_FIRE', reason: `Exercise verification record. ${sampleReportV2Notice}`, createdAt: new Date(item.observedAt.getTime() + 60000) } });
        const perimeter = { geometry: item.perimeter, observedAt: iso(item.observedAt), source: 'Training fixture', areaHectares: areaHectares(item.perimeter), revision: 1 };
        const snapshot = { id: item.id, number: item.number, title: item.title, verificationStatus: 'CONFIRMED_FIRE', handlingStatus: item.handlingStatus, approvedAt: iso(item.publication.publishedAt), publicPerimeter: perimeter };
        await tx.trPublicInformation.create({ data: {
          ...item.publication,
          reportId: plan.reports[item.reportIndex]!.id,
          status: 'PUBLISHED',
          sources: jsonValue([{ title: 'Public-domain reference image provenance', url: photos[item.reportIndex]!.provenance.sourcePage }]),
          caseId: item.id,
          authorId: admin.id,
          publisherId: admin.id,
          authorityReference: 'Training fixture',
          publicLocationMode: 'APPROVED_INCIDENT_PERIMETER',
          publicCaseSnapshot: jsonValue(snapshot),
          privacyReview: `No personal location or identity is published. ${sampleReportV2Notice}`,
          createdAt: item.publication.publishedAt,
          updatedAt: item.publication.publishedAt,
        } });
        await tx.trAuditLog.create({ data: { systemActor: sampleReportV2Provenance, action: 'SAMPLE_CASE_AND_PUBLICATION_CREATED', targetType: 'CASE', targetId: item.id, reason: sampleReportV2Notice, details: jsonValue({ version: 2, isSynthetic: true, authorityReference: 'Training fixture', reportId: plan.reports[item.reportIndex]!.id, fieldUpdateId: item.fieldId, verificationId: item.verificationId, publicationId: item.publication.id, perimeter, notice: sampleReportV2Notice }) } });
        auditsCreated++;
      }
      await verifyDatabaseV2(tx, plan);
      const deleted: Record<string, number> = {};
      deleted.attachments = (await tx.trAttachment.deleteMany({ where: { reportId: { in: prior.reportIds } } })).count;
      deleted.progress = (await tx.trReportProgress.deleteMany({ where: { reportId: { in: prior.reportIds } } })).count;
      deleted.updates = (await tx.trReportUpdate.deleteMany({ where: { reportId: { in: prior.reportIds } } })).count;
      deleted.notifications = (await tx.trNotification.deleteMany({ where: { reportId: { in: prior.reportIds } } })).count;
      deleted.publicationRegions = (await tx.trPublicInformationRegion.deleteMany({ where: { publicInformation: { OR: [{ reportId: { in: prior.reportIds } }, { caseId: { in: prior.caseIds } }] } } })).count;
      deleted.publications = (await tx.trPublicInformation.deleteMany({ where: { OR: [{ reportId: { in: prior.reportIds } }, { caseId: { in: prior.caseIds } }] } })).count;
      deleted.reports = (await tx.trReport.deleteMany({ where: { id: { in: prior.reportIds } } })).count;
      deleted.caseAudits = 0;
      deleted.reportAudits = 0;
      deleted.cases = (await tx.trCase.deleteMany({ where: { id: { in: prior.caseIds } } })).count;
      requireSafe(deleted.reports === 10 && deleted.attachments === 10 && deleted.updates === 20 && deleted.progress === prior.reports.reduce((sum, report) => sum + report.progress.length, 0) && deleted.notifications === 0 && deleted.publications === 0 && deleted.cases === prior.cases.length, 'Prior deletion count mismatch');
      await tx.trAuditLog.create({ data: { systemActor: sampleReportV2Provenance, action: replacementAction, targetType: 'SEED_BATCH', targetId: replacementTarget, reason: 'User-authorized replacement of exact provenance-tagged report fixtures.', details: jsonValue({ version: 2, isSynthetic: true, baseTime: iso(plan.now), notice: sampleReportV2Notice, oldReportIds: prior.reportIds, oldCaseIds: prior.caseIds, oldObjectKeys: prior.oldObjectKeys, newReportIds: plan.reports.map(report => report.id), newCaseIds: plan.cases.map(item => item.id), newPublicationIds: plan.cases.map(item => item.publication.id), deleted }) } });
      auditsCreated++;
      const preservationAfter = await preservationSnapshot(tx, prior.caseIds, excluded);
      requireSafe(isDeepStrictEqual(preservationBefore, preservationAfter), 'Genuine report, current case, or FIRMS preservation failed');
      return {
        deleted,
        created: { reports: 10, attachments: 10, progress: plan.reports.reduce((sum, report) => sum + report.progress.length, 0), cases: 2, fields: 2, verifications: 2, publications: 2 },
        auditsCreated,
      };
    }, { isolationLevel: 'Serializable', maxWait: 15000, timeout: 120000 });
    committed = true;
  } catch (error) {
    const linked = await client.trAttachment.count({ where: { objectKey: { in: photos.map(photo => photo.objectKey) } } }).catch(() => null);
    if (!committed && linked === 0) for (const photo of photos) await storage().send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: photo.objectKey }), { abortSignal: AbortSignal.timeout(15000) }).catch(() => undefined);
    throw error;
  }

  requireSafe(transactionResult, 'Replacement transaction result unavailable');
  const oldObjectsDeleted = await deleteOldObjects(prior.oldObjectKeys);
  const verified = await verifyDatabaseV2(client, plan);
  await verifyObjectsFromDatabase(client, verified.reports);
  const users = await fixtureUsers(client);
  const citizen = users.find(user => user.role === 'USER')! as typeof users[number] & { role: 'USER' };
  const publicVisibility = await verifyPublicV2(client, plan, citizen);
  const preservationAfter = await preservationSnapshot(client, prior.caseIds, excluded);
  requireSafe(isDeepStrictEqual(preservationBefore, preservationAfter), 'Post-commit preservation verification failed');
  return {
    mode: 'APPLIED',
    provenance: sampleReportV2Provenance,
    created: transactionResult.created,
    deleted: transactionResult.deleted,
    objects: { newPrivateObjects: 10, signedImagesVerified: 10, oldObjectsDeleted },
    auditsCreated: transactionResult.auditsCreated,
    workflow: verified.workflow,
    publicVisibility,
    preserved: preservationAfter,
    limitations: ['Images are public-domain references, not location evidence.', 'Confirmed cases and publications are clearly labelled training exercises.', 'No operational alert or citizen notification was created.'],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await seedSampleReportsV2(db(), sampleReportV2Flags(process.argv.slice(2)));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({ failed: true, category: error instanceof Error ? error.name : 'Unknown', message: 'Sample report v2 replacement stopped. No credentials were logged. If the database replacement committed before object cleanup failed, rerun the same command to finish verified cleanup.' }));
    process.exitCode = 1;
  } finally {
    await disconnect();
    storage().destroy();
  }
}
