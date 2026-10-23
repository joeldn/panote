import {
  accountDeletionKey,
  accountDisabledKey,
  BACKUP_PROGRESS_KEY,
  BACKUP_SOURCES,
  backupCompleteKey,
  backupKey,
  backupSetPrefix,
  BackupCompleteRecordSchema,
  BackupProgressSchema,
  configKey,
  CRON_STATUS_KEY,
  deletingKey,
  exploreEntryKey,
  exploreHiddenKey,
  exploreTourKey,
  manifestKey,
  OPERATOR_RESTORE_PATH,
  OPERATOR_TOKEN_HEADER,
  originalKey,
  planKey,
  publishKey,
  pubTourKey,
  slugKey,
  tileGcKey,
  tourKey,
  tourOwnerKey,
  uploadLogKey,
} from '@internal/contracts';
import { parseJsonc } from '@internal/worker-kit/testing';
import {
  createExecutionContext,
  createScheduledController,
  env,
  SELF,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import wrangler from '../wrangler.jsonc?raw';
import {
  BACKUP_CRON,
  BACKUP_LEASE_MS,
  BACKUP_MAX_OBJECT_BYTES,
  BACKUP_RETENTION_DAYS,
  BACKUP_SAVE_EVERY,
  pruneBackups,
  restoreFromBackup,
  runBackup,
} from './backup.js';
import { deleteAccount, sweepAccountDeletions, type AccountDeps } from './delete-account.js';
import worker from './index.js';
import { sweepExpiredAliases, unpublish } from './publish.js';
import { sweepSupersededTiles } from './tile-gc.js';

const SUB = 'auth0|backup-owner';
const OTHER = 'auth0|backup-other';
const NOW = new Date('2026-10-22T00:15:00Z');
const DATE = '2026-10-22';
const DAY_MS = 24 * 60 * 60 * 1000;
const PLAN_BYTES = new Uint8Array([82, 73, 70, 70, 0, 1, 2, 255]);

// Every case starts from an empty bucket: the backup lists whole prefixes.
const wipe = async () => {
  for (;;) {
    const page = await env.BUCKET.list();
    if (page.objects.length) await env.BUCKET.delete(page.objects.map((o) => o.key));
    if (!page.truncated) return;
  }
};
beforeEach(wipe);

const put = (key: string, value: unknown = {}, customMetadata?: Record<string, string>) =>
  env.BUCKET.put(key, typeof value === 'string' ? value : JSON.stringify(value), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=30' },
    ...(customMetadata ? { customMetadata } : {}),
  });
const text = async (key: string) => (await env.BUCKET.get(key))?.text() ?? null;
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

/** Everything a published tour with one pano leaves in the bucket, backed up or not. */
const seedContent = async (sub = SUB, tourId = 't1', panoId = 'p1', slug = 'my-tour') => {
  const backedUp = [
    tourKey(sub, tourId),
    publishKey(sub, tourId),
    configKey(sub, panoId),
    pubTourKey(tourId),
    slugKey(slug),
    tourOwnerKey(tourId),
    exploreEntryKey(1_700_000_000_000, tourId),
    exploreTourKey(tourId),
    exploreHiddenKey(tourId),
    accountDisabledKey(sub),
    planKey(tourId, 'pl1', 'image/webp'),
  ];
  const notBackedUp = [
    originalKey(sub, panoId),
    deletingKey(sub, panoId),
    manifestKey(panoId),
    `tiles/${panoId}/t1-abc/0/px/0-0.webp`,
    tileGcKey(panoId, 't1-old'),
    uploadLogKey(sub, new Date(0), panoId),
    `quarantine/case-1/${tourKey(sub, tourId)}`,
    'ops/dlq-alert/q.json',
  ];
  await env.BUCKET.put(planKey(tourId, 'pl1', 'image/webp'), PLAN_BYTES, {
    httpMetadata: { contentType: 'image/webp', cacheControl: 'public, max-age=31536000' },
  });
  await put(tourKey(sub, tourId), { tourId, title: 'Café' }, { title: 'Café', sceneCount: '1' });
  await put(
    publishKey(sub, tourId),
    { slug, visibility: 'public' },
    { slug, visibility: 'public' },
  );
  await put(configKey(sub, panoId), { panoId }, { title: 'Hall' });
  await put(pubTourKey(tourId), { tourId }, { visibility: 'public', slug });
  await put(slugKey(slug), { v: 1, kind: 'tour', tourId });
  await put(tourOwnerKey(tourId), { v: 1, sub });
  await put(exploreEntryKey(1_700_000_000_000, tourId), { tourId });
  await put(exploreTourKey(tourId), { v: 1, key: exploreEntryKey(1_700_000_000_000, tourId) });
  await put(exploreHiddenKey(tourId), { v: 1, hiddenAt: 'x' });
  await put(accountDisabledKey(sub), { v: 1, disabledAt: 'x' });
  for (const key of notBackedUp) await put(key, 'not json');
  return { backedUp, notBackedUp };
};

