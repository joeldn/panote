// Ported from crud-worker/src/routes.test.ts (the two like cases), expanded per
// port spec section 3.6 to cover the /like bi-modal auth path (D1) and the
// view/stats routes. Storage is shared between it() cases in this file and
// isolated between files (section 0.7), so every case uses its own tourId and
// asserts only on state it created itself.
import { pubTourKey } from '@internal/contracts';
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { setTestJwtVerifier } from '@internal/worker-kit/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import app, { RATE_PERIOD_SECONDS } from './index.js';

// Test seam installed via setTestJwtVerifier - the ONLY sanctioned way to reach
// globalThis.__verifyJwt (port spec section 0.8). 'good' verifies as auth0|me,
// 'sub:<x>' as <x>; anything else rejects, like the source's routes.test.ts seam.
beforeAll(() => {
  setTestJwtVerifier(async (t) => {
    if (t.startsWith('sub:')) return { sub: t.slice(4) };
    if (t !== 'good') throw new Error('bad');
    return { sub: 'auth0|me' };
  });
});
afterAll(() => {
  setTestJwtVerifier(undefined);
});

// A view, like or events batch needs the tour's public bundle; these tests publish one per tourId.
const publish = (tourId: string) => env.BUCKET.put(pubTourKey(tourId), '{}');
beforeAll(async () => {
  for (const id of ['view-1', 'stats-no-reset', 'rl-v6', 'rl-own']) await publish(id);
});

describe('POST /api/tours/:tourId/view', () => {
  it('increments the view counter on each call', async () => {
    const view = () => SELF.fetch('https://x/api/tours/view-1/view', { method: 'POST' });
    await view();
    await view();
    const stats = await SELF.fetch('https://x/api/tours/view-1/stats');
    expect(await stats.json()).toMatchObject({ views: 2 });
  });
});

// Each like gets its own client IP, so the real per-IP limiter never trips here.
let ipSeq = 0;
const like = (tourId: string, headers: Record<string, string> = {}) =>
  SELF.fetch(`https://x/api/tours/${tourId}/like`, {
    method: 'POST',
    headers: { 'CF-Connecting-IP': `203.0.113.${++ipSeq}`, ...headers },
  });

const ANON_1 = '6f9619ff-8b86-4d01-b42d-00cf4fc964ff';
const ANON_2 = '0b4e7a0e-5fe1-4b1c-9a51-3f2d4c7b8e90';

const storedKeys = async (tourId: string) =>
  runInDurableObject(env.STATS.get(env.STATS.idFromName(tourId)), async (_instance, state) => [
    ...(await state.storage.list()).keys(),
  ]);

describe('POST /api/tours/:tourId/like', () => {
  it('400s when the liker has no identity at all', async () => {
    const r = await like('like-anon');
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'login or X-Client-Id required to like' });
  });

  it('counts a like keyed by X-Client-Id', async () => {
    await publish('like-anon');
    const r = await like('like-anon', { 'X-Client-Id': ANON_1 });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ likes: 1 });
  });

  it('dedupes repeated likes from the same X-Client-Id', async () => {
    await publish('like-dedupe-anon');
    await like('like-dedupe-anon', { 'X-Client-Id': ANON_1 });
    const second = await like('like-dedupe-anon', { 'X-Client-Id': ANON_1 });
    expect(await second.json()).toMatchObject({ likes: 1 });
  });

  it('dedupes by sub for a logged-in user even across different X-Client-Id values', async () => {
    // Proves the optional-auth path dedupes by sub rather than falling through
    // to X-Client-Id when a valid identity is present.
    await publish('like-sub');
    const likeAs = (clientId: string) =>
      like('like-sub', { Authorization: 'Bearer good', 'X-Client-Id': clientId });
    const first = await likeAs(ANON_1);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ likes: 1 });
    const second = await likeAs(ANON_2);
    expect(await second.json()).toMatchObject({ likes: 1 });
  });

  it('does not collide two subs that share a raw "&u=" substring', async () => {
    // The DO dedupe key is built as `?u=${encodeURIComponent(who)}`. Without
    // the encode, sub 'a&u=b' would inject a second `u` query param and
    // url.searchParams.get('u') would read back 'a' - colliding with a
    // distinct user whose sub really is 'a'.
    await publish('like-collision');
    const first = await like('like-collision', { Authorization: 'Bearer sub:a' });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ likes: 1 });
    const second = await like('like-collision', { Authorization: 'Bearer sub:a&u=b' });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ likes: 2 });
  });

  it('degrades to the X-Client-Id key when the bearer token is rejected, rather than 401ing', async () => {
    // Pins the authenticateOptional contract: a rejected token must not become
    // a 401. If someone swaps authenticateOptional for authenticate here, this
    // test fails.
    await publish('like-bad-token');
    const r = await like('like-bad-token', { Authorization: 'Bearer bad', 'X-Client-Id': ANON_1 });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ likes: 1 });
  });

  it.each([
    'anon-1',
    'a&u=b',
    ANON_1.toUpperCase(),
    `${ANON_1}x`,
    '6f9619ff-8b86-1d01-b42d-00cf4fc964ff',
    'x'.repeat(4096),
  ])('400s an anonymous X-Client-Id that is not a v4 UUID (%s), storing nothing', async (id) => {
    await publish('like-bad-client');
    const r = await like('like-bad-client', { 'X-Client-Id': id });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'invalid X-Client-Id' });
    expect(await storedKeys('like-bad-client')).toEqual([]);
  });

  it('a logged-in like ignores a malformed X-Client-Id', async () => {
    await publish('like-sub-bad-client');
    const r = await like('like-sub-bad-client', {
      Authorization: 'Bearer good',
      'X-Client-Id': 'not-a-uuid',
    });
    expect(r.status).toBe(200);
  });

  it('404s a well-formed tourId with no published tour, and creates nothing', async () => {
    const r = await like('like-no-such-tour', { 'X-Client-Id': ANON_1 });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'tour not found' });
    expect(await storedKeys('like-no-such-tour')).toEqual([]);
  });
});

