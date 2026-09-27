// Ingest routes (unit B5), driven through app.request with a mocked EVENTS
// binding so every writeDataPoint call can be asserted field by field.
import { env } from 'cloudflare:test';
import { MAX_DWELL_MS } from '@internal/contracts';
import { describe, expect, it, vi } from 'vitest';

import { clampDwell, toDataPoint } from './events.js';
import app from './index.js';

const setup = () => {
  const writeDataPoint = vi.fn<(p?: AnalyticsEngineDataPoint) => void>();
  const testEnv = { ...env, EVENTS: { writeDataPoint } } as Env;
  const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(
      path,
      {
        method: 'POST',
        headers,
        ...(body === undefined
          ? {}
          : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      },
      testEnv,
    );
  const stats = async (tourId: string) =>
    (await app.request(`/api/tours/${tourId}/stats`, {}, testEnv)).json();
  return { writeDataPoint, post, stats };
};

describe('toDataPoint', () => {
  it('writes the documented v1 schema', () => {
    expect(
      toDataPoint('t1', { type: 'hotspot', panoId: 'p1', hotspotId: 'h1', surface: 'embed' }),
    ).toEqual({
      indexes: ['t1'],
      blobs: ['hotspot', 'p1', 'h1', 'embed', 'v1'],
      doubles: [0],
    });
  });

  it('defaults missing ids to "" and surface to page', () => {
    expect(toDataPoint('t1', { type: 'view' })).toEqual({
      indexes: ['t1'],
      blobs: ['view', '', '', 'page', 'v1'],
      doubles: [0],
    });
  });

  it('only records ms for dwell, clamped to [0, 4h]', () => {
    expect(toDataPoint('t', { type: 'scene', ms: 500 }).doubles).toEqual([0]);
    expect(toDataPoint('t', { type: 'dwell', ms: 1500 }).doubles).toEqual([1500]);
    expect(clampDwell(-5)).toBe(0);
    expect(clampDwell(MAX_DWELL_MS + 1)).toBe(MAX_DWELL_MS);
  });
});

describe('POST /api/tours/:tourId/view', () => {
  it('increments the DO and writes one view point', async () => {
    const { writeDataPoint, post, stats } = setup();
    const r = await post('/api/tours/ae-view-1/view', { panoId: 'p1', surface: 'embed' });
    expect(r.status).toBe(200);
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['ae-view-1'],
      blobs: ['view', 'p1', '', 'embed', 'v1'],
      doubles: [0],
    });
    expect(await stats('ae-view-1')).toMatchObject({ views: 1 });
  });

  it('accepts an empty body (the pre-B5 call shape)', async () => {
    const { writeDataPoint, post } = setup();
    expect((await post('/api/tours/ae-view-empty/view')).status).toBe(200);
    expect(writeDataPoint.mock.calls[0]?.[0]?.blobs).toEqual(['view', '', '', 'page', 'v1']);
  });

  it.each([
    ['a bad panoId', { panoId: '../etc' }],
    ['a bad surface', { surface: 'iframe' }],
    ['malformed JSON', '{nope'],
  ])('400s on %s without touching the DO or AE', async (_label, body) => {
    const { writeDataPoint, post, stats } = setup();
    expect((await post('/api/tours/ae-view-bad/view', body)).status).toBe(400);
    expect(writeDataPoint).not.toHaveBeenCalled();
    expect(await stats('ae-view-bad')).toMatchObject({ views: 0 });
  });

  it('413s on an oversized body', async () => {
    const { writeDataPoint, post } = setup();
    const r = await post('/api/tours/ae-view-big/view', { panoId: 'p', pad: 'x'.repeat(9000) });
    expect(r.status).toBe(413);
    expect(writeDataPoint).not.toHaveBeenCalled();
  });
});

describe('tourId validation', () => {
  it.each(['view', 'events', 'like', 'stats'])('400s a junk tourId on /%s', async (route) => {
    const { writeDataPoint } = setup();
    const r = await app.request(
      `/api/tours/bad.id/${route}`,
      { method: route === 'stats' ? 'GET' : 'POST', headers: { 'X-Client-Id': 'c' } },
      { ...env, EVENTS: { writeDataPoint } } as Env,
    );
    expect(r.status).toBe(400);
    expect(writeDataPoint).not.toHaveBeenCalled();
  });

  it('400s a tourId longer than 64 chars', async () => {
    const { post } = setup();
    expect((await post(`/api/tours/${'a'.repeat(65)}/view`)).status).toBe(400);
  });
});

