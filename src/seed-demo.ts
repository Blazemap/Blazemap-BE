import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'dotenv';
import { reportSchema, uploadSchema } from './types/index.js';
import { fingerprint } from './utils/index.js';
import type { MsUser } from './generated/prisma/client.js';

const samplePath = new URL('../../Blazemap-FE/src/assets/images/observation-photo.webp', import.meta.url);
const notice = '[DEMO] Ilustrasi sampel, bukan bukti atau laporan warga nyata.';
class DemoError extends Error {}
function requireDemo(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DemoError(message);
}

export function guardDemo(env: NodeJS.ProcessEnv, primary: NodeJS.ProcessEnv) {
  requireDemo(['development', 'test'].includes(env.NODE_ENV ?? ''), 'Set NODE_ENV explicitly to development or test.');
  requireDemo(env.DEMO_SEED_CONFIRM === 'ISOLATED_DEMO_ONLY', 'Set DEMO_SEED_CONFIRM=ISOLATED_DEMO_ONLY.');
  const database = (value: string | undefined) => {
    try {
      const url = new URL(value ?? '');
      requireDemo(['postgres:', 'postgresql:'].includes(url.protocol) && !url.hash, 'Invalid database URL.');
      requireDemo([...url.searchParams.keys()].every(key => ['sslmode', 'sslcert', 'sslrootcert', 'sslkey', 'connect_timeout'].includes(key)), 'Database URL contains unsupported routing options.');
      return decodeURIComponent(url.pathname.slice(1));
    } catch { throw new DemoError('Invalid database URL.'); }
  };
  const name = database(env.DEMO_DATABASE_URL);
  requireDemo(/^blazemap_demo_[a-z0-9_]+$/.test(name), 'Demo database name must start with blazemap_demo_.');
  requireDemo(env.DEMO_DATABASE_NAME === name, 'DEMO_DATABASE_NAME must explicitly match the demo database.');
  const primaries = [env.DATABASE_URL, primary.DATABASE_URL, env.DIRECT_URL, primary.DIRECT_URL].filter(Boolean);
  requireDemo(primaries.length > 0, 'Primary DATABASE_URL is required for exclusion checking.');
  for (const url of primaries) requireDemo(database(url) !== name, 'Refusing the primary database, including alternate hosts or credentials.');
  const bucket = env.DEMO_S3_BUCKET ?? '';
  requireDemo(/^blazemap-demo-[a-z0-9-]+$/.test(bucket) && bucket.length <= 63, 'Use a dedicated blazemap-demo-* AWS S3 bucket.');
  requireDemo(bucket !== env.S3_BUCKET && bucket !== primary.S3_BUCKET, 'Refusing the primary media bucket.');
  requireDemo(env.DEMO_S3_PREFIX === 'demo/photo-reports-v1/', 'Set DEMO_S3_PREFIX=demo/photo-reports-v1/.');
  requireDemo(env.DEMO_S3_REGION && env.DEMO_S3_ACCESS_KEY_ID && env.DEMO_S3_SECRET_ACCESS_KEY, 'Explicit demo S3 region and credentials are required.');
  requireDemo(!env.DEMO_S3_ENDPOINT && !env.AWS_ENDPOINT_URL && !env.AWS_ENDPOINT_URL_S3, 'Custom S3 endpoints are unsupported: private-bucket enforcement requires AWS S3.');
  const reporters = (env.DEMO_REPORTER_EMAILS ?? '').split(',').map(value => value.trim().toLowerCase());
  requireDemo(reporters.length >= 1 && reporters.length <= 5 && new Set(reporters).size === reporters.length && reporters.every(email => /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(email)), 'Supply 1–5 distinct existing demo emails in DEMO_REPORTER_EMAILS.');
  return { name, bucket, reporters, prefix: env.DEMO_S3_PREFIX };
}

export function guardReporter(user: Pick<MsUser, 'name' | 'active' | 'emailVerified' | 'role' | 'canConfirmIncidents' | 'canPublishInformation'>) {
  requireDemo(user.name.startsWith('[DEMO] ') && user.active && user.emailVerified && user.role === 'USER' && !user.canConfirmIncidents && !user.canPublishInformation, 'Reporter must be an existing active, email-verified, unprivileged USER named [DEMO] ...; no account will be modified.');
}

export function attachmentWhere(id: string, uploaderId: string, now: Date) {
  return { id, uploaderId, state: 'READY' as const, expiresAt: { gt: now }, reportId: null, reportUpdateId: null, fieldUpdateId: null, publicationId: null, revokedAt: null };
}

