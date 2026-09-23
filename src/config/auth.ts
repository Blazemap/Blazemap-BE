import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { APIError } from 'better-auth/api';
import { customSession } from 'better-auth/plugins';
import { effectiveCapabilities } from '../modules/admin/rules.js';
import { db } from './db.js';
import { sendEmail } from './email.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { emailAvailable, env, googleAvailable, origins } from './env.js';
import { unavailable } from '../utils/index.js';

export function googleAvatar(value: unknown): string | null {
  if (typeof value !== 'string' || /[\s\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    const authority = value.slice(8).split(/[/?#]/, 1)[0];
    if (!authority || authority.includes(':')) return null;
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      (url.hostname === 'googleusercontent.com' || url.hostname.endsWith('.googleusercontent.com'))) return url.href;
  } catch { return null; }
  return null;
}

export const privilegeFields = {
  role: { type: ['USER', 'ADMIN'] as ['USER', 'ADMIN'], required: false, defaultValue: 'USER', input: false },
  active: { type: 'boolean', required: false, defaultValue: true, input: false },
  canConfirmIncidents: { type: 'boolean', required: false, defaultValue: false, input: false },
  canPublishInformation: { type: 'boolean', required: false, defaultValue: false, input: false },
} as const;
async function send(to: string, subject: string, url: string) {
  if (!emailAvailable) throw new APIError('SERVICE_UNAVAILABLE', { message: 'Email delivery unavailable' });
  try { await sendEmail(to, subject, `${subject}\n\n${url}\n\nIf you did not request this, ignore this email.`); }
  catch { throw new APIError('SERVICE_UNAVAILABLE', { message: 'Email delivery unavailable' }); }
}
export function createAuth(client: PrismaClient = db()) {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32 || !env.BETTER_AUTH_URL || !env.FRONTEND_URL) throw unavailable('Authentication');
  return betterAuth({
    appName: 'Blazemap', secret: env.BETTER_AUTH_SECRET, baseURL: env.BETTER_AUTH_URL, basePath: '/api/auth', trustedOrigins: origins,
    database: prismaAdapter(client, { provider: 'postgresql' }),
    logger: { disabled: true },
    plugins: [customSession(async ({ user, session }) => ({ user: { ...user, ...effectiveCapabilities(user) }, session }), { user: { additionalFields: privilegeFields } })],
    user: { modelName: 'msUser', additionalFields: privilegeFields, deleteUser: { enabled: false }, validateUserInfo: async ({ user, source }) => {
      if (source.oauth?.providerId === 'google') {
        if (user.emailVerified !== true) return { error: 'email_not_verified' };
        const image = googleAvatar(user.image);
        if (source.action === 'sign-in' && user.id && image) await client.msUser.updateMany({ where: { id: user.id, image: null }, data: { image } });
      }
    } },
    session: { modelName: 'trSession', cookieCache: { enabled: false }, expiresIn: 604800 },
    socialProviders: googleAvailable ? { google: { clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET!, disableImplicitSignUp: true } } : {},
    account: { modelName: 'trAccount', accountLinking: { enabled: false, disableImplicitLinking: true, allowDifferentEmails: false, updateUserInfoOnLink: false } }, verification: { modelName: 'trAuthVerification' },
    onAPIError: { errorURL: new URL('/login?oauth=google', env.FRONTEND_URL).href },
    emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128, requireEmailVerification: true, revokeSessionsOnPasswordReset: true, sendResetPassword: async ({ user, url }) => send(user.email, 'Reset your Blazemap password', url) },
    emailVerification: { sendOnSignUp: true, sendOnSignIn: true, expiresIn: 3600, sendVerificationEmail: async ({ user, url }) => send(user.email, 'Verify your Blazemap email', url) },
    rateLimit: { enabled: true, window: 60, max: 30, customRules: { '/get-session': { window: 60, max: 120 } } },
    advanced: { ipAddress: { ipAddressHeaders: ['x-blazemap-client-ip'] }, disableOriginCheck: false, disableCSRFCheck: false, useSecureCookies: env.NODE_ENV === 'production', defaultCookieAttributes: { httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax' } },
    databaseHooks: {
      user: {
        create: { before: async (user, context) => ({ data: { ...user, image: context?.path === '/callback/:id' ? googleAvatar(user.image) : null, role: 'USER', active: true, canConfirmIncidents: false, canPublishInformation: false } }) },
        update: { before: async user => {
          if (Object.hasOwn(user, 'image')) throw new APIError('BAD_REQUEST', { message: 'Use the protected avatar upload endpoint' });
          return { data: user };
        } },
      },
      session: { create: { before: async session => {
        const user = await client.msUser.findUnique({ where: { id: session.userId }, select: { active: true, emailVerified: true } });
        if (!user?.active) throw new APIError('UNAUTHORIZED', { code: 'account_unavailable', message: 'Account unavailable' });
        if (!user.emailVerified) throw new APIError('UNAUTHORIZED', { code: 'email_not_verified', message: 'Verify your email before logging in' });
        return { data: session };
      } } },
    },
  });
}
let instance: ReturnType<typeof createAuth> | undefined;
export function auth() { return instance ??= createAuth(); }
