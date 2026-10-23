import {
  ACCOUNT_DELETE_CONFIRMATION,
  EXPLORE_INDEX_ROOT,
  exploreHiddenKey,
  exploreTourKey,
  manifestKey,
  OPERATOR_TAKEDOWN_PATH,
  OPERATOR_TOKEN_HEADER,
  originalKey,
  publishKey,
  pubTourKey,
  type ExploreEntry,
  type ExplorePointer,
  type PublishedTour,
} from '@internal/contracts';
import { setTestJwtVerifier } from '@internal/worker-kit/testing';
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { syncExploreQuietly } from './explore.js';
import { unpublish } from './publish.js';

// Storage is shared across it() cases in this file, so every case uses its own
// owner, ids, titles and slugs.
beforeAll(() => {
  setTestJwtVerifier(async (t) => {
    // Signed in just now, as account delete wants.
    if (t.startsWith('good:')) {
      return { sub: `auth0|${t.slice(5)}`, authTime: Math.floor(Date.now() / 1000) };
    }
    throw new Error('bad');
  });
});

const subOf = (who: string) => `auth0|${who}`;
const bearer = (who: string) => ({ Authorization: `Bearer good:${who}` });
const has = async (key: string) => !!(await env.BUCKET.head(key));
const readJson = async <T>(key: string): Promise<T | null> => {
  const obj = await env.BUCKET.get(key);
  return obj ? ((await obj.json()) as T) : null;
};

