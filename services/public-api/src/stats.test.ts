// Ported from crud-worker/src/stats.test.ts, unchanged.
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { importLikerKey, likerHash, MAX_LIKES_PER_TOUR, TourStats } from './stats.js';

const callDO = async (id: string, path: string, method = path === '/' ? 'GET' : 'POST') => {
  const stub = env.STATS.get(env.STATS.idFromName(id));
  return stub.fetch(`https://do${path}`, { method });
};

describe('TourStats DO', () => {
  it('counts views and dedupes likes per user', async () => {
    await callDO('t1', '/view');
    await callDO('t1', '/view');
    await callDO('t1', '/like?u=alice');
    await callDO('t1', '/like?u=alice'); // duplicate — must not double-count
    await callDO('t1', '/like?u=bob');
    const res = await callDO('t1', '/');
    expect(await res.json()).toEqual({ views: 2, likes: 2 });
  });

  it('DELETE clears the counts and the like dedupe (account delete)', async () => {
    await callDO('t-del', '/view');
    await callDO('t-del', '/like?u=alice');
    const res = await callDO('t-del', '/', 'DELETE');
    expect(await res.json()).toEqual({ views: 0, likes: 0 });
    expect(await (await callDO('t-del', '/')).json()).toEqual({ views: 0, likes: 0 });
    // liked:alice went too, so the same user's like counts again.
    await callDO('t-del', '/like?u=alice');
    expect(await (await callDO('t-del', '/')).json()).toEqual({ views: 0, likes: 1 });
  });
});

describe('TourStats like store cap', () => {
  const stub = (id: string) => env.STATS.get(env.STATS.idFromName(id));

  it('stops counting and storing new likers once the tour holds MAX_LIKES_PER_TOUR', async () => {
    await runInDurableObject(stub('t-cap'), async (_i, state) => {
      await state.storage.put('counts', { views: 0, likes: MAX_LIKES_PER_TOUR });
    });
    const res = await callDO('t-cap', '/like?u=newcomer');
    expect(await res.json()).toEqual({ views: 0, likes: MAX_LIKES_PER_TOUR });
    const stored = await runInDurableObject(stub('t-cap'), async (_i, state) =>
      state.storage.list(),
    );
    expect([...stored.keys()]).toEqual(['counts']);
  });

  it('still counts the last like under the cap', async () => {
    await runInDurableObject(stub('t-cap-edge'), async (_i, state) => {
      await state.storage.put('counts', { views: 0, likes: MAX_LIKES_PER_TOUR - 1 });
    });
    const res = await callDO('t-cap-edge', '/like?u=last');
    expect(await res.json()).toEqual({ views: 0, likes: MAX_LIKES_PER_TOUR });
  });

  it('refuses an over-long liker key', async () => {
    await callDO('t-long', `/like?u=${'x'.repeat(257)}`);
    expect(await (await callDO('t-long', '/')).json()).toEqual({ views: 0, likes: 0 });
  });

  it('DELETE (account delete) still clears a capped store', async () => {
    await runInDurableObject(stub('t-cap-del'), async (_i, state) => {
      await state.storage.put('counts', { views: 3, likes: MAX_LIKES_PER_TOUR });
    });
    await callDO('t-cap-del', '/', 'DELETE');
    await callDO('t-cap-del', '/like?u=alice');
    expect(await (await callDO('t-cap-del', '/')).json()).toEqual({ views: 0, likes: 1 });
  });
});

