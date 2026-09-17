import 'dotenv/config';
import { z } from 'zod';

const optional = z.preprocess(v => v === '' ? undefined : v, z.string().optional());
const oauthCredential = (schema: z.ZodString) => z.preprocess(v => typeof v === 'string' && !v.trim() ? undefined : v, schema.optional());
const raw = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  DATABASE_URL: optional, BETTER_AUTH_SECRET: optional, BETTER_AUTH_URL: optional, FRONTEND_URL: optional,
  GOOGLE_CLIENT_ID: oauthCredential(z.string().max(256).regex(/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/)),
  GOOGLE_CLIENT_SECRET: oauthCredential(z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/)),
  AI_SERVICE_URL: optional, AI_SERVICE_TOKEN: optional, AI_AUTO_REANALYZE: optional, FIRMS_MAP_KEY: optional, FIRMS_PRODUCTS: optional, FIRMS_AREA: optional, FIRMS_POLL_INTERVAL_MS: optional, BMKG_POLL_INTERVAL_MS: optional,
  TRIAGE_HOTSPOT_RADIUS_METERS: optional, TRIAGE_HOTSPOT_WINDOW_HOURS: optional, TRIAGE_SETTLEMENT_RADIUS_METERS: optional,
  S3_ENDPOINT: optional, S3_REGION: optional, S3_BUCKET: optional, S3_ACCESS_KEY_ID: optional, S3_SECRET_ACCESS_KEY: optional, S3_FORCE_PATH_STYLE: optional,
  SMTP_HOST: optional, SMTP_PORT: optional, SMTP_SECURE: optional, SMTP_USER: optional, SMTP_PASSWORD: optional, SMTP_FROM: optional,
}).safeParse(process.env);
if (!raw.success) throw new Error('Invalid backend configuration');
export const env = raw.data;
export function pollIntervals(source: { FIRMS_POLL_INTERVAL_MS?: string; BMKG_POLL_INTERVAL_MS?: string } = env) {
  const parse = (value: string | undefined, fallback: number, minimum: number) => z.coerce.number().int().min(minimum).max(86400000).parse(value || fallback);
  return { FIRMS: parse(source.FIRMS_POLL_INTERVAL_MS, 900000, 900000), BMKG: parse(source.BMKG_POLL_INTERVAL_MS, 21600000, 3600000) };
}
export function reevaluationAllowed(source: { AI_AUTO_REANALYZE?: string; AI_SERVICE_URL?: string; AI_SERVICE_TOKEN?: string } = env) {
  return source.AI_AUTO_REANALYZE === 'true' && !!source.AI_SERVICE_URL && !!source.AI_SERVICE_TOKEN;
}
export const origins = [env.FRONTEND_URL, env.BETTER_AUTH_URL].filter((v): v is string => !!v).map(v => {
  try {
    const url = new URL(v);
    if (!['http:', 'https:'].includes(url.protocol) || (env.NODE_ENV === 'production' && url.protocol !== 'https:')) throw new Error();
    return url.origin;
  } catch { throw new Error('Invalid application origin configuration'); }
});
export const googleAvailable = !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
export const emailAvailable = !!(env.SMTP_HOST && env.SMTP_PORT && env.SMTP_FROM && (env.SMTP_USER ? env.SMTP_PASSWORD : true));
export const uploadsAvailable = !!(env.S3_REGION && env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY);
