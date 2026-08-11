// Ported from crud-worker/src/stats.test.ts, unchanged.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const callDO = async (id: string, path: string) => {
  const stub = env.STATS.get(env.STATS.idFromName(id));
  return stub.fetch(`https://do${path}`, {
    method: path === '/' ? 'GET' : 'POST',
  });
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
});