describe('TourStats liker hashing', () => {
  const stub = (id: string) => env.STATS.get(env.STATS.idFromName(id));
  const keys = (id: string) =>
    runInDurableObject(stub(id), async (_i, state) => [...(await state.storage.list()).keys()]);
  const hmac = async (who: string) =>
    `likedh:${await likerHash(who, await importLikerKey('test-liker-key'))}`;

  it('stores an HMAC of the liker, never the id itself', async () => {
    await callDO('t-hash', '/like?u=google-oauth2|123');
    const stored = await keys('t-hash');
    expect(stored).toContain(await hmac('google-oauth2|123'));
    expect(stored.join()).not.toContain('google-oauth2');
    expect(stored.join()).not.toContain('123');
  });

  it('hashes with the key: another key or none gives another hash', async () => {
    const keyed = await likerHash('alice', await importLikerKey('test-liker-key'));
    expect(keyed).toMatch(/^[0-9a-f]{64}$/);
    expect(await likerHash('alice', await importLikerKey('other-key'))).not.toBe(keyed);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await likerHash('alice', await importLikerKey(undefined))).not.toBe(keyed);
  });

  it('falls back to an unkeyed, domain-prefixed SHA-256 without the secret, and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await runInDurableObject(stub('t-unkeyed'), async (_i, state) => {
      const unkeyed = new TourStats(state, { LIKER_HASH_FALLBACK: 'allow' });
      await unkeyed.fetch(new Request('https://do/like?u=alice', { method: 'POST' }));
      return unkeyed.fetch(new Request('https://do/like?u=alice', { method: 'POST' }));
    });
    expect(await res.json()).toEqual({ views: 0, likes: 1 });
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode('panote:liker:v1:alice'),
    );
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    const stored = await keys('t-unkeyed');
    expect(stored).toContain(`likedh:${hex}`);
    expect(stored.join()).not.toContain('alice');
    // Once per isolate: an earlier test may already have logged it.
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('refuses likes without the secret where the fallback is not allowed (production)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const [like, view, legacy] = await runInDurableObject(stub('t-closed'), async (_i, state) => {
      await state.storage.put('liked:old', 1);
      const closed = new TourStats(state, { LIKER_HASH_FALLBACK: 'refuse' });
      const like = await closed.fetch(new Request('https://do/like?u=alice', { method: 'POST' }));
      const view = await closed.fetch(new Request('https://do/view', { method: 'POST' }));
      return [
        { status: like.status, body: await like.json() },
        await view.json(),
        await state.storage.get('liked:old'),
      ] as const;
    });
    expect(like).toEqual({ status: 503, body: { error: 'likes unavailable' } });
    expect(error).toHaveBeenCalledTimes(1);
    // Views still count, and a raw key stays raw until it can be hashed.
    expect(view).toEqual({ views: 1, likes: 0 });
    expect(legacy).toBe(1);
    expect((await keys('t-closed')).join()).not.toContain('likedh:');
  });

  it('creates no state on a read of an unknown tour, or after DELETE', async () => {
    await callDO('t-unknown', '/');
    expect(await keys('t-unknown')).toEqual([]);
    await callDO('t-reread', '/like?u=alice');
    await callDO('t-reread', '/', 'DELETE');
    await callDO('t-reread', '/');
    expect(await keys('t-reread')).toEqual([]);
  });

  it('counts every one of many concurrent likes', async () => {
    const likes = Array.from({ length: 20 }, (_, i) => callDO('t-race', `/like?u=user-${i}`));
    await Promise.all(likes);
    expect(await (await callDO('t-race', '/')).json()).toEqual({ views: 0, likes: 20 });
  });

  it('counts a like stored raw before the change, and rewrites it hashed', async () => {
    await runInDurableObject(stub('t-legacy'), async (_i, state) => {
      await state.storage.put({ counts: { views: 0, likes: 1 }, 'liked:alice': 1 });
    });
    const res = await callDO('t-legacy', '/like?u=alice');
    expect(await res.json()).toEqual({ views: 0, likes: 1 });
    const stored = await keys('t-legacy');
    expect(stored).not.toContain('liked:alice');
    expect(stored).toContain(await hmac('alice'));
    // Still a duplicate after the rewrite.
    await callDO('t-legacy', '/like?u=alice');
    expect(await (await callDO('t-legacy', '/')).json()).toEqual({ views: 0, likes: 1 });
  });

  it('rewrites raw keys a batch per request, and dedupes a raw key still waiting', async () => {
    const legacy: Record<string, unknown> = { counts: { views: 0, likes: 300 } };
    for (let i = 0; i < 300; i++) legacy[`liked:user-${String(i).padStart(3, '0')}`] = 1;
    await runInDurableObject(stub('t-batch'), async (_i, state) => {
      for (const batch of [0, 1, 2]) {
        const entries = Object.entries(legacy).slice(batch * 128, (batch + 1) * 128);
        await state.storage.put(Object.fromEntries(entries));
      }
    });
    const raw = async () => (await keys('t-batch')).filter((k) => k.startsWith('liked:'));
    await callDO('t-batch', '/');
    expect(await raw()).toHaveLength(300 - 128);
    // user-299 is still raw: it counts as liked.
    await callDO('t-batch', '/like?u=user-299');
    expect(await raw()).toHaveLength(300 - 256);
    await callDO('t-batch', '/');
    expect(await raw()).toHaveLength(0);
    expect(await (await callDO('t-batch', '/')).json()).toEqual({ views: 0, likes: 300 });
    await callDO('t-batch', '/like?u=user-000');
    await callDO('t-batch', '/like?u=user-299');
    expect(await (await callDO('t-batch', '/')).json()).toEqual({ views: 0, likes: 300 });
    expect(await keys('t-batch')).toContain(await hmac('user-299'));
  });
});