export function demoReports(now = new Date()) {
  return Array.from({ length: 10 }, (_, index) => reportSchema.parse({
    observationTypes: [['SMOKE'], ['FLAME'], ['BURNING_SMELL']][index % 3],
    observedAt: new Date(now.getTime() - (index + 1) * 3600000).toISOString(),
    locationMode: 'INCIDENT_ESTIMATE', latitude: 0, longitude: 0,
    locationDescription: `[DEMO] Lokasi simulasi ${index + 1}; koordinat 0,0 bukan lokasi kejadian.`,
    description: `${notice} Skenario latihan ${index + 1}; jenis pengamatan dan waktu adalah simulasi. Foto orang dengan ponsel di hutan tidak membuktikan kebakaran dan bukan identitas pelapor.`,
    attachmentIds: [], idempotencyKey: `demo-photo-reports-v1-${String(index + 1).padStart(2, '0')}`,
  }));
}

export async function samplePhoto() {
  const { default: sharp } = await import('sharp');
  const { fileTypeFromBuffer } = await import('file-type');
  const source = await readFile(samplePath);
  requireDemo(source.length <= 5 * 1024 * 1024 && (await fileTypeFromBuffer(source))?.mime === 'image/webp', 'Local sample must be a WebP image under 5 MiB.');
  const image = sharp(source, { limitInputPixels: 20000000, failOn: 'warning' });
  requireDemo(((await image.metadata()).pages ?? 1) === 1, 'Animated sample images are not supported.');
  const banner = Buffer.from('<svg width="960" height="100"><rect width="960" height="100" fill="black"/><text x="480" y="42" text-anchor="middle" font-family="sans-serif" font-size="30" fill="white">DEMO - ILUSTRASI SAMPEL</text><text x="480" y="80" text-anchor="middle" font-family="sans-serif" font-size="25" fill="white">BUKAN BUKTI / BUKAN LAPORAN NYATA</text></svg>');
  const bytes = await image.resize(960, 640, { fit: 'cover' }).composite([{ input: banner, gravity: 'south' }]).webp().toBuffer();
  const input = uploadSchema.parse({ filename: '[DEMO] ilustrasi-sampel-bukan-bukti.webp', contentType: 'image/webp', size: bytes.length });
  requireDemo((await fileTypeFromBuffer(bytes))?.mime === input.contentType, 'Invalid processed sample.');
  await sharp(bytes, { limitInputPixels: 20000000, failOn: 'warning' }).resize(1, 1).toBuffer();
  return { bytes, ...input, digest: createHash('sha256').update(bytes).digest('hex') };
}

