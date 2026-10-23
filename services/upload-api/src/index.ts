import {
  accountDeletionKey,
  accountDisabledKey,
  contentIdError,
  deletingKey,
  isContentId,
  MAX_PLAN_BYTES,
  originalKey,
  planKey,
  planPrefix,
  resolveTourAccess,
  tourKey,
  uploadedForKey,
  type AccessStore,
  type PanoUploadedFor,
  type PlanImageType,
  type TourDoc,
} from '@internal/contracts';
import {
  authenticate,
  rateLimit,
  readJsonBody,
  toErrorResponse,
  WorkerError,
} from '@internal/worker-kit';
import { createR2S3Client, type R2HeadResult } from '@internal/worker-kit/r2-s3';

import {
  pausedResponse,
  releaseLater,
  reserveCeiling,
  UploadCeiling,
  type Held,
} from './ceiling.js';
import {
  checkDailyUploads,
  checkQuota,
  quotaLimits,
  recordUpload,
  UPLOAD_LOG_PRUNE_MAX,
} from './quota.js';

// Mirrors the MAX_ORIGINAL_BYTES wrangler var (services/tiler-consumer/wrangler.jsonc:55,92).
const MAX_ORIGINAL_BYTES = 150 * 1024 * 1024;
// Most bytes of plan images one tour's prefix may hold, counting the declared upload:
// the live image, a replaced one the share link still shows, and a few uploaded but not
// saved yet. admin-api sweeps unused ones (an hour old) on the tour's next save.
export const MAX_PLAN_BYTES_PER_TOUR = 4 * MAX_PLAN_BYTES;
// A HEAD that isn't a clean 404 (a transient 5xx, or a 403) must never be
// read as "doesn't exist" - that would fail open during an R2 hiccup.
const assertHeadIsDefinitive = (head: R2HeadResult): void => {
  if (!head.ok && head.status !== 404) throw new WorkerError('storage unavailable', 502);
};
// The UPLOAD_URL_LIMITER binding's `simple.period` (wrangler.jsonc), sent as the
// 429's Retry-After. The limit itself lives in wrangler.jsonc, per env.
export const UPLOAD_URL_RATE_PERIOD_SECONDS = 60;
// How long an upload URL stays valid. The admin uploader PUTs the moment it gets
// the URL, so this mostly bounds replays of a leaked or reused URL. 600 s still
// covers a whole 150 MiB PUT at ~2 Mbit/s, in case R2 (unlike S3, which checks
// only when the request starts) were to check expiry at the end of a slow upload.
export const UPLOAD_URL_EXPIRY_SECONDS = 600;
const ALLOWED_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
// The request body is a handful of short fields (contentType, size, panoId or kind and
// tourId): anything bigger than this is not ours, and is never buffered.
export const MAX_BODY_BYTES = 8 * 1024;

interface UploadUrlBody {
  /** Absent for a pano's original; `'plan'` for a tour's floor-plan image. */
  kind?: unknown;
  contentType?: unknown;
  size?: unknown;
  panoId?: unknown;
  /**
   * The tour a plan image is for (required), or the tour an original is for (optional): an
   * editor of someone else's tour uploads into that tour owner's account.
   */
  tourId?: unknown;
}

type R2 = ReturnType<typeof createR2S3Client>;

// resolveTourAccess's reads over the S3 API. Anything but a clean 404 throws, as for the
// HEADs: no clear answer must never read as "no such member".
const s3Store = (r2: R2): AccessStore => ({
  exists: async (key) => {
    const head = await r2.head(key);
    assertHeadIsDefinitive(head);
    return head.ok;
  },
  readJson: async (key) => {
    const res = await r2.get(key);
    if (res.status === 404) return null;
    if (!res.ok) throw new WorkerError('storage unavailable', 502);
    return res.json().catch(() => null);
  },
});

/**
 * Whose account an upload for `tourId` goes into: the caller's when they own the tour, the
 * owner's when they are one of its editors. A Response when neither, or when the owner's
 * account is being deleted (404) or disabled by the operator (403).
 */
async function tourOwnerFor(r2: R2, sub: string, tourId: string): Promise<string | Response> {
  const access = await resolveTourAccess(s3Store(r2), sub, tourId);
  if (!access) return Response.json({ error: 'tour not found' }, { status: 404 });
  if (access.role === 'owner') return sub;
  const [deletion, disabled] = await Promise.all([
    r2.head(accountDeletionKey(access.owner)),
    r2.head(accountDisabledKey(access.owner)),
  ]);
  assertHeadIsDefinitive(deletion);
  assertHeadIsDefinitive(disabled);
  if (deletion.ok) return Response.json({ error: 'tour not found' }, { status: 404 });
  if (disabled.ok) return Response.json({ error: 'owner account disabled' }, { status: 403 });
  return access.owner;
}

