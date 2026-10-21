import { userPanosPrefix } from '@internal/contracts';
import type { R2S3Client } from '@internal/worker-kit/r2-s3';

// Per-owner storage quotas. Both vars are optional: unset (or empty) means
// unlimited, and an unlimited owner costs no extra R2 request at all.
export interface QuotaEnv {
  /** Most panos one owner may hold, counting the one about to be uploaded. */
  MAX_PANOS_PER_OWNER?: string | undefined;
  /** Most bytes of originals one owner may hold, counting the declared upload size. */
  MAX_BYTES_PER_OWNER?: string | undefined;
}

export interface QuotaLimits {
  maxPanos: number | null;
  maxBytes: number | null;
}

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
});

export type QuotaRefusal = 'pano limit reached' | 'storage limit reached';

export interface QuotaRequest {
  /** Declared size of the upload, in bytes. */
  size: number;
  /** Set for a replace: that pano already counts, and its old original's bytes go. */
  replacing?: string | undefined;
}

/**
 * The upload-URL issuing path's quota hook. Null when the upload fits (or no
 * limit is set), otherwise the reason it doesn't. Counts what is in the
 * owner's prefix now, so it is a soft cap: concurrent requests can each pass.
 */
export const checkQuota = async (
  r2: Pick<R2S3Client, 'listObjects'>,
  sub: string,
  limits: QuotaLimits,
  req: QuotaRequest,
): Promise<QuotaRefusal | null> => {
  if (limits.maxPanos === null && limits.maxBytes === null) return null;
  const prefix = userPanosPrefix(sub);
  const panoIds = new Set<string>();
  let bytes = 0;
  for (const { key, size } of await r2.listObjects(prefix)) {
    const [panoId, name] = key.slice(prefix.length).split('/');
    if (!panoId) continue;
    panoIds.add(panoId);
    if (name === 'original' && panoId !== req.replacing) bytes += size;
  }
  if (limits.maxPanos !== null && req.replacing === undefined && panoIds.size >= limits.maxPanos) {
    return 'pano limit reached';
  }
  if (limits.maxBytes !== null && bytes + req.size > limits.maxBytes) {
    return 'storage limit reached';
  }
  return null;
};