/** The bucket with every operation counted, and with chosen GETs failing. */
const countingBucket = (failGet: (key: string) => boolean = () => false) => {
  const counts = { ops: 0 };
  const bucket = new Proxy(env.BUCKET, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        counts.ops += 1;
        if (prop === 'get' && failGet(args[0] as string)) {
          return Promise.reject(new Error('boom'));
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { bucket, counts };
};

/** A dated set with one copy and a complete.json saying how it went. */
const seedSet = async (date: string, { failed = 0, objects = 1 } = {}) => {
  await put(backupKey(date, tourKey(SUB, 't1')));
  await put(backupCompleteKey(date), {
    v: 1,
    date,
    startedAt: `${date}T00:00:00Z`,
    completedAt: `${date}T00:15:00Z`,
    objects,
    bytes: 2,
    failed,
    skipped: 0,
    runs: 1,
  });
};

const completeRecord = async (date = DATE) =>
  BackupCompleteRecordSchema.parse(JSON.parse((await text(backupCompleteKey(date)))!));

describe('runBackup', () => {
  it('copies every backed-up key with its metadata, and nothing else', async () => {
    const { backedUp, notBackedUp } = await seedContent();

    const result = await runBackup(env.BUCKET, NOW);

    expect(result).toMatchObject({ status: 'complete', date: DATE, copied: backedUp.length });
    expect(await keysUnder(backupSetPrefix(DATE))).toEqual(
      [...backedUp.map((k) => backupKey(DATE, k)), backupCompleteKey(DATE)].sort(),
    );
    for (const key of notBackedUp) expect(await text(backupKey(DATE, key))).toBeNull();
    const copy = await env.BUCKET.get(backupKey(DATE, tourKey(SUB, 't1')));
    expect(await copy!.json()).toEqual({ tourId: 't1', title: 'Café' });
    expect(copy!.customMetadata).toEqual({ title: 'Café', sceneCount: '1' });
    expect(copy!.httpMetadata).toMatchObject({
      contentType: 'application/json',
      cacheControl: 'public, max-age=30',
    });
    const plan = await env.BUCKET.get(backupKey(DATE, planKey('t1', 'pl1', 'image/webp')));
    expect(new Uint8Array(await plan!.arrayBuffer())).toEqual(PLAN_BYTES);
    expect(plan!.httpMetadata).toMatchObject({
      contentType: 'image/webp',
      cacheControl: 'public, max-age=31536000',
    });
    const done = BackupCompleteRecordSchema.parse(
      JSON.parse((await text(backupCompleteKey(DATE)))!),
    );
    expect(done).toMatchObject({ date: DATE, objects: backedUp.length, failed: 0, runs: 1 });
    expect(await text(BACKUP_PROGRESS_KEY)).toBeNull();
  });

  it('does nothing more that day once the set is complete, for one GET and one HEAD', async () => {
    await seedContent();
    await runBackup(env.BUCKET, NOW);
    const { bucket, counts } = countingBucket();

    const again = await runBackup(bucket, new Date(NOW.getTime() + 60 * 60 * 1000));

    expect(again).toMatchObject({ status: 'idle', date: DATE, copied: 0, operations: 2 });
    expect(counts.ops).toBe(2);
  });

  it('stops within its budget and resumes where it stopped, until the set is whole', async () => {
    const { backedUp } = await seedContent();
    await seedContent(OTHER, 't2', 'p2', 'other-tour');
    const all = await (async () => {
      await runBackup(env.BUCKET, NOW);
      const keys = await keysUnder(backupSetPrefix(DATE));
      await wipe();
      await seedContent();
      await seedContent(OTHER, 't2', 'p2', 'other-tour');
      return keys;
    })();
    expect(all.length).toBe(2 * backedUp.length + 1);

    const runs: string[] = [];
    for (let i = 0; i < 50; i++) {
      const { bucket, counts } = countingBucket();
      const r = await runBackup(bucket, new Date(NOW.getTime() + i * 15 * 60 * 1000), 7);
      expect(counts.ops).toBe(r.operations);
      expect(r.operations).toBeLessThanOrEqual(7);
      runs.push(r.status);
      if (r.status === 'partial') {
        const progress = BackupProgressSchema.parse(JSON.parse((await text(BACKUP_PROGRESS_KEY))!));
        expect(progress.date).toBe(DATE);
      }
      if (r.status !== 'partial') break;
    }

    expect(runs.at(-1)).toBe('complete');
    expect(runs.length).toBeGreaterThan(3);
    expect(await keysUnder(backupSetPrefix(DATE))).toEqual(all);
    const done = BackupCompleteRecordSchema.parse(
      JSON.parse((await text(backupCompleteKey(DATE)))!),
    );
    expect(done).toMatchObject({ objects: 2 * backedUp.length, runs: runs.length });
  });

  it('finishes a set past midnight before starting the next day’s', async () => {
    await seedContent();
    expect((await runBackup(env.BUCKET, NOW, 5)).status).toBe('partial');

    const tomorrow = new Date(NOW.getTime() + DAY_MS);
    expect(await runBackup(env.BUCKET, tomorrow)).toMatchObject({
      status: 'complete',
      date: DATE,
    });
    expect(await runBackup(env.BUCKET, tomorrow)).toMatchObject({
      status: 'complete',
      date: '2026-10-23',
    });
  });

  it('carries on past a copy that fails, and says so in the marker', async () => {
    const { backedUp } = await seedContent();
    const failing = configKey(SUB, 'p1');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { bucket } = countingBucket((key) => key === failing);

    const result = await runBackup(bucket, NOW);

    expect(result.status).toBe('complete');
    expect(await text(backupKey(DATE, failing))).toBeNull();
    const done = BackupCompleteRecordSchema.parse(
      JSON.parse((await text(backupCompleteKey(DATE)))!),
    );
    expect(done).toMatchObject({ objects: backedUp.length - 1, failed: 1 });
    expect(errors.mock.calls.flat().join(' ')).toMatch(/1 failed/);
    // Logs never name a key: keys carry the owner.
    expect(errors.mock.calls.flat().join(' ')).not.toContain('panos/');
  });

  it('starts over when the progress record is unreadable', async () => {
    const { backedUp } = await seedContent();
    await put(BACKUP_PROGRESS_KEY, 'not json');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await runBackup(env.BUCKET, NOW)).toMatchObject({
      status: 'complete',
      copied: backedUp.length,
    });
  });

  it('prunes sets older than the retention once a set completes', async () => {
    await seedContent();
    const old = '2026-09-01';
    const edge = '2026-09-22';
    for (const d of [old, edge, '2026-10-21']) await put(backupKey(d, tourKey(SUB, 't1')));

    const result = await runBackup(env.BUCKET, NOW);

    expect(result.pruned).toEqual([old]);
    expect(await keysUnder(backupSetPrefix(old))).toEqual([]);
    expect(await keysUnder(backupSetPrefix(edge))).toHaveLength(1);
    expect(await keysUnder(backupSetPrefix('2026-10-21'))).toHaveLength(1);
  });

  it('never prunes the last good set when the new one had failures or copied nothing', async () => {
    const { bucket } = countingBucket((key) => key === configKey(SUB, 'p1'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await seedSet('2026-08-01');
    await seedSet('2026-09-01');
    await seedSet('2026-09-02', { failed: 1 });
    await seedContent();

    // A set with a failed copy: the newest good set (2026-09-01) stays, however old.
    const failing = await runBackup(bucket, NOW);
    expect((await completeRecord()).failed).toBe(1);
    expect(failing.pruned).toEqual(['2026-08-01', '2026-09-02']);
    expect(await keysUnder(backupSetPrefix('2026-09-01'))).toHaveLength(2);

    // A set that copied nothing: still 2026-09-01.
    await wipe();
    await seedSet('2026-09-01');
    const empty = await runBackup(env.BUCKET, NOW);
    expect((await completeRecord()).objects).toBe(0);
    expect(empty.pruned).toEqual([]);
    expect(await keysUnder(backupSetPrefix('2026-09-01'))).toHaveLength(2);
  });

  it('counts an oversized object once, however many runs pass over its page', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await put(tourKey(SUB, 'a1'));
    await put(tourKey(SUB, 'a2'));
    await put(tourKey(SUB, 'zz'), 'x'.repeat(BACKUP_MAX_OBJECT_BYTES + 1));

    let runs = 0;
    for (; runs < 50; runs++) {
      const r = await runBackup(env.BUCKET, new Date(NOW.getTime() + runs * 15 * 60 * 1000), 7);
      if (r.status === 'complete') break;
    }

    expect(runs).toBeGreaterThan(1);
    expect(await completeRecord()).toMatchObject({ objects: 2, skipped: 1, failed: 0 });
  });

  it('saves its progress part way through a page, so a run that dies loses little', async () => {
    const total = BACKUP_SAVE_EVERY + 20;
    for (let i = 0; i < total; i++) await put(tourKey(SUB, `t${String(i).padStart(3, '0')}`));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Dies (every R2 call throws) once a save records BACKUP_SAVE_EVERY objects.
    let dead = false;
    const dying = new Proxy(env.BUCKET, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if (typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          if (dead) throw new Error('gone');
          const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          if (prop === 'put' && args[0] === BACKUP_PROGRESS_KEY) {
            const saved = BackupProgressSchema.parse(JSON.parse(args[1] as string));
            if (saved.objects >= BACKUP_SAVE_EVERY) dead = true;
          }
          return result;
        };
      },
    });

    await expect(runBackup(dying, NOW)).rejects.toThrow();
    const saved = BackupProgressSchema.parse(JSON.parse((await text(BACKUP_PROGRESS_KEY))!));
    expect(saved.objects).toBe(BACKUP_SAVE_EVERY);

    // Its lease has run out by the run after next; that one picks up where the save left off.
    const later = new Date(NOW.getTime() + 30 * 60 * 1000);
    expect(later.getTime()).toBeGreaterThan(NOW.getTime() + BACKUP_LEASE_MS);
    const resumed = await runBackup(env.BUCKET, later);
    expect(resumed).toMatchObject({ status: 'complete', copied: total - BACKUP_SAVE_EVERY });
    expect(await completeRecord()).toMatchObject({ objects: total, failed: 0 });
  });

  it('leaves a set alone while another run holds its lease', async () => {
    await seedContent();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await runBackup(env.BUCKET, NOW, 5)).status).toBe('partial');
    const progress = BackupProgressSchema.parse(JSON.parse((await text(BACKUP_PROGRESS_KEY))!));
    // A partial run hands the lease back.
    expect(progress.lockedUntil).toBeUndefined();
    await put(BACKUP_PROGRESS_KEY, {
      ...progress,
      lockedUntil: new Date(NOW.getTime() + 10 * 60 * 1000).toISOString(),
    });

    const busy = await runBackup(env.BUCKET, new Date(NOW.getTime() + 5 * 60 * 1000));

    expect(busy).toMatchObject({ status: 'busy', copied: 0 });
    expect(await keysUnder(backupSetPrefix(DATE))).toEqual([]);
    // Once the lease runs out, the next run carries on.
    const after = await runBackup(env.BUCKET, new Date(NOW.getTime() + 15 * 60 * 1000));
    expect(after.status).toBe('complete');
  });

  it('of two runs that read the same progress, only one takes the set', async () => {
    await seedContent();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Another run writes its lease between this run's read and its own lease write.
    const racing = new Proxy(env.BUCKET, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if (typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          if (prop === 'put' && args[0] === BACKUP_PROGRESS_KEY) {
            await target.put(BACKUP_PROGRESS_KEY, JSON.stringify({ other: 'run' }));
          }
          return (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        };
      },
    });

    const lost = await runBackup(racing, NOW);

    expect(lost).toMatchObject({ status: 'busy', copied: 0 });
    expect(await keysUnder(backupSetPrefix(DATE))).toEqual([]);
    expect(JSON.parse((await text(BACKUP_PROGRESS_KEY))!)).toEqual({ other: 'run' });
  });

  it('backs up exactly these prefixes (a new one is a decision, made here)', async () => {
    expect(BACKUP_SOURCES.map((s) => s.prefix)).toEqual([
      'accounts/',
      'explore/',
      'panos/',
      'pub/',
      'slugs/',
      'tour-owners/',
      'tours/',
    ]);
  });
});

