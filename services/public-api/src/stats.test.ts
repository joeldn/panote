// Ported from crud-worker/src/stats.test.ts, unchanged.
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { MAX_LIKES_PER_TOUR } from './stats.js';

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
      state.storage.get('liked:newcomer'),
    );
    expect(stored).toBeUndefined();
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
