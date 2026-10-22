import { describe, expect, it, vi } from 'vitest';

import { json, manifest } from '../__fixtures__/helpers.js';
import { ApiError, ApiSchemaError } from './http.js';
import { createPublicApi, exploreCoverUrl, fetchManifest, refreshManifestCache } from './public.js';

describe('refreshManifestCache', () => {
  it('re-fetches the manifest with cache: reload and reads the whole body', async () => {
    const res = json(manifest('t1-b'));
    const fetch = vi.fn(async () => res);
    await refreshManifestCache('https://cdn.test/tiles/', 'p1', { fetch });
    expect(fetch).toHaveBeenCalledWith('https://cdn.test/tiles/p1/manifest.json', {
      cache: 'reload',
    });
    expect(res.bodyUsed).toBe(true);
  });
});

describe('fetchManifest', () => {
  it('reads <tiles>/<panoId>/manifest.json with cache: no-store', async () => {
    const fetch = vi.fn(async () => json(manifest('t1-a')));
    const m = await fetchManifest('https://cdn.test/tiles/', 'p1', { fetch });
    expect(m?.version).toBe('t1-a');
    expect(fetch).toHaveBeenCalledWith('https://cdn.test/tiles/p1/manifest.json', {
      cache: 'no-store',
    });
  });

  it('returns null on 404 (not tiled yet)', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 404 }));
    await expect(fetchManifest('https://cdn.test/tiles/', 'p1', { fetch })).resolves.toBeNull();
  });

  it('throws on other errors and on an invalid manifest', async () => {
    const f500 = vi.fn(async () => new Response('', { status: 503 }));
    await expect(
      fetchManifest('https://cdn.test/tiles/', 'p1', { fetch: f500 }),
    ).rejects.toBeInstanceOf(ApiError);
    const bad = vi.fn(async () => json({ ...manifest(), tileSize: 300 }));
    await expect(
      fetchManifest('https://cdn.test/tiles/', 'p1', { fetch: bad }),
    ).rejects.toBeInstanceOf(ApiSchemaError);
  });

  it('passes the abort signal through', async () => {
    const ac = new AbortController();
    const fetch = vi.fn(async (_u: string, _i?: RequestInit) => json(manifest()));
    await fetchManifest('https://cdn.test/tiles/', 'p1', { fetch, signal: ac.signal });
    expect(fetch.mock.calls[0]?.[1]?.signal).toBe(ac.signal);
  });
});

describe('createPublicApi', () => {
  it('validates stats and sends X-Client-Id on like', async () => {
    const fetch = vi.fn(async (_u: string, _i?: RequestInit) => json({ views: 3, likes: 1 }));
    const api = createPublicApi({ fetch, clientId: () => 'client-1' });
    await expect(api.getStats('t1')).resolves.toEqual({ views: 3, likes: 1 });
    await api.like('t1');
    expect(fetch.mock.calls[1]?.[0]).toBe('/api/tours/t1/like');
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'X-Client-Id': 'client-1' },
    });
    await api.recordView('t1');
    expect(fetch.mock.calls[2]?.[0]).toBe('/api/tours/t1/view');
    expect(fetch.mock.calls[2]?.[1]).toEqual({ method: 'POST' });
    await api.recordView('t1', { panoId: 'p1', surface: 'embed' });
    expect(fetch.mock.calls[3]?.[1]).toEqual({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"panoId":"p1","surface":"embed"}',
    });
  });

  it('rejects an invalid stats body and a bad tourId', async () => {
    const fetch = vi.fn(async () => json({ views: -1, likes: 'x' }));
    const api = createPublicApi({ fetch });
    await expect(api.getStats('t1')).rejects.toBeInstanceOf(ApiSchemaError);
    await expect(api.getStats('a/b')).rejects.toThrow(TypeError);
  });
});

describe('explore', () => {
  const card = {
    tourId: 't1',
    slug: 'my-tour',
    title: 'My tour',
    sceneCount: 3,
    cover: { panoId: 'p1', version: 't1-abc', image: 'og' as const },
    publishedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };

  it('GETs /api/explore, then the next page by cursor, and validates the page', async () => {
    const fetch = vi.fn(async (_u: string, _i?: RequestInit) =>
      json({ tours: [card], cursor: '8299999999999-t1' }),
    );
    const api = createPublicApi({ fetch, baseUrl: 'https://api.test/' });
    const ac = new AbortController();
    await expect(api.explore(null, { signal: ac.signal })).resolves.toEqual({
      tours: [card],
      cursor: '8299999999999-t1',
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.test/api/explore');
    expect(fetch.mock.calls[0]?.[1]?.signal).toBe(ac.signal);
    await api.explore('8299999999999-t1');
    expect(fetch.mock.calls[1]?.[0]).toBe('https://api.test/api/explore?cursor=8299999999999-t1');
  });

  it('refuses a malformed cursor before fetching, and a page that breaks the contract', async () => {
    const fetch = vi.fn(async () => json({ tours: [{ ...card, sceneCount: -1 }], cursor: null }));
    const api = createPublicApi({ fetch });
    await expect(api.explore('../x')).rejects.toThrow(TypeError);
    expect(fetch).not.toHaveBeenCalled();
    await expect(api.explore()).rejects.toBeInstanceOf(ApiSchemaError);
  });

  it('throws ApiError on a non-2xx, so a 429 reads as one', async () => {
    const fetch = vi.fn(async () => json({ error: 'rate limited' }, 429));
    await expect(createPublicApi({ fetch }).explore()).rejects.toMatchObject({ status: 429 });
  });

  it('builds the cover URL from the CDN tiles root', () => {
    expect(exploreCoverUrl('https://cdn.test/tiles/', card.cover)).toBe(
      'https://cdn.test/tiles/p1/t1-abc/og.jpg',
    );
    expect(exploreCoverUrl('https://cdn.test/tiles/', { ...card.cover, image: 'preview' })).toBe(
      'https://cdn.test/tiles/p1/t1-abc/preview.webp',
    );
  });
});
