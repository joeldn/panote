import { readJsonBody, WorkerError } from '@internal/worker-kit';

// Every limiter binding's `simple.period` (wrangler.jsonc), sent as the 429's
// Retry-After. The limits themselves live in wrangler.jsonc, per env.
export const WRITE_RATE_PERIOD_SECONDS = 60;

/**
 * The largest scene config body PUT /api/admin/panos/:panoId/config takes. A config at
 * every schema cap (200 hotspots with 20,000-character bodies, 2,048-character media
 * urls and 200,000 translated characters) is about 4.5 MiB of JSON in ASCII and 12.6 MiB
 * in 3-byte UTF-8 (CJK text). 16 MiB lets that through and still bounds what one request
 * can make the Worker hold, which is well under the isolate's 128 MB.
 */
export const MAX_CONFIG_BODY_BYTES = 16 * 1024 * 1024;

/**
 * Every other write body: a tour (100 scenes, 10 languages' titles and descriptions) is
 * under 50 KiB at its caps, an operator restore (100 keys of 512 characters) about 52 KiB,
 * and the publish, slug, visibility, account and takedown bodies a few hundred bytes.
 */
export const MAX_WRITE_BODY_BYTES = 256 * 1024;

/**
 * A write's JSON body, read at most `maxBytes` (worker-kit's body.ts): a bigger body is a
 * 413 before it is buffered. A body that isn't JSON reads as `{}`, so the route's own
 * schema answers its 400, as it did when routes called `c.req.json()`.
 */
export const jsonBody = async (
  req: Request,
  maxBytes: number = MAX_WRITE_BODY_BYTES,
): Promise<unknown> => {
  const body = await readJsonBody(req, maxBytes);
  if (body.ok) return body.value;
  if (body.status === 413) throw new WorkerError('body too large', 413);
  return {};
};

/** jsonBody for a route that adds fields to the body: anything but an object reads as `{}`. */
export const jsonObjectBody = async (
  req: Request,
  maxBytes: number = MAX_WRITE_BODY_BYTES,
): Promise<Record<string, unknown>> => {
  const value = await jsonBody(req, maxBytes);
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};