// Every PUT here is a blind overwrite, so `If-Match: *` stands in for a real ETag.
const api = (who: string, method: string, path: string, body?: unknown) =>
  SELF.fetch(`https://x/api/admin${path}`, {
    method,
    headers: { ...bearer(who), ...(method === 'PUT' ? { 'If-Match': '*' } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** A tiled pano the owner can publish; its manifest names an og.jpg unless told otherwise. */
const readyPano = async (who: string, panoId: string, manifest: object = { og: true }) => {
  await env.BUCKET.put(originalKey(subOf(who), panoId), 'bytes');
  const r = await api(who, 'PUT', `/panos/${panoId}/config`, { title: 'Scene', hotspots: [] });
  expect(r.status).toBe(200);
  await env.BUCKET.put(
    manifestKey(panoId),
    JSON.stringify({ pano: panoId, version: 't1-abc', ...manifest }),
  );
};

/** A one-scene tour, published with `body` (a slug and a visibility, say). */
const publishedTour = async (who: string, body: object, manifest?: object) => {
  const panoId = `${who}-p1`;
  await readyPano(who, panoId, manifest);
  const created = await api(who, 'POST', '/tours', {
    title: `Tour ${who}`,
    scenes: [{ panoId }],
  });
  const { tourId } = (await created.json()) as { tourId: string };
  const r = await api(who, 'POST', `/tours/${tourId}/publish`, body);
  expect(r.status).toBe(200);
  return { tourId, panoId };
};

/** The tour's index entry and its key, found through its pointer; null if not listed. */
const listed = async (tourId: string) => {
  const pointer = await readJson<ExplorePointer>(exploreTourKey(tourId));
  if (!pointer) return null;
  const entry = await readJson<ExploreEntry>(pointer.key);
  return entry ? { key: pointer.key, entry } : null;
};

/** Every index key naming this tour: a stale duplicate would show up here. */
const indexKeys = async (tourId: string) =>
  (await env.BUCKET.list({ prefix: EXPLORE_INDEX_ROOT })).objects
    .map((o) => o.key)
    .filter((k) => k.endsWith(`-${tourId}.json`));

const takedown = (sub: string, tourId: string, action: string) =>
  SELF.fetch(`https://x${OPERATOR_TAKEDOWN_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [OPERATOR_TOKEN_HEADER]: 'test-operator-token' },
    body: JSON.stringify({ sub, tourId, action }),
  });

describe('Explore index: publish', () => {
  it('a Public publish lists the tour with a card and no owner data', async () => {
    const { tourId, panoId } = await publishedTour('ex-pub', {
      slug: 'ex-pub-tour',
      visibility: 'public',
    });
    const got = await listed(tourId);
    expect(got?.entry).toMatchObject({
      v: 1,
      tourId,
      slug: 'ex-pub-tour',
      title: 'Tour ex-pub',
      sceneCount: 1,
      cover: { panoId, version: 't1-abc', image: 'og' },
    });
    expect(got?.key).toMatch(new RegExp(`^${EXPLORE_INDEX_ROOT}\\d{13}-${tourId}\\.json$`));
    const raw = JSON.stringify(got);
    expect(raw).not.toContain('auth0');
    expect(raw).not.toContain('ex-pub|');
    // The bundle carries what public-api's HEAD re-check needs.
    const head = await env.BUCKET.head(pubTourKey(tourId));
    expect(head?.customMetadata).toEqual({ visibility: 'public', slug: 'ex-pub-tour' });
  });

  it('an Unlisted publish (the default) lists nothing', async () => {
    const { tourId } = await publishedTour('ex-unl', { slug: 'ex-unl-tour' });
    expect(await has(exploreTourKey(tourId))).toBe(false);
    expect(await indexKeys(tourId)).toEqual([]);
  });

  it('falls back to the equirect preview, and lists a ready scene with no image coverless', async () => {
    const a = await publishedTour('ex-prev', { visibility: 'public' }, { preview: true });
    expect((await listed(a.tourId))?.entry.cover).toMatchObject({ image: 'preview' });
    const b = await publishedTour('ex-noimg', { visibility: 'public' }, {});
    expect((await listed(b.tourId))?.entry.cover).toBeNull();
  });

  it('a republish keeps the place in the list and refreshes the card', async () => {
    const who = 'ex-again';
    const { tourId, panoId } = await publishedTour(who, { visibility: 'public' });
    const first = await listed(tourId);
    const put = await api(who, 'PUT', `/tours/${tourId}`, {
      title: 'Renamed tour',
      scenes: [{ panoId }],
    });
    expect(put.status).toBe(200);
    await api(who, 'POST', `/tours/${tourId}/publish`, { afterSave: true });
    const second = await listed(tourId);
    expect(second?.key).toBe(first?.key);
    expect(second?.entry.title).toBe('Renamed tour');
    expect(second?.entry.listedAt).toBe(first?.entry.listedAt);
    expect(await indexKeys(tourId)).toEqual([first?.key]);
  });

  it('a slug rename updates the card in place', async () => {
    const who = 'ex-rename';
    const { tourId } = await publishedTour(who, { slug: 'ex-rename-a', visibility: 'public' });
    const before = await listed(tourId);
    const r = await api(who, 'PUT', `/tours/${tourId}/slug`, { slug: 'ex-rename-b' });
    expect(r.status).toBe(200);
    const after = await listed(tourId);
    expect(after?.key).toBe(before?.key);
    expect(after?.entry.slug).toBe('ex-rename-b');
  });

  it('switching to Unlisted removes it; back to Public lists it again', async () => {
    const who = 'ex-vis';
    const { tourId } = await publishedTour(who, { visibility: 'public' });
    const first = await listed(tourId);
    expect(first).not.toBeNull();
    await api(who, 'PATCH', `/tours/${tourId}/visibility`, { visibility: 'unlisted' });
    expect(await listed(tourId)).toBeNull();
    expect(await indexKeys(tourId)).toEqual([]);
    await api(who, 'PATCH', `/tours/${tourId}/visibility`, { visibility: 'public' });
    expect((await listed(tourId))?.entry.tourId).toBe(tourId);
    expect(await indexKeys(tourId)).toHaveLength(1);
  });

  it('a failed index write is logged and never fails the publish', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = {
      head: () => Promise.reject(new Error('r2 down')),
      get: () => Promise.reject(new Error('r2 down')),
    } as unknown as R2Bucket;
    const bundle = { tourId: 't', visibility: 'public', scenes: [{}] } as unknown as PublishedTour;
    await expect(syncExploreQuietly(broken, bundle, new Date())).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('[explore] index update failed:', 'Error');
    error.mockRestore();
  });
});

describe('Explore index: every way off the list', () => {
  it("the owner's Stop sharing", async () => {
    const who = 'ex-stop';
    const { tourId } = await publishedTour(who, { visibility: 'public' });
    const { key } = (await listed(tourId))!;
    expect((await api(who, 'DELETE', `/tours/${tourId}/publish`)).status).toBe(204);
    expect(await has(key)).toBe(false);
    expect(await has(exploreTourKey(tourId))).toBe(false);
  });

  it('a tour delete', async () => {
    const who = 'ex-del';
    const { tourId } = await publishedTour(who, { visibility: 'public' });
    const { key } = (await listed(tourId))!;
    expect((await api(who, 'DELETE', `/tours/${tourId}`)).status).toBe(204);
    expect(await has(key)).toBe(false);
    expect(await has(exploreTourKey(tourId))).toBe(false);
  });

  it('an account delete', async () => {
    const who = 'ex-acct';
    const { tourId } = await publishedTour(who, { visibility: 'public' });
    const { key } = (await listed(tourId))!;
    const r = await api(who, 'DELETE', '/account', { confirm: ACCOUNT_DELETE_CONFIRMATION });
    expect(r.status).toBe(200);
    expect(await has(key)).toBe(false);
    expect(await has(exploreTourKey(tourId))).toBe(false);
  });

  it.each(['unpublish', 'delete'])('an operator %s', async (action) => {
    const who = `ex-op-${action}`;
    const { tourId } = await publishedTour(who, { visibility: 'public' });
    const { key } = (await listed(tourId))!;
    expect((await takedown(subOf(who), tourId, action)).status).toBe(200);
    expect(await has(key)).toBe(false);
    expect(await has(exploreTourKey(tourId))).toBe(false);
  });

  it('a removal that fails throws and keeps publish.json, so the takedown can be retried', async () => {
    const who = 'ex-retry';
    const sub = subOf(who);
    const { tourId } = await publishedTour(who, { visibility: 'public' });
    const { key } = (await listed(tourId))!;
    const flaky = new Proxy(env.BUCKET, {
      get(target, prop) {
        if (prop === 'delete') {
          return (k: string) =>
            k === key ? Promise.reject(new Error('r2 down')) : target.delete(k);
        }
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(unpublish(flaky, sub, tourId, { stopSharing: true })).rejects.toThrow('r2 down');
    // The bundle is already gone, so public-api drops the entry meanwhile.
    expect(await has(pubTourKey(tourId))).toBe(false);
    expect(await has(publishKey(sub, tourId))).toBe(true);
    expect((await takedown(sub, tourId, 'unpublish')).status).toBe(200);
    expect(await has(key)).toBe(false);
    expect(await has(publishKey(sub, tourId))).toBe(false);
  });
});

describe('Explore index: an unreadable pointer', () => {
  it('removal still finds and deletes the entry by listing the index', async () => {
    const who = 'ex-badptr';
    const { tourId } = await publishedTour(who, { visibility: 'public' });
    const { key } = (await listed(tourId))!;
    await env.BUCKET.put(exploreTourKey(tourId), 'not json at all');
    expect((await api(who, 'DELETE', `/tours/${tourId}/publish`)).status).toBe(204);
    expect(await has(key)).toBe(false);
    expect(await has(exploreTourKey(tourId))).toBe(false);
    expect(await indexKeys(tourId)).toEqual([]);
  });

  it('a republish replaces it without leaving the old entry behind', async () => {
    const who = 'ex-badptr2';
    const { tourId } = await publishedTour(who, { visibility: 'public' });
    const { key } = (await listed(tourId))!;
    await env.BUCKET.put(exploreTourKey(tourId), JSON.stringify({ v: 1, key: 'pub/x.json' }));
    await api(who, 'POST', `/tours/${tourId}/publish`, { afterSave: true });
    const keys = await indexKeys(tourId);
    expect(keys).toHaveLength(1);
    expect((await listed(tourId))?.key).toBe(keys[0]);
    expect(keys[0] === key || !(await has(key))).toBe(true);
  });
});

describe('operator hide from Explore', () => {
  it('takes it off the list, keeps the share link, and a later publish leaves it off', async () => {
    const who = 'ex-hide';
    const sub = subOf(who);
    const { tourId } = await publishedTour(who, { slug: 'ex-hide-tour', visibility: 'public' });
    const { key } = (await listed(tourId))!;
    const r = await takedown(sub, tourId, 'hide');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ action: 'hide', purged: 0 });
    expect(await has(exploreHiddenKey(tourId))).toBe(true);
    expect(await has(key)).toBe(false);
    expect(await has(pubTourKey(tourId))).toBe(true);
    expect(await has(publishKey(sub, tourId))).toBe(true);
    // The owner's next Save, or a fresh share, doesn't relist it.
    expect((await api(who, 'POST', `/tours/${tourId}/publish`, { afterSave: true })).status).toBe(
      200,
    );
    await api(who, 'PATCH', `/tours/${tourId}/visibility`, { visibility: 'public' });
    expect(await listed(tourId)).toBeNull();
    expect(await indexKeys(tourId)).toEqual([]);
  });

  it('unhide lists a published Public tour again', async () => {
    const who = 'ex-unhide';
    const sub = subOf(who);
    const { tourId } = await publishedTour(who, { visibility: 'public' });
    await takedown(sub, tourId, 'hide');
    const r = await takedown(sub, tourId, 'unhide');
    expect(await r.json()).toEqual({ action: 'unhide', purged: 0 });
    expect(await has(exploreHiddenKey(tourId))).toBe(false);
    expect((await listed(tourId))?.entry.tourId).toBe(tourId);
  });

  it("404s a tour the named owner doesn't have", async () => {
    const { tourId } = await publishedTour('ex-hide-owner', { visibility: 'public' });
    const r = await takedown(subOf('ex-hide-stranger'), tourId, 'hide');
    expect(r.status).toBe(404);
    expect(await has(exploreHiddenKey(tourId))).toBe(false);
    expect(await listed(tourId)).not.toBeNull();
  });
});
