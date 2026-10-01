import { describe, expect, it, vi } from 'vitest';

import { json } from '../__fixtures__/helpers.js';
import { AuthRequiredError } from '../auth.js';
import { createAdminApi, publishErrorOf } from './admin.js';
import { ApiError, ApiSchemaError, ConflictError } from './http.js';

const status = {
  hasConfig: true,
  hasOriginal: true,
  deleting: false,
  tiling: 'ready',
  manifest: { version: 't1-abc', format: 'webp', tileSize: 512 },
  updatedAt: '2026-09-26T00:00:00.000Z',
};

function setup(...responses: Response[]) {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    return next;
  });
  const api = createAdminApi({
    getToken: async () => 'tok',
    fetch,
    baseUrl: 'https://panote.test/',
  });
  const call = (i = 0) => {
    const c = fetch.mock.calls[i];
    if (!c) throw new Error(`no call ${i}`);
    return {
      url: c[0],
      init: c[1] ?? {},
      headers: (c[1]?.headers ?? {}) as Record<string, string>,
    };
  };
  return { api, fetch, call };
}

describe('createAdminApi', () => {
  it('sends the bearer token and validates list responses', async () => {
    const { api, call } = setup(json({ tours: [], cursor: null }));
    await expect(api.listTours({ limit: 10, cursor: 'abc' })).resolves.toEqual({
      tours: [],
      cursor: null,
    });
    expect(call().url).toBe('https://panote.test/api/admin/tours?cursor=abc&limit=10');
    expect(call().headers.Authorization).toBe('Bearer tok');
  });

  it('rejects a schema-invalid GET body with ApiSchemaError', async () => {
    const { api } = setup(json({ tours: [{ tourId: 't1' }], cursor: null }));
    const err = await api.listTours().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiSchemaError);
    expect((err as ApiSchemaError).url).toBe('https://panote.test/api/admin/tours');
  });

  it('rejects a non-JSON 200 body', async () => {
    const { api } = setup(new Response('<html>spa fallback</html>', { status: 200 }));
    await expect(api.listPanos()).rejects.toBeInstanceOf(ApiSchemaError);
  });

  it('canonicalises out-of-range angles and clamps pitch/fov on load', async () => {
    const config = {
      panoId: 'p1',
      title: 'Hall',
      north: 3 * Math.PI,
      initialView: { yaw: 5 * Math.PI, pitch: 4, fov: 200 },
      hotspots: [
        { id: 'h1', type: 'info', yaw: -3 * Math.PI, pitch: -9, title: 'Door' },
        { id: 'h2', type: 'link', yaw: 7, pitch: 0, title: 'Next', targetPanoId: 'p2' },
      ],
    };
    const { api } = setup(json({ config, etag: 'e1', status }));
    const res = await api.getPano('p1');
    if (res.status !== 'ok') throw new Error('expected ok');
    const c = res.data.config;
    expect(c.north).toBeCloseTo(Math.PI);
    expect(c.initialView?.yaw).toBeCloseTo(Math.PI);
    expect(c.initialView?.pitch).toBe(Math.PI / 2);
    expect(c.initialView?.fov).toBe(80);
    expect(c.hotspots[0]?.yaw).toBeCloseTo(Math.PI);
    expect(c.hotspots[0]?.pitch).toBe(-Math.PI / 2);
    expect(c.hotspots[1]?.yaw).toBeCloseTo(7 - 2 * Math.PI);
    for (const h of c.hotspots) {
      expect(h.yaw).toBeGreaterThan(-Math.PI);
      expect(h.yaw).toBeLessThanOrEqual(Math.PI);
    }
  });

  it('rejects non-finite angles', async () => {
    const config = { panoId: 'p1', title: 'x', initialView: { yaw: null, pitch: 0, fov: 70 } };
    const { api } = setup(json({ config, etag: 'e1', status }));
    await expect(api.getPano('p1')).rejects.toBeInstanceOf(ApiSchemaError);
  });

  it('validates tour-with-configs, including missing entries', async () => {
    const body = {
      tour: { tourId: 't1', title: 'T', scenes: [{ panoId: 'p1' }, { panoId: 'p2' }] },
      etag: 'te',
      configs: {
        p1: {
          config: { panoId: 'p1', title: 'A', initialView: { yaw: 10, pitch: 0, fov: 70 } },
          etag: 'e1',
        },
        p2: { missing: true, deleting: true, hasOriginal: false },
      },
    };
    const { api, call } = setup(json(body));
    const res = await api.getTourWithConfigs('t1');
    expect(call().url).toBe('https://panote.test/api/admin/tours/t1?include=configs');
    if (res.status !== 'ok') throw new Error('expected ok');
    const p1 = res.data.configs.p1;
    expect(p1 && 'config' in p1 && p1.config.initialView?.yaw).toBeCloseTo(10 - 4 * Math.PI);
    expect(res.data.configs.p2).toEqual({ missing: true, deleting: true, hasOriginal: false });
  });

  it('sends If-None-Match and maps 304 to not-modified', async () => {
    const { api, call } = setup(new Response(null, { status: 304, headers: { ETag: '"te"' } }));
    await expect(api.getTour('t1', { ifNoneMatch: 'te' })).resolves.toEqual({
      status: 'not-modified',
      etag: 'te',
    });
    expect(call().headers['If-None-Match']).toBe('"te"');
  });

  it('maps a pano 404 to its tombstone flags, validating the body', async () => {
    const { api } = setup(
      json({ error: 'config not found', deleting: true, hasOriginal: false }, 404),
      json({ error: 'nope' }, 404),
    );
    await expect(api.getPano('p1')).resolves.toEqual({
      status: 'not-found',
      deleting: true,
      hasOriginal: false,
    });
    await expect(api.getPano('p1')).rejects.toBeInstanceOf(ApiSchemaError);
  });

  it('maps a tour 404 to not-found', async () => {
    const { api } = setup(json({ error: 'not found' }, 404));
    await expect(api.getTour('t1')).resolves.toEqual({ status: 'not-found' });
  });

  it('getPanoStatus uses ?status=1 and validates', async () => {
    const { api, call } = setup(json({ status }), json({ status: { ...status, tiling: 'weird' } }));
    await expect(api.getPanoStatus('p1')).resolves.toMatchObject({ tiling: 'ready' });
    expect(call().url).toBe('https://panote.test/api/admin/panos/p1?status=1');
    await expect(api.getPanoStatus('p1')).rejects.toBeInstanceOf(ApiSchemaError);
  });

  it('PUT sends a quoted If-Match and returns the new etag', async () => {
    const { api, call } = setup(json({ etag: 'e2' }), json({ etag: 'e3' }));
    await expect(api.putTour('t1', { title: 'T', scenes: [] }, 'e1')).resolves.toEqual({
      etag: 'e2',
    });
    expect(call().init.method).toBe('PUT');
    expect(call().headers['If-Match']).toBe('"e1"');
    expect(JSON.parse(call().init.body as string)).toEqual({ title: 'T', scenes: [] });
    await api.putPanoConfig('p1', { title: 'A' }, '*');
    expect(call(1).headers['If-Match']).toBe('*');
  });

  it('createPanoConfig sends If-None-Match: * (no If-Match) and maps 412 to ConflictError', async () => {
    const { api, call } = setup(json({ etag: 'e1' }), json({ error: 'conflict' }, 412));
    await expect(api.createPanoConfig('p1', { title: 'A' })).resolves.toEqual({ etag: 'e1' });
    expect(call().init.method).toBe('PUT');
    expect(call().url).toBe('https://panote.test/api/admin/panos/p1/config');
    expect(call().headers['If-None-Match']).toBe('*');
    expect(call().headers['If-Match']).toBeUndefined();
    await expect(api.createPanoConfig('p1', { title: 'B' })).rejects.toBeInstanceOf(ConflictError);
  });

  it('PUT 412 throws ConflictError; other errors throw ApiError with status', async () => {
    const { api } = setup(
      json({ error: 'conflict' }, 412),
      json({ error: 'pano is being deleted' }, 409),
    );
    await expect(api.putTour('t1', { title: 'T' }, 'old')).rejects.toBeInstanceOf(ConflictError);
    const err = await api.putPanoConfig('p1', { title: 'A' }, 'e').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, message: '409: pano is being deleted' });
  });

  it('refuses an empty If-Match rather than sending an unconditional write', async () => {
    const { api, fetch } = setup();
    await expect(api.putTour('t1', { title: 'T' }, '')).rejects.toThrow(/If-Match/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('createTour validates the returned tourId', async () => {
    const { api } = setup(json({ tourId: 'abc-123' }, 201), json({ tourId: '../x' }, 201));
    await expect(api.createTour({ title: 'T' })).resolves.toEqual({ tourId: 'abc-123' });
    await expect(api.createTour({ title: 'T' })).rejects.toBeInstanceOf(ApiSchemaError);
  });

  it('rejects ids that do not match PANO_PATTERN before fetching', async () => {
    const { api, fetch } = setup();
    await expect(api.getTour('../../etc')).rejects.toThrow(TypeError);
    await expect(api.deletePano('a/b')).rejects.toThrow(TypeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('DELETE resolves on 204 and throws on failure', async () => {
    const { api } = setup(new Response(null, { status: 204 }), json({ error: 'boom' }, 500));
    await expect(api.deleteTour('t1')).resolves.toBeUndefined();
    await expect(api.deletePano('p1')).rejects.toMatchObject({ status: 500 });
  });

  it('PATCHes visibility and surfaces a 409 as ApiError', async () => {
    const { api, call } = setup(
      json({ visibility: 'public' }),
      json({ error: 'not published' }, 409),
    );
    await expect(api.setVisibility('t1', 'public')).resolves.toEqual({ visibility: 'public' });
    expect(call().url).toBe('https://panote.test/api/admin/tours/t1/visibility');
    expect(call().init.method).toBe('PATCH');
    expect(call().init.body).toBe('{"visibility":"public"}');
    await expect(api.setVisibility('t1', 'unlisted')).rejects.toMatchObject({ status: 409 });
  });

  it('maps a 401 on any route to AuthRequiredError', async () => {
    const { api } = setup(
      json({ error: 'unauthorized' }, 401),
      json({ error: 'unauthorized' }, 401),
      json({ error: 'unauthorized' }, 401),
    );
    await expect(api.listTours()).rejects.toBeInstanceOf(AuthRequiredError);
    await expect(api.getTour('t1')).rejects.toBeInstanceOf(AuthRequiredError);
    await expect(api.putTour('t1', { title: 'T' }, 'e')).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('passes through a token getter that already requires sign-in', async () => {
    const fetch = vi.fn();
    const api = createAdminApi({
      getToken: () => Promise.reject(new AuthRequiredError()),
      fetch,
    });
    await expect(api.listPanos()).rejects.toBeInstanceOf(AuthRequiredError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('publish routes', () => {
  const published = {
    slug: 'old-town',
    visibility: 'unlisted',
    url: '/s/old-town',
    publishedAt: '2026-09-26T00:00:00.000Z',
  };

  it('POSTs publish with the request body and validates the result', async () => {
    const { api, call } = setup(json(published), json(published));
    await expect(api.publishTour('t1')).resolves.toEqual(published);
    expect(call(0).url).toBe('https://panote.test/api/admin/tours/t1/publish');
    expect(call(0).init.method).toBe('POST');
    expect(call(0).init.body).toBe('{}');
    expect(call(0).headers['If-Match']).toBeUndefined();
    await api.publishTour('t1', { slug: 'old-town' });
    expect(call(1).init.body).toBe('{"slug":"old-town"}');
  });

  it('PUTs a slug rename and PATCHes visibility', async () => {
    const { api, call } = setup(
      json({ slug: 'new-town', oldSlugRedirectsUntil: '2026-10-26T00:00:00.000Z' }),
      json({ visibility: 'public' }),
    );
    await expect(api.renameSlug('t1', 'new-town')).resolves.toEqual({
      slug: 'new-town',
      oldSlugRedirectsUntil: '2026-10-26T00:00:00.000Z',
    });
    expect(call(0).url).toBe('https://panote.test/api/admin/tours/t1/slug');
    expect(call(0).init.method).toBe('PUT');
    expect(call(0).init.body).toBe('{"slug":"new-town"}');
    await expect(api.setVisibility('t1', 'public')).resolves.toEqual({ visibility: 'public' });
    expect(call(1).url).toBe('https://panote.test/api/admin/tours/t1/visibility');
    expect(call(1).init.method).toBe('PATCH');
    expect(call(1).init.body).toBe('{"visibility":"public"}');
  });

  it('DELETEs publish', async () => {
    const { api, call } = setup(new Response(null, { status: 204 }));
    await expect(api.unpublishTour('t1')).resolves.toBeUndefined();
    expect(call().url).toBe('https://panote.test/api/admin/tours/t1/publish');
    expect(call().init.method).toBe('DELETE');
  });

  it.each([
    [409, { error: 'slug taken' }, { kind: 'slug-taken' }],
    [409, { error: 'slug lost' }, { kind: 'slug-lost' }],
    [409, { error: 'conflict' }, { kind: 'conflict' }],
    [409, { error: 'not published' }, { kind: 'not-published' }],
    [404, { error: 'not found' }, { kind: 'not-found' }],
    [400, { error: 'reserved slug' }, { kind: 'slug-invalid', reason: 'reserved' }],
    [400, { error: 'invalid slug' }, { kind: 'slug-invalid', reason: 'invalid' }],
    [
      422,
      { error: 'scenes not publishable', scenes: [{ panoId: 'p1', reason: 'not-ready' }] },
      { kind: 'unprocessable', scenes: [{ panoId: 'p1', reason: 'not-ready' }] },
    ],
  ])('classifies a %i %j', async (statusCode, body, expected) => {
    const { api } = setup(json(body, statusCode));
    const err = await api.renameSlug('t1', 'x-y-z').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(publishErrorOf(err)).toEqual(expected);
  });

  it('does not classify unrelated errors', async () => {
    const { api } = setup(json({ error: 'boom' }, 500), json({ error: 'other' }, 409));
    expect(publishErrorOf(await api.publishTour('t1').catch((e: unknown) => e))).toBeNull();
    expect(publishErrorOf(await api.publishTour('t1').catch((e: unknown) => e))).toBeNull();
    expect(publishErrorOf(new Error('network'))).toBeNull();
  });
});

describe('getInsights', () => {
  const insights = {
    days: 14,
    from: '2026-09-18T00:00:00.000Z',
    to: '2026-10-01T12:00:00.000Z',
    totalViews: 3,
    avgDwellMs: null,
    daily: [{ date: '2026-10-01', views: 3 }],
    byPano: [{ panoId: 'p1', views: 3 }],
    topHotspots: [],
  };

  it('GETs the 14-day window by default and validates the result', async () => {
    const { api, call } = setup(json(insights), json(insights));
    await expect(api.getInsights('t1')).resolves.toEqual({ status: 'ok', data: insights });
    expect(call(0).url).toBe('https://panote.test/api/admin/tours/t1/insights?days=14');
    expect(call(0).init.method).toBe('GET');
    await api.getInsights('t1', 7);
    expect(call(1).url).toBe('https://panote.test/api/admin/tours/t1/insights?days=7');
  });

  it('maps the 502 to unavailable and a 404 to not-found', async () => {
    const { api } = setup(
      json({ error: 'analytics unavailable' }, 502),
      json({ error: 'not found' }, 404),
    );
    await expect(api.getInsights('t1')).resolves.toEqual({ status: 'unavailable' });
    await expect(api.getInsights('t1')).resolves.toEqual({ status: 'not-found' });
  });

  it('throws on any other failure or a drifted body', async () => {
    const { api } = setup(
      json({ error: 'bad gateway' }, 502),
      json({ error: 'boom' }, 500),
      json({ ...insights, totalViews: -1 }),
    );
    await expect(api.getInsights('t1')).rejects.toBeInstanceOf(ApiError);
    await expect(api.getInsights('t1')).rejects.toBeInstanceOf(ApiError);
    await expect(api.getInsights('t1')).rejects.toBeInstanceOf(ApiSchemaError);
  });
});
