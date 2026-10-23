import { planKey, pubTourKey, tourKey, tourOwnerKey, type TourPlan } from '@internal/contracts';
import { setTestJwtVerifier } from '@internal/worker-kit/testing';
import {
  createExecutionContext,
  createScheduledController,
  env,
  SELF,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import worker from './index.js';
import {
  PLAN_SWEEP_CURSOR_KEY,
  PLAN_ORPHAN_GRACE_MS,
  PLAN_UNUSED_GRACE_MS,
  sweepUnsavedPlans,
} from './plan-sweep.js';

const SUB = 'auth0|plan-sweep-owner';
const HOUR_MS = 60 * 60 * 1000;
// Objects are stamped with the real clock when put, so ages come from a `now` ahead of it.
const after = (ms: number) => new Date(Date.now() + ms);

const wipe = async () => {
  for (;;) {
    const page = await env.BUCKET.list();
    if (page.objects.length) await env.BUCKET.delete(page.objects.map((o) => o.key));
    if (!page.truncated) return;
  }
};
beforeEach(wipe);
beforeAll(() => {
  setTestJwtVerifier(async (t) => {
    if (t.startsWith('good:')) return { sub: t.slice(5) };
    throw new Error('bad');
  });
});

const plan = (id: string): TourPlan => ({ id, type: 'image/webp', width: 10, height: 10 });
const img = (tourId: string, id: string) => planKey(tourId, id, 'image/webp');
const putImages = async (tourId: string, ...ids: string[]) => {
  for (const id of ids) await env.BUCKET.put(img(tourId, id), 'img');
};
const plansLeft = async () =>
  (await env.BUCKET.list({ prefix: 'pub/plans/' })).objects.map((o) => o.key).sort();
const putTour = async (tourId: string, p?: TourPlan, pointer = true) => {
  await env.BUCKET.put(
    tourKey(SUB, tourId),
    JSON.stringify({ tourId, title: 't', scenes: [], ...(p ? { plan: p } : {}) }),
  );
  if (pointer) await putPointer(tourId);
};
// An owner pointer alone: its tour.json is gone, so the tour is.
const putPointer = (tourId: string) =>
  env.BUCKET.put(tourOwnerKey(tourId), JSON.stringify({ v: 1, sub: SUB }));

describe('sweepUnsavedPlans', () => {
  it('deletes a gone tour’s images once they are a day old', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A pointer whose tour.json is gone, and no bundle: deleted.
    await putImages('gone-a', 'x', 'y');
    await putImages('gone-b', 'z');
    await putPointer('gone-a');
    await putPointer('gone-b');

    const early = await sweepUnsavedPlans(env.BUCKET, after(PLAN_ORPHAN_GRACE_MS - HOUR_MS));
    expect(early).toEqual({ deleted: [], tours: 0, unknown: 0, done: true });
    expect(await plansLeft()).toHaveLength(3);

    const out = await sweepUnsavedPlans(env.BUCKET, after(PLAN_ORPHAN_GRACE_MS + HOUR_MS));
    expect(out.deleted.sort()).toEqual([
      img('gone-a', 'x'),
      img('gone-a', 'y'),
      img('gone-b', 'z'),
    ]);
    expect(out).toMatchObject({ tours: 2, done: true });
    expect(await plansLeft()).toEqual([]);
  });

  it('keeps what the stored tour and its live bundle name, and the rest for 7 days', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await putTour('live', plan('saved'));
    await env.BUCKET.put(pubTourKey('live'), JSON.stringify({ plan: plan('shared') }));
    await putImages('live', 'saved', 'shared', 'draft');

    const inDraftWindow = await sweepUnsavedPlans(
      env.BUCKET,
      after(PLAN_UNUSED_GRACE_MS - HOUR_MS),
    );
    expect(inDraftWindow.deleted).toEqual([]);

    const out = await sweepUnsavedPlans(env.BUCKET, after(PLAN_UNUSED_GRACE_MS + HOUR_MS));
    expect(out.deleted).toEqual([img('live', 'draft')]);
    expect(await plansLeft()).toEqual([img('live', 'saved'), img('live', 'shared')].sort());
  });

  it('keeps a saved, unpublished tour with no owner pointer, and counts it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A tour from before owner pointers: tour.json names its plan, nothing is published.
    await putTour('legacy', plan('saved'), false);
    await putImages('legacy', 'saved', 'draft');

    const out = await sweepUnsavedPlans(env.BUCKET, after(PLAN_UNUSED_GRACE_MS + HOUR_MS));

    expect(out).toEqual({ deleted: [], tours: 0, unknown: 1, done: true });
    expect(await plansLeft()).toEqual([img('legacy', 'draft'), img('legacy', 'saved')]);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/1 tour\(s\) alone with no owner pointer/);
  });

  it('treats a published tour with no owner pointer as existing', async () => {
    await env.BUCKET.put(pubTourKey('old'), JSON.stringify({ plan: plan('shared') }));
    await putImages('old', 'shared', 'other');

    const soon = await sweepUnsavedPlans(env.BUCKET, after(2 * PLAN_ORPHAN_GRACE_MS));
    expect(soon.deleted).toEqual([]);
  });

  it('skips a tour whose reads fail, and carries on with the rest', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await putImages('bad', 'x');
    await putImages('ok', 'y');
    await putPointer('ok');
    const failing = new Proxy(env.BUCKET, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if (prop === 'get') {
          return (key: string) =>
            key === tourOwnerKey('bad') ? Promise.reject(new Error('r2')) : target.get(key);
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const out = await sweepUnsavedPlans(failing, after(2 * PLAN_ORPHAN_GRACE_MS));

    expect(out.deleted).toEqual([img('ok', 'y')]);
    expect(error.mock.calls.flat().join(' ')).not.toContain('pub/');
  });

  it('stops at its budget, saves a cursor, and the next run carries on from it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const t of ['t-a', 't-b', 't-c']) {
      await putImages(t, 'x');
      await putPointer(t);
    }
    const now = after(2 * PLAN_ORPHAN_GRACE_MS);

    // The cursor read and a listing, then one tour (up to 4) with one left for the cursor.
    const first = await sweepUnsavedPlans(env.BUCKET, now, 7);

    expect(first).toEqual({ deleted: [img('t-a', 'x')], tours: 1, unknown: 0, done: false });
    expect(warn.mock.calls.flat().join(' ')).toMatch(/budget reached/);
    expect(JSON.parse(await (await env.BUCKET.get(PLAN_SWEEP_CURSOR_KEY))!.text())).toEqual({
      v: 1,
      startAfter: img('t-a', 'x'),
    });

    const second = await sweepUnsavedPlans(env.BUCKET, now);
    expect(second).toEqual({
      deleted: [img('t-b', 'x'), img('t-c', 'x')],
      tours: 2,
      unknown: 0,
      done: true,
    });
    // A finished pass clears the cursor, so the next run starts from the top.
    expect(await env.BUCKET.head(PLAN_SWEEP_CURSOR_KEY)).toBeNull();
    await putImages('t-0', 'x');
    await putPointer('t-0');
    const third = await sweepUnsavedPlans(env.BUCKET, after(2 * PLAN_ORPHAN_GRACE_MS));
    expect(third.deleted).toEqual([img('t-0', 'x')]);
  });

  it('reads nothing for a tour whose images are all too young to judge', async () => {
    await putTour('young');
    await putImages('young', 'x');
    const gets = vi.spyOn(env.BUCKET, 'get');

    const out = await sweepUnsavedPlans(env.BUCKET, after(HOUR_MS));

    expect(out).toEqual({ deleted: [], tours: 0, unknown: 0, done: true });
    // Only the cursor read.
    expect(gets).toHaveBeenCalledTimes(1);
  });

  it('runs in the daily cron as the "plan-sweep" task', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await putImages('cron-gone', 'x');
    await putPointer('cron-gone');
    const ctx = createExecutionContext();

    await worker.scheduled(
      createScheduledController({
        scheduledTime: after(2 * PLAN_ORPHAN_GRACE_MS).getTime(),
        cron: '17 3 * * *',
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(await plansLeft()).toEqual([]);
  });
});

