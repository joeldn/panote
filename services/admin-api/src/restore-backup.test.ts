// The operator restore CLI (scripts/restore-backup-lib.ts) end to end: a real backup run,
// planned over an S3-shaped store on the test bucket, written through the operator route.
import {
  accountDeletionKey,
  accountDisabledKey,
  BACKUP_PROGRESS_KEY,
  backupKey,
  configKey,
  exploreEntryKey,
  originalKey,
  trashKey,
  exploreTourKey,
  planKey,
  publishKey,
  pubTourKey,
  slugKey,
  tourKey,
  tourOwnerKey,
} from '@internal/contracts';
import { createExecutionContext, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  existingNow,
  listBackupSets,
  listTrash,
  planTrashRestore,
  planRestore,
  runRestore,
  type RestoreArgs,
  type RestoreStore,
} from '../scripts/restore-backup-lib.ts';
import { runBackup } from './backup.js';
import worker from './index.js';
import { moveToTrash } from './trash.js';

const SUB = 'google-oauth2|restore-1';
const OTHER = 'google-oauth2|restore-2';
const NOW = new Date('2026-10-22T00:15:00Z');
const DATE = '2026-10-22';

// The S3 client's surface, over the test bucket.
const store: RestoreStore = {
  async get(key) {
    const obj = await env.BUCKET.get(key);
    if (!obj) return new Response(null, { status: 404 });
    return new Response(await obj.arrayBuffer(), { headers: { etag: `"${obj.etag}"` } });
  },
  async head(key) {
    const obj = await env.BUCKET.head(key);
    return { ok: !!obj, status: obj ? 200 : 404, etag: obj ? `"${obj.etag}"` : null };
  },
  async listObjects(prefix) {
    const out: { key: string; size: number }[] = [];
    let cursor: string | undefined;
    do {
      const page = await env.BUCKET.list({ prefix, ...(cursor ? { cursor } : {}) });
      out.push(...page.objects.map((o) => ({ key: o.key, size: o.size })));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return out;
  },
  async listPrefixes(prefix) {
    const page = await env.BUCKET.list({ prefix, delimiter: '/' });
    return page.delimitedPrefixes;
  },
};

const wipe = async () => {
  for (;;) {
    const page = await env.BUCKET.list();
    if (page.objects.length) await env.BUCKET.delete(page.objects.map((o) => o.key));
    if (!page.truncated) return;
  }
};
beforeEach(wipe);

const put = (key: string, value: unknown, customMetadata?: Record<string, string>) =>
  env.BUCKET.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: 'application/json' },
    ...(customMetadata ? { customMetadata } : {}),
  });
const has = async (key: string) => !!(await env.BUCKET.head(key));
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);

/** A published, listed tour with one scene, its slug and one old alias. */
const seedTour = async (sub: string, tourId: string, panoId: string, slug: string) => {
  const entry = exploreEntryKey(1_700_000_000_000, tourId);
  await put(tourKey(sub, tourId), { tourId, scenes: [{ panoId }] }, { title: 'Ünïcode' });
  await put(
    publishKey(sub, tourId),
    { slug, visibility: 'public', publishedAt: 'x', aliases: [`${slug}-old`] },
    { slug, visibility: 'public' },
  );
  await put(configKey(sub, panoId), { panoId }, { title: 'Scène' });
  await put(configKey(sub, `${panoId}-unused`), { panoId: `${panoId}-unused` });
  await put(pubTourKey(tourId), { tourId, scenes: [{ panoId }] }, { visibility: 'public' });
  await put(slugKey(slug), { v: 1, kind: 'tour', tourId });
  await put(
    slugKey(`${slug}-old`),
    { v: 1, kind: 'redirect', tourId, redirect: slug, expiresAt: '2026-11-01T00:00:00Z' },
    { kind: 'redirect', expiresAt: '2026-11-01T00:00:00Z' },
  );
  await put(tourOwnerKey(tourId), { v: 1, sub });
  await put(entry, { tourId });
  await put(exploreTourKey(tourId), { v: 1, key: entry });
  // Its floor-plan image: bytes, not JSON, under the owner-free pub/plans/<tourId>/.
  await env.BUCKET.put(planKey(tourId, 'pl1', 'image/png'), PNG, {
    httpMetadata: { contentType: 'image/png' },
  });
  return [
    tourKey(sub, tourId),
    publishKey(sub, tourId),
    configKey(sub, panoId),
    tourOwnerKey(tourId),
    pubTourKey(tourId),
    slugKey(slug),
    slugKey(`${slug}-old`),
    entry,
    exploreTourKey(tourId),
    planKey(tourId, 'pl1', 'image/png'),
  ];
};

