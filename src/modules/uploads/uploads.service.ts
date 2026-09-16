import { createHash, randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { db, env, storage } from '../../config/index.js';
import { uploadSchema, type Actor, type Transaction } from '../../types/index.js';
import { AppError, unavailable } from '../../utils/index.js';
import { lockedActor, audit } from '../admin/access.js';

export async function createIntent(actor: Actor, body: unknown) {
  const input = uploadSchema.parse(body);
  const s3 = storage();
  const item = await db().$transaction(async tx => {
    await lockedActor(tx, actor);
    const recent = await tx.trAttachment.count({ where: { uploaderId: actor.id, createdAt: { gt: new Date(Date.now() - 3600000) } } });
    if (recent >= 30) throw new AppError('Hourly upload limit reached', 429, 'RATE_LIMIT');
    const key = randomUUID();
    return tx.trAttachment.create({ data: { ...input, uploaderId: actor.id, stagingKey: `pending/${actor.id}/${key}`, objectKey: `evidence/${actor.id}/${key}`, expiresAt: new Date(Date.now() + 3600000) } });
  });
  try {
    const command = new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: item.stagingKey, ContentType: input.contentType, IfNoneMatch: '*' });
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300, signableHeaders: new Set(['content-type', 'if-none-match']) });
    return { id: item.id, uploadUrl, method: 'PUT' as const, headers: { 'Content-Type': input.contentType, 'If-None-Match': '*' } };
  } catch { throw unavailable('Uploads'); }
}
export async function inspectImage(bytes: Buffer, declaredType: string, size: number) {
  if (bytes.length !== size || bytes.length > 5 * 1024 * 1024) throw new AppError('Uploaded image size does not match intent', 400, 'INVALID_UPLOAD');
  const detected = await fileTypeFromBuffer(bytes);
  if (!detected || detected.mime !== declaredType || !['image/jpeg', 'image/png', 'image/webp'].includes(detected.mime)) throw new AppError('Image content does not match declared type', 400, 'INVALID_UPLOAD');
  try {
    const image = sharp(bytes, { limitInputPixels: 20000000, failOn: 'warning' });
    const metadata = await image.metadata();
    if ((metadata.pages ?? 1) > 1) throw new Error();
    await image.resize(1, 1).toBuffer();
  } catch { throw new AppError('Image is corrupt, animated, or too large to decode', 400, 'INVALID_UPLOAD'); }
  return { detectedType: detected.mime, digest: createHash('sha256').update(bytes).digest('hex') };
}
export async function finalize(actor: Actor, id: string) {
  const s3 = storage();
  const item = await db().$transaction(async tx => {
    await lockedActor(tx, actor);
    const item = await tx.trAttachment.findFirst({ where: { id, uploaderId: actor.id } });
    if (!item) throw new AppError('Upload not found', 404, 'NOT_FOUND');
    if (['READY', 'ATTACHED'].includes(item.state)) return item;
    if (item.state !== 'PENDING' || item.expiresAt < new Date()) throw new AppError('Upload is expired or already processing', 409, 'UPLOAD_STATE');
    await tx.trAttachment.update({ where: { id, state: 'PENDING' }, data: { state: 'FINALIZING' } });
    return item;
  });
  if (['READY', 'ATTACHED'].includes(item.state)) return { id };
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: item.stagingKey }), { abortSignal: AbortSignal.timeout(15000) });
    if (head.ContentLength !== item.size || head.ContentType?.split(';')[0] !== item.contentType) throw new AppError('Uploaded type or size does not match intent', 400, 'INVALID_UPLOAD');
    const object = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: item.stagingKey, IfMatch: head.ETag }), { abortSignal: AbortSignal.timeout(15000) });
    if (!object.Body) throw unavailable('Upload object');
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > item.size) throw new AppError('Uploaded image exceeds intent size', 400, 'INVALID_UPLOAD');
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    const inspected = await inspectImage(bytes, item.contentType, item.size);
    try {
      await s3.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: item.objectKey, Body: bytes, ContentType: inspected.detectedType, ContentLength: bytes.length, Metadata: { sha256: inspected.digest }, IfNoneMatch: '*' }), { abortSignal: AbortSignal.timeout(15000) });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'PreconditionFailed') throw error;
      const existing = await s3.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: item.objectKey }), { abortSignal: AbortSignal.timeout(15000) });
      if (existing.Metadata?.sha256 !== inspected.digest || existing.ContentLength !== item.size) throw new AppError('Stored object does not match the finalized image', 409, 'UPLOAD_CONFLICT');
    }
    await db().$transaction(async tx => {
      await lockedActor(tx, actor);
      await tx.trAttachment.update({ where: { id, state: 'FINALIZING' }, data: { state: 'READY', ...inspected } });
      await audit(tx, actor.id, 'UPLOAD_FINALIZED', 'ATTACHMENT', id);
    });
    return { id };
  } catch (error) {
    await db().trAttachment.updateMany({ where: { id, state: 'FINALIZING' }, data: { state: error instanceof AppError && error.status === 400 ? 'REJECTED' : 'PENDING' } });
    if (error instanceof AppError) throw error;
    throw unavailable('Uploads');
  }
}
export async function attach(tx: Transaction, actor: Actor, ids: string[], parent: { reportId: string } | { fieldUpdateId: string }) {
  if (!ids.length) return;
  if (new Set(ids).size !== ids.length) throw new AppError('Duplicate attachment', 400, 'INVALID_ATTACHMENT');
  const count = await tx.trAttachment.updateMany({ where: { id: { in: ids }, uploaderId: actor.id, state: 'READY', expiresAt: { gt: new Date() }, reportId: null, reportUpdateId: null, fieldUpdateId: null, publicationId: null, revokedAt: null }, data: { ...parent, state: 'ATTACHED' } });
  if (count.count !== ids.length) throw new AppError('One or more attachments are unavailable', 400, 'INVALID_ATTACHMENT');
}
export async function download(actor: Actor, id: string) {
  const item = await db().trAttachment.findFirst({ where: { id, revokedAt: null, state: { in: ['READY', 'ATTACHED'] }, ...(actor.role === 'ADMIN' ? {} : { uploaderId: actor.id }) }, select: { objectKey: true, contentType: true } });
  if (!item) throw new AppError('Attachment not found', 404, 'NOT_FOUND');
  try { return { url: await getSignedUrl(storage(), new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: item.objectKey, ResponseContentDisposition: 'attachment', ResponseContentType: item.contentType }), { expiresIn: 60 }) }; }
  catch { throw unavailable('Downloads'); }
}
export async function cleanupUploads() {
  await db().trAttachment.updateMany({ where: { state: 'FINALIZING', expiresAt: { lt: new Date(Date.now() - 3600000) } }, data: { state: 'PENDING' } });
  const candidates = await db().trAttachment.findMany({ where: { state: { in: ['PENDING', 'READY', 'REJECTED', 'DELETING'] }, expiresAt: { lt: new Date() }, reportId: null, reportUpdateId: null, fieldUpdateId: null, publicationId: null }, take: 100, select: { id: true, stagingKey: true, objectKey: true } });
  for (const item of candidates) {
    const claim = await db().trAttachment.updateMany({ where: { id: item.id, state: { in: ['PENDING', 'READY', 'REJECTED', 'DELETING'] }, reportId: null, reportUpdateId: null, fieldUpdateId: null, publicationId: null }, data: { state: 'DELETING' } });
    if (!claim.count) continue;
    for (const key of [item.stagingKey, item.objectKey]) await storage().send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }), { abortSignal: AbortSignal.timeout(15000) });
    await db().trAttachment.delete({ where: { id: item.id, state: 'DELETING' } });
  }
  return { processed: candidates.length };
}
