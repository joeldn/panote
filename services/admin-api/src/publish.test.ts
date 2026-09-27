import {
  deletingKey,
  encodeId,
  manifestKey,
  originalKey,
  PublishedTourSchema,
  PublishOkSchema,
  publishKey,
  pubTourKey,
  slugKey,
  SlugPutOkSchema,
  type PublishedTour,
  type PublishRecord,
  type SlugRecord,
} from '@internal/contracts';
import { setTestJwtVerifier } from '@internal/worker-kit/testing';
import {
  createExecutionContext,
  createScheduledController,
  env,
  SELF,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import worker from './index.js';
import { DEFAULT_SLUG_ALIAS_DAYS, parseAliasDays } from './publish.js';

const MY_SUB = 'auth0|me';
const OTHER_SUB = 'auth0|other';
const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(() => {
  setTestJwtVerifier(async (t) => {
    if (t === 'good') return { sub: MY_SUB };
    if (t === 'good-other') return { sub: OTHER_SUB };
    return Promise.reject(new Error('bad'));
  });
});

type Who = 'me' | 'other';
const bearer = (who: Who) => ({ Authorization: `Bearer ${who === 'me' ? 'good' : 'good-other'}` });
const subOf = (who: Who) => (who === 'me' ? MY_SUB : OTHER_SUB);

// Storage is shared across it() cases in this file, so every case uses its
// own ids, titles and slugs.

const putConfig = async (who: Who, panoId: string, title = `Scene ${panoId}`) => {
  const r = await SELF.fetch(`https://x/api/admin/panos/${panoId}/config`, {
    method: 'PUT',
    headers: { ...bearer(who), 'If-Match': '*' },
    body: JSON.stringify({ title, hotspots: [] }),
  });
  expect(r.status).toBe(200);
};

/** A fully owned, tiled pano: original + config + manifest. */
const readyPano = async (panoId: string, who: Who = 'me') => {
  await env.BUCKET.put(originalKey(subOf(who), panoId), 'bytes');
  await putConfig(who, panoId);
  await env.BUCKET.put(manifestKey(panoId), JSON.stringify({ pano: panoId }));
};

const createTour = async (title: string, panoIds: string[], who: Who = 'me') => {
  const r = await SELF.fetch('https://x/api/admin/tours', {
    method: 'POST',
    headers: bearer(who),
    body: JSON.stringify({ title, scenes: panoIds.map((panoId) => ({ panoId })) }),
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { tourId: string }).tourId;
};

const publish = (tourId: string, body: object = {}, who: Who = 'me') =>
  SELF.fetch(`https://x/api/admin/tours/${tourId}/publish`, {
    method: 'POST',
    headers: bearer(who),
    body: JSON.stringify(body),
  });

const putSlug = (tourId: string, slug: string, who: Who = 'me') =>
  SELF.fetch(`https://x/api/admin/tours/${tourId}/slug`, {
    method: 'PUT',
    headers: bearer(who),
    body: JSON.stringify({ slug }),
  });

const patchVisibility = (tourId: string, visibility: string, who: Who = 'me') =>
  SELF.fetch(`https://x/api/admin/tours/${tourId}/visibility`, {
    method: 'PATCH',
    headers: bearer(who),
    body: JSON.stringify({ visibility }),
  });

const unpublishReq = (tourId: string, who: Who = 'me') =>
  SELF.fetch(`https://x/api/admin/tours/${tourId}/publish`, {
    method: 'DELETE',
    headers: bearer(who),
  });

const readJson = async <T>(key: string): Promise<T | null> => {
  const obj = await env.BUCKET.get(key);
  return obj ? ((await obj.json()) as T) : null;
};

const readSlug = (slug: string) => readJson<SlugRecord>(slugKey(slug));

/** A published one-scene tour with an explicit slug. */
const publishedTour = async (id: string, slug: string) => {
  await readyPano(`${id}-p1`);
  const tourId = await createTour(`Tour ${id}`, [`${id}-p1`]);
  const r = await publish(tourId, { slug });
  expect(r.status).toBe(200);
  return tourId;
};

describe('POST /api/admin/tours/:tourId/publish', () => {
  it('first publish claims a default slug from the title, unlisted, and writes all three objects', async () => {
    await readyPano('pub-first-p1');
    await readyPano('pub-first-p2');
    const tourId = await createTour('Seaside Villa Walkthrough', ['pub-first-p1', 'pub-first-p2']);

    const r = await publish(tourId);
    expect(r.status).toBe(200);
    const body = PublishOkSchema.parse(await r.json());
    expect(body.slug).toBe('seaside-villa-walkthrough');
    expect(body.visibility).toBe('unlisted');
    expect(body.url).toBe('/s/seaside-villa-walkthrough');

    expect(await readSlug(body.slug)).toEqual({ v: 1, kind: 'tour', tourId });
    const slugHead = await env.BUCKET.head(slugKey(body.slug));
    expect(slugHead?.customMetadata).toEqual({ kind: 'tour' });

    const bundle = PublishedTourSchema.parse(await readJson(pubTourKey(tourId)));
    expect(bundle).toMatchObject({
      v: 1,
      tourId,
      title: 'Seaside Villa Walkthrough',
      visibility: 'unlisted',
      slug: body.slug,
      publishedAt: body.publishedAt,
      startPanoId: 'pub-first-p1',
      settings: { controls: 'bottom', showMap: true, showCompass: true, autoRotate: false },
    });
    expect(bundle.scenes.map((s) => s.config.title)).toEqual([
      'Scene pub-first-p1',
      'Scene pub-first-p2',
    ]);

    const record = await readJson<PublishRecord>(publishKey(MY_SUB, tourId));
    expect(record).toMatchObject({
      slug: body.slug,
      visibility: 'unlisted',
      publishedAt: body.publishedAt,
    });
    const recordHead = await env.BUCKET.head(publishKey(MY_SUB, tourId));
    expect(recordHead?.customMetadata).toEqual({ slug: body.slug, visibility: 'unlisted' });
  });

  it('the pub bundle carries no owner data', async () => {
    await readyPano('pub-owner-p1');
    const tourId = await createTour('Owner Free', ['pub-owner-p1']);
    expect((await publish(tourId)).status).toBe(200);
    const raw = await (await env.BUCKET.get(pubTourKey(tourId)))!.text();
    expect(raw).not.toContain('panos/');
    expect(raw).not.toContain(encodeId(MY_SUB));
    expect(raw).not.toContain(MY_SUB);
    expect(raw).not.toContain('auth0');
  });

  it('re-publishing is idempotent: same slug and publishedAt, refreshed content', async () => {
    await readyPano('pub-idem-p1');
    const tourId = await createTour('Idempotent Tour', ['pub-idem-p1']);
    const first = PublishOkSchema.parse(await (await publish(tourId)).json());

    const tourObj = await env.BUCKET.head(`tours/${encodeId(MY_SUB)}/${tourId}/tour.json`);
    const put = await SELF.fetch(`https://x/api/admin/tours/${tourId}`, {
      method: 'PUT',
      headers: { ...bearer('me'), 'If-Match': tourObj!.etag },
      body: JSON.stringify({
        title: 'Idempotent Tour Renamed',
        scenes: [{ panoId: 'pub-idem-p1' }],
      }),
    });
    expect(put.status).toBe(200);

    const second = PublishOkSchema.parse(await (await publish(tourId)).json());
    expect(second).toEqual(first);
    const bundle = await readJson<PublishedTour>(pubTourKey(tourId));
    expect(bundle?.title).toBe('Idempotent Tour Renamed');
    expect(await readSlug(first.slug)).toEqual({ v: 1, kind: 'tour', tourId });
  });

  it('a taken default slug falls back to -2', async () => {
    await readyPano('pub-dup-a');
    await readyPano('pub-dup-b');
    const a = await createTour('Duplicate Title House', ['pub-dup-a']);
    const b = await createTour('Duplicate Title House', ['pub-dup-b']);
    const ra = PublishOkSchema.parse(await (await publish(a)).json());
    const rb = PublishOkSchema.parse(await (await publish(b)).json());
    expect(ra.slug).toBe('duplicate-title-house');
    expect(rb.slug).toBe('duplicate-title-house-2');
  });

  it('two tours racing for one slug: exactly one wins, the other gets 409', async () => {
    await readyPano('pub-race-a');
    await readyPano('pub-race-b');
    const a = await createTour('Race A', ['pub-race-a']);
    const b = await createTour('Race B', ['pub-race-b']);
    const results = await Promise.all([
      publish(a, { slug: 'contested-slug' }),
      publish(b, { slug: 'contested-slug' }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    const loser = results.find((r) => r.status === 409)!;
    expect(await loser.json()).toEqual({ error: 'slug taken' });
    const winnerId = results[0]!.status === 200 ? a : b;
    const loserId = winnerId === a ? b : a;
    expect(await readSlug('contested-slug')).toEqual({ v: 1, kind: 'tour', tourId: winnerId });
    expect(await env.BUCKET.head(pubTourKey(loserId))).toBeNull();
  });

  it('422 collects every missing, deleting, not-owned and not-ready scene', async () => {
    await readyPano('pub-422-ok');
    // deleting: tombstone left by an interrupted delete
    await env.BUCKET.put(originalKey(MY_SUB, 'pub-422-del'), 'bytes');
    await env.BUCKET.put(deletingKey(MY_SUB, 'pub-422-del'), '');
    // not-owned: a config under my prefix, but the original is someone else's
    await readyPano('pub-422-foreign', 'other');
    await putConfig('me', 'pub-422-foreign');
    // not-ready: owned and configured, not tiled yet
    await env.BUCKET.put(originalKey(MY_SUB, 'pub-422-tiling'), 'bytes');
    await putConfig('me', 'pub-422-tiling');

    const tourId = await createTour('Broken Tour', [
      'pub-422-ok',
      'pub-422-gone',
      'pub-422-del',
      'pub-422-foreign',
      'pub-422-tiling',
    ]);
    const r = await publish(tourId);
    expect(r.status).toBe(422);
    const body = (await r.json()) as { error: string; scenes: unknown[] };
    expect(body.error).toBe('scenes not publishable');
    expect(body.scenes).toEqual(
      expect.arrayContaining([
        { panoId: 'pub-422-gone', reason: 'missing' },
        { panoId: 'pub-422-del', reason: 'deleting' },
        { panoId: 'pub-422-foreign', reason: 'not-owned' },
        { panoId: 'pub-422-tiling', reason: 'not-ready' },
      ]),
    );
    expect(body.scenes).toHaveLength(4);
    expect(await env.BUCKET.head(pubTourKey(tourId))).toBeNull();
    expect(await env.BUCKET.head(publishKey(MY_SUB, tourId))).toBeNull();
  });

  it("a config written for someone else's panoId can't be published", async () => {
    await readyPano('pub-steal-p1', 'other');
    await putConfig('me', 'pub-steal-p1', 'Stolen');
    const tourId = await createTour('Stolen Tour', ['pub-steal-p1']);
    const r = await publish(tourId, { slug: 'stolen-tour' });
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({
      error: 'scenes not publishable',
      scenes: [{ panoId: 'pub-steal-p1', reason: 'not-owned' }],
    });
    expect(await env.BUCKET.head(slugKey('stolen-tour'))).toBeNull();
  });

  it('422s a tour with no scenes', async () => {
    const tourId = await createTour('Empty Tour', []);
    const r = await publish(tourId);
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ error: 'tour has no scenes', scenes: [] });
  });

  it("404s another user's tour and 400s a bad or reserved slug", async () => {
    await readyPano('pub-400-p1');
    const tourId = await createTour('Guarded', ['pub-400-p1']);
    expect((await publish(tourId, {}, 'other')).status).toBe(404);
    const invalid = await publish(tourId, { slug: 'Not A Slug' });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'invalid slug' });
    const reserved = await publish(tourId, { slug: 'admin' });
    expect(reserved.status).toBe(400);
    expect(await reserved.json()).toEqual({ error: 'reserved slug' });
    expect((await publish(tourId, { visibility: 'secret' })).status).toBe(400);
    expect((await publish('bad id!')).status).toBe(400);
  });

  it('honours an explicit visibility and keeps it on a later bare publish', async () => {
    const tourId = await publishedTour('pub-vis', 'pub-vis-slug');
    const r = PublishOkSchema.parse(await (await publish(tourId, { visibility: 'public' })).json());
    expect(r.visibility).toBe('public');
    const again = PublishOkSchema.parse(await (await publish(tourId)).json());
    expect(again.visibility).toBe('public');
  });

  it('the owner GET and the tours list report the publish state', async () => {
    const tourId = await publishedTour('pub-get', 'pub-get-slug');
    const got = await SELF.fetch(`https://x/api/admin/tours/${tourId}`, { headers: bearer('me') });
    const body = (await got.json()) as { publish: unknown };
    expect(body.publish).toMatchObject({ slug: 'pub-get-slug', visibility: 'unlisted' });
    const list = await SELF.fetch('https://x/api/admin/tours?limit=100', { headers: bearer('me') });
    const tours = ((await list.json()) as { tours: { tourId: string; publish: unknown }[] }).tours;
    expect(tours.find((t) => t.tourId === tourId)?.publish).toEqual({
      slug: 'pub-get-slug',
      visibility: 'unlisted',
    });
  });
});

describe('PUT /api/admin/tours/:tourId/slug', () => {
  it('renames, leaving the old slug as a redirect alias for SLUG_ALIAS_DAYS', async () => {
    const tourId = await publishedTour('slug-rename', 'rename-old');
    const before = Date.now();
    const r = await putSlug(tourId, 'rename-new');
    const after = Date.now();
    expect(r.status).toBe(200);
    const body = SlugPutOkSchema.parse(await r.json());
    expect(body.slug).toBe('rename-new');

    const alias = await readSlug('rename-old');
    expect(alias).toMatchObject({ v: 1, kind: 'redirect', tourId, redirect: 'rename-new' });
    const expiresAt = Date.parse((alias as { expiresAt: string }).expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 30 * DAY_MS);
    expect(expiresAt).toBeLessThanOrEqual(after + 30 * DAY_MS);
    expect(body.oldSlugRedirectsUntil).toBe((alias as { expiresAt: string }).expiresAt);
    const head = await env.BUCKET.head(slugKey('rename-old'));
    expect(head?.customMetadata).toEqual({
      kind: 'redirect',
      expiresAt: body.oldSlugRedirectsUntil,
    });

    expect(await readSlug('rename-new')).toEqual({ v: 1, kind: 'tour', tourId });
    expect((await readJson<PublishedTour>(pubTourKey(tourId)))?.slug).toBe('rename-new');
    expect((await readJson<PublishRecord>(publishKey(MY_SUB, tourId)))?.slug).toBe('rename-new');
  });

  it('a retried rename is idempotent, including after a partial failure', async () => {
    const tourId = await publishedTour('slug-retry', 'retry-old');
    const first = SlugPutOkSchema.parse(await (await putSlug(tourId, 'retry-new')).json());
    const aliasAfterFirst = await readSlug('retry-old');

    // Plain retry once everything landed: nothing changes.
    const second = await putSlug(tourId, 'retry-new');
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ slug: 'retry-new', oldSlugRedirectsUntil: null });
    expect(await readSlug('retry-old')).toEqual(aliasAfterFirst);

    // Simulate a crash before publish.json was updated: the retry must
    // still succeed and must not extend the alias's expiry.
    const record = (await readJson<PublishRecord>(publishKey(MY_SUB, tourId)))!;
    await env.BUCKET.put(
      publishKey(MY_SUB, tourId),
      JSON.stringify({ ...record, slug: 'retry-old', aliases: [] }),
    );
    const third = await putSlug(tourId, 'retry-new');
    expect(third.status).toBe(200);
    expect(await third.json()).toEqual({
      slug: 'retry-new',
      oldSlugRedirectsUntil: first.oldSlugRedirectsUntil,
    });
    expect(await readSlug('retry-old')).toEqual(aliasAfterFirst);
    expect(await readSlug('retry-new')).toEqual({ v: 1, kind: 'tour', tourId });
  });

  it('collapses a rename chain onto the newest slug, keeping each alias expiry', async () => {
    const tourId = await publishedTour('slug-chain', 'chain-a');
    const ab = SlugPutOkSchema.parse(await (await putSlug(tourId, 'chain-b')).json());
    const bc = SlugPutOkSchema.parse(await (await putSlug(tourId, 'chain-c')).json());
    expect(await readSlug('chain-a')).toMatchObject({
      kind: 'redirect',
      redirect: 'chain-c',
      expiresAt: ab.oldSlugRedirectsUntil,
    });
    expect(await readSlug('chain-b')).toMatchObject({
      kind: 'redirect',
      redirect: 'chain-c',
      expiresAt: bc.oldSlugRedirectsUntil,
    });
  });

  it('can move back onto one of its own aliases', async () => {
    const tourId = await publishedTour('slug-back', 'back-a');
    await putSlug(tourId, 'back-b');
    const r = await putSlug(tourId, 'back-a');
    expect(r.status).toBe(200);
    expect(await readSlug('back-a')).toEqual({ v: 1, kind: 'tour', tourId });
    expect(await readSlug('back-b')).toMatchObject({ kind: 'redirect', redirect: 'back-a' });
    expect((await env.BUCKET.head(slugKey('back-a')))?.customMetadata).toEqual({ kind: 'tour' });
  });

  it("409s a slug held by another tour, including another tour's alias", async () => {
    const other = await publishedTour('slug-taken-o', 'taken-live');
    await putSlug(other, 'taken-live-2');
    const mine = await publishedTour('slug-taken-m', 'taken-mine');
    expect((await putSlug(mine, 'taken-live-2')).status).toBe(409);
    expect((await putSlug(mine, 'taken-live')).status).toBe(409);
    expect(await readSlug('taken-mine')).toEqual({ v: 1, kind: 'tour', tourId: mine });
  });

  it('404s a missing tour, 409s an unpublished one, 400s a bad slug', async () => {
    const tourId = await createTour('Never Published', []);
    expect((await putSlug(tourId, 'never-pub')).status).toBe(409);
    expect((await putSlug(tourId, 'never-pub', 'other')).status).toBe(404);
    expect((await putSlug(tourId, 'x')).status).toBe(400);
  });
});

