import { InsightsOkSchema, tourKey } from '@internal/contracts';
import { setTestJwtVerifier } from '@internal/worker-kit/testing';
import { createExecutionContext, env } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  AnalyticsUnavailable,
  buildInsightsQueries,
  getInsights,
  insightsWindow,
  parseDays,
  SQL_TIMEOUT_MS,
} from './insights.js';
import worker from './index.js';

const MY_SUB = 'auth0|me';

beforeAll(() => {
  setTestJwtVerifier(async (t) => {
    if (t === 'good') return { sub: MY_SUB };
    if (t === 'good-other') return { sub: 'auth0|other' };
    return Promise.reject(new Error('bad'));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const testEnv = { ...env, CF_ANALYTICS_TOKEN: 'test-token' } as Env;

// The default export is { fetch, scheduled } since the publish cron landed.
const request = (path: string, init: RequestInit, e: Env) =>
  worker.fetch(new Request(`https://x${path}`, init), e, createExecutionContext());

const get = (path: string, token = 'good', e: Env = testEnv) =>
  request(path, { headers: { Authorization: `Bearer ${token}` } }, e);

const createTour = (tourId: string) =>
  env.BUCKET.put(tourKey(MY_SUB, tourId), JSON.stringify({ tourId, title: 't', scenes: [] }));

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ meta: [], data, rows: Array.isArray(data) ? data.length : 0 }), {
    status,
  });

// Routes each of the 4 SQL calls by what it selects.
const stubSql = (rows: { daily: unknown; dwell: unknown; byPano: unknown; top: unknown }) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const sql = String(init?.body);
    if (sql.includes("blob1 = 'dwell'")) return json(rows.dwell);
    if (sql.includes("blob1 = 'hotspot'")) return json(rows.top);
    if (sql.includes('toStartOfDay')) return json(rows.daily);
    return json(rows.byPano);
  });

describe('parseDays', () => {
  it('defaults to 14 and accepts 1..30', () => {
    expect(parseDays(undefined)).toBe(14);
    expect(parseDays('1')).toBe(1);
    expect(parseDays('30')).toBe(30);
  });

  it.each(['0', '31', '', 'abc', '1.5', '-1', '007', ' 7'])('rejects %j', (raw) => {
    expect(parseDays(raw)).toBeNull();
  });
});

describe('insightsWindow', () => {
  it('covers `days` whole UTC days ending today', () => {
    const { from, dates } = insightsWindow(3, new Date('2026-09-27T23:59:59Z'));
    expect(from.toISOString()).toBe('2026-09-25T00:00:00.000Z');
    expect(dates).toEqual(['2026-09-25', '2026-09-26', '2026-09-27']);
  });
});

describe('buildInsightsQueries', () => {
  it('builds the four documented queries', () => {
    const q = buildInsightsQueries('panote_events_dev', 'tour-1', new Date('2026-09-14T00:00:00Z'));
    expect(q).toMatchInlineSnapshot(`
      {
        "avgDwell": "SELECT SUM(double1 * _sample_interval) / SUM(_sample_interval) AS avg, SUM(_sample_interval) AS n FROM panote_events_dev WHERE index1 = 'tour-1' AND blob1 = 'dwell' AND timestamp >= toDateTime('2026-09-14 00:00:00') FORMAT JSON",
        "byPano": "SELECT blob2 AS p, SUM(_sample_interval) AS n FROM panote_events_dev WHERE index1 = 'tour-1' AND blob1 = 'view' AND timestamp >= toDateTime('2026-09-14 00:00:00') AND blob2 != '' GROUP BY p ORDER BY n DESC LIMIT 100 FORMAT JSON",
        "daily": "SELECT toStartOfDay(timestamp) AS d, SUM(_sample_interval) AS n FROM panote_events_dev WHERE index1 = 'tour-1' AND blob1 = 'view' AND timestamp >= toDateTime('2026-09-14 00:00:00') GROUP BY d ORDER BY d FORMAT JSON",
        "topHotspots": "SELECT blob2 AS p, blob3 AS h, SUM(_sample_interval) AS n FROM panote_events_dev WHERE index1 = 'tour-1' AND blob1 = 'hotspot' AND timestamp >= toDateTime('2026-09-14 00:00:00') AND blob3 != '' GROUP BY p, h ORDER BY n DESC LIMIT 5 FORMAT JSON",
      }
    `);
  });

  it.each([
    ['tourId', 'panote_events', "x' OR '1'='1"],
    ['dataset', 'events; DROP', 'tour-1'],
  ])('throws on an unsafe %s rather than interpolating it', (_label, ds, tourId) => {
    expect(() => buildInsightsQueries(ds, tourId, new Date())).toThrow();
  });

  it('treats a bad dataset as analytics unavailable', () => {
    expect(() => buildInsightsQueries('bad-name', 'tour-1', new Date())).toThrow(
      AnalyticsUnavailable,
    );
  });
});

