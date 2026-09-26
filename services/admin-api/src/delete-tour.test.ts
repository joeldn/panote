import { configKey, originalKey, tourKey } from '@internal/contracts';
import { describe, expect, it } from 'vitest';

import { deleteTour } from './delete-tour.js';

const SUB = 'auth0|delete-tour-fixture';

/** In-memory fake supporting exactly what deleteTour + deletePano need:
 * head/get/put/delete, and list() in both delimiter mode (listChildren) and
 * flat prefix mode (deletePano's sweeps). A hook can mutate the store right
 * as a chosen delimiter-mode list() call starts, to simulate a concurrent
 * tour delete completing in the gap between deleteTour's two reference checks. */
class FakeBucket {
  private readonly store = new Map<string, string>();
  private delimiterListCalls = 0;
  private onDelimiterListCall: Map<number, () => void> = new Map();

  seed(key: string, value = ''): void {
    this.store.set(key, value);
  }

  onNthDelimiterList(n: number, fn: () => void): void {
    this.onDelimiterListCall.set(n, fn);
  }

  async head(key: string): Promise<{ key: string } | null> {
    return this.store.has(key) ? { key } : null;
  }

  async get(key: string): Promise<{ json: <T>() => Promise<T> } | null> {
    const value = this.store.get(key);
    if (value === undefined) return null;
    return { json: async <T>() => JSON.parse(value) as T };
  }

  async put(key: string, value: unknown): Promise<{ key: string }> {
    this.store.set(key, typeof value === 'string' ? value : String(value));
    return { key };
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.store.delete(k);
  }

  async list(options?: {
    prefix?: string;
    delimiter?: string;
  }): Promise<{ objects: { key: string }[]; delimitedPrefixes: string[]; truncated: false }> {
    const prefix = options?.prefix ?? '';
    if (options?.delimiter) {
      this.delimiterListCalls += 1;
      this.onDelimiterListCall.get(this.delimiterListCalls)?.();
    }
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix));
    if (!options?.delimiter) {
      return { objects: keys.map((key) => ({ key })), delimitedPrefixes: [], truncated: false };
    }
    const delimited = new Set<string>();
    for (const k of keys) {
      const rest = k.slice(prefix.length);
      const idx = rest.indexOf(options.delimiter);
      if (idx >= 0) delimited.add(prefix + rest.slice(0, idx + 1));
    }
    return { objects: [], delimitedPrefixes: [...delimited], truncated: false };
  }
}

const tourDoc = (tourId: string, panoIds: string[]) =>
  JSON.stringify({ tourId, title: tourId, scenes: panoIds.map((panoId) => ({ panoId })) });

describe('deleteTour: two tours sharing a pano, deleted concurrently (review fix)', () => {
  it('a pano still referenced at the first check but unreferenced by the time of the second check gets cleaned up', async () => {
    const bucket = new FakeBucket();
    const sharedPano = 'shared-p1';
    bucket.seed(tourKey(SUB, 'tour-a'), tourDoc('tour-a', [sharedPano]));
    bucket.seed(tourKey(SUB, 'tour-b'), tourDoc('tour-b', [sharedPano]));
    bucket.seed(originalKey(SUB, sharedPano), 'original bytes');
    bucket.seed(configKey(SUB, sharedPano), '{}');

    // deleteTour(tour-a)'s call sequence: 1st listChildren (first reference
    // check, sees tour-b) ... tour-a's own tour.json delete ... 2nd
    // listChildren (second reference check). Simulate tour-b's own delete
    // (a concurrent deleteTour(tour-b)) finishing in that exact gap.
    bucket.onNthDelimiterList(2, () => {
      void bucket.delete(tourKey(SUB, 'tour-b'));
    });

    await deleteTour(bucket as unknown as R2Bucket, SUB, 'tour-a');

    expect(await bucket.head(originalKey(SUB, sharedPano))).toBeNull();
    expect(await bucket.head(tourKey(SUB, 'tour-a'))).toBeNull();
  });

  it('without the race, a pano genuinely still referenced by another tour is left untouched', async () => {
    const bucket = new FakeBucket();
    const sharedPano = 'shared-p2';
    bucket.seed(tourKey(SUB, 'tour-c'), tourDoc('tour-c', [sharedPano]));
    bucket.seed(tourKey(SUB, 'tour-d'), tourDoc('tour-d', [sharedPano]));
    bucket.seed(originalKey(SUB, sharedPano), 'original bytes');

    await deleteTour(bucket as unknown as R2Bucket, SUB, 'tour-c');

    expect(await bucket.head(tourKey(SUB, 'tour-c'))).toBeNull();
    expect(await bucket.head(originalKey(SUB, sharedPano))).not.toBeNull();
    expect(await bucket.head(tourKey(SUB, 'tour-d'))).not.toBeNull();
  });

  it('is a no-op for a tourId that was already deleted', async () => {
    const bucket = new FakeBucket();
    await expect(
      deleteTour(bucket as unknown as R2Bucket, SUB, 'never-existed'),
    ).resolves.toBeUndefined();
  });
});
