import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { toNodeHandler } from 'better-auth/node';
import { auth, databaseAvailable, emailAvailable, env, origins, swaggerRouter } from './config/index.js';
import { databaseGuard, errorHandler, originGuard, requestLogger } from './middleware/index.js';
import { apiRouter, status } from './modules/index.js';
import { unavailable } from './utils/index.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  app.use(helmet());
  app.use(requestLogger);
  app.use(cors({ origin: origins, credentials: true, methods: ['GET', 'POST', 'PATCH', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'X-Blazemap-Expected-Updated-At', 'X-Blazemap-Audit-Reason'], exposedHeaders: ['Retry-After', 'X-Retry-After'] }));
  app.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use(rateLimit({ windowMs: 60000, limit: 180, standardHeaders: 'draft-8', legacyHeaders: false, message: { message: 'Too many requests', code: 'RATE_LIMIT' } }));
  app.get('/health', async (_req, res) => { const ready = await databaseAvailable(); res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'unavailable' }); });
  app.get('/api/public/status', async (_req, res) => { res.json({ data: await status() }); });
  app.use('/api', swaggerRouter);
  app.use(databaseGuard);
  app.all('/api/auth/{*splat}', async (req, res) => {
    if (!emailAvailable && /\/(sign-up\/email|request-password-reset|send-verification-email|forget-password)$/.test(req.path)) throw unavailable('Email delivery');
    req.headers['x-blazemap-client-ip'] = req.ip ?? req.socket.remoteAddress;
    await toNodeHandler(auth())(req, res);
  });
  app.use(express.json({ limit: '512kb' }));
  app.use(originGuard);
  app.use('/api', apiRouter);
  app.use((_req, res) => { res.status(404).json({ message: 'Endpoint not found', code: 'NOT_FOUND' }); });
  app.use(errorHandler);
  return app;
}
