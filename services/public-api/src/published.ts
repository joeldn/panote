import { pubTourKey } from '@internal/contracts';

// How long one isolate trusts a positive "this tour is published" answer. After an
// unpublish or a takedown, views, events and likes can still be counted this long.
export const PUBLISHED_CACHE_MS = 30_000;
// Past this many cached tours the cache is emptied, so its memory stays bounded.
export const PUBLISHED_CACHE_MAX = 1000;

export type IsPublished = (bucket: R2Bucket, tourId: string) => Promise<boolean>;

/**
 * Whether the tour's public bundle (`pub/tours/<tourId>.json`) exists, by one R2 HEAD.
 * Only a yes is cached: a tour published a moment ago counts at once, and an unknown
 * id costs a HEAD every time (the per-IP limiter is its brake).
 */
export function createPublishedCheck(now: () => number = Date.now): IsPublished {
  const until = new Map<string, number>();
  return async (bucket, tourId) => {
    const expires = until.get(tourId);
    if (expires !== undefined && expires > now()) return true;
    until.delete(tourId);
    if (!(await bucket.head(pubTourKey(tourId)))) return false;
    if (until.size >= PUBLISHED_CACHE_MAX) until.clear();
    until.set(tourId, now() + PUBLISHED_CACHE_MS);
    return true;
  };
}