// A tour's floor-plan image: a fresh key under the tour's public plan prefix, so a
// replaced image is never served stale from a cache. Only the owner of the tour, or one
// of its editors, gets one. It counts toward the daily upload limit and the global ceiling (it is an upload
// URL), and toward its tour's MAX_PLAN_BYTES_PER_TOUR, not the owner's storage quota:
// the prefix is owner-free, so counting it per owner would list every tour's. The cap
// is soft (see below): it keeps a tour near 16 MiB in normal use, but a client that
// takes a day's URLs before uploading can get one tour to about 216 MiB, and an owner
// to about 40 GiB across MAX_TOURS_PER_OWNER tours over many days (docs/deploy.md).
async function planUrl(
  r2: R2,
  sub: string,
  tourId: string,
  contentType: PlanImageType,
  size: number,
  { env, ctx, reserved }: { env: Env; ctx: ExecutionContext; reserved: Reserved },
): Promise<Response> {
  const owner = await tourOwnerFor(r2, sub, tourId);
  if (owner instanceof Response) return owner;
  // Every page of the prefix (listObjects follows continuation tokens). Soft: it counts
  // what is stored now, so parallel requests, and URLs issued but not yet PUT, can each
  // pass and take the tour past the cap.
  const stored = await r2.listObjects(planPrefix(tourId)).catch(unavailable);
  if (stored.reduce((sum, o) => sum + o.size, size) > MAX_PLAN_BYTES_PER_TOUR) {
    return Response.json({ error: 'plan storage limit reached' }, { status: 403 });
  }
  const planId = crypto.randomUUID();
  const subs = uploaders(sub, owner);
  const now = Date.now();
  const refused =
    (await dailyLimit(r2, subs, quotaLimits(env).maxUploadsPerDay, now, ctx)) ??
    (await reserveAndLog(r2, subs, planId, size, now, { env, reserved }));
  if (refused) return refused;
  const key = planKey(tourId, planId, contentType);
  const url = await r2.presignPut(key, {
    expiresInSeconds: UPLOAD_URL_EXPIRY_SECONDS,
    headers: { 'content-type': contentType },
    contentLength: size,
  });
  return Response.json({ planId, key, url });
}

// The global ceiling's reservation for this request, once made: the Worker's catch gives
// it back if anything fails before the URL is returned.
interface Reserved {
  held: Held | null;
}

// Whose daily upload limit an upload counts against: the person uploading, and the
// account it goes into when that is someone else's (an editor's upload). Both, so an editor
// can't use up an owner's day unnoticed, nor get round their own limit through other tours.
const uploaders = (sub: string, owner: string): string[] => (owner === sub ? [sub] : [sub, owner]);

// The daily upload limit for one more URL: a 403 once any of `subs` has reached it.
async function dailyLimit(
  r2: R2,
  subs: readonly string[],
  maxUploadsPerDay: number | null,
  now: number,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const daily = await Promise.all(
    subs.map((s) => checkDailyUploads(r2, s, maxUploadsPerDay, now).catch(unavailable)),
  );
  for (const d of daily) pruneLater(r2, d.expired, ctx);
  if (daily.some((d) => d.refused)) {
    return Response.json({ error: 'daily upload limit reached' }, { status: 403 });
  }
  return null;
}

// Once the person's own limits pass: the global ceiling for one more URL (named by `id`,
// of `size` bytes), a 503 while it is paused, else null with the URL logged for each of
// `subs` first (no log entry, no URL).
async function reserveAndLog(
  r2: R2,
  subs: readonly string[],
  id: string,
  size: number,
  now: number,
  { env, reserved }: { env: Env; reserved: Reserved },
): Promise<Response | null> {
  const held = await reserveCeiling(env, size, now);
  if (held === 'paused') return pausedResponse(now);
  reserved.held = held;
  if (quotaLimits(env).maxUploadsPerDay !== null) {
    await Promise.all(subs.map((s) => recordUpload(r2, s, id, now).catch(unavailable)));
  }
  return null;
}

// Whether `panoId` is one of the tour's scenes, from the owner's tour.json. An editor can
// only add a pano they uploaded for the tour (admin-api), so this is safe to go by.
async function tourHasScene(r2: R2, owner: string, tourId: string, panoId: string) {
  const res = await r2.get(tourKey(owner, tourId));
  if (res.status === 404) return false;
  if (!res.ok) throw new WorkerError('storage unavailable', 502);
  const tour = (await res.json().catch(() => null)) as Pick<TourDoc, 'scenes'> | null;
  return Array.isArray(tour?.scenes) && tour.scenes.some((s) => s.panoId === panoId);
}

// A failed listing or write is no answer either: fail closed, as for the HEADs.
const unavailable = (): never => {
  throw new WorkerError('storage unavailable', 502);
};

