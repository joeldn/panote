import { tourKey, userToursPrefix } from '@internal/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  computeTilingStatus,
  configCustomMetadata,
  listTourSummaries,
  paginateIds,
  parseListLimit,
  resolvePanoTitle,
  resolveTourFields,
  tourCustomMetadata,
} from './lists.js';

describe('computeTilingStatus', () => {
  it('is none with no manifest and no original', () => {
    expect(
      computeTilingStatus({
        hasManifest: false,
        manifestVersion: undefined,
        originalEtag: undefined,
        tileFailedOriginalEtag: undefined,
      }),
    ).toBe('none');
  });

  it('is pending with an original but no manifest', () => {
    expect(
      computeTilingStatus({
        hasManifest: false,
        manifestVersion: undefined,
        originalEtag: 'etag-a',
        tileFailedOriginalEtag: undefined,
      }),
    ).toBe('pending');
  });

  it('is ready when the manifest version etag capture matches the current original etag', () => {
    expect(
      computeTilingStatus({
        hasManifest: true,
        manifestVersion: 't1-etag-a',
        originalEtag: 'etag-a',
        tileFailedOriginalEtag: undefined,
      }),
    ).toBe('ready');
  });

  it('is pending, not ready, when the manifest is for a since-replaced original (etag mismatch)', () => {
    expect(
      computeTilingStatus({
        hasManifest: true,
        manifestVersion: 't1-old-etag',
        originalEtag: 'new-etag',
        tileFailedOriginalEtag: undefined,
      }),
    ).toBe('pending');
  });

  it('ignores a TILER_OUTPUT_VERSION bump - only the etag capture is compared, not the full version string', () => {
    expect(
      computeTilingStatus({
        hasManifest: true,
        manifestVersion: 't1-etag-a',
        originalEtag: 'etag-a',
        tileFailedOriginalEtag: undefined,
      }),
    ).toBe('ready');
    expect(
      computeTilingStatus({
        hasManifest: true,
        manifestVersion: 't2-etag-a',
        originalEtag: 'etag-a',
        tileFailedOriginalEtag: undefined,
      }),
    ).toBe('ready');
  });

  it('is failed when a tile-failed marker matches the current original etag and there is no ready manifest', () => {
    expect(
      computeTilingStatus({
        hasManifest: false,
        manifestVersion: undefined,
        originalEtag: 'etag-a',
        tileFailedOriginalEtag: 'etag-a',
      }),
    ).toBe('failed');
  });

  it('is pending, not failed, when the tile-failed marker is stale (a later upload superseded it)', () => {
    expect(
      computeTilingStatus({
        hasManifest: false,
        manifestVersion: undefined,
        originalEtag: 'new-etag',
        tileFailedOriginalEtag: 'old-etag',
      }),
    ).toBe('pending');
  });

  it('review fix: ready wins over a same-etag failed marker (a race between a late success and a stale marker)', () => {
    expect(
      computeTilingStatus({
        hasManifest: true,
        manifestVersion: 't1-etag-a',
        originalEtag: 'etag-a',
        tileFailedOriginalEtag: 'etag-a',
      }),
    ).toBe('ready');
  });

  it('is none when there is a manifest but no original at all (e.g. mid-delete)', () => {
    expect(
      computeTilingStatus({
        hasManifest: true,
        manifestVersion: 't1-gone',
        originalEtag: undefined,
        tileFailedOriginalEtag: undefined,
      }),
    ).toBe('none');
  });
});

describe('resolveTourFields', () => {
  it('uses customMetadata with no legacy read', async () => {
    const legacyRead = vi.fn();
    const fields = await resolveTourFields(
      { title: 'From Metadata', sceneCount: '3', coverPanoId: 'cover-p1' },
      legacyRead,
    );
    expect(fields).toEqual({ title: 'From Metadata', sceneCount: 3, coverPanoId: 'cover-p1' });
    expect(legacyRead).not.toHaveBeenCalled();
  });

  it('maps an empty coverPanoId (no scenes) to null, not an empty string', async () => {
    const fields = await resolveTourFields(
      { title: 'No Scenes', sceneCount: '0', coverPanoId: '' },
      vi.fn(),
    );
    expect(fields.coverPanoId).toBeNull();
  });

  it('falls back to exactly one legacy read when customMetadata is absent (a pre-A2 object)', async () => {
    const legacyRead = vi.fn(async () => ({
      tourId: 't1',
      title: 'Legacy Tour',
      scenes: [{ panoId: 'legacy-p1' }, { panoId: 'legacy-p2' }],
    }));
    const fields = await resolveTourFields(undefined, legacyRead);
    expect(fields).toEqual({ title: 'Legacy Tour', sceneCount: 2, coverPanoId: 'legacy-p1' });
    expect(legacyRead).toHaveBeenCalledTimes(1);
  });

  it('falls back when customMetadata is missing sceneCount (partial/foreign metadata)', async () => {
    const legacyRead = vi.fn(async () => ({ tourId: 't1', title: 'Legacy', scenes: [] }));
    const fields = await resolveTourFields({ title: 'Ignored' }, legacyRead);
    expect(fields.title).toBe('Legacy');
    expect(legacyRead).toHaveBeenCalledTimes(1);
  });
});

