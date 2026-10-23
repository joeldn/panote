import { encodeId, SLUG_HOLDS_ROOT, slugHoldKey } from '@internal/contracts';
import { putJson } from '@internal/worker-kit/r2-binding';

// Cooling-off for released slugs (docs/deploy.md, "admin-api object caps"). When a
// tour's live slug or alias is released (Stop sharing, takedown, tour or account
// delete), a hold is written before the slug record is deleted. Until it expires
// only the same owner may claim the slug again, so nobody else can take over an
// old share link. Private (slug-holds/ is outside the CDN's WAF prefixes). The owner
// is stored as an unsalted SHA-256 of the owner segment: that only keeps the raw sub
// out of a casual listing of the bucket. It is not a pseudonym: Auth0 subs can be
// guessed (a provider prefix and an id), and anyone who guesses one can hash it and
// match it.

export const SLUG_HOLD_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

type SlugHold = { v: 1; owner: string; expiresAt: string };

const encoder = new TextEncoder();

/** The owner as a hold stores it: hex SHA-256 of base64url(sub). Unsalted; see above. */
export const holdOwner = async (sub: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(encodeId(sub)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** Holds `slug` for its owner `sub` for SLUG_HOLD_DAYS from `now`, replacing any older hold. */
export const holdSlug = async (
  bucket: R2Bucket,
  sub: string,
  slug: string,
  now: Date,
): Promise<void> => {
  const key = slugHoldKey(slug);
  if (!key) return;
  const expiresAt = new Date(now.getTime() + SLUG_HOLD_DAYS * DAY_MS).toISOString();
  const hold: SlugHold = { v: 1, owner: await holdOwner(sub), expiresAt };
  await putJson(bucket, key, hold, undefined, { expiresAt });
};

/**
 * Whether someone other than `sub` holds `slug` right now. Fails closed: a hold that
 * doesn't parse, or has the wrong shape, counts as held (it exists, like an unparsable
 * slug record), and an R2 error throws, failing the publish like any other R2 error.
 */
export const heldByOther = async (
  bucket: R2Bucket,
  sub: string,
  slug: string,
  nowMs: number,
): Promise<boolean> => {
  const key = slugHoldKey(slug);
  const obj = key ? await bucket.get(key) : null;
  if (!obj) return false;
  const value: unknown = await obj.json().catch(() => null);
  const hold = (value && typeof value === 'object' ? value : {}) as Partial<SlugHold>;
  if (typeof hold.owner !== 'string' || typeof hold.expiresAt !== 'string') return true;
  const expiresAt = Date.parse(hold.expiresAt);
  if (Number.isNaN(expiresAt)) return true;
  if (expiresAt <= nowMs) return false;
  return hold.owner !== (await holdOwner(sub));
};

/** Daily cron: deletes every hold past its expiresAt. Returns the keys deleted. */
export const sweepExpiredHolds = async (bucket: R2Bucket, now: Date): Promise<string[]> => {
  const expired = (meta: Record<string, string> | undefined): boolean =>
    !!meta?.expiresAt && Date.parse(meta.expiresAt) <= now.getTime();
  const deleted: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: SLUG_HOLDS_ROOT,
      include: ['customMetadata'],
      ...(cursor ? { cursor } : {}),
    });
    const keys = page.objects.filter((o) => expired(o.customMetadata)).map((o) => o.key);
    if (keys.length > 0) await bucket.delete(keys);
    deleted.push(...keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return deleted;
};
