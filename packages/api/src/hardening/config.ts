import type { RequestHandler, Response } from 'express';

export type StartupConfigFlags = Record<string, true>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Adds the flags to the startup config the client already loads (`GET /api/config`), so the
 * client needs no extra request. Mounted on `/api/config` ahead of its router.
 */
export function createStartupConfigFlags(flags: StartupConfigFlags): RequestHandler {
  return (req, res, next) => {
    if (req.method === 'GET' && req.path === '/') {
      const json = res.json;
      res.json = function (this: Response, body?: unknown) {
        return json.call(this, isPlainObject(body) ? { ...body, ...flags } : body);
      } as Response['json'];
    }
    next();
  };
}
