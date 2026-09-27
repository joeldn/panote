import { describe, expect, it, vi } from 'vitest';

import { json } from '../__fixtures__/helpers.js';
import { ApiError, ApiSchemaError } from './http.js';
import { loadPublishedTour } from './published.js';

const CDN = 'https://cdn.test/';
const NOW = Date.parse('2026-09-27T00:00:00Z');

const bundle = (tourId = 'tour-a') => ({
  v: 1,
  tourId,
  title: 'Old town',
  visibility: 'unlisted',
  slug: 'old-town',
  publishedAt: '2026-09-20T00:00:00Z',
  settings: { controls: 'bottom', showMap: true, showCompass: true, autoRotate: false },
  startPanoId: 'pano-1',
  scenes: [{ panoId: 'pano-1', config: { panoId: 'pano-1', title: 'Square', hotspots: [] } }],
});
const alias = (redirect: string, expiresAt = '2026-10-01T00:00:00Z', tourId = 'tour-a') => ({
  v: 1,
  kind: 'redirect',
  tourId,
  redirect,
  expiresAt,
});

/** A CDN stub: keys map to bodies, anything else is a 404. */
const cdn = (objects: Record<string, unknown>) =>
  vi.fn(async (url: string, _init?: RequestInit) => {
    const key = url.slice(CDN.length);
    return key in objects ? json(objects[key]) : new Response('', { status: 404 });
  });

const load = (slug: string, fetch: ReturnType<typeof cdn>) =>
  loadPublishedTour(CDN, slug, { fetch, now: () => NOW });

describe('loadPublishedTour', () => {
  it('reads the slug pointer, then the pub bundle', async () => {
    const fetch = cdn({
      'slugs/old-town.json': { v: 1, kind: 'tour', tourId: 'tour-a' },
      'pub/tours/tour-a.json': bundle(),
    });
    const result = await load('old-town', fetch);
    expect(result).toMatchObject({ kind: 'tour', tour: { tourId: 'tour-a', title: 'Old town' } });
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      `${CDN}slugs/old-town.json`,
      `${CDN}pub/tours/tour-a.json`,
    ]);
  });

  it('is unavailable when the slug is missing, invalid, or its bundle is gone', async () => {
    await expect(load('nope', cdn({}))).resolves.toEqual({ kind: 'unavailable' });
    const none = cdn({});
    await expect(load('../x', none)).resolves.toEqual({ kind: 'unavailable' });
    expect(none).not.toHaveBeenCalled();
    const orphan = cdn({ 'slugs/old-town.json': { v: 1, kind: 'tour', tourId: 'tour-a' } });
    await expect(load('old-town', orphan)).resolves.toEqual({ kind: 'unavailable' });
  });

  it('is unavailable for an unsafe tourId or a bundle of another tour', async () => {
    const unsafe = cdn({ 'slugs/a-b.json': { v: 1, kind: 'tour', tourId: '../x' } });
    await expect(load('a-b', unsafe)).resolves.toEqual({ kind: 'unavailable' });
    const mismatch = cdn({
      'slugs/a-b.json': { v: 1, kind: 'tour', tourId: 'tour-a' },
      'pub/tours/tour-a.json': bundle('tour-b'),
    });
    await expect(load('a-b', mismatch)).resolves.toEqual({ kind: 'unavailable' });
  });

  it('follows an unexpired alias onto the same tour', async () => {
    const fetch = cdn({
      'slugs/old-name.json': alias('new-name'),
      'slugs/new-name.json': { v: 1, kind: 'tour', tourId: 'tour-a' },
    });
    await expect(load('old-name', fetch)).resolves.toEqual({ kind: 'redirect', slug: 'new-name' });
  });

  it.each([
    [
      'expired',
      alias('new-name', '2026-09-01T00:00:00Z'),
      { v: 1, kind: 'tour', tourId: 'tour-a' },
    ],
    ['foreign target', alias('new-name'), { v: 1, kind: 'tour', tourId: 'tour-b' }],
    ['chained target', alias('new-name'), alias('newer-name')],
    ['missing target', alias('new-name'), undefined],
  ])('is unavailable for an alias with an %s', async (_label, record, target) => {
    const objects: Record<string, unknown> = { 'slugs/old-name.json': record };
    if (target) objects['slugs/new-name.json'] = target;
    await expect(load('old-name', cdn(objects))).resolves.toEqual({ kind: 'unavailable' });
  });

  it('throws on a non-404 failure or a document that fails its schema', async () => {
    const down = vi.fn(async () => new Response('', { status: 503 }));
    await expect(loadPublishedTour(CDN, 'old-town', { fetch: down })).rejects.toBeInstanceOf(
      ApiError,
    );
    const bad = cdn({ 'slugs/old-town.json': { v: 2, kind: 'tour', tourId: 'tour-a' } });
    await expect(load('old-town', bad)).rejects.toBeInstanceOf(ApiSchemaError);
  });

  it('passes the abort signal through', async () => {
    const ac = new AbortController();
    const fetch = cdn({});
    await loadPublishedTour(CDN, 'old-town', { fetch, signal: ac.signal });
    expect(fetch.mock.calls[0]?.[1]?.signal).toBe(ac.signal);
  });
});
