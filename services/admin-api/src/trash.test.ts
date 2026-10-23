import {
  accountDeletionKey,
  accountDisabledKey,
  configKey,
  manifestKey,
  OPERATOR_RESTORE_PATH,
  OPERATOR_TAKEDOWN_PATH,
  OPERATOR_TOKEN_HEADER,
  originalKey,
  panoPrefix,
  TRASH_ROOT,
  tourKey,
  trashKey,
} from '@internal/contracts';
import { setTestJwtVerifier } from '@internal/worker-kit/testing';
import {
  createExecutionContext,
  createScheduledController,
  env,
  SELF,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { deleteAccount, type AccountDeps } from './delete-account.js';
import { deleteOwnedPano } from './delete-owned-pano.js';
import { deletePano } from './delete-pano.js';
import { deleteTour } from './delete-tour.js';
import worker from './index.js';
import { unpublish } from './publish.js';
import { moveToTrash, restoreFromTrash, sweepTrash } from './trash.js';

const SUB = 'google-oauth2|trash-owner';
const NOW = new Date('2026-10-22T03:17:00Z');
const TODAY = '2026-10-22';
const DAY_MS = 24 * 60 * 60 * 1000;
const BYTES = new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]);

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

const keysUnder = async (prefix: string) => {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix, ...(cursor ? { cursor } : {}) });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys.sort();
};
const json = (key: string, value: unknown) => env.BUCKET.put(key, JSON.stringify(value));

/** An original the way upload-api leaves it: image bytes, content type, custom metadata. */
const putOriginal = (sub: string, panoId: string) =>
  env.BUCKET.put(originalKey(sub, panoId), BYTES, {
    httpMetadata: { contentType: 'image/jpeg' },
    customMetadata: { name: 'Hall.jpg' },
  });

const expectTrashed = async (sub: string, panoId: string, date = TODAY) => {
  expect(await env.BUCKET.head(originalKey(sub, panoId))).toBeNull();
  const copy = await env.BUCKET.get(trashKey(date, originalKey(sub, panoId)));
  expect(copy).not.toBeNull();
  expect(new Uint8Array(await copy!.arrayBuffer())).toEqual(BYTES);
  expect(copy!.httpMetadata?.contentType).toBe('image/jpeg');
  expect(copy!.customMetadata).toEqual({ name: 'Hall.jpg' });
};

const accountDeps = (): AccountDeps => ({
  bucket: env.BUCKET,
  unpublishTour: (sub, tourId) => unpublish(env.BUCKET, sub, tourId),
  clearStats: async () => {},
});

