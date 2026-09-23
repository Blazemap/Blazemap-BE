import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import sharp from 'sharp';
import { db, env, storage } from '../../config/index.js';
import { idSchema, reasonSchema, type Actor } from '../../types/index.js';
import { AppError, unavailable } from '../../utils/index.js';
import { audit, lockedActor } from '../admin/access.js';
import { nextPublicationTimestamp } from '../admin/rules.js';
import type { PrismaClient } from '../../generated/prisma/client.js';

const approvalSchema = z.strictObject({ attachmentId: idSchema, sourceAttachmentId: idSchema, publicationUseBasis: reasonSchema, redactionReview: reasonSchema });
export async function approveMedia(actor: Actor, publicationId: string, body: unknown, client: PrismaClient = db(), s3: Pick<ReturnType<typeof storage>, 'send'> = storage()) {
  const input = approvalSchema.parse(body);
  const upload = await client.$transaction(async tx => {
    await lockedActor(tx, actor, true, 'canPublishInformation');
    const publication = await tx.trPublicInformation.findUniqueOrThrow({ where: { id: publicationId } });
    if (publication.status !== 'DRAFT') throw new AppError('Media can be approved only on a draft', 409, 'INVALID_PUBLICATION_STATE');
    const source = await tx.trAttachment.findFirst({ where: { id: input.sourceAttachmentId, state: 'ATTACHED', revokedAt: null, publicationId: null } });
    const upload = await tx.trAttachment.findFirst({ where: { id: input.attachmentId, uploaderId: actor.id, state: 'READY', expiresAt: { gt: new Date() } } });
    if (!source || !upload || source.id === upload.id || source.digest === upload.digest) throw new AppError('Upload a separately reviewed redacted derivative first', 400, 'INVALID_DERIVATIVE');
    await tx.trAttachment.update({ where: { id: upload.id, state: 'READY' }, data: { state: 'FINALIZING' } });
    return upload;
  });
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: upload.objectKey }), { abortSignal: AbortSignal.timeout(15000) });
    if (!object.Body || object.ContentLength !== upload.size) throw unavailable('Media object');
    const bytes = Buffer.from(await object.Body.transformToByteArray());
    if (bytes.length !== upload.size || bytes.length > 5242880) throw unavailable('Media object');
    const output = await sharp(bytes, { limitInputPixels: 20000000, failOn: 'warning' }).rotate().webp({ quality: 90 }).toBuffer();
    if (output.length > 5242880) throw new AppError('Reviewed derivative exceeds upload size limit', 400, 'INVALID_UPLOAD');
    const key = `approved/${randomUUID()}.webp`;
    const pending = await client.trAttachment.create({ data: { objectKey: key, stagingKey: `unused/${randomUUID()}`, filename: 'reviewed-image.webp', contentType: 'image/webp', detectedType: 'image/webp', digest: createHash('sha256').update(output).digest('hex'), size: output.length, uploaderId: actor.id, state: 'PENDING', expiresAt: new Date(Date.now() + 3600000), sourceAttachmentId: input.sourceAttachmentId } });
    await s3.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: output, ContentType: 'image/webp', IfNoneMatch: '*' }), { abortSignal: AbortSignal.timeout(15000) });
    return await client.$transaction(async tx => {
      await lockedActor(tx, actor, true, 'canPublishInformation');
      await tx.$queryRaw`SELECT id FROM "TrPublicInformation" WHERE id = ${publicationId} FOR UPDATE`;
      const publication = await tx.trPublicInformation.findUniqueOrThrow({ where: { id: publicationId } });
      if (publication.status !== 'DRAFT') throw new AppError('Publication changed during review', 409, 'PUBLICATION_CONFLICT');
      const source = await tx.trAttachment.findFirst({ where: { id: input.sourceAttachmentId, state: 'ATTACHED', revokedAt: null, publicationId: null } });
      if (!source) throw new AppError('Source evidence is no longer available', 409, 'INVALID_DERIVATIVE');
      const approved = await tx.trAttachment.update({ where: { id: pending.id, state: 'PENDING' }, data: { state: 'ATTACHED', publicationId, sourceAttachmentId: source.id, publicationUseBasis: input.publicationUseBasis, redactionReview: input.redactionReview, approvedById: actor.id, approvedAt: new Date() }, select: { id: true, filename: true, contentType: true, size: true, approvedAt: true } });
      await tx.trAttachment.update({ where: { id: upload.id, state: 'FINALIZING' }, data: { state: 'READY' } });
      await tx.trPublicInformation.update({ where: { id: publicationId, status: 'DRAFT' }, data: { updatedAt: nextPublicationTimestamp(publication.updatedAt) } });
      await audit(tx, actor.id, 'PUBLIC_MEDIA_APPROVED', 'PUBLICATION', publicationId, input.publicationUseBasis, { attachmentId: approved.id, sourceAttachmentId: source.id });
      return approved;
    });
  } catch (error) {
    await client.trAttachment.updateMany({ where: { id: upload.id, state: 'FINALIZING' }, data: { state: 'READY' } });
    if (error instanceof AppError) throw error;
    throw unavailable('Public media processing');
  }
}
export async function publicDownload(id: string) {
  const item = await publicMediaItem(id);
  try { return { url: await getSignedUrl(storage(), new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: item.objectKey, ResponseContentType: item.contentType, ResponseContentDisposition: 'inline' }), { expiresIn: 60 }) }; }
  catch { throw unavailable('Public media'); }
}
async function publicMediaItem(id: string) {
  const item = await db().trAttachment.findFirst({ where: { id, state: 'ATTACHED', revokedAt: null, approvedAt: { not: null }, approvedById: { not: null }, sourceAttachmentId: { not: null }, publication: { status: 'PUBLISHED', OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }] } }, select: { objectKey: true, detectedType: true } });
  if (!item?.detectedType) throw new AppError('Media not found', 404, 'NOT_FOUND');
  return { objectKey: item.objectKey, contentType: item.detectedType };
}
export async function publicContent(id: string) {
  const item = await publicMediaItem(id);
  try {
    const object = await storage().send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: item.objectKey }), { abortSignal: AbortSignal.timeout(15000) });
    if (!object.Body) throw unavailable('Public media');
    const bytes = Buffer.from(await object.Body.transformToByteArray());
    if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw unavailable('Public media');
    return { bytes, contentType: item.contentType };
  } catch (error) { if (error instanceof AppError) throw error; throw unavailable('Public media'); }
}
export async function revokeMedia(actor: Actor, id: string, body: unknown, client: PrismaClient = db()) {
  const { reason } = z.strictObject({ reason: reasonSchema }).parse(body);
  return client.$transaction(async tx => {
    await lockedActor(tx, actor, true, 'canPublishInformation');
    const attachment = await tx.trAttachment.findUniqueOrThrow({ where: { id, publicationId: { not: null } }, select: { publicationId: true } });
    const publicationId = attachment.publicationId!;
    await tx.$queryRaw`SELECT id FROM "TrPublicInformation" WHERE id = ${publicationId} FOR UPDATE`;
    const publication = await tx.trPublicInformation.findUniqueOrThrow({ where: { id: publicationId }, select: { updatedAt: true } });
    const item = await tx.trAttachment.update({ where: { id, publicationId }, data: { revokedAt: new Date() }, select: { id: true, publicationId: true, revokedAt: true } });
    await tx.trPublicInformation.update({ where: { id: publicationId }, data: { updatedAt: nextPublicationTimestamp(publication.updatedAt) } });
    await audit(tx, actor.id, 'PUBLIC_MEDIA_REVOKED', 'PUBLICATION', item.publicationId!, reason, { attachmentId: id });
    return { id: item.id, revokedAt: item.revokedAt };
  });
}