describe('pruneBackups', () => {
  it('never deletes the newest good set, however old', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await seedSet('2026-01-01');
    await seedSet('2026-01-02');
    await put(backupKey('2026-01-03', tourKey(SUB, 't1'))); // never completed
    await seedSet('2026-10-21', { failed: 2 });
    await seedSet(DATE, { objects: 0 });
    expect(await pruneBackups(env.BUCKET, NOW)).toEqual(['2026-01-01', '2026-01-03']);
    expect(await keysUnder(backupSetPrefix('2026-01-02'))).toHaveLength(2);
  });

  it('prunes nothing when there is no good set to keep', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await seedSet('2026-01-01', { failed: 1 });
    await seedSet(DATE, { objects: 0 });
    expect(await pruneBackups(env.BUCKET, NOW)).toEqual([]);
    expect(await keysUnder(backupSetPrefix('2026-01-01'))).toHaveLength(2);
    expect(errors.mock.calls.flat().join(' ')).toMatch(/no good set/);
  });

  it('leaves the progress record and anything that is not a dated set', async () => {
    await put(BACKUP_PROGRESS_KEY);
    await put('backup/notes/x.json');
    await seedSet(DATE);
    const old = new Date(NOW.getTime() - (BACKUP_RETENTION_DAYS + 5) * DAY_MS);
    await put(backupKey(old.toISOString().slice(0, 10), tourKey(SUB, 't1')));
    expect(await pruneBackups(env.BUCKET, NOW)).toHaveLength(1);
    expect(await keysUnder('backup/')).toEqual([
      ...(await keysUnder(backupSetPrefix(DATE))),
      'backup/notes/x.json',
      BACKUP_PROGRESS_KEY,
    ]);
  });
});

