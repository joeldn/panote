import {
  CDN_PURGE_DEAD_PREFIX,
  CDN_PURGE_PENDING_PREFIX,
  manifestKey,
  OPERATOR_TAKEDOWN_PATH,
  OPERATOR_TOKEN_HEADER,
  originalKey,
  planKey,
  pubTourKey,
  slugKey,
  tourKey,
} from '@internal/contracts';
import { setTestJwtVerifier } from '@internal/worker-kit/testing';
import {
  createExecutionContext,
  createScheduledController,
  env,
  SELF,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { RECENT_UPLOAD_MS, STALLED_TILING_MS } from './delete-owned-pano.js';
import { BACKUP_CRON } from './backup.js';
import worker from './index.js';
import { PLAN_SWEEP_GRACE_MS } from './plans.js';

const MY_SUB = 'auth0|purge-me';
const TOKEN = 'route-test-purge-token';
const ZONE = 'fedcba9876543210fedcba9876543210';
const PURGE_URL = `https://api.cloudflare.com/client/v4/zones/${ZONE}/purge_cache`;
const AUTH = { Authorization: 'Bearer good' };

beforeAll(() => {
  setTestJwtVerifier(async (t) => {
    if (t === 'good') return { sub: MY_SUB };
    if (t === 'good-other') return { sub: 'auth0|purge-other' };
    return Promise.reject(new Error('bad'));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// The pano DELETE refuses a pano still tiling or uploaded within the hour: mark
// it tiled, then move the worker's clock on (R2 stamps `uploaded` for real).
const clockPast = (ms: number) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + ms);
};
const deletablePano = async (panoId: string) => {
  await readyPano(panoId);
  const original = await env.BUCKET.head(originalKey(MY_SUB, panoId));
  await env.BUCKET.put(
    manifestKey(panoId),
    JSON.stringify({
      pano: panoId,
      version: `t1-${original!.etag}`,
      format: 'webp',
      tileSize: 512,
    }),
  );
  clockPast(RECENT_UPLOAD_MS + 60_000);
};

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
const call = async (
  path: string,
  init: RequestInit,
  configured = true,
  headers: Record<string, string> = AUTH,
): Promise<Response> => {
  const ctx = createExecutionContext();
  const purgeEnv = configured ? { ...env, CF_PURGE_TOKEN: TOKEN, CDN_ZONE_ID: ZONE } : env;
  const res = await worker.fetch(
    new Request(`https://x${path}`, { ...init, headers }),
    purgeEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
};

const pendingRecords = async () => {
  const listed = await env.BUCKET.list({ prefix: CDN_PURGE_PENDING_PREFIX });
  return Promise.all(
    listed.objects.map(async (o) => (await (await env.BUCKET.get(o.key))!.json()) as unknown),
  );
};
const clearPending = async () => {
  const listed = await env.BUCKET.list({ prefix: CDN_PURGE_PENDING_PREFIX });
  if (listed.objects.length) await env.BUCKET.delete(listed.objects.map((o) => o.key));
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
    await deletablePano('purge-p1');
    const { bodies } = mockPurgeFetch();
    expect((await call('/api/admin/panos/purge-p1', { method: 'DELETE' })).status).toBe(204);
    expect(bodies).toEqual([{ prefixes: ['cdn.panote.dev/tiles/purge-p1/'] }]);
  });

  it('DELETE pano without proof of ownership purges nothing', async () => {
    const { spy } = mockPurgeFetch();
    expect((await call('/api/admin/panos/purge-never', { method: 'DELETE' })).status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  it('DELETE pano of an owned original with no tiles yet purges nothing', async () => {
    await env.BUCKET.put(originalKey(MY_SUB, 'purge-untiled'), 'bytes');
    // Past the stall cutoff: a pano never tiled in a day is deletable.
    clockPast(STALLED_TILING_MS + 60_000);
    const { spy } = mockPurgeFetch();
    expect((await call('/api/admin/panos/purge-untiled', { method: 'DELETE' })).status).toBe(204);
    expect(spy).not.toHaveBeenCalled();
    expect(await env.BUCKET.head(originalKey(MY_SUB, 'purge-untiled'))).toBeNull();
  });

  it("a non-owner's DELETE tour and DELETE publish purge nothing", async () => {
    const tourId = await publishedTour(['purge-foreign-p'], 'purge-foreign');
    const { spy } = mockPurgeFetch();
    const other = { Authorization: 'Bearer good-other' };
    for (const path of [`/api/admin/tours/${tourId}`, `/api/admin/tours/${tourId}/publish`]) {
      expect((await call(path, { method: 'DELETE' }, true, other)).status).toBe(204);
    }
    expect(spy).not.toHaveBeenCalled();
    expect(await env.BUCKET.head(pubTourKey(tourId))).not.toBeNull();
    expect(await env.BUCKET.head(slugKey('purge-foreign'))).not.toBeNull();
  });

  it("another owner's DELETE of a tour leaves its plan images; the owner's takes and purges them", async () => {
    const tourId = await publishedTour(['purge-plan-del-p'], 'purge-plan-del');
    const image = planKey(tourId, 'plan-1', 'image/webp');
    await env.BUCKET.put(image, 'img');
    const { spy, bodies } = mockPurgeFetch();
    const other = { Authorization: 'Bearer good-other' };
    expect(
      (await call(`/api/admin/tours/${tourId}`, { method: 'DELETE' }, true, other)).status,
    ).toBe(204);
    expect(await env.BUCKET.head(image)).not.toBeNull();
    expect(spy).not.toHaveBeenCalled();

    expect((await call(`/api/admin/tours/${tourId}`, { method: 'DELETE' })).status).toBe(204);
    expect(await env.BUCKET.head(image)).toBeNull();
    expect(bodies).toContainEqual({
      files: expect.arrayContaining([`https://cdn.panote.dev/${image}`]),
    });
  });

  it('a tour save deletes and purges the plan image it replaced, and keeps the saved one', async () => {
    await readyPano('purge-plan-put-p');
    const created = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ title: 'plans', scenes: [{ panoId: 'purge-plan-put-p' }] }),
    });
    const { tourId } = (await created.json()) as { tourId: string };
    const oldImage = planKey(tourId, 'plan-old', 'image/webp');
    const newImage = planKey(tourId, 'plan-new', 'image/webp');
    await env.BUCKET.put(oldImage, 'img');
    await env.BUCKET.put(newImage, 'img');
    clockPast(PLAN_SWEEP_GRACE_MS + 60_000);
    const { bodies } = mockPurgeFetch();
    const head = await env.BUCKET.head(tourKey(MY_SUB, tourId));
    const saved = await call(
      `/api/admin/tours/${tourId}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          title: 'plans',
          scenes: [{ panoId: 'purge-plan-put-p' }],
          plan: { id: 'plan-new', type: 'image/webp', width: 10, height: 10 },
        }),
      },
      true,
      { ...AUTH, 'If-Match': head!.etag },
    );
    expect(saved.status).toBe(200);
    expect(await env.BUCKET.head(oldImage)).toBeNull();
    expect(await env.BUCKET.head(newImage)).not.toBeNull();
    expect(bodies).toEqual([{ files: [`https://cdn.panote.dev/${oldImage}`] }]);
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
    ['a 500', 'purge-fail-500', () => Promise.resolve(new Response('no', { status: 500 }))],
    ['a 429', 'purge-fail-429', () => Promise.resolve(new Response('no', { status: 429 }))],
    ['a rejected fetch', 'purge-fail-reject', () => Promise.reject(new TypeError('network down'))],
  ])(
    'still 204s on %s from the purge API, retries it, then queues it for the cron',
    async (_, panoId, respond) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await deletablePano(panoId);
      // The retries' backoff runs on setTimeout, after the response.
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout'], now: Date.now() });
      const { spy } = mockPurgeFetch(respond);
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request(`https://x/api/admin/panos/${panoId}`, { method: 'DELETE', headers: AUTH }),
        { ...env, CF_PURGE_TOKEN: TOKEN, CDN_ZONE_ID: ZONE },
        ctx,
      );
      expect(res.status).toBe(204);
      const done = waitOnExecutionContext(ctx);
      await vi.advanceTimersByTimeAsync(10_000);
      await done;
      expect(spy).toHaveBeenCalledTimes(3);
      const queued = await pendingRecords();
      expect(queued).toContainEqual(
        expect.objectContaining({ prefixes: [`tiles/${panoId}/`], files: [] }),
      );
    },
  );

  it('makes no purge call when CF_PURGE_TOKEN is unset (the test env)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await deletablePano('purge-unconf');
    const { spy } = mockPurgeFetch();
    expect((await call('/api/admin/panos/purge-unconf', { method: 'DELETE' }, false)).status).toBe(
      204,
    );
    expect(spy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('operator takedown purge (M2)', () => {
  const OPERATOR = { [OPERATOR_TOKEN_HEADER]: 'test-operator-token' };
  const takedown = (tourId: string, action: string) =>
    call(
      OPERATOR_TAKEDOWN_PATH,
      {
        method: 'POST',
        body: JSON.stringify({ sub: MY_SUB, tourId, action }),
      },
      true,
      OPERATOR,
    );
  // A tiled pano: a manifest and `n` tiles in one version dir.
  const tiles = async (panoId: string, n: number): Promise<string[]> => {
    const keys = Array.from({ length: n }, (_, i) => `tiles/${panoId}/t1-x/f/0/${i}.webp`);
    for (let i = 0; i < keys.length; i += 100) {
      await Promise.all(keys.slice(i, i + 100).map((k) => env.BUCKET.put(k, 'tile')));
    }
    return [manifestKey(panoId), ...keys];
  };

  it('purges every tile by URL, never by prefix, and answers with what the purge did', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tourId = await publishedTour(['op-purge-a', 'op-purge-b'], 'op-purge');
    const tileKeys = [...(await tiles('op-purge-a', 3)), ...(await tiles('op-purge-b', 2))];
    const { bodies } = mockPurgeFetch();
    const r = await takedown(tourId, 'delete');
    expect(r.status).toBe(200);
    const json = (await r.json()) as { purged: number; purge: unknown };
    expect(json.purge).toEqual({ status: 'purged', purged: json.purged, pending: 0, failed: 0 });
    expect(bodies.every((b) => !('prefixes' in (b as object)))).toBe(true);
    const urls = bodies.flatMap((b) => (b as { files: string[] }).files);
    expect(urls).toEqual(
      expect.arrayContaining([
        ...tileKeys.map((k) => `https://cdn.panote.dev/${k}`),
        `https://cdn.panote.dev/${pubTourKey(tourId)}`,
        `https://cdn.panote.dev/${slugKey('op-purge')}`,
      ]),
    );
    expect(json.purged).toBe(urls.length);
  });

  it('chunks the URLs 100 per request', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tourId = await publishedTour(['op-purge-big'], 'op-purge-big');
    await tiles('op-purge-big', 250);
    const { bodies } = mockPurgeFetch();
    expect((await takedown(tourId, 'delete')).status).toBe(200);
    const sizes = bodies.map((b) => (b as { files: string[] }).files.length);
    expect(sizes.every((n) => n <= 100)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(253);
  });

  it('reports a purge that keeps failing as pending, and queues it for the cron', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await clearPending();
    const tourId = await publishedTour(['op-purge-fail'], 'op-purge-fail');
    await tiles('op-purge-fail', 1);
    // The retries' backoff runs on setTimeout, before the route answers.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'], now: Date.now() });
    mockPurgeFetch(async () => new Response('', { status: 503 }));
    let answered = false;
    const pending = takedown(tourId, 'delete').finally(() => (answered = true));
    // Move the fake clock on while the route works; an R2 call lets real I/O progress.
    while (!answered) {
      await vi.advanceTimersByTimeAsync(1_000);
      await env.BUCKET.head('tick');
    }
    const json = (await (await pending).json()) as {
      purged: number;
      purge: { status: string; pending: number };
    };
    expect(json.purge).toMatchObject({ status: 'pending', pending: json.purged });
    const queued = (await pendingRecords()) as { files: string[] }[];
    expect(queued.flatMap((q) => q.files)).toContain('tiles/op-purge-fail/t1-x/f/0/0.webp');
  });

  it('reports a purge Cloudflare refuses outright as failed, and dead-letters it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const tourId = await publishedTour(['op-purge-bad'], 'op-purge-bad');
    await tiles('op-purge-bad', 1);
    mockPurgeFetch(async () => new Response('', { status: 400 }));
    const r = await takedown(tourId, 'delete');
    expect(r.status).toBe(200);
    const json = (await r.json()) as { purged: number; purge: { status: string; failed: number } };
    expect(json.purge).toMatchObject({ status: 'failed', failed: json.purged });
    const dead = await env.BUCKET.list({ prefix: CDN_PURGE_DEAD_PREFIX });
    expect(dead.objects.length).toBeGreaterThan(0);
  });

  it('reports a skipped purge when it is not configured', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tourId = await publishedTour(['op-purge-unconf'], 'op-purge-unconf');
    const r = await call(
      OPERATOR_TAKEDOWN_PATH,
      { method: 'POST', body: JSON.stringify({ sub: MY_SUB, tourId, action: 'unpublish' }) },
      false,
      OPERATOR,
    );
    expect(await r.json()).toMatchObject({ purged: 2, purge: { status: 'skipped', failed: 2 } });
  });
});

describe('queued purge retry on the 15-minute cron', () => {
  it('retries what is queued, and deletes the record once it went through', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await clearPending();
    await env.BUCKET.put(
      `${CDN_PURGE_PENDING_PREFIX}2026-10-23T00:00:00.000Z-a.json`,
      JSON.stringify({
        v: 1,
        firstAt: new Date().toISOString(),
        prefixes: ['tiles/cron-p/'],
        files: [],
      }),
    );
    const { bodies } = mockPurgeFetch();
    const ctx = createExecutionContext();
    await worker.scheduled(
      createScheduledController({ scheduledTime: Date.now(), cron: BACKUP_CRON }),
      { ...env, CF_PURGE_TOKEN: TOKEN, CDN_ZONE_ID: ZONE },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(bodies).toEqual([{ prefixes: ['cdn.panote.dev/tiles/cron-p/'] }]);
    expect(await pendingRecords()).toEqual([]);
  });
});
