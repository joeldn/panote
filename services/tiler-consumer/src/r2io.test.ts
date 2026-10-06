import { describe, expect, it, vi } from 'vitest';
import { UPLOAD_CONCURRENCY, uploadDir } from './r2io.js';

describe('uploadDir', () => {
  it('uploads every tile under tilePrefix, in file order', async () => {
    const order: string[] = [];
    const put = vi.fn(async (key: string) => {
      order.push(key);
    });
    await uploadDir(
      {
        '0/px/0-0.webp': new Uint8Array(),
        '0/nx/0-0.webp': new Uint8Array(),
      },
      'tiles/p1/v1/',
      put,
    );
    expect(order).toEqual(['tiles/p1/v1/0/px/0-0.webp', 'tiles/p1/v1/0/nx/0-0.webp']);
  });

  it('never uploads manifest.json, even when present in files - the manifest is handled by the caller', async () => {
    const put = vi.fn(async () => {});
    await uploadDir(
      {
        '0/px/0-0.webp': new Uint8Array(),
        'manifest.json': new Uint8Array(),
      },
      'tiles/p2/v1/',
      put,
    );
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith('tiles/p2/v1/0/px/0-0.webp', expect.anything(), 'image/webp');
  });

  it('picks content-type by extension: .json, .webp, and other', async () => {
    const calls: Array<{ key: string; contentType: string }> = [];
    const put = vi.fn(async (key: string, _body: Uint8Array, contentType: string) => {
      calls.push({ key, contentType });
    });
    await uploadDir(
      {
        'level0/0-0.webp': new Uint8Array(),
        'other.bin': new Uint8Array(),
        'sub/data.json': new Uint8Array(),
      },
      'tiles/p3/v1/',
      put,
    );
    expect(calls).toEqual([
      { key: 'tiles/p3/v1/level0/0-0.webp', contentType: 'image/webp' },
      { key: 'tiles/p3/v1/other.bin', contentType: 'application/octet-stream' },
      { key: 'tiles/p3/v1/sub/data.json', contentType: 'application/json' },
    ]);
  });
});

// Fake bucket whose PUTs resolve after a per-key delay, so completions land
// out of start order; tracks how many are in flight at once.
const fakeBucket = (delayOf: (key: string) => number, failKey?: string) => {
  const stored = new Set<string>();
  const events: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const put = async (key: string): Promise<void> => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    events.push(`start ${key}`);
    await new Promise((r) => setTimeout(r, delayOf(key)));
    inFlight--;
    events.push(`end ${key}`);
    if (key === failKey) throw new Error(`R2 PUT ${key} -> 500`);
    stored.add(key);
  };
  return { put, stored, events, maxInFlight: () => maxInFlight, inFlight: () => inFlight };
};

const tileFiles = (n: number): Record<string, Uint8Array> => {
  const files: Record<string, Uint8Array> = { 'manifest.json': new Uint8Array() };
  for (let i = 0; i < n; i++) files[`1/px/${i}.webp`] = new Uint8Array();
  files['preview.webp'] = new Uint8Array();
  return files;
};

// Later keys finish sooner, so completion order is the reverse of start order.
const reversedDelay = (key: string): number => 10 - (Number(/(\d+)\.webp$/.exec(key)?.[1]) % 10);

describe('uploadDir bounded concurrency', () => {
  it('never has more than N PUTs in flight, and uploads every tile and the preview', async () => {
    const bucket = fakeBucket(reversedDelay);
    await uploadDir(tileFiles(40), 't/', bucket.put, 4);
    expect(bucket.maxInFlight()).toBe(4);
    expect(bucket.stored.size).toBe(41);
    expect(bucket.stored.has('t/preview.webp')).toBe(true);
    expect(bucket.stored.has('t/manifest.json')).toBe(false);
  });

  it(`defaults to ${UPLOAD_CONCURRENCY} in flight`, async () => {
    const bucket = fakeBucket(reversedDelay);
    await uploadDir(tileFiles(60), 't/', bucket.put);
    expect(bucket.maxInFlight()).toBe(UPLOAD_CONCURRENCY);
    expect(bucket.stored.size).toBe(61);
  });

  it('resolves only after every tile PUT has finished, even when they finish out of order', async () => {
    const bucket = fakeBucket(reversedDelay);
    await uploadDir(tileFiles(30), 't/', bucket.put, 8);
    // The caller's manifest PUT (container.ts) runs after this await.
    await bucket.put('t/manifest.json');
    const ends = bucket.events.filter((e) => e.startsWith('end '));
    expect(ends.at(-1)).toBe('end t/manifest.json');
    expect(bucket.events.indexOf('start t/manifest.json')).toBe(bucket.events.length - 2);
    // Completion order really did differ from start order.
    const starts = bucket.events.filter((e) => e.startsWith('start ')).map((e) => e.slice(6));
    expect(ends.map((e) => e.slice(4))).not.toEqual(starts);
  });

  it('rejects with the tile error after draining in-flight PUTs, starting no new ones', async () => {
    const bucket = fakeBucket(() => 5, 't/1/px/3.webp');
    await expect(uploadDir(tileFiles(40), 't/', bucket.put, 4)).rejects.toThrow(
      'R2 PUT t/1/px/3.webp -> 500',
    );
    expect(bucket.inFlight()).toBe(0);
    const failedAt = bucket.events.indexOf('end t/1/px/3.webp');
    expect(bucket.events.slice(failedAt).some((e) => e.startsWith('start '))).toBe(false);
    expect(bucket.stored.size).toBeLessThan(41);
  });

  it('rejects a non-positive concurrency instead of silently uploading nothing', async () => {
    await expect(uploadDir(tileFiles(1), 't/', async () => {}, 0)).rejects.toThrow(
      'positive integer',
    );
  });
});
