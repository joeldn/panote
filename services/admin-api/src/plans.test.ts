import { planKey, pubTourKey, type TourPlan } from '@internal/contracts';
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { deletePlans, PLAN_SWEEP_GRACE_MS, sweepPlans } from './plans.js';

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

describe('sweepPlans', () => {
  it('deletes images the saved tour and its share link no longer use', async () => {
    await seed('sw-a', 'old', 'live', 'saved');
    await env.BUCKET.put(pubTourKey('sw-a'), JSON.stringify({ plan: plan('live') }));
    const gone = await sweepPlans(env.BUCKET, 'sw-a', plan('saved'), later());
    expect(gone).toEqual([planKey('sw-a', 'old', 'image/webp')]);
    expect(await keys('sw-a')).toEqual([
      planKey('sw-a', 'live', 'image/webp'),
      planKey('sw-a', 'saved', 'image/webp'),
    ]);
  });

  it('removes every image once the plan is removed and the link is gone', async () => {
    await seed('sw-b', 'a', 'b');
    expect((await sweepPlans(env.BUCKET, 'sw-b', undefined, later())).sort()).toHaveLength(2);
    expect(await keys('sw-b')).toEqual([]);
  });

  it('leaves an image uploaded within the grace period: the editor may not have saved it yet', async () => {
    await seed('sw-c', 'fresh');
    expect(await sweepPlans(env.BUCKET, 'sw-c', undefined, Date.now())).toEqual([]);
    expect(await keys('sw-c')).toEqual([planKey('sw-c', 'fresh', 'image/webp')]);
  });

  it('ignores an unreadable plan in the bundle rather than failing', async () => {
    await seed('sw-d', 'x');
    await env.BUCKET.put(pubTourKey('sw-d'), JSON.stringify({ plan: { id: '../evil' } }));
    expect(await sweepPlans(env.BUCKET, 'sw-d', undefined, later())).toEqual([
      planKey('sw-d', 'x', 'image/webp'),
    ]);
  });
});