describe('POST /api/tours/:tourId/events', () => {
  it('writes one point per event and 204s, even for a text/plain beacon', async () => {
    const { writeDataPoint, post } = setup();
    const r = await post(
      '/api/tours/ae-ev-1/events',
      JSON.stringify({
        events: [
          { type: 'scene', panoId: 'p1' },
          { type: 'hotspot', panoId: 'p1', hotspotId: 'door_2' },
          { type: 'dwell', ms: 12_345.5, surface: 'embed' },
        ],
      }),
      { 'content-type': 'text/plain;charset=UTF-8' },
    );
    expect(r.status).toBe(204);
    expect(writeDataPoint.mock.calls.map(([p]) => p)).toEqual([
      { indexes: ['ae-ev-1'], blobs: ['scene', 'p1', '', 'page', 'v1'], doubles: [0] },
      { indexes: ['ae-ev-1'], blobs: ['hotspot', 'p1', 'door_2', 'page', 'v1'], doubles: [0] },
      { indexes: ['ae-ev-1'], blobs: ['dwell', '', '', 'embed', 'v1'], doubles: [12_345.5] },
    ]);
  });

  it('clamps dwell to [0, 4h]', async () => {
    const { writeDataPoint, post } = setup();
    await post('/api/tours/ae-ev-clamp/events', {
      events: [
        { type: 'dwell', ms: -10 },
        { type: 'dwell', ms: 10 * MAX_DWELL_MS },
      ],
    });
    expect(writeDataPoint.mock.calls.map(([p]) => p?.doubles)).toEqual([[0], [MAX_DWELL_MS]]);
  });

  it('never stores anything beyond the documented fields', async () => {
    const { writeDataPoint, post } = setup();
    await post(
      '/api/tours/ae-ev-priv/events',
      { events: [{ type: 'scene', panoId: 'p1', ip: '1.2.3.4', ua: 'x', sub: 'auth0|me' }] },
      {
        'X-Client-Id': 'client-123',
        'CF-Connecting-IP': '1.2.3.4',
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://example.com/',
        'CF-IPCountry': 'NZ',
      },
    );
    const point = writeDataPoint.mock.calls[0]?.[0];
    expect(point).toEqual({
      indexes: ['ae-ev-priv'],
      blobs: ['scene', 'p1', '', 'page', 'v1'],
      doubles: [0],
    });
    const flat = JSON.stringify(point);
    for (const leak of ['1.2.3.4', 'Mozilla', 'example.com', 'NZ', 'client-123', 'auth0']) {
      expect(flat).not.toContain(leak);
    }
  });

  it('accepts 20 events and 400s 21, writing nothing', async () => {
    const { writeDataPoint, post } = setup();
    const batch = (n: number) => ({ events: Array.from({ length: n }, () => ({ type: 'scene' })) });
    expect((await post('/api/tours/ae-ev-cap/events', batch(20))).status).toBe(204);
    expect(writeDataPoint).toHaveBeenCalledTimes(20);
    writeDataPoint.mockClear();
    expect((await post('/api/tours/ae-ev-cap/events', batch(21))).status).toBe(400);
    expect(writeDataPoint).not.toHaveBeenCalled();
  });

  it.each([
    ['a bad hotspotId', { events: [{ type: 'hotspot', hotspotId: 'has space' }] }],
    ['an unknown type', { events: [{ type: 'view' }] }],
    ['a bad panoId', { events: [{ type: 'scene', panoId: 'a/b' }] }],
    ['dwell without ms', { events: [{ type: 'dwell' }] }],
    ['a missing events array', {}],
  ])('400s the whole batch on %s', async (_label, body) => {
    const { writeDataPoint, post } = setup();
    const ok = { type: 'scene' };
    const withOk =
      'events' in body ? { events: [ok, ...(body as { events: unknown[] }).events] } : body;
    expect((await post('/api/tours/ae-ev-bad/events', withOk)).status).toBe(400);
    expect(writeDataPoint).not.toHaveBeenCalled();
  });
});