describe('moveToTrash', () => {
  it('copies the object with its metadata to the day’s trash, then deletes it', async () => {
    await putOriginal(SUB, 'p1');

    expect(await moveToTrash(env.BUCKET, originalKey(SUB, 'p1'), NOW)).toBe(true);

    await expectTrashed(SUB, 'p1');
  });

  it('does nothing for a key that is not there', async () => {
    expect(await moveToTrash(env.BUCKET, originalKey(SUB, 'gone'), NOW)).toBe(false);
    expect(await keysUnder(TRASH_ROOT)).toEqual([]);
  });

  it('deletes nothing when the copy fails', async () => {
    await putOriginal(SUB, 'p1');
    const failing = new Proxy(env.BUCKET, {
      get(target, prop) {
        if (prop === 'put') return () => Promise.reject(new Error('r2 down'));
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(moveToTrash(failing, originalKey(SUB, 'p1'), NOW)).rejects.toThrow('r2 down');

    expect(await env.BUCKET.head(originalKey(SUB, 'p1'))).not.toBeNull();
  });
});

describe('every delete of an original goes through the trash', () => {
  it('the owner’s pano delete', async () => {
    await putOriginal(SUB, 'p1');
    await json(configKey(SUB, 'p1'), { panoId: 'p1' });
    await json(manifestKey('p1'), { version: 'v1' });
    const later = Date.now() + 2 * DAY_MS;

    const out = await deleteOwnedPano(env.BUCKET, SUB, 'p1', later);

    expect(out).toMatchObject({ ok: true });
    await expectTrashed(SUB, 'p1', new Date(later).toISOString().slice(0, 10));
    expect(await keysUnder(panoPrefix(SUB, 'p1'))).toEqual([]);
    expect(await keysUnder('tiles/p1/')).toEqual([]);
  });

  it('a pano delete resumed after the original went: nothing more to move', async () => {
    await putOriginal(SUB, 'p1');
    await deletePano(env.BUCKET, SUB, 'p1', { trash: true, now: NOW });
    await env.BUCKET.put(`${panoPrefix(SUB, 'p1')}deleting`, '');

    await deletePano(env.BUCKET, SUB, 'p1', { trash: true, now: new Date(NOW.getTime() + DAY_MS) });

    expect(await keysUnder(TRASH_ROOT)).toEqual([trashKey(TODAY, originalKey(SUB, 'p1'))]);
  });

  it('tour delete, for the panos no other tour uses', async () => {
    await json(tourKey(SUB, 't1'), { tourId: 't1', title: 't', scenes: [{ panoId: 'p1' }] });
    await putOriginal(SUB, 'p1');

    await deleteTour(env.BUCKET, SUB, 't1', async () => [], { trash: true, now: NOW });

    await expectTrashed(SUB, 'p1');
  });

  it('account delete', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await json(tourKey(SUB, 't1'), { tourId: 't1', title: 't', scenes: [{ panoId: 'p1' }] });
    await putOriginal(SUB, 'p1');
    await putOriginal(SUB, 'p2');

    expect((await deleteAccount(accountDeps(), SUB, NOW)).status).toBe('deleted');

    await expectTrashed(SUB, 'p1', new Date().toISOString().slice(0, 10));
    await expectTrashed(SUB, 'p2', new Date().toISOString().slice(0, 10));
  });
});

describe('a takedown deletes for real', () => {
  it('the operator’s tour delete leaves nothing in the trash', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await json(tourKey(SUB, 't1'), { tourId: 't1', title: 't', scenes: [{ panoId: 'p1' }] });
    await putOriginal(SUB, 'p1');

    const res = await SELF.fetch(`https://x${OPERATOR_TAKEDOWN_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [OPERATOR_TOKEN_HEADER]: 'test-operator-token',
      },
      body: JSON.stringify({ sub: SUB, tourId: 't1', action: 'delete' }),
    });

    expect(res.status).toBe(200);
    expect(await env.BUCKET.head(originalKey(SUB, 'p1'))).toBeNull();
    expect(await keysUnder(TRASH_ROOT)).toEqual([]);
  });

  it('closing a disabled owner’s account (takedown.ts --close-account) skips the trash', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await json(accountDisabledKey(SUB), { v: 1, disabledAt: NOW.toISOString() });
    await putOriginal(SUB, 'p1');

    await deleteAccount(accountDeps(), SUB, NOW);

    expect(await env.BUCKET.head(originalKey(SUB, 'p1'))).toBeNull();
    expect(await keysUnder(TRASH_ROOT)).toEqual([]);
  });
});

describe('sweepTrash', () => {
  const trashed = (date: string, panoId: string) => trashKey(date, originalKey(SUB, panoId));
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY_MS).toISOString().slice(0, 10);

  it('deletes days 30 or more days old and keeps younger ones', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const [n, p] of [
      [31, 'a'],
      [30, 'b'],
      [29, 'c'],
      [0, 'd'],
    ] as const) {
      await env.BUCKET.put(trashed(daysAgo(n), p), BYTES);
    }
    await env.BUCKET.put(`${TRASH_ROOT}not-a-date/x`, '');

    const out = await sweepTrash(env.BUCKET, NOW);

    expect(out).toEqual({ deleted: 2, days: [daysAgo(31), daysAgo(30)], done: true });
    expect(await keysUnder(TRASH_ROOT)).toEqual(
      [trashed(daysAgo(29), 'c'), trashed(TODAY, 'd'), `${TRASH_ROOT}not-a-date/x`].sort(),
    );
  });

  it('stops at its budget and the next run carries on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const n of [40, 35, 31]) {
      await env.BUCKET.put(trashed(daysAgo(n), 'a'), BYTES);
      await env.BUCKET.put(trashed(daysAgo(n), 'b'), BYTES);
    }

    // The day listing, then a list and a delete for the oldest day: the budget is spent.
    const first = await sweepTrash(env.BUCKET, NOW, 3);

    expect(first).toEqual({ deleted: 2, days: [daysAgo(40)], done: false });
    expect(warn.mock.calls.flat().join(' ')).toMatch(/budget reached/);
    expect(await keysUnder(TRASH_ROOT)).toHaveLength(4);

    const second = await sweepTrash(env.BUCKET, new Date(NOW.getTime() + DAY_MS), 5);
    expect(second).toEqual({ deleted: 4, days: [daysAgo(35), daysAgo(31)], done: true });
    expect(await keysUnder(TRASH_ROOT)).toEqual([]);
  });

  it('costs one listing when nothing is old enough, and says nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await env.BUCKET.put(trashed(TODAY, 'a'), BYTES);

    expect(await sweepTrash(env.BUCKET, NOW, 1)).toEqual({ deleted: 0, days: [], done: true });
    expect(warn).not.toHaveBeenCalled();
  });

  it('runs in the daily cron as the "trash" task', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await env.BUCKET.put(trashed(daysAgo(30), 'a'), BYTES);
    const ctx = createExecutionContext();

    await worker.scheduled(
      createScheduledController({ scheduledTime: NOW.getTime(), cron: '17 3 * * *' }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(await keysUnder(TRASH_ROOT)).toEqual([]);
  });
});

describe('restore from the trash', () => {
  const restore = (body: unknown) =>
    SELF.fetch(`https://x${OPERATOR_RESTORE_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [OPERATOR_TOKEN_HEADER]: 'test-operator-token',
      },
      body: JSON.stringify(body),
    });

  it('puts a deleted original back with its metadata, create-only', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await putOriginal(SUB, 'p1');
    await putOriginal(SUB, 'p2');
    await moveToTrash(env.BUCKET, originalKey(SUB, 'p1'), NOW);
    await moveToTrash(env.BUCKET, originalKey(SUB, 'p2'), NOW);
    await env.BUCKET.put(originalKey(SUB, 'p2'), 'a newer upload');

    const res = await restore({
      from: 'trash',
      date: TODAY,
      keys: [originalKey(SUB, 'p1'), originalKey(SUB, 'p2'), originalKey(SUB, 'p3')],
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      restored: [originalKey(SUB, 'p1')],
      existing: [originalKey(SUB, 'p2')],
      missing: [originalKey(SUB, 'p3')],
      refused: [],
      failed: [],
    });
    const back = await env.BUCKET.get(originalKey(SUB, 'p1'));
    expect(new Uint8Array(await back!.arrayBuffer())).toEqual(BYTES);
    expect(back!.httpMetadata?.contentType).toBe('image/jpeg');
    expect(back!.customMetadata).toEqual({ name: 'Hall.jpg' });
    expect(await (await env.BUCKET.get(originalKey(SUB, 'p2')))!.text()).toBe('a newer upload');
    // The trash copy stays until it ages out.
    expect(await env.BUCKET.head(trashKey(TODAY, originalKey(SUB, 'p1')))).not.toBeNull();
  });

  it('overwrites only when asked', async () => {
    await putOriginal(SUB, 'p1');
    await moveToTrash(env.BUCKET, originalKey(SUB, 'p1'), NOW);
    await env.BUCKET.put(originalKey(SUB, 'p1'), 'newer');

    const out = await restoreFromTrash(env.BUCKET, TODAY, [originalKey(SUB, 'p1')], true);

    expect(out.restored).toEqual([originalKey(SUB, 'p1')]);
    const back = await env.BUCKET.get(originalKey(SUB, 'p1'));
    expect(new Uint8Array(await back!.arrayBuffer())).toEqual(BYTES);
  });

  it('refuses an owner whose account is marked for deletion', async () => {
    await putOriginal(SUB, 'p1');
    await moveToTrash(env.BUCKET, originalKey(SUB, 'p1'), NOW);
    await json(accountDeletionKey(SUB), { v: 1, sub: SUB, requestedAt: NOW.toISOString() });

    const out = await restoreFromTrash(env.BUCKET, TODAY, [originalKey(SUB, 'p1')], false);

    expect(out.refused).toEqual([originalKey(SUB, 'p1')]);
    expect(await env.BUCKET.head(originalKey(SUB, 'p1'))).toBeNull();
  });

  it('takes only original keys from the trash', async () => {
    const res = await restore({ from: 'trash', date: TODAY, keys: [configKey(SUB, 'p1')] });
    expect(res.status).toBe(400);
  });
});
