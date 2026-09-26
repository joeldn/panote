import { deletingKey, originalKey, PANO_PATTERN } from '@internal/contracts';
import { authenticate, toErrorResponse, WorkerError } from '@internal/worker-kit';
import { createR2S3Client, type R2HeadResult } from '@internal/worker-kit/r2-s3';

// Mirrors the MAX_ORIGINAL_BYTES wrangler var (services/tiler-consumer/wrangler.jsonc:55,92).
const MAX_ORIGINAL_BYTES = 150 * 1024 * 1024;
// A HEAD that isn't a clean 404 (a transient 5xx, or a 403) must never be
// read as "doesn't exist" - that would fail open during an R2 hiccup.
const assertHeadIsDefinitive = (head: R2HeadResult): void => {
  if (!head.ok && head.status !== 404) throw new WorkerError('storage unavailable', 502);
};
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

      const key = originalKey(sub, panoId);
      const putUrl = await r2.presignPut(key, { headers: { 'content-type': contentType } });
      return Response.json({ panoId, key, url: putUrl });
    } catch (e) {
      return toErrorResponse(e);
    }
  },
};