describe('PATCH /api/admin/tours/:tourId/visibility', () => {
  it('updates the bundle and publish.json; 409 when unpublished', async () => {
    const tourId = await publishedTour('vis-patch', 'vis-patch-slug');
    const r = await patchVisibility(tourId, 'public');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ visibility: 'public' });
    expect((await readJson<PublishedTour>(pubTourKey(tourId)))?.visibility).toBe('public');
    expect((await env.BUCKET.head(publishKey(MY_SUB, tourId)))?.customMetadata).toEqual({
      slug: 'vis-patch-slug',
      visibility: 'public',
    });
    expect((await patchVisibility(tourId, 'hidden')).status).toBe(400);
    expect((await patchVisibility(tourId, 'public', 'other')).status).toBe(404);

    const draft = await createTour('Draft Tour', []);
    const notPublished = await patchVisibility(draft, 'public');
    expect(notPublished.status).toBe(409);
    expect(await notPublished.json()).toEqual({ error: 'not published' });
  });
});

describe('DELETE /api/admin/tours/:tourId/publish', () => {
  it('removes the live pointer, bundle and publish.json, and is idempotent', async () => {
    const tourId = await publishedTour('unpub', 'unpub-slug');
    expect((await unpublishReq(tourId)).status).toBe(204);
    expect(await env.BUCKET.head(slugKey('unpub-slug'))).toBeNull();
    expect(await env.BUCKET.head(pubTourKey(tourId))).toBeNull();
    expect(await env.BUCKET.head(publishKey(MY_SUB, tourId))).toBeNull();
    expect((await unpublishReq(tourId)).status).toBe(204);
    // The freed slug can be claimed again.
    const again = await publish(tourId, { slug: 'unpub-slug' });
    expect(again.status).toBe(200);
  });

  it('leaves an earlier rename alias to expire on its own', async () => {
    const tourId = await publishedTour('unpub-alias', 'unpub-alias-old');
    await putSlug(tourId, 'unpub-alias-new');
    expect((await unpublishReq(tourId)).status).toBe(204);
    expect(await env.BUCKET.head(slugKey('unpub-alias-new'))).toBeNull();
    expect(await readSlug('unpub-alias-old')).toMatchObject({ kind: 'redirect', tourId });
  });

  it("does not delete a slug that now points at another tour, or another user's bundle", async () => {
    const tourId = await publishedTour('unpub-foreign', 'unpub-foreign-slug');
    // Another user can't unpublish my tour by guessing its tourId.
    expect((await unpublishReq(tourId, 'other')).status).toBe(204);
    expect(await env.BUCKET.head(pubTourKey(tourId))).not.toBeNull();
    expect(await readSlug('unpub-foreign-slug')).toEqual({ v: 1, kind: 'tour', tourId });

    // A stale publish.json naming a slug someone else now holds: that slug stays.
    await env.BUCKET.put(
      slugKey('unpub-foreign-slug'),
      JSON.stringify({ v: 1, kind: 'tour', tourId: 'someone-else' }),
    );
    expect((await unpublishReq(tourId)).status).toBe(204);
    expect(await readSlug('unpub-foreign-slug')).toEqual({
      v: 1,
      kind: 'tour',
      tourId: 'someone-else',
    });
    expect(await env.BUCKET.head(pubTourKey(tourId))).toBeNull();
  });

  it('deleting a tour also unpublishes it', async () => {
    const tourId = await publishedTour('del-tour-pub', 'del-tour-pub-slug');
    const r = await SELF.fetch(`https://x/api/admin/tours/${tourId}`, {
      method: 'DELETE',
      headers: bearer('me'),
    });
    expect(r.status).toBe(204);
    expect(await env.BUCKET.head(slugKey('del-tour-pub-slug'))).toBeNull();
    expect(await env.BUCKET.head(pubTourKey(tourId))).toBeNull();
    expect(await env.BUCKET.head(publishKey(MY_SUB, tourId))).toBeNull();
  });
});