const deleteAll = (keys: string[]) => env.BUCKET.delete(keys);

const restoreArgs = (scope: Extract<RestoreArgs, { mode: 'restore' }>['scope'], over = {}) =>
  ({
    mode: 'restore',
    date: DATE,
    scope,
    overwrite: false,
    apply: true,
    r2: { accountId: 'a', bucket: 'pano-content-dev', accessKeyId: 'k', secretAccessKey: 's' },
    api: { origin: 'https://panote.dev', token: 'test-operator-token' },
    ...over,
  }) as RestoreArgs;

const deps = () => {
  const lines: string[] = [];
  const fetchFn = vi.fn((input: string, init: RequestInit) => SELF.fetch(input, init));
  return { lines, fetchFn, deps: { store, fetch: fetchFn, log: (l: string) => lines.push(l) } };
};

describe('planRestore', () => {
  it("plans one tour: its own records, its scenes' configs and its public keys", async () => {
    const keys = await seedTour(SUB, 't1', 'p1', 'my-tour');
    await seedTour(OTHER, 't2', 'p2', 'their-tour');
    await runBackup(env.BUCKET, NOW);

    const plan = await planRestore(store, DATE, { kind: 'tour', tourId: 't1', sub: undefined });

    expect([...plan.keys].sort()).toEqual([...keys].sort());
    // Private records go back before the public ones that point at them.
    expect(plan.keys[0]).toBe(publishKey(SUB, 't1'));
    expect(plan.keys.indexOf(pubTourKey('t1'))).toBeGreaterThan(
      plan.keys.indexOf(tourKey(SUB, 't1')),
    );
  });

  it('plans one owner: every tour and config, with their public keys', async () => {
    const t1 = await seedTour(SUB, 't1', 'p1', 'my-tour');
    const t3 = await seedTour(SUB, 't3', 'p3', 'my-other-tour');
    await seedTour(OTHER, 't2', 'p2', 'their-tour');
    await put(accountDisabledKey(SUB), { v: 1, disabledAt: 'x' });
    await runBackup(env.BUCKET, NOW);

    const plan = await planRestore(store, DATE, { kind: 'owner', sub: SUB });

    expect([...plan.keys].sort()).toEqual(
      [...t1, ...t3, configKey(SUB, 'p1-unused'), configKey(SUB, 'p3-unused')].sort(),
    );
    expect(plan.notes.join('\n')).toMatch(/disabled on that date/);
  });

  it('refuses an owner marked for deletion, and leaves them out of a whole-bucket restore', async () => {
    await seedTour(SUB, 't1', 'p1', 'my-tour');
    const other = await seedTour(OTHER, 't2', 'p2', 'their-tour');
    await runBackup(env.BUCKET, NOW);
    await put(accountDeletionKey(SUB), { v: 1, sub: SUB, requestedAt: 'x' });

    await expect(planRestore(store, DATE, { kind: 'owner', sub: SUB })).rejects.toThrow(
      /marked for deletion/,
    );
    await expect(
      planRestore(store, DATE, { kind: 'tour', tourId: 't1', sub: undefined }),
    ).rejects.toThrow(/marked for deletion/);
    const all = await planRestore(store, DATE, { kind: 'all' });
    expect([...all.keys].sort()).toEqual([...other, configKey(OTHER, 'p2-unused')].sort());
    expect(all.notes.join('\n')).toMatch(/1 owner\(s\) left out/);
  });

  it('never plans an account marker', async () => {
    await seedTour(SUB, 't1', 'p1', 'my-tour');
    await put(accountDisabledKey(OTHER), { v: 1, disabledAt: 'x' });
    await runBackup(env.BUCKET, NOW);

    const all = await planRestore(store, DATE, { kind: 'all' });

    expect(all.keys.some((k) => k.startsWith('accounts/'))).toBe(false);
    expect(all.notes.join('\n')).toMatch(/1 account marker/);
  });

  it('says so for a date with no set, a tour not in it, or a --sub that does not own it', async () => {
    await seedTour(SUB, 't1', 'p1', 'my-tour');
    await runBackup(env.BUCKET, NOW);
    await expect(planRestore(store, '2026-01-01', { kind: 'all' })).rejects.toThrow(
      /no backup set/,
    );
    await expect(
      planRestore(store, DATE, { kind: 'tour', tourId: 'nope', sub: undefined }),
    ).rejects.toThrow(/no tour nope/);
    await expect(
      planRestore(store, DATE, { kind: 'tour', tourId: 't1', sub: OTHER }),
    ).rejects.toThrow(/under --sub/);
  });
});