describe('what deletes data never touches backups', () => {
  it('account deletion, its sweep and the daily sweeps leave every copy', async () => {
    const { backedUp } = await seedContent();
    await runBackup(env.BUCKET, NOW);
    const before = await keysUnder('backup/');
    const deps: AccountDeps = {
      bucket: env.BUCKET,
      unpublishTour: (sub, tourId) => unpublish(env.BUCKET, sub, tourId),
      clearStats: async () => {},
    };

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await deleteAccount(deps, SUB, NOW);
    const later = new Date(NOW.getTime() + 40 * DAY_MS);
    await sweepAccountDeletions(deps, later);
    await sweepExpiredAliases(env.BUCKET, later);
    await sweepSupersededTiles(env.BUCKET, later);

    expect(await text(tourKey(SUB, 't1'))).toBeNull();
    expect(await keysUnder('backup/')).toEqual(before);
    expect(before).toHaveLength(backedUp.length + 1);
  });
});

describe('scheduled', () => {
  const fire = async (cron: string) => {
    const ctx = createExecutionContext();
    await worker.scheduled(
      createScheduledController({ scheduledTime: NOW.getTime(), cron }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
  };

  it('runs the backup on its own cron, and only there', async () => {
    await seedContent();
    await fire('17 3 * * *');
    expect(await text(backupCompleteKey(DATE))).toBeNull();
    await fire(BACKUP_CRON);
    expect(await text(backupCompleteKey(DATE))).not.toBeNull();
  });

  it('never runs the daily tasks, or records a daily run, on the backup cron', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await fire(BACKUP_CRON);
    expect(await text(CRON_STATUS_KEY)).toBeNull();
    await fire('17 3 * * *');
    expect(await text(CRON_STATUS_KEY)).not.toBeNull();
  });

  it('has both crons in every env block of wrangler.jsonc', () => {
    const config = parseJsonc(wrangler) as {
      env: Record<string, { triggers: { crons: string[] } }>;
    };
    for (const name of ['dev', 'production']) {
      expect(config.env[name]!.triggers.crons).toEqual(['17 3 * * *', BACKUP_CRON]);
    }
  });
});

describe('restore', () => {
  const restore = (body: unknown, token: string | null = 'test-operator-token') =>
    SELF.fetch(`https://x${OPERATOR_RESTORE_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token === null ? {} : { [OPERATOR_TOKEN_HEADER]: token }),
      },
      body: JSON.stringify(body),
    });

  it('restores a missing key with its metadata, and leaves one that exists', async () => {
    await seedContent();
    await runBackup(env.BUCKET, NOW);
    await env.BUCKET.delete(tourKey(SUB, 't1'));
    await put(publishKey(SUB, 't1'), { changed: true });

    const res = await restore({
      date: DATE,
      keys: [tourKey(SUB, 't1'), publishKey(SUB, 't1'), tourKey(SUB, 'gone')],
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      restored: [tourKey(SUB, 't1')],
      existing: [publishKey(SUB, 't1')],
      missing: [tourKey(SUB, 'gone')],
      refused: [],
      failed: [],
    });
    const back = await env.BUCKET.get(tourKey(SUB, 't1'));
    expect(await back!.json()).toEqual({ tourId: 't1', title: 'Café' });
    expect(back!.customMetadata).toEqual({ title: 'Café', sceneCount: '1' });
    expect(back!.httpMetadata?.contentType).toBe('application/json');
    expect(JSON.parse((await text(publishKey(SUB, 't1')))!)).toEqual({ changed: true });
  });

  it('overwrites only when asked', async () => {
    await seedContent();
    await runBackup(env.BUCKET, NOW);
    await put(publishKey(SUB, 't1'), { changed: true });

    const out = await restoreFromBackup(env.BUCKET, DATE, [publishKey(SUB, 't1')], true);

    expect(out.restored).toEqual([publishKey(SUB, 't1')]);
    expect(JSON.parse((await text(publishKey(SUB, 't1')))!)).toEqual({
      slug: 'my-tour',
      visibility: 'public',
    });
  });

  it('refuses an owner whose account is marked for deletion', async () => {
    await seedContent();
    await runBackup(env.BUCKET, NOW);
    await env.BUCKET.delete(tourKey(SUB, 't1'));
    await put(accountDeletionKey(SUB), { v: 1, sub: SUB, requestedAt: NOW.toISOString() });

    const out = await restoreFromBackup(
      env.BUCKET,
      DATE,
      [tourKey(SUB, 't1'), pubTourKey('t1')],
      false,
    );

    expect(out.refused).toEqual([tourKey(SUB, 't1'), pubTourKey('t1')]);
    expect(await text(tourKey(SUB, 't1'))).toBeNull();
  });

  it('finds the owner of a public, slug, Explore or owner-pointer key, and refuses if deleted', async () => {
    await seedContent();
    await seedContent(OTHER, 't2', 'p2', 'other-tour');
    // A bundle with no owner pointer anywhere, and one whose pointer is only live.
    await put(pubTourKey('orphan'), { tourId: 'orphan' });
    await put(pubTourKey('late'), { tourId: 'late' });
    await runBackup(env.BUCKET, NOW);
    await put(tourOwnerKey('late'), { v: 1, sub: OTHER });
    await put(accountDeletionKey(SUB), { v: 1, sub: SUB, requestedAt: NOW.toISOString() });
    const ofTour = (tourId: string, slug: string) => [
      pubTourKey(tourId),
      slugKey(slug),
      tourOwnerKey(tourId),
      exploreEntryKey(1_700_000_000_000, tourId),
      exploreTourKey(tourId),
      exploreHiddenKey(tourId),
    ];
    const keys = [...ofTour('t1', 'my-tour'), ...ofTour('t2', 'other-tour')];
    await env.BUCKET.delete([...keys, pubTourKey('orphan'), pubTourKey('late')]);

    const out = await restoreFromBackup(
      env.BUCKET,
      DATE,
      [...keys, pubTourKey('orphan'), pubTourKey('late')],
      false,
    );

    expect(out.refused).toEqual([...ofTour('t1', 'my-tour'), pubTourKey('orphan')]);
    expect(out.restored).toEqual([...ofTour('t2', 'other-tour'), pubTourKey('late')]);
    for (const key of ofTour('t1', 'my-tour')) expect(await text(key)).toBeNull();
  });

  it("restores a plan image through its tour's owner pointer, and refuses one it can't place", async () => {
    await seedContent();
    await seedContent(OTHER, 't2', 'p2', 'other-tour');
    await env.BUCKET.put(planKey('orphan', 'pl1', 'image/png'), PLAN_BYTES);
    await runBackup(env.BUCKET, NOW);
    const plans = [
      planKey('t1', 'pl1', 'image/webp'),
      planKey('t2', 'pl1', 'image/webp'),
      planKey('orphan', 'pl1', 'image/png'),
    ];
    await env.BUCKET.delete(plans);
    await put(accountDeletionKey(SUB), { v: 1, sub: SUB, requestedAt: NOW.toISOString() });

    const res = await restore({ date: DATE, keys: plans });

    expect(await res.json()).toMatchObject({
      restored: [planKey('t2', 'pl1', 'image/webp')],
      refused: [planKey('t1', 'pl1', 'image/webp'), planKey('orphan', 'pl1', 'image/png')],
    });
    const back = await env.BUCKET.get(planKey('t2', 'pl1', 'image/webp'));
    expect(new Uint8Array(await back!.arrayBuffer())).toEqual(PLAN_BYTES);
    expect(back!.httpMetadata?.contentType).toBe('image/webp');
    expect(await env.BUCKET.head(planKey('t1', 'pl1', 'image/webp'))).toBeNull();
  });

  it('reports a key whose R2 call fails, and still restores the rest', async () => {
    await seedContent();
    await runBackup(env.BUCKET, NOW);
    await env.BUCKET.delete([tourKey(SUB, 't1'), publishKey(SUB, 't1')]);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { bucket } = countingBucket((key) => key === backupKey(DATE, publishKey(SUB, 't1')));

    const out = await restoreFromBackup(
      bucket,
      DATE,
      [tourKey(SUB, 't1'), publishKey(SUB, 't1')],
      false,
    );

    expect(out).toMatchObject({ restored: [tourKey(SUB, 't1')], failed: [publishKey(SUB, 't1')] });
    expect(await text(tourKey(SUB, 't1'))).not.toBeNull();
    expect(errors.mock.calls.flat().join(' ')).not.toContain('tours/');
  });

  it('is a 404 without the operator token, and a 400 for a key it would never restore', async () => {
    expect((await restore({ date: DATE, keys: [tourKey(SUB, 't1')] }, 'wrong')).status).toBe(404);
    expect((await restore({ date: DATE, keys: [tourKey(SUB, 't1')] }, null)).status).toBe(404);
    for (const key of [accountDeletionKey(SUB), originalKey(SUB, 'p1')]) {
      expect((await restore({ date: DATE, keys: [key] })).status).toBe(400);
    }
  });
});
