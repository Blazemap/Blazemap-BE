import { createHash, randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { db, env, storage } from '../../config/index.js';
import type { Actor } from '../../types/index.js';
import { AppError, unavailable } from '../../utils/index.js';
import { lockedActor } from '../admin/access.js';

export function avatarPrefix(id: string) { return `avatars/${createHash('sha256').update(id).digest('hex')}/`; }
export function ownsAvatar(id: string, key: unknown): key is string {
  return typeof key === 'string' && key.startsWith(avatarPrefix(id)) && /^[0-9a-f-]{36}\.jpg$/.test(key.slice(avatarPrefix(id).length));
}
export function requireAvatarOwner(actor: Pick<Actor, 'id'>, id: string) {
  if (actor.id !== id) throw new AppError('Account changed; sign in again', 403, 'ACCOUNT_CHANGED');
}
export async function sanitizeAvatar(bytes: unknown) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 1024 * 1024 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new AppError('A JPEG image up to 1 MB is required', 400, 'INVALID_AVATAR');
  try {
    const image = sharp(bytes, { limitInputPixels: 512 * 512, failOn: 'warning' });
    const meta = await image.metadata();
    if (meta.format !== 'jpeg' || meta.width !== 512 || meta.height !== 512 || (meta.pages ?? 1) !== 1) throw new Error();
    return await image.autoOrient().flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer();
  } catch { throw new AppError('Avatar must be a valid 512 × 512 JPEG', 400, 'INVALID_AVATAR'); }
}
export async function saveAvatar(actor: Actor, id: string, body: unknown) {
  requireAvatarOwner(actor, id);
  const bytes = await sanitizeAvatar(body);
  const s3 = storage();
  const key = `${avatarPrefix(id)}${randomUUID()}.jpg`;
  try { await s3.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: bytes, ContentType: 'image/jpeg', ContentLength: bytes.length, CacheControl: 'private, no-store', IfNoneMatch: '*' }), { abortSignal: AbortSignal.timeout(15000) }); }
  catch { throw unavailable('Avatar storage'); }
  const previous = await db().$transaction(async tx => {
    await lockedActor(tx, actor);
    const previous = await tx.msUser.findUniqueOrThrow({ where: { id }, select: { image: true } });
    await tx.msUser.update({ where: { id }, data: { image: key } });
    return previous.image;
  });
  if (ownsAvatar(id, previous)) {
    try { await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: previous }), { abortSignal: AbortSignal.timeout(5000) }); }
    catch { /* ponytail: failed cleanup retains a private orphan; add a reference-aware sweep if storage growth requires it. */ }
  }
  return { image: key };
}
export async function readAvatar(actor: Actor, id: string) {
  requireAvatarOwner(actor, id);
  const user = await db().msUser.findUnique({ where: { id, active: true }, select: { image: true } });
  if (!ownsAvatar(id, user?.image)) throw new AppError('Avatar not found', 404, 'NOT_FOUND');
  try {
    const object = await storage().send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: user.image }), { abortSignal: AbortSignal.timeout(15000) });
    if (!object.Body || !object.ContentLength || object.ContentLength > 1024 * 1024 || object.ContentType !== 'image/jpeg') throw new Error();
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > 1024 * 1024) throw new Error();
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch { throw unavailable('Avatar download'); }
}