describe('slug alias expiry cron', () => {
  const putSlugRecord = (slug: string, record: SlugRecord) =>
    env.BUCKET.put(slugKey(slug), JSON.stringify(record), {
      customMetadata:
        record.kind === 'redirect'
          ? { kind: 'redirect', expiresAt: record.expiresAt }
          : { kind: 'tour' },
    });

  const runCron = async (scheduledTime: number) => {
    const ctx = createExecutionContext();
    await worker.scheduled(
      createScheduledController({ scheduledTime, cron: '17 3 * * *' }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
  };

  it('frees an expired alias and leaves a live pointer and an unexpired alias alone', async () => {
    const now = Date.now();
    await putSlugRecord('cron-expired', {
      v: 1,
      kind: 'redirect',
      tourId: 'cron-t1',
      redirect: 'cron-live',
      expiresAt: new Date(now - 1000).toISOString(),
    });
    await putSlugRecord('cron-fresh', {
      v: 1,
      kind: 'redirect',
      tourId: 'cron-t1',
      redirect: 'cron-live',
      expiresAt: new Date(now + DAY_MS).toISOString(),
    });
    await putSlugRecord('cron-live', { v: 1, kind: 'tour', tourId: 'cron-t1' });

    await runCron(now);

    expect(await env.BUCKET.head(slugKey('cron-expired'))).toBeNull();
    expect(await readSlug('cron-fresh')).toMatchObject({ kind: 'redirect' });
    expect(await readSlug('cron-live')).toEqual({ v: 1, kind: 'tour', tourId: 'cron-t1' });

    // The released slug is now free for anyone to claim.
    await readyPano('cron-claim-p1');
    const tourId = await createTour('Cron Claimer', ['cron-claim-p1']);
    expect((await publish(tourId, { slug: 'cron-expired' })).status).toBe(200);
  });

  it('a real rename alias is swept once SLUG_ALIAS_DAYS have passed', async () => {
    const tourId = await publishedTour('cron-rename', 'cron-rename-old');
    const { oldSlugRedirectsUntil } = SlugPutOkSchema.parse(
      await (await putSlug(tourId, 'cron-rename-new')).json(),
    );
    const until = Date.parse(oldSlugRedirectsUntil!);
    await runCron(until - 1000);
    expect(await env.BUCKET.head(slugKey('cron-rename-old'))).not.toBeNull();
    await runCron(until + 1000);
    expect(await env.BUCKET.head(slugKey('cron-rename-old'))).toBeNull();
    expect(await readSlug('cron-rename-new')).toEqual({ v: 1, kind: 'tour', tourId });
  });
});

describe('parseAliasDays', () => {
  it('reads a positive SLUG_ALIAS_DAYS and falls back to 30 otherwise', () => {
    expect(parseAliasDays('7')).toBe(7);
    expect(parseAliasDays('30')).toBe(30);
    for (const bad of [undefined, '', ' ', '0', '-3', 'abc']) {
      expect(parseAliasDays(bad)).toBe(DEFAULT_SLUG_ALIAS_DAYS);
    }
    expect(DEFAULT_SLUG_ALIAS_DAYS).toBe(30);
  });
});
