import {
  ACCOUNT_DELETE_CONFIRMATION,
  exploreApprovedKey,
  EXPLORE_INDEX_ROOT,
  EXPLORE_QUEUE_PATH,
  EXPLORE_STALE_ERROR,
  explorePendingKey,
  exploreHiddenKey,
  exploreTourKey,
  manifestKey,
  OPERATOR_TAKEDOWN_PATH,
  OPERATOR_TOKEN_HEADER,
  originalKey,
  publishKey,
  pubTourKey,
  type ExploreEntry,
  type ExplorePending,
  type ExplorePointer,
  type ExploreQueue,
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

const queue = async (): Promise<ExplorePending[]> => {
  const r = await SELF.fetch(`https://x${EXPLORE_QUEUE_PATH}`, { headers: bearer('operator') });
  expect(r.status).toBe(200);
  return ((await r.json()) as ExploreQueue).tours;
};
const waiting = async (tourId: string) => (await queue()).find((t) => t.tourId === tourId);
const decide = (tourId: string, action: string, fingerprint: string) =>
  SELF.fetch(`https://x${EXPLORE_QUEUE_PATH}/${tourId}`, {
    method: 'POST',
    headers: bearer('operator'),
    body: JSON.stringify({ action, fingerprint }),
  });
/** The operator approves the tour as it waits in the queue. */
const approve = async (tourId: string) => {
  const pending = await waiting(tourId);
  expect(pending).toBeDefined();
  expect((await decide(tourId, 'approve', pending!.fingerprint)).status).toBe(200);
};

/**
 * A one-scene tour, published with `body` (a slug and a visibility, say). A Public one
 * is approved for Explore too, unless `approved` is false.
 */
const publishedTour = async (
  who: string,
  body: { visibility?: string; slug?: string },
  manifest?: object,
  { approved = true }: { approved?: boolean } = {},
) => {
  const panoId = `${who}-p1`;
  await readyPano(who, panoId, manifest);
  const created = await api(who, 'POST', '/tours', {
    title: `Tour ${who}`,
    scenes: [{ panoId }],
  });
  const { tourId } = (await created.json()) as { tourId: string };
  const r = await api(who, 'POST', `/tours/${tourId}/publish`, body);
  expect(r.status).toBe(200);
  if (body.visibility === 'public' && approved) await approve(tourId);
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
    // A change to what it shows takes it off until the operator has looked again.
    expect(await listed(tourId)).toBeNull();
    expect(await waiting(tourId)).toMatchObject({ reason: 'changed', title: 'Renamed tour' });
    await approve(tourId);
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
    await approve(tourId);
    const after = await listed(tourId);
    expect(after?.key).toBe(before?.key);
    expect(after?.entry.slug).toBe('ex-rename-b');
  });

  it('switching to Unlisted removes it; back to Public lists it again in its old place', async () => {
    const who = 'ex-vis';
    const { tourId } = await publishedTour(who, { visibility: 'public' });
    const first = await listed(tourId);
    expect(first).not.toBeNull();
    await api(who, 'PATCH', `/tours/${tourId}/visibility`, { visibility: 'unlisted' });
    expect(await listed(tourId)).toBeNull();
    expect(await indexKeys(tourId)).toEqual([]);
    await new Promise((r) => setTimeout(r, 5));
    await api(who, 'PATCH', `/tours/${tourId}/visibility`, { visibility: 'public' });
    const again = await listed(tourId);
    // Unchanged, so still approved; and not listed as new: a round trip through Unlisted
    // can't bump a tour to the top.
    expect(again?.key).toBe(first?.key);
    expect(again?.entry.listedAt).toBe(first?.entry.listedAt);
    expect(await indexKeys(tourId)).toEqual([first?.key]);
  });

  it("a new account's tour is filed at its heldUntil, and keeps that place", async () => {
    const who = 'ex-held';
    const { tourId, panoId } = await publishedTour(who, { visibility: 'public' });
    const bundle = (await readJson<PublishedTour>(pubTourKey(tourId)))!;
    // As the bundle stands, unheld: filed now. Take it off, then list it as held.
    await syncExploreQuietly(env.BUCKET, { ...bundle, visibility: 'unlisted' }, new Date());
    await env.BUCKET.delete(exploreTourKey(tourId));
    const now = new Date();
    const heldUntil = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await syncExploreQuietly(env.BUCKET, { ...bundle, heldUntil }, now);
    const held = await listed(tourId);
    expect(held?.entry.listedAt).toBe(heldUntil);
    expect(held?.entry.cover?.panoId).toBe(panoId);
    // A later Save, once the hold is over, leaves it where it was filed.
    await syncExploreQuietly(env.BUCKET, bundle, new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000));
    expect((await listed(tourId))?.key).toBe(held?.key);
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
  it("the owner's Stop sharing, which keeps the tour's place for when it is shared again", async () => {
    const who = 'ex-stop';
    const { tourId } = await publishedTour(who, { visibility: 'public' });
    const { key } = (await listed(tourId))!;
    expect((await api(who, 'DELETE', `/tours/${tourId}/publish`)).status).toBe(204);
    expect(await has(key)).toBe(false);
    expect(await indexKeys(tourId)).toEqual([]);
    expect(await has(exploreTourKey(tourId))).toBe(true);
    // Sharing it again lists it where it was, not as new.
    const reshare = await api(who, 'POST', `/tours/${tourId}/publish`, { visibility: 'public' });
    expect(reshare.status).toBe(200);
    expect((await listed(tourId))?.key).toBe(key);
    // Deleting it after a Stop sharing still takes the pointer.
    expect((await api(who, 'DELETE', `/tours/${tourId}/publish`)).status).toBe(204);
    expect((await api(who, 'DELETE', `/tours/${tourId}`)).status).toBe(204);
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
    expect(await indexKeys(tourId)).toEqual([]);
    // An unpublish keeps the tour, and with it its place; a delete takes both.
    expect(await has(exploreTourKey(tourId))).toBe(action === 'unpublish');
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

  it('unhide queues a published Public tour for approval again', async () => {
    const who = 'ex-unhide';
    const sub = subOf(who);
    const { tourId } = await publishedTour(who, { visibility: 'public' });
    await takedown(sub, tourId, 'hide');
    const r = await takedown(sub, tourId, 'unhide');
    expect(await r.json()).toEqual({ action: 'unhide', purged: 0 });
    expect(await has(exploreHiddenKey(tourId))).toBe(false);
    // Back through the queue: hiding withdrew the approval.
    expect(await listed(tourId)).toBeNull();
    await approve(tourId);
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

describe('Explore approval queue', () => {
  it('a Public publish waits in the queue, listed only once approved', async () => {
    const who = 'ex-q-new';
    const { tourId, panoId } = await publishedTour(
      who,
      { slug: 'ex-q-new-tour', visibility: 'public' },
      undefined,
      { approved: false },
    );
    expect(await listed(tourId)).toBeNull();
    const pending = await waiting(tourId);
    expect(pending).toMatchObject({
      v: 1,
      tourId,
      slug: 'ex-q-new-tour',
      title: `Tour ${who}`,
      sceneCount: 1,
      cover: { panoId, version: 't1-abc', image: 'og' },
      reason: 'new',
    });
    expect(pending?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(pending)).not.toContain('auth0');
    await approve(tourId);
    expect((await listed(tourId))?.entry.slug).toBe('ex-q-new-tour');
    expect(await waiting(tourId)).toBeUndefined();
    expect(await readJson(exploreApprovedKey(tourId))).toMatchObject({
      v: 1,
      fingerprint: pending?.fingerprint,
    });
  });

  it('a republish with nothing changed keeps the tour listed', async () => {
    const who = 'ex-q-same';
    const { tourId } = await publishedTour(who, { visibility: 'public' });
    const { key } = (await listed(tourId))!;
    await api(who, 'POST', `/tours/${tourId}/publish`, { afterSave: true });
    expect((await listed(tourId))?.key).toBe(key);
    expect(await waiting(tourId)).toBeUndefined();
  });

  it('keeps its first place in the queue while it changes, and an Unlisted switch leaves it', async () => {
    const who = 'ex-q-wait';
    const { tourId, panoId } = await publishedTour(who, { visibility: 'public' }, undefined, {
      approved: false,
    });
    const first = (await waiting(tourId))!;
    await new Promise((r) => setTimeout(r, 5));
    await api(who, 'PUT', `/tours/${tourId}`, { title: 'Second title', scenes: [{ panoId }] });
    await api(who, 'POST', `/tours/${tourId}/publish`, { afterSave: true });
    const second = (await waiting(tourId))!;
    expect(second.queuedAt).toBe(first.queuedAt);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    // The operator saw the first version: approving it now is refused.
    const stale = await decide(tourId, 'approve', first.fingerprint);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: EXPLORE_STALE_ERROR });
    expect(await listed(tourId)).toBeNull();
    await api(who, 'PATCH', `/tours/${tourId}/visibility`, { visibility: 'unlisted' });
    expect(await has(explorePendingKey(tourId))).toBe(false);
  });

  it('reject hides the tour from Explore, keeps its share link, and a later Save stays off', async () => {
    const who = 'ex-q-reject';
    const { tourId } = await publishedTour(who, { visibility: 'public' }, undefined, {
      approved: false,
    });
    const pending = (await waiting(tourId))!;
    const r = await decide(tourId, 'reject', pending.fingerprint);
    expect(r.status).toBe(200);
    expect(((await r.json()) as ExploreQueue).tours.some((t) => t.tourId === tourId)).toBe(false);
    expect(await has(exploreHiddenKey(tourId))).toBe(true);
    expect(await has(pubTourKey(tourId))).toBe(true);
    await api(who, 'POST', `/tours/${tourId}/publish`, { afterSave: true });
    expect(await waiting(tourId)).toBeUndefined();
    expect(await listed(tourId)).toBeNull();
  });

  it('a tour leaving for good leaves the queue and loses its approval', async () => {
    const who = 'ex-q-gone';
    const a = await publishedTour(who, { visibility: 'public' }, undefined, { approved: false });
    expect((await api(who, 'DELETE', `/tours/${a.tourId}`)).status).toBe(204);
    expect(await has(explorePendingKey(a.tourId))).toBe(false);
    const b = await publishedTour(`${who}-2`, { visibility: 'public' });
    expect((await takedown(subOf(`${who}-2`), b.tourId, 'unpublish')).status).toBe(200);
    expect(await has(exploreApprovedKey(b.tourId))).toBe(false);
  });

  it('is for operators only, and decisions take a valid tour and fingerprint', async () => {
    const who = 'ex-q-gate';
    const { tourId } = await publishedTour(who, { visibility: 'public' }, undefined, {
      approved: false,
    });
    const asOwner = await SELF.fetch(`https://x${EXPLORE_QUEUE_PATH}`, { headers: bearer(who) });
    expect(asOwner.status).toBe(404);
    const ownerApprove = await SELF.fetch(`https://x${EXPLORE_QUEUE_PATH}/${tourId}`, {
      method: 'POST',
      headers: bearer(who),
      body: JSON.stringify({ action: 'approve', fingerprint: 'x' }),
    });
    expect(ownerApprove.status).toBe(404);
    expect((await decide('not a tour!', 'approve', 'x')).status).toBe(404);
    expect((await decide(tourId, 'promote', 'x')).status).toBe(400);
    expect((await decide(tourId, 'approve', 'wrong')).status).toBe(409);
    expect(await listed(tourId)).toBeNull();
  });
});

describe('Explore approval: the verifier’s cases', () => {
  it('a changed Save drops the approval before the new bundle is live, even if the sync fails', async () => {
    const who = 'ex-q-syncfail';
    const { tourId, panoId } = await publishedTour(who, { visibility: 'public' });
    expect(await has(exploreApprovedKey(tourId))).toBe(true);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const realHead = env.BUCKET.head.bind(env.BUCKET);
    const head = vi.spyOn(env.BUCKET, 'head').mockImplementation(async (key: string) => {
      if (key === exploreHiddenKey(tourId)) throw new Error('r2 down');
      return realHead(key);
    });
    try {
      await api(who, 'PUT', `/tours/${tourId}`, { title: 'Swapped', scenes: [{ panoId }] });
      const r = await api(who, 'POST', `/tours/${tourId}/publish`, { afterSave: true });
      expect(r.status).toBe(200);
    } finally {
      head.mockRestore();
      error.mockRestore();
    }
    expect((await readJson<PublishedTour>(pubTourKey(tourId)))?.title).toBe('Swapped');
    // public-api lists nothing without an approval, whatever the entry says.
    expect(await has(exploreApprovedKey(tourId))).toBe(false);
  });

  it('an approve or reject after a hide is refused and leaves no approval', async () => {
    const who = 'ex-q-hidden';
    const { tourId } = await publishedTour(who, { visibility: 'public' }, undefined, {
      approved: false,
    });
    const { fingerprint } = (await waiting(tourId))!;
    expect((await takedown(subOf(who), tourId, 'hide')).status).toBe(200);
    expect((await decide(tourId, 'approve', fingerprint)).status).toBe(409);
    expect((await decide(tourId, 'reject', fingerprint)).status).toBe(409);
    expect(await has(exploreApprovedKey(tourId))).toBe(false);
  });

  it('a start scene not ready keeps the tour’s place in the queue', async () => {
    const who = 'ex-q-notready';
    const { tourId, panoId } = await publishedTour(who, { visibility: 'public' }, undefined, {
      approved: false,
    });
    const first = (await waiting(tourId))!;
    const bundle = (await readJson<PublishedTour>(pubTourKey(tourId)))!;
    const manifest = await env.BUCKET.get(manifestKey(panoId));
    const body = await manifest!.text();
    await env.BUCKET.delete(manifestKey(panoId));
    await syncExploreQuietly(env.BUCKET, bundle, new Date(Date.now() + 1000));
    expect((await waiting(tourId))?.queuedAt).toBe(first.queuedAt);
    await env.BUCKET.put(manifestKey(panoId), body);
    await syncExploreQuietly(env.BUCKET, bundle, new Date(Date.now() + 2000));
    expect((await waiting(tourId))?.queuedAt).toBe(first.queuedAt);
  });
});
