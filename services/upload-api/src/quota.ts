import { userPanosPrefix } from '@internal/contracts';
import type { R2S3Client } from '@internal/worker-kit/r2-s3';

// Per-owner quotas. Every var is optional: unset (or empty) means unlimited, and
// an owner with no limit set costs no extra R2 request at all.
export interface QuotaEnv {
  /** Most panos one owner may hold, counting the one about to be uploaded. */
  MAX_PANOS_PER_OWNER?: string | undefined;
  /** Most bytes of originals one owner may hold, counting the declared upload size. */
  MAX_BYTES_PER_OWNER?: string | undefined;
  /** Most originals one owner may write in a rolling 24 hours, counting this one. */
  MAX_UPLOADS_PER_OWNER_PER_DAY?: string | undefined;
}

export interface QuotaLimits {
  maxPanos: number | null;
  maxBytes: number | null;
  maxUploadsPerDay: number | null;
}

export const UPLOAD_WINDOW_MS = 24 * 60 * 60 * 1000;

// A var that isn't a non-negative integer is a config mistake: fail closed
// (no uploads) rather than silently lift the limit.
const parseLimit = (name: string, raw: string | undefined): number | null => {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
};

export const quotaLimits = (env: QuotaEnv): QuotaLimits => ({
  maxPanos: parseLimit('MAX_PANOS_PER_OWNER', env.MAX_PANOS_PER_OWNER),
  maxBytes: parseLimit('MAX_BYTES_PER_OWNER', env.MAX_BYTES_PER_OWNER),
  maxUploadsPerDay: parseLimit('MAX_UPLOADS_PER_OWNER_PER_DAY', env.MAX_UPLOADS_PER_OWNER_PER_DAY),
});

export type QuotaRefusal =
  'pano limit reached' | 'storage limit reached' | 'daily upload limit reached';

export interface QuotaRequest {
  /** Declared size of the upload, in bytes. */
  size: number;
  /** Set for a replace: that pano already counts, and its old original's bytes go. */
  replacing?: string | undefined;
  /** Epoch ms; the daily window is the 24 hours before it. */
  now: number;
}

/**
 * The upload-URL issuing path's quota hook. Null when the upload fits (or no
 * limit is set), otherwise the reason it doesn't. Counts what is in the
 * owner's prefix now, so it is a soft cap: concurrent requests can each pass.
 * A pano with a delete tombstone (`deleting`) is on its way out and doesn't count
 * toward panos or bytes.
 *
 * A replace adds no pano, so at the pano limit it is fine; an owner already over
 * it (the limit was lowered under them) gets no replace either, as for storage.
 *
 * The daily limit counts originals whose last write is inside the past 24 hours,
 * from the same listing (no extra request, no new state): every new pano, and
 * every replaced one, counts once; a tombstoned one still counts, since it was
 * tiled. It counts writes, not URLs: a URL issued but not yet used isn't seen,
 * and replacing one pano again within the day doesn't count twice. The upload-URL
 * rate limiter and the presign expiry bound those; see docs/deploy.md.
 *
 * Known cost: with a limit set, every upload-URL request lists the owner's whole
 * panos/ prefix (one LIST per 1,000 objects, several objects per pano). Unset,
 * nothing is listed.
 */
export const checkQuota = async (
  r2: Pick<R2S3Client, 'listObjects'>,
  sub: string,
  limits: QuotaLimits,
  req: QuotaRequest,
): Promise<QuotaRefusal | null> => {
  if (limits.maxPanos === null && limits.maxBytes === null && limits.maxUploadsPerDay === null) {
    return null;
  }
  const prefix = userPanosPrefix(sub);
  const originalBytes = new Map<string, number>();
  const panoIds = new Set<string>();
  const deleting = new Set<string>();
  const since = req.now - UPLOAD_WINDOW_MS;
  let uploadsToday = 0;
  for (const { key, size, lastModified } of await r2.listObjects(prefix)) {
    const [panoId, name] = key.slice(prefix.length).split('/');
    if (!panoId) continue;
    panoIds.add(panoId);
    if (name === 'deleting') deleting.add(panoId);
    if (name === 'original') {
      originalBytes.set(panoId, size);
      // NaN (no LastModified) fails closed: it counts as recent. The pano being
      // replaced is left out, since this upload counts it again below.
      if (panoId !== req.replacing && !(lastModified < since)) uploadsToday += 1;
    }
  }
  let panos = 0;
  let bytes = 0;
  for (const panoId of panoIds) {
    if (deleting.has(panoId)) continue;
    panos += 1;
    if (panoId !== req.replacing) bytes += originalBytes.get(panoId) ?? 0;
  }
  if (limits.maxPanos !== null) {
    // A new pano must fit under the limit; a replace only must not be over it.
    if (req.replacing === undefined ? panos >= limits.maxPanos : panos > limits.maxPanos) {
      return 'pano limit reached';
    }
  }
  if (limits.maxBytes !== null && bytes + req.size > limits.maxBytes) {
    return 'storage limit reached';
  }
  if (limits.maxUploadsPerDay !== null && uploadsToday + 1 > limits.maxUploadsPerDay) {
    return 'daily upload limit reached';
  }
  return null;
};
