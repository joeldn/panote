// The operator restore CLI (scripts/restore-backup-lib.ts) end to end: a real backup run,
// planned over an S3-shaped store on the test bucket, written through the operator route.
import {
  accountDeletionKey,
  accountDisabledKey,
  BACKUP_PROGRESS_KEY,
  backupKey,
  configKey,
  exploreEntryKey,
  exploreTourKey,
  publishKey,
  pubTourKey,
  slugKey,
  tourKey,
  tourOwnerKey,
} from '@internal/contracts';
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  existingNow,
  listBackupSets,
  planRestore,
  runRestore,
  type RestoreArgs,
  type RestoreStore,
} from '../scripts/restore-backup-lib.ts';
import { runBackup } from './backup.js';

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
      expect.stringMatching(/^2026-10-22: complete, 10 object\(s\)/),
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
    expect(lines.at(-2)).toMatch(/^restored 8 key\(s\)/);
  });

  it('--overwrite replaces what is there with the backed-up copy', async () => {
    await seedTour(SUB, 't1', 'p1', 'my-tour');
    await runBackup(env.BUCKET, NOW);
    await put(configKey(SUB, 'p1'), { panoId: 'p1', edited: true });
    const { deps: d } = deps();

    await runRestore(restoreArgs({ kind: 'owner', sub: SUB }, { overwrite: true }), d);

    expect(await (await env.BUCKET.get(configKey(SUB, 'p1')))!.json()).toEqual({ panoId: 'p1' });
  });

  it('batches a large restore into requests the route accepts', async () => {
    for (let i = 0; i < 120; i++) await put(configKey(SUB, `bulk-${i}`), { i });
    await runBackup(env.BUCKET, NOW);
    await env.BUCKET.delete(Array.from({ length: 120 }, (_, i) => configKey(SUB, `bulk-${i}`)));
    const { fetchFn, deps: d } = deps();

    await runRestore(restoreArgs({ kind: 'owner', sub: SUB }), d);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(await has(configKey(SUB, 'bulk-119'))).toBe(true);
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