describe('resolvePanoTitle', () => {
  it('uses customMetadata with no legacy read', async () => {
    const legacyRead = vi.fn();
    const title = await resolvePanoTitle({ title: 'From Metadata' }, legacyRead);
    expect(title).toBe('From Metadata');
    expect(legacyRead).not.toHaveBeenCalled();
  });

  it('falls back to one legacy read when customMetadata is absent', async () => {
    const legacyRead = vi.fn(async () => ({
      panoId: 'p1',
      title: 'Legacy Pano',
      hotspots: [],
    }));
    const title = await resolvePanoTitle(undefined, legacyRead);
    expect(title).toBe('Legacy Pano');
    expect(legacyRead).toHaveBeenCalledTimes(1);
  });

  it('is null when there is no config at all (legacy read resolves null)', async () => {
    const title = await resolvePanoTitle(undefined, async () => null);
    expect(title).toBeNull();
  });
});

describe('tourCustomMetadata / configCustomMetadata', () => {
  it('writes title, sceneCount and coverPanoId from the first scene', () => {
    expect(
      tourCustomMetadata({
        tourId: 't1',
        title: 'My Tour',
        scenes: [{ panoId: 'p1' }, { panoId: 'p2' }],
      }),
    ).toEqual({ title: 'My Tour', sceneCount: '2', coverPanoId: 'p1' });
  });

  it('writes an empty coverPanoId string for a tour with no scenes', () => {
    expect(tourCustomMetadata({ tourId: 't1', title: 'Empty', scenes: [] })).toEqual({
      title: 'Empty',
      sceneCount: '0',
      coverPanoId: '',
    });
  });

  it('writes only title for a pano config', () => {
    expect(configCustomMetadata({ panoId: 'p1', title: 'Hall', hotspots: [] })).toEqual({
      title: 'Hall',
    });
  });
});

describe('parseListLimit', () => {
  it('defaults to 50 when absent', () => {
    expect(parseListLimit(undefined)).toEqual({ ok: true, limit: 50 });
  });

  it('rejects zero, negative, fractional and non-numeric values (review fix)', () => {
    expect(parseListLimit('0')).toEqual({ ok: false });
    expect(parseListLimit('-5')).toEqual({ ok: false });
    expect(parseListLimit('0.5')).toEqual({ ok: false });
    expect(parseListLimit('12.9')).toEqual({ ok: false });
    expect(parseListLimit('not-a-number')).toEqual({ ok: false });
  });

  it('rejects a value over MAX_LIST_LIMIT rather than silently clamping it (review fix)', () => {
    expect(parseListLimit('500')).toEqual({ ok: false });
    expect(parseListLimit('101')).toEqual({ ok: false });
  });

  it('accepts the boundary values 1 and 100', () => {
    expect(parseListLimit('1')).toEqual({ ok: true, limit: 1 });
    expect(parseListLimit('100')).toEqual({ ok: true, limit: 100 });
  });

  it('passes a valid in-range value through', () => {
    expect(parseListLimit('7')).toEqual({ ok: true, limit: 7 });
  });
});

