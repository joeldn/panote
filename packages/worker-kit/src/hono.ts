import { HTTPException } from 'hono/http-exception';
import { routePath } from 'hono/route';
import type { Context, MiddlewareHandler } from 'hono';

import { describeError, WorkerError } from './errors.js';
import { recordOps, type OpsEventSink } from './ops-events.js';

/**
 * Hono onError handler. WorkerError -> { error: message } at its status;
 * HTTPException -> its own response (Hono throws these internally);
 * anything else -> { error: 'internal' } at 500.
 */
export const errorHandler = (err: Error, _c: Context): Response => {
  if (err instanceof WorkerError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  // Hono throws HTTPException itself (bad method, malformed body); honour it.
  if (err instanceof HTTPException) return err.getResponse();
  // Message, stack and cause chain, owner segments masked (like toErrorResponse):
  // logging the Error itself would print a key's base64url(sub) as is.
  console.error('unhandled worker error:', describeError(err));
  return Response.json({ error: 'internal' }, { status: 500 });
};

/**
 * Records a `server-error` operator event for every 5xx the app answers, thrown (turned
 * into a 500 by errorHandler) or returned. Cloudflare counts both as successful
 * invocations, so nothing else counts them. Register it first, so it sees every answer.
 * The detail names the route as registered (`/api/admin/tours/:tourId`), never the path,
 * which carries ids: after `next()` Hono's route index is the handler that answered.
 */
export const recordServerErrors =
  (service: string): MiddlewareHandler<{ Bindings: { OPS_EVENTS?: OpsEventSink } }> =>
  async (c, next) => {
    await next();
    if (c.res.status < 500) return;
    recordOps(c.env?.OPS_EVENTS, service, {
      event: 'server-error',
      detail: `${c.res.status} ${c.req.method} ${routePath(c) || 'unknown'}`,
    });
  };
