import { planKey, pubTourKey, tourKey, type TourPlan } from '@internal/contracts';
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { deletePlans, PLAN_SWEEP_GRACE_MS, PLAN_SWEEP_MAX_PAGES, sweepPlans } from './plans.js';

// Storage is shared between cases in this file, so each uses its own tourId.
const plan = (id: string): TourPlan => ({ id, type: 'image/webp', width: 10, height: 10 });
const seed = async (tourId: string, ...ids: string[]) => {
  for (const id of ids) await env.BUCKET.put(planKey(tourId, id, 'image/webp'), 'img');
};
const keys = async (tourId: string) =>
  (await env.BUCKET.list({ prefix: `pub/plans/${tourId}/` })).objects.map((o) => o.key).sort();
const later = () => Date.now() + PLAN_SWEEP_GRACE_MS + 60_000;

describe('deletePlans', () => {
  it('deletes every plan image of the tour, and only that tour, returning the keys', async () => {
    await seed('del-a', 'p1', 'p2');
    await seed('del-b', 'p3');
    const gone = await deletePlans(env.BUCKET, 'del-a');
    expect(gone.sort()).toEqual([
      planKey('del-a', 'p1', 'image/webp'),
      planKey('del-a', 'p2', 'image/webp'),
    ]);
    expect(await keys('del-a')).toEqual([]);
    expect(await keys('del-b')).toEqual([planKey('del-b', 'p3', 'image/webp')]);
    expect(await deletePlans(env.BUCKET, 'del-a')).toEqual([]);
  });
});

const SUB = 'auth0|plans-owner';
const storeTour = (tourId: string, p?: TourPlan) =>
  env.BUCKET.put(tourKey(SUB, tourId), JSON.stringify({ tourId, title: 't', scenes: [], plan: p }));
const sweep = (tourId: string, now = later()) => sweepPlans(env.BUCKET, SUB, tourId, now);

describe('sweepPlans', () => {
  it('deletes images the stored tour and its share link no longer use', async () => {
    await seed('sw-a', 'old', 'live', 'saved');
    await storeTour('sw-a', plan('saved'));
    await env.BUCKET.put(pubTourKey('sw-a'), JSON.stringify({ plan: plan('live') }));
    expect(await sweep('sw-a')).toEqual([planKey('sw-a', 'old', 'image/webp')]);
    expect(await keys('sw-a')).toEqual([
      planKey('sw-a', 'live', 'image/webp'),
      planKey('sw-a', 'saved', 'image/webp'),
    ]);
  });

  it('keeps the plan the tour.json now stored names, whatever an earlier save carried', async () => {
    // A save with plan A races a later one with plan B; A's sweep runs after B is stored.
    await seed('sw-race', 'a', 'b');
    await storeTour('sw-race', plan('b'));
    expect(await sweep('sw-race')).toEqual([planKey('sw-race', 'a', 'image/webp')]);
    expect(await keys('sw-race')).toEqual([planKey('sw-race', 'b', 'image/webp')]);
  });

  it('removes every image once the plan is removed and the link is gone', async () => {
    await seed('sw-b', 'a', 'b');
    await storeTour('sw-b');
    expect(await sweep('sw-b')).toHaveLength(2);
    expect(await keys('sw-b')).toEqual([]);
  });

  it('deletes nothing once the tour itself is gone', async () => {
    await seed('sw-gone', 'a');
    expect(await sweep('sw-gone')).toEqual([]);
    expect(await keys('sw-gone')).toEqual([planKey('sw-gone', 'a', 'image/webp')]);
  });

  it('leaves an image uploaded within the grace period: the editor may not have saved it yet', async () => {
    await seed('sw-c', 'fresh');
    await storeTour('sw-c');
    expect(await sweep('sw-c', Date.now())).toEqual([]);
    expect(await keys('sw-c')).toEqual([planKey('sw-c', 'fresh', 'image/webp')]);
  });

  it('ignores an unreadable plan in the bundle rather than failing', async () => {
    await seed('sw-d', 'x');
    await storeTour('sw-d');
    await env.BUCKET.put(pubTourKey('sw-d'), JSON.stringify({ plan: { id: '../evil' } }));
    expect(await sweep('sw-d')).toEqual([planKey('sw-d', 'x', 'image/webp')]);
  });

  it('follows a truncated listing, up to its page cap', async () => {
    // A fake bucket: one stale image per page, more pages than the cap.
    const old = new Date(0);
    const pageKey = (n: number) => planKey('sw-pages', `p${n}`, 'image/webp');
    const deleted: string[] = [];
    const bucket = {
      list: async ({ cursor }: { cursor?: string }) => {
        const n = Number(cursor ?? 0);
        return {
          objects: [{ key: pageKey(n), uploaded: old }],
          truncated: true,
          cursor: String(n + 1),
        };
      },
      get: async (key: string) =>
        key === tourKey(SUB, 'sw-pages')
          ? { json: async () => ({ plan: plan('p1') }), etag: 'e' }
          : null,
      delete: async (k: string[]) => void deleted.push(...k),
    } as unknown as R2Bucket;
    const gone = await sweepPlans(bucket, SUB, 'sw-pages', later());
    const expected = Array.from({ length: PLAN_SWEEP_MAX_PAGES }, (_, n) => pageKey(n)).filter(
      (k) => k !== pageKey(1),
    );
    expect(gone).toEqual(expected);
    expect(deleted).toEqual(expected);
  });
});
