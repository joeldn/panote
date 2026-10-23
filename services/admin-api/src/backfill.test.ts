import {
  EXPLORE_INDEX_ROOT,
  exploreTourKey,
  manifestKey,
  OPERATOR_BACKFILL_PATH,
  OPERATOR_TOKEN_HEADER,
  originalKey,
  pubTourKey,
  tourKey,
  tourOwnerKey,
  type ExploreEntry,
  type ExplorePointer,
  type PublishedTour,
} from '@internal/contracts';
import { setTestJwtVerifier } from '@internal/worker-kit/testing';
import { env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { runBackfill } from '../scripts/backfill-covers-lib.ts';
import { backfillTours } from './backfill.js';

beforeAll(() => {
  setTestJwtVerifier(async (t) => {
    if (t.startsWith('good:')) return { sub: `auth0|${t.slice(5)}` };
    throw new Error('bad');
  });
});
const wipe = async () => {
  for (;;) {
    const page = await env.BUCKET.list();
    if (page.objects.length) await env.BUCKET.delete(page.objects.map((o) => o.key));
    if (!page.truncated) return;
  }
};
beforeEach(async () => {
  await wipe();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const subOf = (who: string) => `auth0|${who}`;
const api = (who: string, method: string, path: string, body?: unknown) =>
  SELF.fetch(`https://x/api/admin${path}`, {
    method,
    headers: {
      Authorization: `Bearer good:${who}`,
      ...(method === 'PUT' ? { 'If-Match': '*' } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const readJson = async <T>(key: string): Promise<T | null> => {
  const obj = await env.BUCKET.get(key);
  return obj ? ((await obj.json()) as T) : null;
};
const backfill = (body: unknown, token: string | null = 'test-operator-token') =>
  SELF.fetch(`https://x${OPERATOR_BACKFILL_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token === null ? {} : { [OPERATOR_TOKEN_HEADER]: token }),
    },
    body: JSON.stringify(body),
  });

const readyPano = async (who: string, panoId: string, version = 't1-abc') => {
  await env.BUCKET.put(originalKey(subOf(who), panoId), 'bytes');
  expect(
    (await api(who, 'PUT', `/panos/${panoId}/config`, { title: 'S', hotspots: [] })).status,
  ).toBe(200);
  await env.BUCKET.put(manifestKey(panoId), JSON.stringify({ pano: panoId, version, og: true }));
};

/**
 * A two-scene Public tour starred on its second scene, published, then made to look like
 * it predates the code: metadata naming its first scene, no owner pointer, no Explore entry.
 */
const oldTour = async (who: string) => {
  const [p1, p2] = [`${who}-p1`, `${who}-p2`];
  await readyPano(who, p1);
  await readyPano(who, p2);
  const created = await api(who, 'POST', '/tours', {
    title: `Tour ${who}`,
    scenes: [{ panoId: p1 }, { panoId: p2 }],
    startPanoId: p2,
  });
  const { tourId } = (await created.json()) as { tourId: string };
  expect(
    (
      await api(who, 'POST', `/tours/${tourId}/publish`, {
        slug: `${who}-tour`,
        visibility: 'public',
      })
    ).status,
  ).toBe(200);
  const key = tourKey(subOf(who), tourId);
  const obj = await env.BUCKET.get(key);
  await env.BUCKET.put(key, await obj!.text(), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { title: `Tour ${who}`, sceneCount: '2', coverPanoId: p1 },
  });
  await env.BUCKET.delete(tourOwnerKey(tourId));
  const pointer = await readJson<ExplorePointer>(exploreTourKey(tourId));
  await env.BUCKET.delete([pointer!.key, exploreTourKey(tourId)]);
  // A pre-Explore bundle was published months ago.
  const bundle = (await readJson<PublishedTour>(pubTourKey(tourId)))!;
  const head = await env.BUCKET.head(pubTourKey(tourId));
  await env.BUCKET.put(
    pubTourKey(tourId),
    JSON.stringify({ ...bundle, publishedAt: '2026-06-01T00:00:00.000Z' }),
    { httpMetadata: head!.httpMetadata ?? {}, customMetadata: head!.customMetadata ?? {} },
  );
  return { tourId, p1, p2, key };
};

const listed = async (tourId: string) => {
  const pointer = await readJson<ExplorePointer>(exploreTourKey(tourId));
  return pointer ? { key: pointer.key, entry: await readJson<ExploreEntry>(pointer.key) } : null;
};

describe('POST /api/admin/operator/backfill', () => {
  it('reports what an old tour needs and changes nothing without apply', async () => {
    const t = await oldTour('bf-dry');
    const before = await env.BUCKET.head(t.key);

    const res = await backfill({});

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tours: [{ tourId: t.tourId, changes: ['cover', 'owner-pointer', 'explore'] }],
      cursor: null,
    });
    expect((await env.BUCKET.head(t.key))!.etag).toBe(before!.etag);
    expect(await env.BUCKET.head(tourOwnerKey(t.tourId))).toBeNull();
    expect(await listed(t.tourId)).toBeNull();
  });

  it('with apply, fixes the cover, writes the pointer and lists the tour at its publish time', async () => {
    const t = await oldTour('bf-apply');
    const body = await (await env.BUCKET.get(t.key))!.text();

    const res = await backfill({ apply: true });

    expect((await res.json()) as unknown).toMatchObject({
      tours: [{ tourId: t.tourId, changes: ['cover', 'owner-pointer', 'explore'] }],
    });
    const tour = await env.BUCKET.get(t.key);
    expect(tour!.customMetadata).toEqual({
      title: 'Tour bf-apply',
      sceneCount: '2',
      coverPanoId: t.p2,
    });
    expect(await tour!.text()).toBe(body);
    expect(await readJson(tourOwnerKey(t.tourId))).toEqual({ v: 1, sub: subOf('bf-apply') });
    const got = await listed(t.tourId);
    expect(got?.entry).toMatchObject({
      tourId: t.tourId,
      cover: { panoId: t.p2, version: 't1-abc', image: 'og' },
      listedAt: '2026-06-01T00:00:00.000Z',
    });
    expect(got?.key.startsWith(EXPLORE_INDEX_ROOT)).toBe(true);
    // The dashboard reads the fixed cover straight away.
    const list = await api('bf-apply', 'GET', '/tours');
    expect(
      ((await list.json()) as { tours: { coverPanoId: string }[] }).tours[0]!.coverPanoId,
    ).toBe(t.p2);

    // Idempotent: a second pass finds nothing to do.
    expect(await (await backfill({ apply: true })).json()).toEqual({
      tours: [{ tourId: t.tourId, changes: [] }],
      cursor: null,
    });
  });

  it('skips the cover, not reporting it, when a save lands between the read and the write', async () => {
    const t = await oldTour('bf-race');
    const saved = { title: 'Saved since', sceneCount: '2', coverPanoId: t.p2 };
    // The owner saves right after the backfill reads tour.json, so its conditional put misses.
    const racing = new Proxy(env.BUCKET, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if (prop === 'get') {
          return async (key: string) => {
            const obj = await target.get(key);
            if (key !== t.key || !obj) return obj;
            const body = await obj.text();
            const doc = { ...(JSON.parse(body) as object), title: 'Saved since' };
            await target.put(key, JSON.stringify(doc), { customMetadata: saved });
            return {
              etag: obj.etag,
              httpMetadata: obj.httpMetadata,
              customMetadata: obj.customMetadata,
              text: async () => body,
            };
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const out = await backfillTours(racing, { limit: 10, apply: true }, async () => true);

    expect(out.tours).toEqual([
      {
        tourId: t.tourId,
        changes: ['owner-pointer', 'explore'],
        skipped: 'tour.json changed since read',
      },
    ]);
    expect((await env.BUCKET.head(t.key))!.customMetadata).toEqual(saved);
  });

  it('refreshes an Explore cover a re-tile left on an old version', async () => {
    const t = await oldTour('bf-retile');
    await backfill({ apply: true });
    const firstKey = (await listed(t.tourId))!.key;
    await env.BUCKET.put(
      manifestKey(t.p2),
      JSON.stringify({ pano: t.p2, version: 't2-new', preview: true }),
    );

    const out = await (await backfill({ apply: true })).json();

    expect(out).toMatchObject({ tours: [{ tourId: t.tourId, changes: ['explore'] }] });
    const got = await listed(t.tourId);
    expect(got?.entry?.cover).toEqual({ panoId: t.p2, version: 't2-new', image: 'preview' });
    // Same place in the list.
    expect(got?.key).toBe(firstKey);
  });

  it('leaves an Unlisted tour off Explore, and a tour saved since alone', async () => {
    const who = 'bf-unl';
    await readyPano(who, `${who}-p1`);
    const created = await api(who, 'POST', '/tours', {
      title: 'U',
      scenes: [{ panoId: `${who}-p1` }],
    });
    const { tourId } = (await created.json()) as { tourId: string };
    await api(who, 'POST', `/tours/${tourId}/publish`, { slug: `${who}-tour` });

    expect(await (await backfill({ apply: true })).json()).toEqual({
      tours: [{ tourId, changes: [] }],
      cursor: null,
    });
    expect(await listed(tourId)).toBeNull();
  });

  it('pages through tours with a cursor, and the CLI walks every page', async () => {
    const a = await oldTour('bf-page-a');
    const b = await oldTour('bf-page-b');

    const first = (await (await backfill({ limit: 1 })).json()) as {
      tours: { tourId: string }[];
      cursor: string;
    };
    expect(first.tours).toHaveLength(1);
    expect(first.cursor).toMatch(/^tours\/.+\/tour\.json$/);
    const second = (await (await backfill({ limit: 1, cursor: first.cursor })).json()) as {
      tours: { tourId: string }[];
    };
    expect([first.tours[0]!.tourId, second.tours[0]!.tourId].sort()).toEqual(
      [a.tourId, b.tourId].sort(),
    );

    const lines: string[] = [];
    const fetchFn = vi.fn((input: string, init: RequestInit) => SELF.fetch(input, init));
    const code = await runBackfill(
      {
        apply: true,
        limit: 1,
        bucket: 'pano-content-dev',
        api: { origin: 'https://panote.dev', token: 'test-operator-token' },
      },
      { fetch: fetchFn, log: (l) => lines.push(l) },
    );
    expect(code).toBe(0);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(lines.at(-1)).toMatch(/^2 tour\(s\): 2 updated \(cover 2, owner pointer 2, Explore 2\)/);
    expect(await readJson(tourOwnerKey(b.tourId))).toEqual({ v: 1, sub: subOf('bf-page-b') });
  });

  it('is a 404 without the operator token, and a 400 for a bad cursor', async () => {
    expect((await backfill({}, null)).status).toBe(404);
    expect((await backfill({}, 'wrong')).status).toBe(404);
    expect((await backfill({ cursor: 'panos/x' })).status).toBe(400);
    expect((await backfill({ limit: 26 })).status).toBe(400);
  });
});
