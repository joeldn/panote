import {
  uploadLogKey,
  uploadLogTime,
  userPanosPrefix,
  userUploadLogPrefix,
} from '@internal/contracts';
import type { R2S3Client } from '@internal/worker-kit/r2-s3';

// Per-owner quotas. Every var is optional: unset (or empty) means unlimited, and
// an owner with no limit set costs no extra R2 request at all.
export interface QuotaEnv {
  /** Most panos one owner may hold, counting the one about to be uploaded. */
  MAX_PANOS_PER_OWNER?: string | undefined;
  /** Most bytes of originals one owner may hold, counting the declared upload size. */
  MAX_BYTES_PER_OWNER?: string | undefined;
  /** Most upload URLs one owner may get in a rolling 24 hours, counting this one. */
  MAX_UPLOADS_PER_OWNER_PER_DAY?: string | undefined;
}

export interface QuotaLimits {
  maxPanos: number | null;
  maxBytes: number | null;
  maxUploadsPerDay: number | null;
}

export const UPLOAD_WINDOW_MS = 24 * 60 * 60 * 1000;
// Expired upload-log entries one request deletes at most, so a long-idle owner's
// backlog can't run a request into the subrequest limit; the rest go next time.
export const UPLOAD_LOG_PRUNE_MAX = 50;

// A var that isn't a non-negative integer is a config mistake: fail closed
// (no uploads) rather than silently lift the limit.
export const parseLimit = (name: string, raw: string | undefined): number | null => {
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
}

/**
 * The storage half of the upload-URL quota hook: null when the upload fits (or
 * neither limit is set), otherwise the reason it doesn't. Counts what is in the
 * owner's prefix now, so it is a soft cap: concurrent requests can each pass.
 * A pano with a delete tombstone (`deleting`) is on its way out and doesn't count.
 *
 * A replace adds no pano, so at the pano limit it is fine; an owner already over
 * it (the limit was lowered under them) gets no replace either, as for storage.
 *
 * Known cost: with a limit set, every upload-URL request lists the owner's whole
 * panos/ prefix (one LIST per 1,000 objects, several objects per pano). Unset,
 * nothing is listed.
 */
export const checkQuota = async (
  r2: Pick<R2S3Client, 'listObjects'>,
  sub: string,
  limits: Pick<QuotaLimits, 'maxPanos' | 'maxBytes'>,
  req: QuotaRequest,
): Promise<QuotaRefusal | null> => {
  if (limits.maxPanos === null && limits.maxBytes === null) return null;
  const { panos, bytes } = await countHoldings(r2, sub, req.replacing);
  if (limits.maxPanos !== null) {
    // A new pano must fit under the limit; a replace only must not be over it.
    if (req.replacing === undefined ? panos >= limits.maxPanos : panos > limits.maxPanos) {
      return 'pano limit reached';
    }
  }
  if (limits.maxBytes !== null && bytes + req.size > limits.maxBytes) {
    return 'storage limit reached';
  }
  return null;
};

/**
 * What the owner holds against the storage limits, in one listing of their panos/ prefix:
 * panos not on their way out (no `deleting` tombstone), and their originals' bytes, less
 * `replacing`'s (a replace's old original goes).
 */
export const countHoldings = async (
  r2: Pick<R2S3Client, 'listObjects'>,
  sub: string,
  replacing?: string,
): Promise<{ panos: number; bytes: number }> => {
  const prefix = userPanosPrefix(sub);
  const originalBytes = new Map<string, number>();
  const panoIds = new Set<string>();
  const deleting = new Set<string>();
  for (const { key, size } of await r2.listObjects(prefix)) {
    const [panoId, name] = key.slice(prefix.length).split('/');
    if (!panoId) continue;
    panoIds.add(panoId);
    if (name === 'deleting') deleting.add(panoId);
    if (name === 'original') originalBytes.set(panoId, size);
  }
  let panos = 0;
  let bytes = 0;
  for (const panoId of panoIds) {
    if (deleting.has(panoId)) continue;
    panos += 1;
    if (panoId !== replacing) bytes += originalBytes.get(panoId) ?? 0;
  }
  return { panos, bytes };
};

export interface DailyUploads {
  /** Whether one more upload URL would take the owner past the limit. */
  refused: boolean;
  /** Entries older than the window (or malformed), to delete best-effort. */
  expired: string[];
}

/**
 * The daily half: counts the owner's upload-log entries (one per URL issued,
 * see recordUpload) from the past 24 hours, in one listing of
 * upload-log/<owner>/ (about one entry per URL issued in the window, plus any
 * expired ones not yet pruned). It counts URLs, not stored originals, so an
 * upload deleted again, a URL never used, and every replace (a new tiling job
 * each) all still count. Soft like checkQuota: concurrent requests can each pass.
 * Null limit: nothing listed.
 */
export const checkDailyUploads = async (
  r2: Pick<R2S3Client, 'listObjects'>,
  sub: string,
  maxUploadsPerDay: number | null,
  now: number,
): Promise<DailyUploads> => {
  if (maxUploadsPerDay === null) return { refused: false, expired: [] };
  const { recent, expired } = await countRecentUploads(r2, sub, now);
  return { refused: recent + 1 > maxUploadsPerDay, expired };
};

/** The owner's upload-log entries from the past 24 hours, and the older ones to prune. */
export const countRecentUploads = async (
  r2: Pick<R2S3Client, 'listObjects'>,
  sub: string,
  now: number,
): Promise<{ recent: number; expired: string[] }> => {
  const prefix = userUploadLogPrefix(sub);
  const since = now - UPLOAD_WINDOW_MS;
  let recent = 0;
  const expired: string[] = [];
  for (const { key } of await r2.listObjects(prefix)) {
    const at = uploadLogTime(key.slice(prefix.length));
    // Only upload-api writes here, so a name it can't read is a stale format,
    // not an upload to count.
    if (Number.isNaN(at) || at < since) expired.push(key);
    else recent += 1;
  }
  return { recent, expired };
};

/** Logs one issued upload URL for checkDailyUploads; written before the URL is returned. */
export const recordUpload = (
  r2: Pick<R2S3Client, 'put'>,
  sub: string,
  panoId: string,
  now: number,
): Promise<void> =>
  r2.put(uploadLogKey(sub, new Date(now), panoId), '', {
    contentType: 'application/octet-stream',
  });