describe('POST /api/tours/:tourId/view for an unpublished tour', () => {
  it('404s and creates no Durable Object state', async () => {
    const r = await SELF.fetch('https://x/api/tours/view-no-such-tour/view', { method: 'POST' });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'tour not found' });
    expect(await storedKeys('view-no-such-tour')).toEqual([]);
  });
});

describe('GET /api/tours/:tourId/stats', () => {
  it('sets content-type and a 30s cache-control', async () => {
    const r = await SELF.fetch('https://x/api/tours/stats-headers/stats');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/json');
    expect(r.headers.get('cache-control')).toBe('public, max-age=30');
    expect(await r.json()).toEqual({ views: 0, likes: 0 });
  });
});

describe('stats reset is not public', () => {
  it('a DELETE through the public routes never reaches the DO', async () => {
    await SELF.fetch('https://x/api/tours/stats-no-reset/view', { method: 'POST' });
    for (const path of ['stats', 'view', 'like']) {
      const r = await SELF.fetch(`https://x/api/tours/stats-no-reset/${path}`, {
        method: 'DELETE',
      });
      expect(r.status).toBe(404);
    }
    const stats = await SELF.fetch('https://x/api/tours/stats-no-reset/stats');
    expect(await stats.json()).toMatchObject({ views: 1 });
  });
});

describe('rate limits (per client IP)', () => {
  // Through app.request, so each limiter can be a fake that records its keys.
  const limited = () => vi.fn(async (_o: { key: string }) => ({ success: false }));
  const allowed = () => vi.fn(async (_o: { key: string }) => ({ success: true }));
  const call = (path: string, overrides: Partial<Env>, headers: Record<string, string> = {}) =>
    app.request(
      path,
      { method: 'POST', headers: { 'CF-Connecting-IP': '198.51.100.7', ...headers } },
      { ...env, ...overrides },
    );

  it.each([
    ['view', 'VIEW_LIMITER'],
    ['like', 'LIKE_LIMITER'],
    ['events', 'EVENTS_LIMITER'],
  ] as const)('429s %s with Retry-After, keyed by CF-Connecting-IP', async (route, binding) => {
    const limit = limited();
    const r = await call(`/api/tours/rl-${route}/${route}`, { [binding]: { limit } });
    expect(r.status).toBe(429);
    expect(r.headers.get('Retry-After')).toBe(String(RATE_PERIOD_SECONDS));
    expect(await r.json()).toEqual({ error: 'rate limited' });
    expect(limit).toHaveBeenCalledWith({ key: '198.51.100.7' });
  });

  it('two IPv6 addresses in the same /64 share one counter; another /64 has its own', async () => {
    // One request per key, like a real limiter whose limit is 1.
    const seen = new Set<string>();
    const limit = vi.fn(async ({ key }: { key: string }) => {
      const success = !seen.has(key);
      seen.add(key);
      return { success };
    });
    const view = (ip: string) =>
      call('/api/tours/rl-v6/view', { VIEW_LIMITER: { limit } }, { 'CF-Connecting-IP': ip });
    expect((await view('2001:db8:1:2::1')).status).toBe(200);
    expect((await view('2001:db8:1:2:ffff:eeee:dddd:9')).status).toBe(429);
    expect((await view('2001:db8:1:3::1')).status).toBe(200);
    expect(limit.mock.calls.map(([o]) => o.key)).toEqual([
      '2001:db8:1:2::/64',
      '2001:db8:1:2::/64',
      '2001:db8:1:3::/64',
    ]);
  });

  it('a limited view never reaches the counter', async () => {
    await call('/api/tours/rl-view-count/view', { VIEW_LIMITER: { limit: limited() } });
    const stats = await SELF.fetch('https://x/api/tours/rl-view-count/stats');
    expect(await stats.json()).toEqual({ views: 0, likes: 0 });
  });

  it('each route uses only its own limiter', async () => {
    const view = allowed();
    const like = limited();
    const events = allowed();
    const r = await call('/api/tours/rl-own/view', {
      VIEW_LIMITER: { limit: view },
      LIKE_LIMITER: { limit: like },
      EVENTS_LIMITER: { limit: events },
    });
    expect(r.status).toBe(200);
    expect(view).toHaveBeenCalledTimes(1);
    expect(like).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
  });

  it('stats reads are not limited', async () => {
    const limit = limited();
    const r = await app.request(
      '/api/tours/rl-stats/stats',
      {},
      { ...env, VIEW_LIMITER: { limit }, LIKE_LIMITER: { limit }, EVENTS_LIMITER: { limit } },
    );
    expect(r.status).toBe(200);
    expect(limit).not.toHaveBeenCalled();
  });

  it('a junk tourId is refused before it costs a limiter call', async () => {
    const limit = limited();
    const r = await call('/api/tours/bad%20id/view', { VIEW_LIMITER: { limit } });
    expect(r.status).toBe(400);
    expect(limit).not.toHaveBeenCalled();
  });
});
