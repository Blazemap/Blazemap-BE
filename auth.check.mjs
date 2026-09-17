import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import ts from 'typescript';
import { getIP } from '@better-auth/core/utils/ip';
const source = await readFile(new URL('./src/config/auth.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source
  .replace("import { betterAuth } from 'better-auth';", 'const betterAuth = options => options;')
  .replace("import { prismaAdapter } from 'better-auth/adapters/prisma';", 'const prismaAdapter = () => ({});')
  .replace("import { APIError } from 'better-auth/api';", 'class APIError extends Error {}')
  .replace("import nodemailer from 'nodemailer';", 'const nodemailer = {};')
  .replace("import { db } from './db.js';", 'const db = () => { throw new Error("No database access allowed"); };')
  .replace("import { emailAvailable, env, googleAvailable, origins } from './env.js';", 'const emailAvailable = false, googleAvailable = true, origins = []; const env = { BETTER_AUTH_SECRET: "x".repeat(32), BETTER_AUTH_URL: "https://example.invalid", FRONTEND_URL: "https://example.invalid", NODE_ENV: "test" };')
  .replace("import { unavailable } from '../utils/index.js';", 'const unavailable = () => new Error();'), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
const { createAuth, googleAvatar } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
let image = null;
const config = createAuth({ msUser: { updateMany: async ({ where, data }) => { assert.equal(where.image, null); if (image === null) image = data.image; }, findUnique: async () => ({ active: true, emailVerified: true }) } });
const provider = 'https://lh3.googleusercontent.com/a/fixture';
assert.equal(googleAvatar(provider), provider);
for (const value of ['http://lh3.googleusercontent.com/a', 'https://googleusercontent.com.evil.invalid/a', 'https://user:pass@lh3.googleusercontent.com/a', 'https://lh3.googleusercontent.com:443/a', 'https://lh3.googleusercontent.com:444/a', 'https://evilgoogleusercontent.com/a']) assert.equal(googleAvatar(value), null);
const created = await config.databaseHooks.user.create.before({ image: provider }, { path: '/callback/:id' });
assert.equal(created.data.image, provider);
assert.equal((await config.databaseHooks.user.create.before({ image: provider }, { path: '/sign-up/email' })).data.image, null);
assert.equal(created.data.role, 'USER');
assert.equal(created.data.canConfirmIncidents, false);
assert.equal(created.data.canPublishInformation, false);
await config.user.validateUserInfo({ user: { id: 'fixture', image: provider, emailVerified: true }, source: { action: 'sign-in', oauth: { providerId: 'google' } } });
assert.equal(image, provider);
image = 'avatars/custom-upload';
await config.user.validateUserInfo({ user: { id: 'fixture', image: provider, emailVerified: true }, source: { action: 'sign-in', oauth: { providerId: 'google' } } });
assert.equal(image, 'avatars/custom-upload');
await assert.rejects(config.databaseHooks.user.update.before({ image: provider }));
assert.deepEqual(config.rateLimit, { enabled: true, window: 60, max: 30, customRules: { '/get-session': { window: 60, max: 120 } } });
const app = await readFile(new URL('./src/app.ts', import.meta.url), 'utf8');
assert.match(app, /req.headers\['x-blazemap-client-ip'\] = req.ip \?\? req.socket.remoteAddress/);
assert.equal(getIP(new Headers({ 'x-blazemap-client-ip': '192.0.2.1', 'x-forwarded-for': '198.51.100.1, 198.51.100.2' }), config), '192.0.2.1');
console.log('Google creation/backfill/custom override and trusted IP/rate policy checks passed without database or network access.');
