// Ported from crud-worker/src/routes.test.ts (the two like cases), expanded per
// port spec section 3.6 to cover the /like bi-modal auth path (D1) and the
// view/stats routes. Storage is shared between it() cases in this file and
// isolated between files (section 0.7), so every case uses its own tourId and
// asserts only on state it created itself.
import { SELF } from 'cloudflare:test';
import { setTestJwtVerifier } from '@internal/worker-kit/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Test seam installed via setTestJwtVerifier - the ONLY sanctioned way to reach
// globalThis.__verifyJwt (port spec section 0.8). 'good' verifies; anything else
// rejects, exactly like the source's routes.test.ts seam.
beforeAll(() => {
  setTestJwtVerifier(async (t) => {
    if (t !== 'good') throw new Error('bad');
    return { sub: 'auth0|me' };
  });
});
afterAll(() => {
  setTestJwtVerifier(undefined);
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

describe('POST /api/tours/:tourId/like', () => {
  it('400s when the liker has no identity at all', async () => {
    const r = await SELF.fetch('https://x/api/tours/like-anon/like', { method: 'POST' });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'login or X-Client-Id required to like' });
  });

  it('counts a like keyed by X-Client-Id', async () => {
    const r = await SELF.fetch('https://x/api/tours/like-anon/like', {
      method: 'POST',
      headers: { 'X-Client-Id': 'anon-1' },
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ likes: 1 });
  });

  it('dedupes repeated likes from the same X-Client-Id', async () => {
    const like = () =>
      SELF.fetch('https://x/api/tours/like-dedupe-anon/like', {
        method: 'POST',
        headers: { 'X-Client-Id': 'anon-dupe' },
      });
    await like();
    const second = await like();
    expect(await second.json()).toMatchObject({ likes: 1 });
  });

  it('dedupes by sub for a logged-in user even across different X-Client-Id values', async () => {
    // Proves the optional-auth path dedupes by sub rather than falling through
    // to X-Client-Id when a valid identity is present.
    const like = (clientId: string) =>
      SELF.fetch('https://x/api/tours/like-sub/like', {
        method: 'POST',
        headers: { Authorization: 'Bearer good', 'X-Client-Id': clientId },
      });
    const first = await like('client-a');
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ likes: 1 });
    const second = await like('client-b');
    expect(await second.json()).toMatchObject({ likes: 1 });
  });

  it('degrades to the X-Client-Id key when the bearer token is rejected, rather than 401ing', async () => {
    // Pins the authenticateOptional contract: a rejected token must not become
    // a 401. If someone swaps authenticateOptional for authenticate here, this
    // test fails.
    const r = await SELF.fetch('https://x/api/tours/like-bad-token/like', {
      method: 'POST',
      headers: { Authorization: 'Bearer bad', 'X-Client-Id': 'anon-fallback' },
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ likes: 1 });
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
