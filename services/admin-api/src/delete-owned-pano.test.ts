import {
  configKey,
  deletingKey,
  manifestKey,
  originalKey,
  previewKey,
  tileFailedKey,
  tileVersionPrefix,
  tourKey,
} from '@internal/contracts';
import { describe, expect, it } from 'vitest';

import { deleteOwnedPano, RECENT_UPLOAD_MS, STALLED_TILING_MS } from './delete-owned-pano.js';

const SUB = 'auth0|owned-pano';
const OTHER = 'auth0|owned-pano-other';
const NOW = Date.parse('2026-10-06T12:00:00.000Z');
const OLD = new Date(NOW - 2 * RECENT_UPLOAD_MS);

const etagOf = (key: string): string => `e-${key.replace(/[^A-Za-z0-9_-]/g, '_')}`;

type Rec = { value: string; uploaded: Date; customMetadata?: Record<string, string> };

/** Just enough of R2 for deleteOwnedPano, summarizePano and deletePano: flat
 * and delimiter list(), get/head/put/delete. `beforeTourList(n, fn)` runs
 * `fn` as the n-th listing of a tours/ prefix starts, to land a concurrent
 * tour write between the delete's two reference checks. */
class FakeBucket {
  readonly store = new Map<string, Rec>();
  private tourLists = 0;
  private readonly hooks = new Map<number, () => void>();

  seed(key: string, value = '', uploaded = OLD): this {
    this.store.set(key, { value, uploaded });
    return this;
  }

  beforeTourList(n: number, fn: () => void): void {
    this.hooks.set(n, fn);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  private obj(key: string, rec: Rec) {
    return {
      key,
      etag: etagOf(key),
      uploaded: rec.uploaded,
      customMetadata: rec.customMetadata ?? {},
      json: async () => JSON.parse(rec.value) as unknown,
    };
  }

  async head(key: string) {
    const rec = this.store.get(key);
    return rec ? this.obj(key, rec) : null;
  }

  async get(key: string) {
    return this.head(key);
  }

  async put(key: string, value: unknown) {
    this.store.set(key, { value: String(value), uploaded: new Date(NOW) });
    return this.obj(key, this.store.get(key)!);
  }

  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.store.delete(k);
  }

  async list(options: { prefix?: string; delimiter?: string } = {}) {
    const prefix = options.prefix ?? '';
    if (prefix.startsWith('tours/')) {
      this.tourLists += 1;
      this.hooks.get(this.tourLists)?.();
    }
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort();
    if (!options.delimiter) {
      return {
        objects: keys.map((k) => this.obj(k, this.store.get(k)!)),
        delimitedPrefixes: [],
        truncated: false,
      };
    }
    const children = new Set<string>();
    for (const k of keys) {
      const rest = k.slice(prefix.length);
      const at = rest.indexOf('/');
      if (at >= 0) children.add(prefix + rest.slice(0, at + 1));
    }
    return { objects: [], delimitedPrefixes: [...children], truncated: false };
  }
}

const asR2 = (b: FakeBucket) => b as unknown as R2Bucket;

const tour = (sub: string, tourId: string, panoIds: string[]): [string, string] => [
  tourKey(sub, tourId),
  JSON.stringify({ tourId, title: tourId, scenes: panoIds.map((panoId) => ({ panoId })) }),
];

/** A tiled pano: original, config, a ready manifest, a tile and the preview. */
const seedReadyPano = (b: FakeBucket, sub: string, panoId: string, uploaded = OLD) => {
  const version = `t1-${etagOf(originalKey(sub, panoId))}`;
  b.seed(originalKey(sub, panoId), 'bytes', uploaded)
    .seed(configKey(sub, panoId), JSON.stringify({ panoId, title: panoId, hotspots: [] }))
    .seed(
      manifestKey(panoId),
      JSON.stringify({ pano: panoId, version, format: 'webp', tileSize: 512, preview: true }),
    )
    .seed(`${tileVersionPrefix(panoId, version)}0/pz/0-0.webp`, 'tile')
    .seed(previewKey(panoId, version), 'preview');
};

