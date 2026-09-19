import { createHash } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { z } from 'zod';

export class AppError extends Error {
  constructor(message: string, public status = 400, public code = 'INVALID_REQUEST', public errors?: unknown) { super(message); }
}
export function safeErrorCode(error: unknown, fallback = 'INTERNAL_ERROR') {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : fallback;
}
export const sourceSyncExitCode = (error: unknown) => safeErrorCode(error, 'SYNC_FAILED') === 'SYNC_RATE_LIMIT' ? 0 : 1;
export const unavailable = (service: string) => new AppError(`${service} unavailable`, 503, 'SERVICE_UNAVAILABLE');
export function fingerprint(value: unknown): string {
  function canonical(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)]));
    return v;
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export const jsonValue = (value: unknown) => JSON.parse(JSON.stringify(value)) as import('../generated/prisma/client.js').Prisma.InputJsonValue;
export const asyncHandler = (handler: RequestHandler): RequestHandler => (req, res, next) => { Promise.resolve(handler(req, res, next)).catch(next); };
export const routeId = (req: Request, name = 'id') => z.string().min(1).max(128).parse(req.params[name]);
export async function boundedText(response: Response, maxBytes = 8 * 1024 * 1024): Promise<string> {
  if (!response.ok) throw new AppError('Source returned an unsuccessful status', 503, 'SOURCE_HTTP_STATUS');
  if (!response.body) throw new AppError('Source response body unavailable', 503, 'SOURCE_BODY_MISSING');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) throw new AppError('Source response exceeded the size limit', 503, 'SOURCE_PAYLOAD_TOO_LARGE');
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AppError || error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) throw error;
    throw new AppError('Source response could not be read', 503, 'SOURCE_READ_FAILED');
  } finally { await reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks).toString('utf8');
}