describe('a tour save with a plan', () => {
  it('writes the owner pointer the sweep relies on, if the tour has none', async () => {
    const auth = { Authorization: `Bearer good:${SUB}` };
    const created = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't', scenes: [] }),
    });
    const { tourId } = await created.json<{ tourId: string }>();
    // A tour from before owner pointers existed.
    await env.BUCKET.delete(tourOwnerKey(tourId));

    // Through the handler, so the work it hands to waitUntil is awaited too.
    const save = async (body: unknown) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request(`https://x/api/admin/tours/${tourId}`, {
          method: 'PUT',
          headers: { ...auth, 'Content-Type': 'application/json', 'If-Match': '*' },
          body: JSON.stringify(body),
        }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return res;
    };
    expect((await save({ title: 't', scenes: [] })).status).toBe(200);
    expect(await env.BUCKET.head(tourOwnerKey(tourId))).toBeNull();

    expect((await save({ title: 't', scenes: [], plan: plan('p1') })).status).toBe(200);
    const pointer = await env.BUCKET.get(tourOwnerKey(tourId));
    expect(JSON.parse(await pointer!.text())).toEqual({ v: 1, sub: SUB });
  });

  it('keeps the plan of a save whose pointer write failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const auth = { Authorization: `Bearer good:${SUB}` };
    const created = await SELF.fetch('https://x/api/admin/tours', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't', scenes: [] }),
    });
    const { tourId } = await created.json<{ tourId: string }>();
    await env.BUCKET.delete(tourOwnerKey(tourId));
    await putImages(tourId, 'p1');
    // The best-effort pointer write after the save fails.
    const failing = new Proxy(env.BUCKET, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if (prop === 'put') {
          return (key: string, ...rest: unknown[]) =>
            key === tourOwnerKey(tourId)
              ? Promise.reject(new Error('r2'))
              : (target.put as (...a: unknown[]) => unknown)(key, ...rest);
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`https://x/api/admin/tours/${tourId}`, {
        method: 'PUT',
        headers: { ...auth, 'Content-Type': 'application/json', 'If-Match': '*' },
        body: JSON.stringify({ title: 't', scenes: [], plan: plan('p1') }),
      }),
      { ...env, BUCKET: failing },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(await env.BUCKET.head(tourOwnerKey(tourId))).toBeNull();
    expect(error.mock.calls.flat().join(' ')).toMatch(/owner pointer for tour .+ not written/);

    const out = await sweepUnsavedPlans(env.BUCKET, after(PLAN_UNUSED_GRACE_MS + HOUR_MS));

    expect(out.deleted).toEqual([]);
    expect(await plansLeft()).toEqual([img(tourId, 'p1')]);
  });
});