describe('runRestore', () => {
  it('lists the sets, complete or not', async () => {
    await seedTour(SUB, 't1', 'p1', 'my-tour');
    await runBackup(env.BUCKET, NOW);
    await put(backupKey('2026-10-23', tourKey(SUB, 't1')), {});
    await put(BACKUP_PROGRESS_KEY, {
      v: 1,
      date: '2026-10-23',
      startedAt: 'x',
      objects: 1,
      bytes: 2,
      failed: 0,
      skipped: 0,
      runs: 1,
      source: 0,
    });
    const { lines, deps: d } = deps();

    await runRestore({ mode: 'list', r2: restoreArgs({ kind: 'all' }).r2 }, d);

    expect(lines).toEqual([
      expect.stringMatching(/^2026-10-22: complete, 11 object\(s\)/),
      '2026-10-23: still being written',
    ]);
    expect((await listBackupSets(store)).map((s) => s.date)).toEqual(['2026-10-22', '2026-10-23']);
  });

  it('dry run: says what it would do and writes nothing', async () => {
    const keys = await seedTour(SUB, 't1', 'p1', 'my-tour');
    await runBackup(env.BUCKET, NOW);
    await deleteAll(keys.slice(0, 3));
    const { lines, fetchFn, deps: d } = deps();

    await runRestore(
      restoreArgs({ kind: 'tour', tourId: 't1', sub: SUB }, { apply: false, api: undefined }),
      d,
    );

    expect(fetchFn).not.toHaveBeenCalled();
    expect(await has(keys[0]!)).toBe(false);
    expect(lines).toContain(`would restore ${tourKey(SUB, 't1')}`);
    expect(lines).toContain(`would keep (exists) ${pubTourKey('t1')}`);
    expect(lines.at(-1)).toMatch(/DRY RUN: .* --apply to restore 3 key\(s\)/);
  });

  it('brings a deleted tour back, metadata and all, through the operator route', async () => {
    const keys = await seedTour(SUB, 't1', 'p1', 'my-tour');
    await runBackup(env.BUCKET, NOW);
    await deleteAll(keys);
    // Changed since the backup: left alone without --overwrite.
    await put(configKey(SUB, 'p1'), { panoId: 'p1', edited: true });
    const { lines, fetchFn, deps: d } = deps();

    await runRestore(restoreArgs({ kind: 'tour', tourId: 't1', sub: undefined }), d);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    for (const key of keys) expect(await has(key)).toBe(true);
    const tour = await env.BUCKET.get(tourKey(SUB, 't1'));
    expect(tour!.customMetadata).toEqual({ title: 'Ünïcode' });
    const alias = await env.BUCKET.head(slugKey('my-tour-old'));
    expect(alias!.customMetadata).toEqual({ kind: 'redirect', expiresAt: '2026-11-01T00:00:00Z' });
    expect(await (await env.BUCKET.get(configKey(SUB, 'p1')))!.json()).toMatchObject({
      edited: true,
    });
    const plan = await env.BUCKET.get(planKey('t1', 'pl1', 'image/png'));
    expect(new Uint8Array(await plan!.arrayBuffer())).toEqual(PNG);
    expect(plan!.httpMetadata?.contentType).toBe('image/png');
    expect(lines.at(-2)).toMatch(/^restored 9 key\(s\)/);
  });

  it('--overwrite replaces what is there with the backed-up copy', async () => {
    await seedTour(SUB, 't1', 'p1', 'my-tour');
    await runBackup(env.BUCKET, NOW);
    await put(configKey(SUB, 'p1'), { panoId: 'p1', edited: true });
    const { deps: d } = deps();

    await runRestore(restoreArgs({ kind: 'owner', sub: SUB }, { overwrite: true }), d);

    expect(await (await env.BUCKET.get(configKey(SUB, 'p1')))!.json()).toEqual({ panoId: 'p1' });
  });

  // Hundreds of R2 calls: about 2 s alone, past the 5 s default under a loaded run.
  it('batches a large restore into requests the route accepts', async () => {
    for (let i = 0; i < 120; i++) await put(configKey(SUB, `bulk-${i}`), { i });
    await runBackup(env.BUCKET, NOW);
    await env.BUCKET.delete(Array.from({ length: 120 }, (_, i) => configKey(SUB, `bulk-${i}`)));
    const { fetchFn, deps: d } = deps();

    await runRestore(restoreArgs({ kind: 'owner', sub: SUB }), d);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(await has(configKey(SUB, 'bulk-119'))).toBe(true);
  }, 20_000);
});

