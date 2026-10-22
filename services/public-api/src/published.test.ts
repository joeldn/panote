import { pubTourKey } from '@internal/contracts';
import { describe, expect, it, vi } from 'vitest';

import { createPublishedCheck, PUBLISHED_CACHE_MAX, PUBLISHED_CACHE_MS } from './published.js';

// A bucket holding only the given tours' public bundles, counting its HEADs.
const fakeBucket = (published: Set<string>) => {
  const head = vi.fn(async (key: string) =>
    [...published].some((id) => pubTourKey(id) === key) ? ({} as R2Object) : null,
  );
  return { bucket: { head } as unknown as R2Bucket, head };
};

describe('createPublishedCheck', () => {
  it('heads the public bundle and answers false for a tour that is not published', async () => {
    const { bucket, head } = fakeBucket(new Set());
    const isPublished = createPublishedCheck(() => 0);
    expect(await isPublished(bucket, 'nope')).toBe(false);
    expect(head).toHaveBeenCalledWith(pubTourKey('nope'));
  });

  it('never caches a no: a tour published a moment later counts at once', async () => {
    const published = new Set<string>();
    const { bucket, head } = fakeBucket(published);
    const isPublished = createPublishedCheck(() => 0);
    expect(await isPublished(bucket, 't')).toBe(false);
    published.add('t');
    expect(await isPublished(bucket, 't')).toBe(true);
    expect(head).toHaveBeenCalledTimes(2);
  });

  it('reuses a yes within the window, and an unpublished tour stops counting after it', async () => {
    const published = new Set(['t']);
    const { bucket, head } = fakeBucket(published);
    let t = 1_000;
    const isPublished = createPublishedCheck(() => t);
    expect(await isPublished(bucket, 't')).toBe(true);
    published.delete('t'); // unpublished or taken down
    t += PUBLISHED_CACHE_MS - 1;
    expect(await isPublished(bucket, 't')).toBe(true);
    expect(head).toHaveBeenCalledTimes(1);
    t += 1;
    expect(await isPublished(bucket, 't')).toBe(false);
    expect(head).toHaveBeenCalledTimes(2);
  });

  it('keeps the window at most a minute', () => {
    expect(PUBLISHED_CACHE_MS).toBeLessThanOrEqual(60_000);
  });

  it('empties the cache once it holds the most tours, so memory stays bounded', async () => {
    const ids = Array.from({ length: PUBLISHED_CACHE_MAX + 1 }, (_, i) => `t${i}`);
    const { bucket, head } = fakeBucket(new Set(ids));
    const isPublished = createPublishedCheck(() => 0);
    for (const id of ids) await isPublished(bucket, id);
    head.mockClear();
    // t0 was dropped when the last id arrived; the last id is still cached.
    await isPublished(bucket, ids.at(-1) as string);
    expect(head).not.toHaveBeenCalled();
    await isPublished(bucket, 't0');
    expect(head).toHaveBeenCalledTimes(1);
  });
});
