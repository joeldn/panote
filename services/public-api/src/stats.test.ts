// Ported from crud-worker/src/stats.test.ts, unchanged.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

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