describe('runRestore past the operator rate limit', () => {
  it('waits out each 429 and finishes a restore of many batches', async () => {
    const n = 350;
    for (let i = 0; i < n; i++) await put(configKey(SUB, `many-${i}`), { i });
    // A budget big enough to finish the set in one run.
    await runBackup(env.BUCKET, NOW, 10_000);
    await env.BUCKET.delete(Array.from({ length: n }, (_, i) => configKey(SUB, `many-${i}`)));
    const { lines, deps: d } = deps();
    // 4 batches against a limiter that lets 2 requests through per window; a wait (the
    // script's sleep) starts a new one.
    let inWindow = 0;
    const limit = vi.fn(async () => ({ success: ++inWindow <= 2 }));
    const sleep = vi.fn(async (_ms: number) => {
      inWindow = 0;
    });
    const fetchFn = async (input: string, init: RequestInit) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request(input, init),
        { ...env, OPERATOR_LIMITER: { limit } },
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return res;
    };

    const code = await runRestore(restoreArgs({ kind: 'owner', sub: SUB }), {
      ...d,
      fetch: fetchFn,
      sleep,
    });

    expect(code).toBe(0);
    expect(sleep).toHaveBeenCalled();
    expect(sleep.mock.calls.every(([ms]) => ms === 60_000)).toBe(true);
    expect(lines.join('\n')).toMatch(new RegExp(`restored ${n} key\\(s\\);.* 0 failed`));
    const restored = await Promise.all(
      Array.from({ length: n }, (_, i) => has(configKey(SUB, `many-${i}`))),
    );
    expect(restored.every(Boolean)).toBe(true);
  }, 60_000);
});

describe('runRestore failures', () => {
  // Hundreds of R2 calls: about 2 s alone, past the 5 s default under a loaded run.
  it('lists the keys that failed and exits 1, keeping the batches that went through', async () => {
    for (let i = 0; i < 120; i++) await put(configKey(SUB, `bulk-${i}`), { i });
    await runBackup(env.BUCKET, NOW);
    await env.BUCKET.delete(Array.from({ length: 120 }, (_, i) => configKey(SUB, `bulk-${i}`)));
    const { lines, deps: d } = deps();
    let calls = 0;
    // The first request goes through; the second gets a 500.
    const failing = {
      ...d,
      fetch: (input: string, init: RequestInit) =>
        ++calls === 1
          ? SELF.fetch(input, init)
          : Promise.resolve(new Response(null, { status: 500 })),
    };

    const code = await runRestore(restoreArgs({ kind: 'owner', sub: SUB }), failing);

    expect(code).toBe(1);
    expect(lines.filter((l) => l.startsWith('FAILED '))).toHaveLength(20);
    expect(lines.join('\n')).toMatch(/restored 100 key\(s\);.* 20 failed/);
    const restored = await Promise.all(
      Array.from({ length: 120 }, (_, i) => has(configKey(SUB, `bulk-${i}`))),
    );
    expect(restored.filter(Boolean)).toHaveLength(100);
  }, 20_000);

  it('passes on the keys the route reports as failed', async () => {
    await seedTour(SUB, 't1', 'p1', 'my-tour');
    await runBackup(env.BUCKET, NOW);
    await env.BUCKET.delete(tourKey(SUB, 't1'));
    const { lines, deps: d } = deps();
    const failing = {
      ...d,
      fetch: () =>
        Promise.resolve(
          Response.json({
            restored: [],
            existing: [],
            missing: [],
            refused: [],
            failed: [tourKey(SUB, 't1')],
          }),
        ),
    };

    expect(await runRestore(restoreArgs({ kind: 'tour', tourId: 't1', sub: SUB }), failing)).toBe(
      1,
    );
    expect(lines).toContain(`FAILED ${tourKey(SUB, 't1')}`);
  });
});

