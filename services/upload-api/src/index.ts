import {
  accountDeletionKey,
  accountDisabledKey,
  deletingKey,
  originalKey,
  PANO_PATTERN,
} from '@internal/contracts';
import { authenticate, rateLimit, toErrorResponse, WorkerError } from '@internal/worker-kit';
import { createR2S3Client, type R2HeadResult } from '@internal/worker-kit/r2-s3';

import { checkQuota, quotaLimits } from './quota.js';

// Mirrors the MAX_ORIGINAL_BYTES wrangler var (services/tiler-consumer/wrangler.jsonc:55,92).
const MAX_ORIGINAL_BYTES = 150 * 1024 * 1024;
// A HEAD that isn't a clean 404 (a transient 5xx, or a 403) must never be
// read as "doesn't exist" - that would fail open during an R2 hiccup.
const assertHeadIsDefinitive = (head: R2HeadResult): void => {
  if (!head.ok && head.status !== 404) throw new WorkerError('storage unavailable', 502);
};
// The UPLOAD_URL_LIMITER binding's `simple.period` (wrangler.jsonc), sent as the
// 429's Retry-After. The limit itself lives in wrangler.jsonc, per env.
export const UPLOAD_URL_RATE_PERIOD_SECONDS = 60;
const ALLOWED_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

interface UploadUrlBody {
  contentType?: unknown;
  size?: unknown;
  panoId?: unknown;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== 'POST' || url.pathname !== '/api/upload-url') {
      return Response.json({ error: 'not found' }, { status: 404 });
    }
    try {
      const { sub } = await authenticate(req, env);
      // Per owner, before any R2 request: a runaway client can't run up S3 calls.
      const limited = await rateLimit(env.UPLOAD_URL_LIMITER, sub, UPLOAD_URL_RATE_PERIOD_SECONDS);
      if (limited) return limited;
      const body = ((await req.json().catch(() => null)) ?? {}) as UploadUrlBody;

      const contentType = body.contentType;
      if (typeof contentType !== 'string' || !ALLOWED_CONTENT_TYPES.has(contentType)) {
        return Response.json(
          { error: 'contentType must be image/jpeg, image/png, or image/webp' },
          { status: 400 },
        );
      }
      const size = body.size;
      if (
        typeof size !== 'number' ||
        !Number.isSafeInteger(size) ||
        size <= 0 ||
        size > MAX_ORIGINAL_BYTES
      ) {
        return Response.json(
          {
            error: `size must be a positive integer number of bytes, up to ${MAX_ORIGINAL_BYTES} (150 MiB)`,
          },
          { status: 400 },
        );
      }

      const r2 = createR2S3Client({
        accountId: env.R2_ACCOUNT_ID,
        bucket: env.R2_BUCKET,
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        // A persistent 5xx must surface as a 502 in a few requests, not
        // after aws4fetch's default 10 retries (~30s of backoff).
        retries: 2,
      });

      // An account marked for deletion (410) or disabled by the operator (403) gets
      // no new upload URL, as admin-api refuses its writes. Fails closed like the
      // HEADs below: no clear answer, no URL.
      const [deletion, disabled] = await Promise.all([
        r2.head(accountDeletionKey(sub)),
        r2.head(accountDisabledKey(sub)),
      ]);
      assertHeadIsDefinitive(deletion);
      assertHeadIsDefinitive(disabled);
      if (deletion.ok) return Response.json({ error: 'account deleted' }, { status: 410 });
      if (disabled.ok) return Response.json({ error: 'account disabled' }, { status: 403 });

      // panoId given -> replace-image: only an existing, non-tombstoned
      // original under the caller's own prefix may be re-presigned.
      let panoId: string;
      if ('panoId' in body) {
        if (typeof body.panoId !== 'string' || body.panoId.length === 0) {
          return Response.json({ error: 'panoId must be a non-empty string' }, { status: 400 });
        }
        if (!PANO_PATTERN.test(body.panoId)) {
          return Response.json({ error: `panoId must match ${PANO_PATTERN}` }, { status: 400 });
        }
        panoId = body.panoId;
        const [original, tombstone] = await Promise.all([
          r2.head(originalKey(sub, panoId)),
          r2.head(deletingKey(sub, panoId)),
        ]);
        assertHeadIsDefinitive(original);
        assertHeadIsDefinitive(tombstone);
        if (original.status === 404 || tombstone.ok) {
          return Response.json({ error: 'original not found' }, { status: 404 });
        }
      } else {
        panoId = crypto.randomUUID();
      }

      // Owner quotas, last before signing: only a request that would otherwise get
      // a URL pays for the listing, and only when a limit is set.
      const limits = quotaLimits(env);
      const refusal = await checkQuota(r2, sub, limits, {
        size,
        replacing: 'panoId' in body ? panoId : undefined,
      }).catch(() => {
        // A failed listing is no answer either: fail closed, as for the HEADs.
        throw new WorkerError('storage unavailable', 502);
      });
      if (refusal) return Response.json({ error: refusal }, { status: 403 });

      const key = originalKey(sub, panoId);
      const putUrl = await r2.presignPut(key, { headers: { 'content-type': contentType } });
      return Response.json({ panoId, key, url: putUrl });
    } catch (e) {
      return toErrorResponse(e);
    }
  },
};