describe('paginateIds', () => {
  const sorted = ['a', 'b', 'c', 'd', 'e'];

  it('returns the first page with no cursor', () => {
    expect(paginateIds(sorted, undefined, 2)).toEqual({ page: ['a', 'b'], cursor: 'b' });
  });

  it('resumes from a cursor', () => {
    expect(paginateIds(sorted, 'b', 2)).toEqual({ page: ['c', 'd'], cursor: 'd' });
  });

  it('returns a null cursor on the last page', () => {
    expect(paginateIds(sorted, 'd', 2)).toEqual({ page: ['e'], cursor: null });
  });

  it('a limit at or beyond the remaining count returns a null cursor', () => {
    expect(paginateIds(sorted, undefined, 10)).toEqual({ page: sorted, cursor: null });
  });

  it('review fix: a true keyset resumes after a since-deleted cursor rather than restarting or looping', () => {
    // "c" was deleted since the previous page; the keyset still resumes
    // correctly at the first id greater than it ("d"), not from the top.
    const withoutC = ['a', 'b', 'd', 'e'];
    expect(paginateIds(withoutC, 'c', 2)).toEqual({ page: ['d', 'e'], cursor: null });
  });

  it('review fix: a cursor at or past the end returns an empty page and a null cursor, not a restart', () => {
    expect(paginateIds(sorted, 'e', 2)).toEqual({ page: [], cursor: null });
    expect(paginateIds(sorted, 'z', 2)).toEqual({ page: [], cursor: null });
  });

  it('a cursor before every id returns the first page', () => {
    expect(paginateIds(sorted, '0', 2)).toEqual({ page: ['a', 'b'], cursor: 'b' });
  });
});

describe('title truncation for R2 customMetadata (review fix)', () => {
  it('truncates a tour title over 256 UTF-16 units when writing customMetadata', () => {
    const hugeTitle = 'x'.repeat(9000);
    const meta = tourCustomMetadata({ tourId: 't1', title: hugeTitle, scenes: [] });
    expect(meta.title?.length).toBe(256);
    expect(meta.title).toBe('x'.repeat(256));
  });

  it('truncates a pano config title over 256 UTF-16 units when writing customMetadata', () => {
    const hugeTitle = 'y'.repeat(9000);
    const meta = configCustomMetadata({ panoId: 'p1', title: hugeTitle, hotspots: [] });
    expect(meta.title?.length).toBe(256);
  });

  it('leaves a short title untouched', () => {
    expect(tourCustomMetadata({ tourId: 't1', title: 'Short', scenes: [] }).title).toBe('Short');
  });

  it('review fix: drops a trailing lone high surrogate rather than splitting a surrogate pair', () => {
    const emoji = '\u{1F600}'; // 2 UTF-16 units; unit 255 lands on its high surrogate
    const title = 'a'.repeat(255) + emoji + 'a'.repeat(50);
    const meta = tourCustomMetadata({ tourId: 't1', title, scenes: [] });
    expect(meta.title).toBe('a'.repeat(255));
    expect(meta.title?.length).toBe(255);
    expect(/[\uD800-\uDBFF]$/.test(meta.title ?? '')).toBe(false);
  });

  it('does not drop a surrogate pair that lands exactly on the boundary', () => {
    const emoji = '\u{1F600}';
    const title = 'a'.repeat(254) + emoji; // exactly 256 units, pair fully included
    const meta = tourCustomMetadata({ tourId: 't1', title, scenes: [] });
    expect(meta.title).toBe(title);
    expect(meta.title?.length).toBe(256);
  });
});

/** A minimal in-memory R2Bucket fake: enough of list()'s prefix/cursor/
 * startAfter/limit semantics (key-sorted, `truncated`/`cursor` reported the
 * way R2 does) plus get()/put() to unit-test listTourSummaries in isolation,
 * including its own internal multi-fetch pagination loop. */
type FakeRecord = {
  value: string;
  customMetadata: Record<string, string> | undefined;
  etag: string;
  uploaded: Date;
};
type FakeObject = {
  key: string;
  etag: string;
  uploaded: Date;
  customMetadata: Record<string, string> | undefined;
};

class FakeR2Bucket {
  private readonly store = new Map<string, FakeRecord>();
  getCalls = 0;

  put(key: string, value: string, customMetadata?: Record<string, string>): void {
    this.store.set(key, { value, customMetadata, etag: `etag-${key}`, uploaded: new Date() });
  }

  async get(key: string): Promise<{ json: <T>() => Promise<T>; etag: string } | null> {
    this.getCalls += 1;
    const rec = this.store.get(key);
    if (!rec) return null;
    return { json: async <T>() => JSON.parse(rec.value) as T, etag: rec.etag };
  }

