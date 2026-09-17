import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import ts from 'typescript';
import sharp from 'sharp';

const source = await readFile(new URL('./src/modules/profile/profile.service.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source
  .replace("import { db, env, storage } from '../../config/index.js';", 'const db = () => globalThis.__avatarDb; const env = { S3_BUCKET: "isolated-test" }; const storage = () => globalThis.__avatarStorage;')
  .replace("import { lockedActor } from '../admin/access.js';", 'const lockedActor = async (_tx, actor) => { if (!globalThis.__avatarActive || actor.id !== "owner") throw new Error("Account unavailable"); };')
  .replace("import { AppError, unavailable } from '../../utils/index.js';", 'class AppError extends Error { constructor(message, status, code) { super(message); this.status = status; this.code = code; } } const unavailable = () => new Error("Unavailable");')
  .replace('from \'sharp\'', `from '${import.meta.resolve('sharp')}'`)
  .replace("from '@aws-sdk/client-s3'", `from '${import.meta.resolve('@aws-sdk/client-s3')}'`), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
const { avatarPrefix, ownsAvatar, requireAvatarOwner, sanitizeAvatar, saveAvatar, readAvatar } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const key = `${avatarPrefix('owner')}00000000-0000-4000-8000-000000000000.jpg`;
assert.equal(ownsAvatar('owner', key), true);
for (const value of [null, '', key.replace('avatars/', 'evidence/'), `${avatarPrefix('owner')}../other.jpg`, 'https://evil.invalid/photo.jpg']) assert.equal(ownsAvatar('owner', value), false);
assert.equal(ownsAvatar('other', key), false);
assert.throws(() => requireAvatarOwner({ id: 'other' }, 'owner'), { status: 403 });
await assert.rejects(saveAvatar({ id: 'other' }, 'owner', Buffer.alloc(0)), { status: 403 });
await assert.rejects(readAvatar({ id: 'other' }, 'owner'), { status: 403 });
const jpeg = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#27624b' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
const sanitized = await sanitizeAvatar(jpeg);
const metadata = await sharp(sanitized).metadata();
assert.equal(metadata.width, 512); assert.equal(metadata.height, 512);
assert.equal(metadata.format, 'jpeg'); assert.equal(metadata.exif, undefined); assert.equal(metadata.icc, undefined); assert.equal(metadata.orientation, undefined);
for (const bytes of [Buffer.alloc(0), Buffer.from('<svg/>'), Buffer.alloc(1048577, 255), jpeg.subarray(0, 80), await sharp(jpeg).png().toBuffer(), await sharp(jpeg).resize(513, 512).jpeg().toBuffer()]) await assert.rejects(sanitizeAvatar(bytes), { code: 'INVALID_AVATAR' });
const objects = new Map();
let currentImage = key;
let failPut = false, failCommit = false;
globalThis.__avatarActive = true;
globalThis.__avatarStorage = { send: async command => {
  const input = command.input;
  if (command.constructor.name === 'PutObjectCommand') { if (failPut) throw new Error('Unavailable'); objects.set(input.Key, input.Body); }
  if (command.constructor.name === 'DeleteObjectCommand') objects.delete(input.Key);
  if (command.constructor.name === 'GetObjectCommand') { const bytes = objects.get(input.Key); return { Body: (async function* () { yield bytes; })(), ContentLength: bytes.length, ContentType: 'image/jpeg' }; }
} };
const users = { findUniqueOrThrow: async () => ({ image: currentImage }), findUnique: async () => ({ image: currentImage }), update: async ({ where, data }) => { assert.equal(where.id, 'owner'); if (failCommit) throw new Error('Commit failed'); currentImage = data.image; } };
globalThis.__avatarDb = { msUser: users, $transaction: async callback => callback({ msUser: users }) };
try {
  failPut = true;
  await assert.rejects(saveAvatar({ id: 'owner' }, 'owner', jpeg));
  assert.equal(currentImage, key);
  failPut = false; failCommit = true;
  await assert.rejects(saveAvatar({ id: 'owner' }, 'owner', jpeg));
  assert.equal(currentImage, key);
  failCommit = false;
  const saved = await saveAvatar({ id: 'owner' }, 'owner', jpeg);
  assert.equal(saved.image, currentImage); assert.equal(ownsAvatar('owner', currentImage), true);
  assert.deepEqual(await readAvatar({ id: 'owner' }, 'owner'), sanitized);
  globalThis.__avatarActive = false;
  await assert.rejects(saveAvatar({ id: 'owner' }, 'owner', jpeg));
  assert.equal(currentImage, saved.image);
} finally { delete globalThis.__avatarDb; delete globalThis.__avatarStorage; delete globalThis.__avatarActive; }
const auth = await readFile(new URL('./src/config/auth.ts', import.meta.url), 'utf8');
assert.match(auth, /Object.hasOwn\(user, 'image'\)/);
assert.match(auth, /context\?\.path === '\/callback\/:id' \? googleAvatar\(user.image\) : null/);
assert.match(auth, /where: \{ id: user.id, image: null \}, data: \{ image \}/);
assert.match(source, /where: \{ id \}, data: \{ image: key \}/);
assert.doesNotMatch(source, /trAttachment|getSignedUrl|updateUser\(/);
console.log('Avatar signature, size, dimensions, metadata and owner checks passed (no database or storage access).');