describe('existingNow', () => {
  it('lists instead of a HEAD per key for a big plan', async () => {
    await put(tourKey(SUB, 't1'), {});
    const keys = [
      tourKey(SUB, 't1'),
      ...Array.from({ length: 1001 }, (_, i) => configKey(SUB, `x${i}`)),
    ];
    const head = vi.spyOn(store, 'head');
    expect([...(await existingNow(store, keys))]).toEqual([tourKey(SUB, 't1')]);
    expect(head).not.toHaveBeenCalled();
  });
});

describe('restoring originals from the trash', () => {
  const trashArgs = (over: Record<string, unknown> = {}) =>
    ({
      mode: 'trash-restore',
      panos: [],
      sub: undefined,
      date: undefined,
      overwrite: false,
      apply: true,
      r2: { accountId: 'a', bucket: 'pano-content-dev', accessKeyId: 'k', secretAccessKey: 's' },
      api: { origin: 'https://panote.dev', token: 'test-operator-token' },
      ...over,
    }) as RestoreArgs;
  const trash = async (sub: string, panoId: string, date: string, body = 'jpeg') => {
    await env.BUCKET.put(originalKey(sub, panoId), body, {
      httpMetadata: { contentType: 'image/jpeg' },
    });
    await moveToTrash(env.BUCKET, originalKey(sub, panoId), new Date(`${date}T12:00:00Z`));
  };

  it('lists what is there, and picks the newest copy of each original', async () => {
    await trash(SUB, 'p1', '2026-10-20', 'old');
    await trash(SUB, 'p1', '2026-10-21', 'new');
    await trash(OTHER, 'p2', '2026-10-21');

    expect((await listTrash(store)).map((t) => [t.date, t.panoId])).toEqual([
      ['2026-10-20', 'p1'],
      ['2026-10-21', 'p1'],
      ['2026-10-21', 'p2'],
    ]);
    const { picks } = await planTrashRestore(store, { panos: [], sub: SUB, date: undefined });
    expect(picks.map((p) => [p.date, p.key])).toEqual([['2026-10-21', originalKey(SUB, 'p1')]]);
    const older = await planTrashRestore(store, {
      panos: ['p1'],
      sub: undefined,
      date: '2026-10-20',
    });
    expect(older.picks.map((p) => p.date)).toEqual(['2026-10-20']);
    const none = await planTrashRestore(store, { panos: ['p9'], sub: undefined, date: undefined });
    expect(none.notes).toEqual(['pano p9: not in the trash']);
  });

  it('dry run writes nothing; --apply puts the original back through the route', async () => {
    await trash(SUB, 'p1', '2026-10-21');
    const { lines, fetchFn, deps: d } = deps();

    await runRestore(trashArgs({ panos: ['p1'], apply: false, api: undefined }), d);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await has(originalKey(SUB, 'p1'))).toBe(false);
    expect(lines).toContain(`would restore ${originalKey(SUB, 'p1')} from the trash of 2026-10-21`);

    const code = await runRestore(trashArgs({ panos: ['p1'] }), d);
    expect(code).toBe(0);
    const back = await env.BUCKET.get(originalKey(SUB, 'p1'));
    expect(await back!.text()).toBe('jpeg');
    expect(back!.httpMetadata?.contentType).toBe('image/jpeg');
    expect(await has(trashKey('2026-10-21', originalKey(SUB, 'p1')))).toBe(true);
  });

  it('refuses an owner marked for deletion', async () => {
    await trash(SUB, 'p1', '2026-10-21');
    await put(accountDeletionKey(SUB), { v: 1, sub: SUB, requestedAt: 'x' });
    const { deps: d } = deps();

    await expect(runRestore(trashArgs({ sub: SUB }), d)).rejects.toThrow(/marked for deletion/);
    expect(await has(originalKey(SUB, 'p1'))).toBe(false);
  });
});