async function applyDemo(env: NodeJS.ProcessEnv, config: ReturnType<typeof guardDemo>, photo: Awaited<ReturnType<typeof samplePhoto>>) {
  const [{ PrismaClient }, { PrismaPg }, s3] = await Promise.all([import('./generated/prisma/client.js'), import('@prisma/adapter-pg'), import('@aws-sdk/client-s3')]);
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DEMO_DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 15000 }), log: [] });
  const storage = new s3.S3Client({ region: env.DEMO_S3_REGION, ignoreConfiguredEndpointUrls: true, maxAttempts: 1, credentials: { accessKeyId: env.DEMO_S3_ACCESS_KEY_ID!, secretAccessKey: env.DEMO_S3_SECRET_ACCESS_KEY!, ...(env.DEMO_S3_SESSION_TOKEN ? { sessionToken: env.DEMO_S3_SESSION_TOKEN } : {}) } });
  try {
    const options = { abortSignal: AbortSignal.timeout(15000) };
    const block = await storage.send(new s3.GetPublicAccessBlockCommand({ Bucket: config.bucket }), options);
    const rules = block.PublicAccessBlockConfiguration;
    requireDemo(rules?.BlockPublicAcls && rules.IgnorePublicAcls && rules.BlockPublicPolicy && rules.RestrictPublicBuckets, 'Demo bucket must enable all four S3 Block Public Access settings.');
    const acl = await storage.send(new s3.GetBucketAclCommand({ Bucket: config.bucket }), { abortSignal: AbortSignal.timeout(15000) });
    requireDemo(acl.Grants?.every(grant => !grant.Grantee?.URI), 'Demo bucket must not have public or group ACL grants.');
    const policy = await storage.send(new s3.GetBucketPolicyStatusCommand({ Bucket: config.bucket }), { abortSignal: AbortSignal.timeout(15000) }).catch(error => {
      if (error instanceof Error && error.name === 'NoSuchBucketPolicy') return { PolicyStatus: { IsPublic: false } };
      throw error;
    });
    requireDemo(policy.PolicyStatus?.IsPublic === false, 'Demo bucket must not have a public policy.');
    await client.$transaction(async tx => {
      const identity = await tx.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
      requireDemo(identity[0]?.name === config.name, 'Connected database does not match the confirmed demo database.');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(741037, 10)`;
      requireDemo(await tx.trHotspot.count() === 0 && await tx.trIntegrationRun.count() === 0, 'Refusing a database containing FIRMS or integration data.');
      requireDemo(await tx.trCase.count() === 0 && await tx.trPublicInformation.count() === 0, 'Demo database must not contain cases or publications.');
      requireDemo(await tx.msUser.count({ where: { NOT: { name: { startsWith: '[DEMO] ' } } } }) === 0, 'Refusing a database containing non-demo accounts.');
      requireDemo(await tx.trReport.count({ where: { NOT: { description: { startsWith: '[DEMO]' } } } }) === 0, 'Refusing a database containing non-demo reports.');
      const users = [];
      for (const email of config.reporters) {
        await tx.$queryRaw`SELECT id FROM "MsUser" WHERE email = ${email} FOR UPDATE`;
        const user = await tx.msUser.findUnique({ where: { email } });
        requireDemo(user, 'Demo reporter was not found. Create/verify it separately in the isolated demo app.');
        guardReporter(user);
        users.push(user);
      }
      requireDemo(await tx.trReport.count({ where: { number: { startsWith: '[DEMO]-PHOTO-V1-' } } }) === 0, 'This demo batch already exists; refusing duplicates or partial replacement.');
      const reports = demoReports();
      for (const [index, input] of reports.entries()) {
        const user = users[index % users.length]!;
        const key = randomUUID();
        const objectKey = `${config.prefix}${user.id}/${key}.webp`;
        await storage.send(new s3.PutObjectCommand({ Bucket: config.bucket, Key: objectKey, Body: photo.bytes, ContentType: photo.contentType, ContentLength: photo.size, IfNoneMatch: '*', Metadata: { sha256: photo.digest, purpose: 'demo-sample-not-evidence' } }), { abortSignal: AbortSignal.timeout(15000) });
        const attachment = await tx.trAttachment.create({ data: { objectKey, stagingKey: `${config.prefix}pending/${key}`, filename: photo.filename, contentType: photo.contentType, detectedType: photo.contentType, size: photo.size, digest: photo.digest, uploaderId: user.id, state: 'READY', expiresAt: new Date(Date.now() + 3600000) } });
        const payload = { ...input, attachmentIds: [attachment.id] };
        const { attachmentIds: _ids, ...fields } = payload;
        const report = await tx.trReport.create({ data: { ...fields, observedAt: new Date(fields.observedAt), reporterId: user.id, number: `[DEMO]-PHOTO-V1-${String(index + 1).padStart(2, '0')}`, payloadHash: fingerprint(payload), reviewStatus: 'NEW' } });
        const attached = await tx.trAttachment.updateMany({ where: attachmentWhere(attachment.id, user.id, new Date()), data: { reportId: report.id, state: 'ATTACHED' } });
        requireDemo(attached.count === 1, 'Attachment ownership/state check failed; database transaction rolled back.');
        await tx.trAuditLog.create({ data: { actorId: user.id, systemActor: 'demo-photo-seeder-v1', action: 'DEMO_REPORT_CREATED', targetType: 'REPORT', targetId: report.id, reason: notice } });
      }
    }, { isolationLevel: 'Serializable', timeout: 180000, maxWait: 5000 });
  } finally { storage.destroy(); await client.$disconnect(); }
}

export async function runDemo(args: string[], env: NodeJS.ProcessEnv, primary: NodeJS.ProcessEnv, apply = applyDemo) {
  const { values } = parseArgs({ args, options: { apply: { type: 'boolean', default: false } }, strict: true, allowPositionals: false });
  const config = values.apply ? guardDemo(env, primary) : null;
  const photo = await samplePhoto();
  const reports = demoReports();
  if (!config) return { mode: 'DRY_RUN', reports: reports.length, photos: reports.length, sample: fileURLToPath(samplePath), watermarked: true, writes: 0, network: 0, prerequisites: 'For --apply: isolated blazemap_demo_* database, 1–5 existing [DEMO] verified USER accounts, private blazemap-demo-* AWS S3 bucket and demo-only credentials. Set NODE_ENV=development/test, DEMO_SEED_CONFIRM=ISOLATED_DEMO_ONLY, DEMO_DATABASE_URL, DEMO_DATABASE_NAME, DEMO_REPORTER_EMAILS, DEMO_S3_BUCKET, DEMO_S3_REGION, DEMO_S3_ACCESS_KEY_ID, DEMO_S3_SECRET_ACCESS_KEY, DEMO_S3_PREFIX=demo/photo-reports-v1/. Configure the isolated app to use this same demo DB/bucket for authenticated downloads. No local/public media route exists; S3-compatible custom endpoints are not supported.', preview: reports };
  await apply(env, config, photo);
  return { mode: 'APPLIED', reports: 10, photos: 10, message: 'Only isolated demo reports and private sample attachments created; no accounts, roles, FIRMS, cases, verification or publication changes.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let primary: NodeJS.ProcessEnv = {};
    try { primary = parse(await readFile(new URL('../.env', import.meta.url))); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    console.log(JSON.stringify(await runDemo(process.argv.slice(2), process.env, primary), null, 2));
  } catch (error) {
    console.error(error instanceof DemoError ? error.message : 'Demo seeding failed; no credentials logged. Database work is transactional. If --apply reached storage, private demo objects may remain for operator inspection; do not retry blindly or delete outside the demo namespace.');
    process.exitCode = 1;
  }
}
