import { redactOwner } from '@internal/contracts';
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
  // The stack (or message), with any R2 key's owner segment masked: logging the
  // Error itself would print a key's base64url(sub) as is.
  console.error('unhandled worker error:', redactOwner(err.stack ?? `${err.name}: ${err.message}`));
  return Response.json({ error: 'internal' }, { status: 500 });
};
