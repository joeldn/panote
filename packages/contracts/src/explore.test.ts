import { describe, expect, it } from 'vitest';

import {
  EXPLORE_INDEX_ROOT,
  ExploreEntrySchema,
  ExplorePageSchema,
  ExplorePointerSchema,
  ExploreTourSchema,
} from './index.js';
import {
  exploreCursorKey,
  exploreCursorOf,
  exploreEntryKey,
  exploreHiddenKey,
  exploreRank,
  exploreTourKey,
} from './keys.js';

describe('explore keys', () => {
  it('lists a later listing first: the rank is an inverted, fixed-width timestamp', () => {
    const older = exploreEntryKey(Date.parse('2026-01-01T00:00:00Z'), 'tour-a');
    const newer = exploreEntryKey(Date.parse('2026-06-01T00:00:00Z'), 'tour-b');
    expect([older, newer].sort()).toEqual([newer, older]);
    expect(exploreRank(0)).toBe('9999999999999');
    expect(exploreRank(9_999_999_999_999)).toBe('0000000000000');
    expect(exploreRank(1)).toHaveLength(13);
  });

  it('keeps entries, pointers and hidden markers under explore/, owner-free', () => {
    expect(exploreEntryKey(1_700_000_000_000, 't1')).toBe('explore/index/8299999999999-t1.json');
    expect(exploreTourKey('t1')).toBe('explore/tours/t1.json');
    expect(exploreHiddenKey('t1')).toBe('explore/hidden/t1.json');
  });

  it('refuses a bad tourId or timestamp', () => {
    expect(() => exploreEntryKey(1, 'a/b')).toThrow();
    expect(() => exploreTourKey('../x')).toThrow();
    expect(() => exploreHiddenKey('')).toThrow();
    expect(() => exploreRank(-1)).toThrow();
    expect(() => exploreRank(1.5)).toThrow();
  });

  it('round-trips a cursor through the entry key, and refuses anything else', () => {
    const key = exploreEntryKey(1_700_000_000_000, 't1');
    const cursor = exploreCursorOf(key);
    expect(cursor).toBe('8299999999999-t1');
    expect(exploreCursorKey(cursor!)).toBe(key);
    expect(exploreCursorKey('../pub/tours/x')).toBeNull();
    expect(exploreCursorKey('123-t1')).toBeNull();
    expect(exploreCursorOf('pub/tours/t1.json')).toBeNull();
  });
});

const entry = {
  v: 1,
  tourId: 't1',
  slug: 'my-tour',
  title: 'My tour',
  sceneCount: 2,
  cover: { panoId: 'p1', version: 't1-abc', image: 'og' },
  publishedAt: '2026-01-01T00:00:00.000Z',
  listedAt: '2026-01-02T00:00:00.000Z',
  updatedAt: '2026-01-03T00:00:00.000Z',
};

describe('explore schemas', () => {
  it('parses an entry, with or without a cover', () => {
    expect(ExploreEntrySchema.safeParse(entry).success).toBe(true);
    expect(ExploreEntrySchema.safeParse({ ...entry, cover: null }).success).toBe(true);
  });

  it('refuses a cover whose ids could escape the tiles URL', () => {
    const bad = { ...entry, cover: { panoId: '../x', version: 'v', image: 'og' } };
    expect(ExploreEntrySchema.safeParse(bad).success).toBe(false);
    const kind = { ...entry, cover: { panoId: 'p', version: 'v', image: 'face' } };
    expect(ExploreEntrySchema.safeParse(kind).success).toBe(false);
  });

  it('a pointer must point inside the index', () => {
    expect(
      ExplorePointerSchema.safeParse({ v: 1, key: `${EXPLORE_INDEX_ROOT}x.json` }).success,
    ).toBe(true);
    expect(ExplorePointerSchema.safeParse({ v: 1, key: 'pub/tours/x.json' }).success).toBe(false);
  });

  it('a page carries cards and a cursor that is an entry name or null', () => {
    const { v: _v, listedAt: _l, ...card } = entry;
    expect(ExploreTourSchema.safeParse(card).success).toBe(true);
    expect(ExplorePageSchema.safeParse({ tours: [card], cursor: null }).success).toBe(true);
    expect(ExplorePageSchema.safeParse({ tours: [], cursor: '8299999999999-t1' }).success).toBe(
      true,
    );
    expect(ExplorePageSchema.safeParse({ tours: [], cursor: 'opaque' }).success).toBe(false);
  });
});
