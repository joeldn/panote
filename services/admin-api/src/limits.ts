import { readJsonBody, WorkerError } from '@internal/worker-kit';

// Every other limiter binding's `simple.period` (wrangler.jsonc), sent as the 429's
// Retry-After. The limits themselves live in wrangler.jsonc, per env.
export const WRITE_RATE_PERIOD_SECONDS = 60;
// PANO_DELETE_LIMITER's, a cost cap on pano and tour deletes (R2 sweeps and a CDN prefix
// purge each). It doesn't keep the account's prefix-purge budget whole: the purge queue
// absorbs a 429, and takedowns purge by URL (docs/deploy.md, CDN purge on delete). A
// delete that then 404s still counts, as any request does.
export const PANO_DELETE_RATE_PERIOD_SECONDS = 60;

/**
 * The largest scene config body PUT /api/admin/panos/:panoId/config takes. A config at
 * every schema cap (200 hotspots with 20,000-character bodies, 2,048-character media
 * urls and 200,000 translated characters) is about 4.5 MiB of JSON in ASCII and 12.6 MiB
 * written entirely in 3-byte characters (CJK), so 14 MiB takes every config the schema
 * allows whose text JSON writes as itself. Characters JSON escapes as \uXXXX (control
 * characters, lone surrogates) take 6 bytes each, so text made mostly of them can reach
 * about 25 MiB at the caps and is refused with a 413. The body is decoded as it streams
 * in (worker-kit's body.ts), so the bytes are never held twice. A config over
 * BACKUP_MAX_OBJECT_BYTES (8 MiB, backup.ts) is stored but left out of the daily backup,
 * which reports it.
 */
export const MAX_CONFIG_BODY_BYTES = 14 * 1024 * 1024;

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