describe('getInsights', () => {
  it('zero-fills the daily series and reads quoted 64-bit counts', async () => {
    const now = new Date('2026-09-27T12:00:00Z');
    stubSql({
      daily: [
        { d: '2026-09-25 00:00:00', n: '4' },
        { d: '2026-09-27 00:00:00', n: 2 },
      ],
      dwell: [{ avg: 1500.4, n: '3' }],
      byPano: [
        { p: 'p1', n: '5' },
        { p: 'p2', n: '1' },
      ],
      top: [{ p: 'p1', h: 'door', n: '2' }],
    });
    const r = await getInsights(testEnv, 'tour-1', 4, now);
    expect(r).toEqual({
      days: 4,
      from: '2026-09-24T00:00:00.000Z',
      to: '2026-09-27T12:00:00.000Z',
      totalViews: 6,
      avgDwellMs: 1500,
      daily: [
        { date: '2026-09-24', views: 0 },
        { date: '2026-09-25', views: 4 },
        { date: '2026-09-26', views: 0 },
        { date: '2026-09-27', views: 2 },
      ],
      byPano: [
        { panoId: 'p1', views: 5 },
        { panoId: 'p2', views: 1 },
      ],
      topHotspots: [{ panoId: 'p1', hotspotId: 'door', opens: 2 }],
    });
    expect(InsightsOkSchema.safeParse(r).success).toBe(true);
  });

  it('reports avgDwellMs as null when there are no dwell events', async () => {
    stubSql({ daily: [], dwell: [{ avg: 'nan', n: '0' }], byPano: [], top: [] });
    const r = await getInsights(testEnv, 'tour-1', 1, new Date('2026-09-27T12:00:00Z'));
    expect(r.avgDwellMs).toBeNull();
    expect(r.totalViews).toBe(0);
    expect(r.daily).toEqual([{ date: '2026-09-27', views: 0 }]);
  });
});

describe('GET /api/admin/tours/:tourId/insights', () => {
  it('401s without a token', async () => {
    const r = await request('/api/admin/tours/ins-unauth/insights', {}, testEnv);
    expect(r.status).toBe(401);
  });

  it("404s for another user's tour without querying analytics", async () => {
    await createTour('ins-not-mine');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await get('/api/admin/tours/ins-not-mine/insights', 'good-other');
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not found' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(['0', '31', 'x'])('400s days=%s', async (days) => {
    await createTour('ins-days');
    const r = await get(`/api/admin/tours/ins-days/insights?days=${days}`);
    expect(r.status).toBe(400);
  });

  it('400s a tourId outside PANO_PATTERN', async () => {
    const r = await get(`/api/admin/tours/${encodeURIComponent("a'b")}/insights`);
    expect(r.status).toBe(400);
  });

  it('runs 4 SQL queries against the account endpoint and returns the series', async () => {
    await createTour('ins-ok');
    const spy = stubSql({ daily: [], dwell: [{ avg: 0, n: 0 }], byPano: [], top: [] });
    const r = await get('/api/admin/tours/ins-ok/insights?days=30');
    expect(r.status).toBe(200);
    expect(r.headers.get('Cache-Control')).toBe('private, no-store');
    const body = InsightsOkSchema.parse(await r.json());
    expect(body.days).toBe(30);
    expect(body.daily).toHaveLength(30);
    expect(spy).toHaveBeenCalledTimes(4);
    for (const [url, init] of spy.mock.calls) {
      expect(String(url)).toBe(
        `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
      );
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-token');
      expect(String(init?.body)).toContain("index1 = 'ins-ok'");
    }
  });

  it.each([
    ['a 5xx', () => new Response('boom', { status: 500 })],
    ['a 403', () => new Response('{}', { status: 403 })],
    ['a non-JSON body', () => new Response('<html>', { status: 200 })],
    ['a body with no data array', () => new Response('{"errors":[]}', { status: 200 })],
    ['a non-numeric count', () => json([{ d: '2026-09-27 00:00:00', n: 'x' }])],
  ])('502s on %s from the SQL API', async (_label, respond) => {
    await createTour('ins-502');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => respond());
    const r = await get('/api/admin/tours/ins-502/insights');
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: 'analytics unavailable' });
  });

  it('502s when the fetch itself rejects', async () => {
    await createTour('ins-502-net');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network'));
    const r = await get('/api/admin/tours/ins-502-net/insights');
    expect(r.status).toBe(502);
  });

  it('502s when a SQL call hangs past the timeout', async () => {
    await createTour('ins-502-timeout');
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(signal.reason);
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const pending = get('/api/admin/tours/ins-502-timeout/insights');
    controller.abort(new DOMException('timed out', 'TimeoutError'));
    const r = await pending;
    expect(timeout).toHaveBeenCalledWith(SQL_TIMEOUT_MS);
    expect(SQL_TIMEOUT_MS).toBe(10_000);
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: 'analytics unavailable' });
  });

  it('502s when AE_DATASET is not a safe identifier', async () => {
    await createTour('ins-bad-ds');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await get('/api/admin/tours/ins-bad-ds/insights', 'good', {
      ...testEnv,
      AE_DATASET: 'events; DROP',
    } as Env);
    expect(r.status).toBe(502);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('502s when the token secret is not set', async () => {
    await createTour('ins-no-token');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await get('/api/admin/tours/ins-no-token/insights', 'good', { ...env } as Env);
    expect(r.status).toBe(502);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
