import { createHash } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { z } from 'zod';

export class AppError extends Error {
  constructor(message: string, public status = 400, public code = 'INVALID_REQUEST', public errors?: unknown) { super(message); }
}
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
  if (!response.ok || !response.body) throw unavailable('Source');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) throw unavailable('Source payload');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString('utf8');
}