  async list(options: {
    prefix?: string;
    cursor?: string;
    startAfter?: string;
    limit?: number;
  }): Promise<{ objects: FakeObject[]; truncated: boolean; cursor?: string }> {
    const prefix = options.prefix ?? '';
    let keys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort();
    const after = options.cursor ?? options.startAfter;
    if (after !== undefined) keys = keys.filter((k) => k > after);
    const limit = options.limit ?? keys.length;
    const page = keys.slice(0, limit);
    const truncated = keys.length > limit;
    const objects: FakeObject[] = page.map((key) => {
      const rec = this.store.get(key) as FakeRecord;
      return { key, etag: rec.etag, uploaded: rec.uploaded, customMetadata: rec.customMetadata };
    });
    return truncated
      ? { objects, truncated: true, cursor: page[page.length - 1] as string }
      : { objects, truncated: false };
  }
}

const seedTour = (
  bucket: FakeR2Bucket,
  sub: string,
  tourId: string,
  fields: { title: string; sceneCount: number; coverPanoId: string },
  publish?: { slug: string; visibility: 'public' | 'unlisted' },
): void => {
  bucket.put(tourKey(sub, tourId), JSON.stringify({ tourId, title: fields.title, scenes: [] }), {
    title: fields.title,
    sceneCount: String(fields.sceneCount),
    coverPanoId: fields.coverPanoId,
  });
  if (publish) {
    bucket.put(`${userToursPrefix(sub)}${tourId}/publish.json`, JSON.stringify(publish), {
      slug: publish.slug,
      visibility: publish.visibility,
    });
  }
};

describe('listTourSummaries (review fixes: tourId keyset pagination, no per-item GET)', () => {
  const SUB = 'auth0|list-tours-fixture';

  it('review fix: no bucket.get is called across pages when every tour has customMetadata', async () => {
    const bucket = new FakeR2Bucket();
    for (const tourId of ['t1', 't2', 't3']) {
      seedTour(bucket, SUB, tourId, { title: `Tour ${tourId}`, sceneCount: 1, coverPanoId: 'p1' });
    }
    const page1 = await listTourSummaries(bucket as never, SUB, undefined, 10);
    expect(page1.tours.map((t) => t.tourId).sort()).toEqual(['t1', 't2', 't3']);
    expect(bucket.getCalls).toBe(0);
  });

  it('review fix: walks every page at limit=1 with publish.json present, visiting each tour exactly once', async () => {
    const bucket = new FakeR2Bucket();
    seedTour(
      bucket,
      SUB,
      't1',
      { title: 'Tour t1', sceneCount: 1, coverPanoId: 'p1' },
      {
        slug: 's1',
        visibility: 'public',
      },
    );
    seedTour(
      bucket,
      SUB,
      't2',
      { title: 'Tour t2', sceneCount: 1, coverPanoId: 'p1' },
      {
        slug: 's2',
        visibility: 'unlisted',
      },
    );
    seedTour(bucket, SUB, 't3', { title: 'Tour t3', sceneCount: 1, coverPanoId: 'p1' });

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await listTourSummaries(bucket as never, SUB, cursor, 1);
      expect(result.tours.length).toBeLessThanOrEqual(1);
      seen.push(...result.tours.map((t) => t.tourId));
      if (result.cursor === null) break;
      cursor = result.cursor;
    }
    expect(seen.sort()).toEqual(['t1', 't2', 't3']);
    expect(new Set(seen).size).toBe(3);
  });

  it('review fix: walks every page at limit=2 with publish.json present, visiting each tour exactly once', async () => {
    const bucket = new FakeR2Bucket();
    for (const tourId of ['t1', 't2', 't3']) {
      seedTour(
        bucket,
        SUB,
        tourId,
        { title: `Tour ${tourId}`, sceneCount: 1, coverPanoId: 'p1' },
        { slug: `slug-${tourId}`, visibility: 'public' },
      );
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (let page = 0; page < 10; page++) {
      const result = await listTourSummaries(bucket as never, SUB, cursor, 2);
      pages += 1;
      seen.push(...result.tours.map((t) => t.tourId));
      if (result.cursor === null) break;
      cursor = result.cursor;
    }
    expect(pages).toBe(2);
    expect(seen.sort()).toEqual(['t1', 't2', 't3']);
  });

  it("review fix: a tour's publish summary is not split off by a page boundary", async () => {
    const bucket = new FakeR2Bucket();
    seedTour(
      bucket,
      SUB,
      't1',
      { title: 'Tour t1', sceneCount: 1, coverPanoId: 'p1' },
      {
        slug: 'linked',
        visibility: 'public',
      },
    );
    const { tours } = await listTourSummaries(bucket as never, SUB, undefined, 1);
    expect(tours[0]?.publish).toEqual({ slug: 'linked', visibility: 'public' });
  });
});
