import { accountSinceKey, userPanosPrefix } from '@internal/contracts';
import { getJson, putJson } from '@internal/worker-kit/r2-binding';

// The new-account hold (docs/deploy.md, "Explore"): a tour whose owner's account is
// younger than NEW_ACCOUNT_HOLD_DAYS is published as usual, but its bundle carries
// `heldUntil`, so it stays off Explore and its page is noindex until then. The age
// comes from R2, never the client: the oldest original the owner had when they first
// published, latched in accounts/<owner>/since.json so later publishes cost one GET.

export const DEFAULT_NEW_ACCOUNT_HOLD_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
// List pages of the owner's panos/ prefix read to find the oldest original. At the
// 500-pano cap that prefix is about 1,500 objects; a bigger one only makes the age younger.
const SINCE_SCAN_PAGES = 5;

/** NEW_ACCOUNT_HOLD_DAYS as a number of days, 0 or more (0 turns the hold off), else the default. */
export const parseHoldDays = (raw: string | undefined): number => {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n >= 0
    ? n
    : DEFAULT_NEW_ACCOUNT_HOLD_DAYS;
};

const sinceOf = (value: unknown): number | null => {
  const since = (value as { since?: unknown } | null)?.since;
  const ms = typeof since === 'string' ? Date.parse(since) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

// When the oldest original under the owner's prefix was written, or null for none.
const oldestOriginal = async (bucket: R2Bucket, sub: string): Promise<number | null> => {
  let oldest: number | null = null;
  let cursor: string | undefined;
  for (let page = 0; page < SINCE_SCAN_PAGES; page += 1) {
    const listed = await bucket.list({
      prefix: userPanosPrefix(sub),
      ...(cursor ? { cursor } : {}),
    });
    for (const o of listed.objects) {
      if (!o.key.endsWith('/original')) continue;
      const at = o.uploaded.getTime();
      if (oldest === null || at < oldest) oldest = at;
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
  return oldest;
};

/** When the account started, in epoch ms: latched on the first call, never later than `now`. */
export const accountSince = async (bucket: R2Bucket, sub: string, now: Date): Promise<number> => {
  const key = accountSinceKey(sub);
  const stored = await bucket.get(key);
  const known = stored ? sinceOf(await stored.json().catch(() => null)) : null;
  if (known !== null) return known;
  const since = Math.min(now.getTime(), (await oldestOriginal(bucket, sub)) ?? Infinity);
  const record = { v: 1, since: new Date(since).toISOString() };
  // Create-only, so a first publish racing on another tour can't move it; one that
  // doesn't parse is replaced.
  const wrote = await putJson(bucket, key, record, stored ? undefined : { etagDoesNotMatch: '*' });
  if (wrote.ok) return since;
  const raced = await getJson<unknown>(bucket, key).catch(() => null);
  return (raced ? sinceOf(raced.value) : null) ?? since;
};

/** The bundle's `heldUntil` for this owner: an ISO time while the account is too new, else null. */
export const heldUntil = async (
  bucket: R2Bucket,
  sub: string,
  now: Date,
  holdDays: number,
): Promise<string | null> => {
  if (holdDays <= 0) return null;
  const until = (await accountSince(bucket, sub, now)) + holdDays * DAY_MS;
  return until > now.getTime() ? new Date(until).toISOString() : null;
};
