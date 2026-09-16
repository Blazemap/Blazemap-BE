import type { ErrorRequestHandler, RequestHandler } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import { auth, db, databaseAvailable, origins } from '../config/index.js';
import { AppError, unavailable } from '../utils/index.js';
import type { Actor } from '../types/index.js';

export const databaseGuard: RequestHandler = async (_req, _res, next) => { if (!(await databaseAvailable())) throw unavailable('Database'); next(); };
export const sessionGuard: RequestHandler = async (req, res, next) => {
  const session = await auth().api.getSession({ headers: fromNodeHeaders(req.headers), query: { disableCookieCache: true } });
  if (!session) throw new AppError('Login required', 401, 'UNAUTHORIZED');
  const user = await db().msUser.findUnique({ where: { id: session.user.id }, select: { id: true, role: true, active: true, canConfirmIncidents: true, canPublishInformation: true } });
  if (!user?.active) throw new AppError('Login required', 401, 'UNAUTHORIZED');
  res.locals.actor = user satisfies Actor;
  next();
};
export const adminGuard: RequestHandler = (_req, res, next) => { if ((res.locals.actor as Actor).role !== 'ADMIN') throw new AppError('Administrator access required', 403, 'FORBIDDEN'); next(); };
export const originGuard: RequestHandler = (req, _res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.headers.origin;
    if (!origin || !origins.includes(origin)) throw new AppError('Request origin not allowed', 403, 'INVALID_ORIGIN');
    if (!req.is('application/json')) throw new AppError('JSON request required', 415, 'INVALID_CONTENT_TYPE');
  }
  next();
};
export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (error instanceof z.ZodError) { res.status(400).json({ message: 'Validation failed', code: 'VALIDATION_ERROR', errors: error.issues.map(i => ({ path: i.path.join('.'), message: i.message })) }); return; }
  if (error instanceof AppError) { res.status(error.status).json({ message: error.message, code: error.code, ...(error.errors ? { errors: error.errors } : {}) }); return; }
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (['P2002', 'P2034'].includes(code)) { res.status(409).json({ message: 'Conflicting change; refresh and retry', code: 'CONFLICT' }); return; }
  if (code === 'P2025') { res.status(404).json({ message: 'Record not found', code: 'NOT_FOUND' }); return; }
  if (code === 'P2003') { res.status(400).json({ message: 'Referenced record is unavailable', code: 'INVALID_REFERENCE' }); return; }
  if (['P1000', 'P1001', 'P1002', 'P1017', 'P2021', 'P2022', 'P2024', 'ECONNREFUSED', 'ETIMEDOUT', '42P01'].includes(code)) { res.status(503).json({ message: 'Database unavailable', code: 'SERVICE_UNAVAILABLE' }); return; }
  if (error instanceof SyntaxError) { res.status(400).json({ message: 'Invalid JSON request', code: 'INVALID_JSON' }); return; }
  const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 500;
  res.status(status === 413 ? 413 : 500).json({ message: status === 413 ? 'Request too large' : 'Request could not be completed', code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL_ERROR' });
};
