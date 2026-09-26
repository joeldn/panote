import { describe, expect, it, vi } from 'vitest';

import {
  computeTilingStatus,
  configCustomMetadata,
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
  it('defaults to 50 when absent, zero, negative or not a number', () => {
    expect(parseListLimit(undefined)).toBe(50);
    expect(parseListLimit('0')).toBe(50);
    expect(parseListLimit('-5')).toBe(50);
    expect(parseListLimit('not-a-number')).toBe(50);
  });

  it('caps at 100', () => {
    expect(parseListLimit('500')).toBe(100);
  });

  it('truncates a fractional value', () => {
    expect(parseListLimit('12.9')).toBe(12);
  });

  it('passes a valid in-range value through', () => {
    expect(parseListLimit('7')).toBe(7);
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

  it('restarts from the top for a stale/unknown cursor rather than erroring', () => {
    expect(paginateIds(sorted, 'not-a-real-id', 2)).toEqual({ page: ['a', 'b'], cursor: 'b' });
  });
});