// Best-effort: an entry left behind is outside the window and never counted.
const pruneLater = (r2: R2, expired: readonly string[], ctx: ExecutionContext): void => {
  if (expired.length === 0) return;
  ctx.waitUntil(
    Promise.allSettled(expired.slice(0, UPLOAD_LOG_PRUNE_MAX).map((k) => r2.deleteObject(k))),
  );
};

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== 'POST' || url.pathname !== '/api/upload-url') {
      return Response.json({ error: 'not found' }, { status: 404 });
    }
    const reserved: Reserved = { held: null };
    try {
      const { sub } = await authenticate(req, env);
      // Per owner, before any R2 request: a runaway client can't run up S3 calls.
      const limited = await rateLimit(env.UPLOAD_URL_LIMITER, sub, UPLOAD_URL_RATE_PERIOD_SECONDS);
      if (limited) return limited;
      // Read at most MAX_BODY_BYTES (worker-kit's body.ts). Not JSON reads as {}: the field
      // checks below answer the 400.
      const read = await readJsonBody(req, MAX_BODY_BYTES);
      if (!read.ok && read.status === 413) {
        return Response.json({ error: 'body too large' }, { status: 413 });
      }
      const raw: unknown = (read.ok ? read.value : null) ?? {};
      // A primitive or an array would throw on `in` below (a 500): a 400 instead.
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        return Response.json({ error: 'body must be a JSON object' }, { status: 400 });
      }
      const body = raw as UploadUrlBody;
      if ('kind' in body && body.kind !== 'plan') {
        return Response.json({ error: 'kind must be "plan" when given' }, { status: 400 });
      }
      const isPlan = body.kind === 'plan';

      const contentType = body.contentType;
      if (typeof contentType !== 'string' || !ALLOWED_CONTENT_TYPES.has(contentType)) {
        return Response.json(
          { error: 'contentType must be image/jpeg, image/png, or image/webp' },
          { status: 400 },
        );
      }
      const size = body.size;
      const maxBytes = isPlan ? MAX_PLAN_BYTES : MAX_ORIGINAL_BYTES;
      if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > maxBytes) {
        return Response.json(
          {
            error: `size must be a positive integer number of bytes, up to ${maxBytes} (${maxBytes / 1024 / 1024} MiB)`,
          },
          { status: 400 },
        );
      }
      if ((isPlan || 'tourId' in body) && !isContentId(body.tourId)) {
        return Response.json({ error: contentIdError('tourId') }, { status: 400 });
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

      if (isPlan) {
        return await planUrl(r2, sub, body.tourId as string, contentType as PlanImageType, size, {
          env,
          ctx,
          reserved,
        });
      }

      // The account the original goes into: the caller's, or for an editor the tour owner's.
      let owner = sub;
      if (typeof body.tourId === 'string') {
        const resolved = await tourOwnerFor(r2, sub, body.tourId);
        if (resolved instanceof Response) return resolved;
        owner = resolved;
      }

      // panoId given -> replace-image: only an existing, non-tombstoned
      // original under the owner's prefix may be re-presigned, and for an editor only
      // one of the tour's own scenes.
      let panoId: string;
      if ('panoId' in body) {
        if (typeof body.panoId !== 'string' || body.panoId.length === 0) {
          return Response.json({ error: 'panoId must be a non-empty string' }, { status: 400 });
        }
        if (!isContentId(body.panoId)) {
          return Response.json({ error: contentIdError('panoId') }, { status: 400 });
        }
        panoId = body.panoId;
        if (owner !== sub && !(await tourHasScene(r2, owner, body.tourId as string, panoId))) {
          return Response.json({ error: 'original not found' }, { status: 404 });
        }
        const [original, tombstone] = await Promise.all([
          r2.head(originalKey(owner, panoId)),
          r2.head(deletingKey(owner, panoId)),
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
      // a URL pays for the listings, and only for a limit that is set. Storage counts
      // against the account the pano goes into; the daily limit against both the uploader
      // and that account (uploaders above).
      const limits = quotaLimits(env);
      const now = Date.now();
      const subs = uploaders(sub, owner);
      const [refusal, daily] = await Promise.all([
        checkQuota(r2, owner, limits, {
          size,
          replacing: 'panoId' in body ? panoId : undefined,
        }).catch(unavailable),
        dailyLimit(r2, subs, limits.maxUploadsPerDay, now, ctx),
      ]);
      if (refusal) return Response.json({ error: refusal }, { status: 403 });
      if (daily) return daily;
      // The global ceiling, once the person's own limits pass: one DO call that reserves.
      const ceiling = await reserveAndLog(r2, subs, panoId, size, now, { env, reserved });
      if (ceiling) return ceiling;
      // An editor's new pano: the record that lets them add it to this tour, and only this
      // one (admin-api's tour PUT). Written before the URL, so no upload lands without it.
      if (owner !== sub && !('panoId' in body)) {
        const record: PanoUploadedFor = { v: 1, tourId: body.tourId as string, sub };
        await r2
          .put(uploadedForKey(owner, panoId), JSON.stringify(record), {
            contentType: 'application/json',
            ifNoneMatch: '*',
          })
          .catch(unavailable);
      }

      const key = originalKey(owner, panoId);
      // content-length is signed too: the browser sends the File's size, which is the
      // declared `size`, so a body of any other length breaks the signature.
      const putUrl = await r2.presignPut(key, {
        expiresInSeconds: UPLOAD_URL_EXPIRY_SECONDS,
        headers: { 'content-type': contentType },
        contentLength: size,
      });
      return Response.json({ panoId, key, url: putUrl });
    } catch (e) {
      // No URL went out (the log write or the signing failed): give the slot back.
      releaseLater(env, reserved.held, ctx);
      return toErrorResponse(e);
    }
  },
};

export { UploadCeiling };
