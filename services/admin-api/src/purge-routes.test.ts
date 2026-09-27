import { manifestKey, originalKey, pubTourKey, slugKey } from '@internal/contracts';
import { setTestJwtVerifier } from '@internal/worker-kit/testing';
import { createExecutionContext, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import worker from './index.js';

const MY_SUB = 'auth0|purge-me';
const TOKEN = 'route-test-purge-token';
const ZONE = 'fedcba9876543210fedcba9876543210';
const PURGE_URL = `https://api.cloudflare.com/client/v4/zones/${ZONE}/purge_cache`;
const AUTH = { Authorization: 'Bearer good' };

beforeAll(() => {
  setTestJwtVerifier(async (t) =>
    t === 'good' ? { sub: MY_SUB } : Promise.reject(new Error('bad')),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

// The worker's outbound fetch, mocked: only purge calls are expected here.
const mockPurgeFetch = (respond: () => Promise<Response> = async () => Response.json({})) => {
  const bodies: unknown[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(String(input)).toBe(PURGE_URL);
    bodies.push(JSON.parse(String(init?.body)));
    return await respond();
  });
  return { spy, bodies };
};

/** Calls the worker with purge configured, and waits for its waitUntil work. */
const call = async (path: string, init: RequestInit, configured = true): Promise<Response> => {
  const ctx = createExecutionContext();
  const purgeEnv = configured ? { ...env, CF_PURGE_TOKEN: TOKEN, CDN_ZONE_ID: ZONE } : env;
  const res = await worker.fetch(
    new Request(`https://x${path}`, { ...init, headers: AUTH }),
    purgeEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
};

const readyPano = async (panoId: string) => {
  await env.BUCKET.put(originalKey(MY_SUB, panoId), 'bytes');
  const r = await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
    method: 'PUT',
    headers: { ...AUTH, 'If-Match': '*' },
    body: JSON.stringify({ title: panoId, hotspots: [] }),
  });
  expect(r.status).toBe(200);
  await env.BUCKET.put(manifestKey(panoId), JSON.stringify({ pano: panoId }));
};

const publishedTour = async (panoIds: string[], slug: string): Promise<string> => {
  for (const p of panoIds) await readyPano(p);
  const created = await SELF.fetch('https://x/api/admin/tours', {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ title: slug, scenes: panoIds.map((panoId) => ({ panoId })) }),
  });
  const { tourId } = (await created.json()) as { tourId: string };
  const pub = await SELF.fetch(`https://x/api/admin/tours/${tourId}/publish`, {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ slug }),
  });
  expect(pub.status).toBe(200);
  return tourId;
};

describe('CDN purge on delete/unpublish (B6)', () => {
  it('DELETE pano purges its tiles prefix', async () => {
    await readyPano('purge-p1');
    const { bodies } = mockPurgeFetch();
    expect((await call('/api/admin/panos/purge-p1', { method: 'DELETE' })).status).toBe(204);
    expect(bodies).toEqual([{ prefixes: ['cdn.panote.dev/tiles/purge-p1/'] }]);
  });

  it('DELETE pano without proof of ownership purges nothing', async () => {
    const { spy } = mockPurgeFetch();
    expect((await call('/api/admin/panos/purge-never', { method: 'DELETE' })).status).toBe(204);
    expect(spy).not.toHaveBeenCalled();
  });

  it('DELETE tour batches every deleted pano into one prefix purge, plus the pub URLs', async () => {
    const tourId = await publishedTour(['purge-t-a', 'purge-t-b', 'purge-t-c'], 'purge-tour');
    const { bodies } = mockPurgeFetch();
    expect((await call(`/api/admin/tours/${tourId}`, { method: 'DELETE' })).status).toBe(204);
    expect(bodies).toEqual([
      {
        prefixes: [
          'cdn.panote.dev/tiles/purge-t-a/',
          'cdn.panote.dev/tiles/purge-t-b/',
          'cdn.panote.dev/tiles/purge-t-c/',
        ],
      },
      {
        files: [
          `https://cdn.panote.dev/${pubTourKey(tourId)}`,
          `https://cdn.panote.dev/${slugKey('purge-tour')}`,
        ],
      },
    ]);
  });

  it('unpublish purges the pub bundle and the removed slug', async () => {
    const tourId = await publishedTour(['purge-u1'], 'purge-unpub');
    const { bodies } = mockPurgeFetch();
    expect((await call(`/api/admin/tours/${tourId}/publish`, { method: 'DELETE' })).status).toBe(
      204,
    );
    expect(bodies).toEqual([
      {
        files: [
          `https://cdn.panote.dev/${pubTourKey(tourId)}`,
          `https://cdn.panote.dev/${slugKey('purge-unpub')}`,
        ],
      },
    ]);
  });

  it.each([
    ['a non-2xx', 'purge-fail-500', () => Promise.resolve(new Response('no', { status: 500 }))],
    ['a rejected fetch', 'purge-fail-reject', () => Promise.reject(new TypeError('network down'))],
  ])('still 204s on %s from the purge API', async (_, panoId, respond) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await readyPano(panoId);
    const { spy } = mockPurgeFetch(respond);
    expect((await call(`/api/admin/panos/${panoId}`, { method: 'DELETE' })).status).toBe(204);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('makes no purge call when unconfigured (the dev placeholder zone id)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await readyPano('purge-unconf');
    const { spy } = mockPurgeFetch();
    expect((await call('/api/admin/panos/purge-unconf', { method: 'DELETE' }, false)).status).toBe(
      204,
    );
    expect(spy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });
});
