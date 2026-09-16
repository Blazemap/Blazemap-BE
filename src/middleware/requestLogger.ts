import type { RequestHandler } from 'express';

export const requestLogger: RequestHandler = (req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const status = res.statusCode;
    const color = status < 300 ? '\x1b[32m' : status < 400 ? '\x1b[33m' : '\x1b[31m';
    const route = typeof req.route?.path === 'string' ? req.route.path : '[unmatched]';
    console.log(`\x1b[2m${'='.repeat(72)}\x1b[0m\n\x1b[2m${new Date().toISOString()}\x1b[0m \x1b[36m${req.method.padEnd(6)}\x1b[0m ${route} ${color}${status}\x1b[0m \x1b[35m${Date.now() - started}ms\x1b[0m`);
  });
  next();
};
