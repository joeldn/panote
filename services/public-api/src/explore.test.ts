import {
  EXPLORE_PATH,
  EXPLORE_ROOT,
  exploreEntryKey,
  exploreHiddenKey,
  ExplorePageSchema,
  pubTourKey,
  PUB_TOURS_ROOT,
  type ExploreEntry,
} from '@internal/contracts';
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { listExplore } from './explore.js';
import app, { EXPLORE_MAX_AGE_SECONDS, RATE_PERIOD_SECONDS } from './index.js';

// Storage is shared between it() cases in this file, and the index is one list,
// so each case starts from an empty explore/ and pub/.
const clear = async (prefix: string) => {
  const { objects } = await env.BUCKET.list({ prefix });
  if (objects.length) await env.BUCKET.delete(objects.map((o) => o.key));
};
beforeEach(async () => {
  await clear(EXPLORE_ROOT);
  await clear(PUB_TOURS_ROOT);
});

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-01-01T00:00:00.000Z');

type Seed = {
  day: number;
  visibility?: string;
  slug?: string;
  bundleMetadata?: boolean;
  bundle?: boolean;
  entry?: Partial<ExploreEntry> & Record<string, unknown>;
};

/** One listed tour: its index entry (listed `day` days after T0) and its public bundle. */
const seed = async (tourId: string, s: Seed) => {
  const slug = s.slug ?? `${tourId}-slug`;
  const visibility = s.visibility ?? 'public';
  const listedAt = T0 + s.day * DAY;
  const entry: ExploreEntry = {
    v: 1,
    tourId,
    slug,
    title: `Title ${tourId}`,
    sceneCount: 2,
    cover: { panoId: `${tourId}-p`, version: 't1-abc', image: 'og' },
    publishedAt: new Date(T0).toISOString(),
    listedAt: new Date(listedAt).toISOString(),
    updatedAt: new Date(listedAt).toISOString(),
    ...s.entry,
  };
  await env.BUCKET.put(exploreEntryKey(listedAt, tourId), JSON.stringify(entry));
  if (s.bundle === false) return;
  await env.BUCKET.put(pubTourKey(tourId), JSON.stringify({ v: 1, tourId, slug, visibility }), {
    ...(s.bundleMetadata === false ? {} : { customMetadata: { visibility, slug } }),
  });
};

