import type { RequestHandler } from 'express';
import { asyncHandler } from '../../utils/index.js';

export function respond(action: RequestHandler): RequestHandler { return asyncHandler(action); }
export function single(run: (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]) => unknown | Promise<unknown>, status = 200): RequestHandler {
  return respond(async (req, res) => { res.status(status).json({ data: await run(req, res) }); });
}
export function list(run: (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]) => unknown | Promise<unknown>): RequestHandler {
  return respond(async (req, res) => { res.json(await run(req, res)); });
}