const panoKeys = (b: FakeBucket, panoId: string) =>
  [...b.store.keys()].filter((k) => k.includes(`/${panoId}/`));

describe('deleteOwnedPano', () => {
  it('deletes every object kind of an unused pano: original, config, marker, manifest, tiles, preview', async () => {
    const b = new FakeBucket();
    seedReadyPano(b, SUB, 'p-unused');
    b.seed(tileFailedKey(SUB, 'p-unused'), '');
    seedReadyPano(b, SUB, 'p-sibling');
    b.seed(...tour(SUB, 't1', ['p-sibling']));

    const result = await deleteOwnedPano(asR2(b), SUB, 'p-unused', NOW);

    expect(result).toEqual({ ok: true, tilesDeleted: true });
    expect(panoKeys(b, 'p-unused')).toEqual([]);
    expect(panoKeys(b, 'p-sibling')).toHaveLength(5);
  });

  it('409s a pano any tour uses, including a duplicate tour sharing it, and deletes nothing', async () => {
    const b = new FakeBucket();
    seedReadyPano(b, SUB, 'p-shared');
    // Only the second of two tours uses it, as after duplicating and editing.
    b.seed(...tour(SUB, 't-a', []));
    b.seed(...tour(SUB, 't-b', ['p-other', 'p-shared']));
    const before = panoKeys(b, 'p-shared');

    const result = await deleteOwnedPano(asR2(b), SUB, 'p-shared', NOW);

    expect(result).toEqual({ ok: false, status: 409, conflict: 'in-use' });
    expect(panoKeys(b, 'p-shared')).toEqual(before);
    expect(b.has(deletingKey(SUB, 'p-shared'))).toBe(false);
  });

  it("ignores another owner's tours when checking references", async () => {
    const b = new FakeBucket();
    seedReadyPano(b, SUB, 'p-mine');
    b.seed(...tour(OTHER, 't-theirs', ['p-mine']));
    expect(await deleteOwnedPano(asR2(b), SUB, 'p-mine', NOW)).toMatchObject({ ok: true });
  });

  it("404s another owner's pano and leaves it, its tiles and their manifest alone", async () => {
    const b = new FakeBucket();
    seedReadyPano(b, OTHER, 'p-theirs');
    const before = panoKeys(b, 'p-theirs');

    expect(await deleteOwnedPano(asR2(b), SUB, 'p-theirs', NOW)).toEqual({
      ok: false,
      status: 404,
    });
    expect(panoKeys(b, 'p-theirs')).toEqual(before);
  });

  it('409s a pano that is still tiling, and one tiled less than an hour ago', async () => {
    const b = new FakeBucket();
    b.seed(originalKey(SUB, 'p-tiling'), 'bytes', new Date(NOW - 60_000));
    seedReadyPano(b, SUB, 'p-fresh', new Date(NOW - RECENT_UPLOAD_MS + 60_000));

    expect(await deleteOwnedPano(asR2(b), SUB, 'p-tiling', NOW)).toEqual({
      ok: false,
      status: 409,
      conflict: 'processing',
    });
    expect(await deleteOwnedPano(asR2(b), SUB, 'p-fresh', NOW)).toEqual({
      ok: false,
      status: 409,
      conflict: 'recent',
    });
    expect(b.has(originalKey(SUB, 'p-tiling'))).toBe(true);
    expect(b.has(originalKey(SUB, 'p-fresh'))).toBe(true);
    expect(b.has(deletingKey(SUB, 'p-fresh'))).toBe(false);
  });

  it('409s a pending pano a day old as processing up to the stall cutoff, then deletes it', async () => {
    const b = new FakeBucket();
    b.seed(originalKey(SUB, 'p-stuck'), 'bytes', new Date(NOW - STALLED_TILING_MS + 60_000));
    expect(await deleteOwnedPano(asR2(b), SUB, 'p-stuck', NOW)).toMatchObject({
      conflict: 'processing',
    });
    expect(await deleteOwnedPano(asR2(b), SUB, 'p-stuck', NOW + 120_000)).toEqual({
      ok: true,
      tilesDeleted: false,
    });
    expect(panoKeys(b, 'p-stuck')).toEqual([]);
  });

  it('a tour that starts using the pano after the first check wins: tombstone rolled back, nothing deleted', async () => {
    const b = new FakeBucket();
    seedReadyPano(b, SUB, 'p-race');
    b.seed(...tour(SUB, 't-race', []));
    const before = panoKeys(b, 'p-race');
    // Lands after the first reference check passed and the tombstone was
    // written, before the second check reads the tours.
    b.beforeTourList(2, () => {
      expect(b.has(deletingKey(SUB, 'p-race'))).toBe(true);
      b.seed(...tour(SUB, 't-race', ['p-race']));
    });

    const result = await deleteOwnedPano(asR2(b), SUB, 'p-race', NOW);

    expect(result).toEqual({ ok: false, status: 409, conflict: 'in-use' });
    expect(panoKeys(b, 'p-race')).toEqual(before);
    expect(b.has(deletingKey(SUB, 'p-race'))).toBe(false);
  });

  it('writes the tombstone before deleting anything, and only with the original as proof', async () => {
    const b = new FakeBucket();
    seedReadyPano(b, SUB, 'p-order');
    const seen: boolean[] = [];
    // The second tours/ listing is the re-check after the tombstone.
    b.beforeTourList(2, () => {
      seen.push(b.has(deletingKey(SUB, 'p-order')), b.has(originalKey(SUB, 'p-order')));
    });
    await deleteOwnedPano(asR2(b), SUB, 'p-order', NOW);
    expect(seen).toEqual([true, true]);
  });

  it("deletes a config-only pano's own prefix without a tombstone and never another owner's tiles", async () => {
    const b = new FakeBucket();
    // OTHER owns this panoId's original and tiles; SUB only ever PUT a config.
    seedReadyPano(b, OTHER, 'p-squat');
    b.seed(configKey(SUB, 'p-squat'), JSON.stringify({ panoId: 'p-squat', title: 'x' }));

    expect(await deleteOwnedPano(asR2(b), SUB, 'p-squat', NOW)).toEqual({
      ok: true,
      tilesDeleted: false,
    });
    expect(b.has(configKey(SUB, 'p-squat'))).toBe(false);
    expect(b.has(manifestKey('p-squat'))).toBe(true);
    expect(b.has(originalKey(OTHER, 'p-squat'))).toBe(true);
  });

  describe('resuming an interrupted delete (tombstone present)', () => {
    it('finishes it, skipping the age checks, when the pano is unused', async () => {
      const b = new FakeBucket();
      seedReadyPano(b, SUB, 'p-resume', new Date(NOW - 1000));
      b.seed(deletingKey(SUB, 'p-resume'));
      expect(await deleteOwnedPano(asR2(b), SUB, 'p-resume', NOW)).toEqual({
        ok: true,
        tilesDeleted: true,
      });
      expect(panoKeys(b, 'p-resume')).toEqual([]);
    });

    it('rolls the tombstone back when a tour uses it and the original is still there', async () => {
      const b = new FakeBucket();
      seedReadyPano(b, SUB, 'p-resume-used');
      b.seed(deletingKey(SUB, 'p-resume-used'));
      b.seed(...tour(SUB, 't1', ['p-resume-used']));
      expect(await deleteOwnedPano(asR2(b), SUB, 'p-resume-used', NOW)).toMatchObject({
        conflict: 'in-use',
      });
      expect(b.has(deletingKey(SUB, 'p-resume-used'))).toBe(false);
      expect(b.has(originalKey(SUB, 'p-resume-used'))).toBe(true);
    });

    it('finishes it even when a tour uses it once the original is already gone', async () => {
      const b = new FakeBucket();
      b.seed(deletingKey(SUB, 'p-half'));
      b.seed(configKey(SUB, 'p-half'), '{}');
      b.seed(`${tileVersionPrefix('p-half', 'v1')}0/pz/0-0.webp`, 'tile');
      b.seed(...tour(SUB, 't1', ['p-half']));
      expect(await deleteOwnedPano(asR2(b), SUB, 'p-half', NOW)).toEqual({
        ok: true,
        tilesDeleted: true,
      });
      expect(panoKeys(b, 'p-half')).toEqual([]);
    });
  });
});