describe('listExplore', () => {
  it('lists newest-listed first, as cards with no owner data', async () => {
    await seed('old', { day: 1 });
    await seed('new', { day: 3 });
    await seed('mid', { day: 2, entry: { owner: 'auth0|someone', email: 'a@b.c' } });
    const page = await listExplore(env.BUCKET, undefined);
    expect(page.tours.map((t) => t.tourId)).toEqual(['new', 'mid', 'old']);
    expect(page.cursor).toBeNull();
    expect(Object.keys(page.tours[1]!).sort()).toEqual([
      'cover',
      'publishedAt',
      'sceneCount',
      'slug',
      'title',
      'tourId',
      'updatedAt',
    ]);
    expect(JSON.stringify(page)).not.toMatch(/auth0|a@b\.c/);
  });

  it('drops an entry whose bundle is gone, Unlisted, or hidden by the operator', async () => {
    await seed('gone', { day: 1, bundle: false });
    await seed('unlisted', { day: 2, visibility: 'unlisted' });
    await seed('hidden', { day: 3 });
    await env.BUCKET.put(exploreHiddenKey('hidden'), '{"v":1}');
    await seed('ok', { day: 4 });
    const page = await listExplore(env.BUCKET, undefined);
    expect(page.tours.map((t) => t.tourId)).toEqual(['ok']);
  });

  it('drops an entry with no ready scene, one that does not parse, or one filed under another tour', async () => {
    await seed('empty', { day: 1, entry: { sceneCount: 0 } });
    await seed('broken', { day: 2, entry: { title: 7 as unknown as string } });
    await seed('misfiled', { day: 3, entry: { tourId: 'someone-else' } });
    expect((await listExplore(env.BUCKET, undefined)).tours).toEqual([]);
  });

  it('takes the slug from the bundle, reading it whole when it has no metadata', async () => {
    await seed('renamed', { day: 1, slug: 'new-slug', entry: { slug: 'old-slug' } });
    await seed('legacy', { day: 2, bundleMetadata: false });
    await seed('legacy-unl', { day: 3, bundleMetadata: false, visibility: 'unlisted' });
    const page = await listExplore(env.BUCKET, undefined);
    expect(page.tours.map((t) => [t.tourId, t.slug])).toEqual([
      ['legacy', 'legacy-slug'],
      ['renamed', 'new-slug'],
    ]);
  });

  it('pages by cursor, skipping dropped entries, until the end', async () => {
    for (let i = 1; i <= 5; i += 1) await seed(`p${i}`, { day: i });
    await seed('p6', { day: 6, bundle: false });
    const first = await listExplore(env.BUCKET, undefined, 2);
    expect(first.tours.map((t) => t.tourId)).toEqual(['p5', 'p4']);
    expect(first.cursor).not.toBeNull();
    const second = await listExplore(env.BUCKET, first.cursor!, 2);
    expect(second.tours.map((t) => t.tourId)).toEqual(['p3', 'p2']);
    const third = await listExplore(env.BUCKET, second.cursor!, 2);
    expect(third.tours.map((t) => t.tourId)).toEqual(['p1']);
    expect(third.cursor).toBeNull();
  });

  it('leaves out an entry filed later than now (a held tour) until its time comes', async () => {
    await seed('now', { day: 1 });
    await seed('held', { day: 9 });
    const before = T0 + 5 * DAY;
    expect(
      (await listExplore(env.BUCKET, undefined, 24, before)).tours.map((t) => t.tourId),
    ).toEqual(['now']);
    // A cursor pointing into the future can't reach it either.
    const ahead = `${exploreEntryKey(T0 + 10 * DAY, 'x')
      .split('/')
      .at(-1)!
      .slice(0, -5)}`;
    expect((await listExplore(env.BUCKET, ahead, 24, before)).tours.map((t) => t.tourId)).toEqual([
      'now',
    ]);
    const after = T0 + 9 * DAY;
    expect(
      (await listExplore(env.BUCKET, undefined, 24, after)).tours.map((t) => t.tourId),
    ).toEqual(['held', 'now']);
  });

  it('drops an entry whose listedAt is later than now, whatever its key says', async () => {
    await seed('odd', { day: 1, entry: { listedAt: new Date(T0 + 30 * DAY).toISOString() } });
    expect((await listExplore(env.BUCKET, undefined, 24, T0 + 2 * DAY)).tours).toEqual([]);
  });

  it('stops after a few list calls when everything is dropped, and hands back a cursor', async () => {
    for (let i = 1; i <= 8; i += 1) await seed(`d${i}`, { day: i, bundle: false });
    const page = await listExplore(env.BUCKET, undefined, 2);
    expect(page.tours).toEqual([]);
    expect(page.cursor).not.toBeNull();
    const rest = await listExplore(env.BUCKET, page.cursor!, 2);
    expect(rest.tours).toEqual([]);
    expect(rest.cursor).toBeNull();
  });
});

describe('GET /api/explore', () => {
  let host = 0;
  // A host per case: the edge cache is keyed by URL.
  const get = (query = '') => SELF.fetch(`https://h${++host}.test${EXPLORE_PATH}${query}`);

  it('answers a page that passes the contract, cacheable for a short while', async () => {
    await seed('r1', { day: 1 });
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe(`public, max-age=${EXPLORE_MAX_AGE_SECONDS}`);
    const body = ExplorePageSchema.parse(await r.json());
    expect(body.tours.map((t) => t.slug)).toEqual(['r1-slug']);
  });

  it('serves a repeat from the edge cache, ignoring made-up query parameters', async () => {
    await seed('c1', { day: 1 });
    const url = `https://cache.test${EXPLORE_PATH}`;
    expect(((await (await SELF.fetch(url)).json()) as { tours: unknown[] }).tours).toHaveLength(1);
    await seed('c2', { day: 2 });
    const again = await SELF.fetch(`${url}?bust=1`);
    expect(((await again.json()) as { tours: unknown[] }).tours).toHaveLength(1);
  });

  it.each(['nope', '../pub/tours/x', '123-x'])(
    '400s a cursor that is not an entry name (%s)',
    async (c) => {
      const r = await get(`?cursor=${encodeURIComponent(c)}`);
      expect(r.status).toBe(400);
    },
  );

  it('429s with Retry-After, keyed by CF-Connecting-IP', async () => {
    const limit = vi.fn(async (_o: { key: string }) => ({ success: false }));
    const r = await app.request(
      EXPLORE_PATH,
      { headers: { 'CF-Connecting-IP': '198.51.100.9' } },
      { ...env, EXPLORE_LIMITER: { limit } },
    );
    expect(r.status).toBe(429);
    expect(r.headers.get('Retry-After')).toBe(String(RATE_PERIOD_SECONDS));
    expect(limit).toHaveBeenCalledWith({ key: '198.51.100.9' });
  });
});
