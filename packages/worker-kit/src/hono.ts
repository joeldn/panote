import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';

import { WorkerError } from './errors.js';

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
  console.error('unhandled worker error:', err);
  return Response.json({ error: 'internal' }, { status: 500 });
};
