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
  deletingKey,
  exploreEntryKey,
  exploreHiddenKey,
  exploreTourKey,
  manifestKey,
  OPERATOR_RESTORE_PATH,
  OPERATOR_TOKEN_HEADER,
  originalKey,
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
  BACKUP_RETENTION_DAYS,
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
  it('never deletes the set it is told to keep, however old', async () => {
    await put(backupKey('2026-01-01', tourKey(SUB, 't1')));
    await put(backupKey('2026-01-02', tourKey(SUB, 't1')));
    expect(await pruneBackups(env.BUCKET, NOW, '2026-01-02')).toEqual(['2026-01-01']);
    expect(await keysUnder(backupSetPrefix('2026-01-02'))).toHaveLength(1);
  });

  it('leaves the progress record and anything that is not a dated set', async () => {
    await put(BACKUP_PROGRESS_KEY);
    await put('backup/notes/x.json');
    const old = new Date(NOW.getTime() - (BACKUP_RETENTION_DAYS + 5) * DAY_MS);
    await put(backupKey(old.toISOString().slice(0, 10), tourKey(SUB, 't1')));
    expect(await pruneBackups(env.BUCKET, NOW, DATE)).toHaveLength(1);
    expect(await keysUnder('backup/')).toEqual(['backup/notes/x.json', BACKUP_PROGRESS_KEY]);
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

    expect(out.refused).toEqual([tourKey(SUB, 't1')]);
    expect(await text(tourKey(SUB, 't1'))).toBeNull();
  });

  it('is a 404 without the operator token, and a 400 for a key it would never restore', async () => {
    expect((await restore({ date: DATE, keys: [tourKey(SUB, 't1')] }, 'wrong')).status).toBe(404);
    expect((await restore({ date: DATE, keys: [tourKey(SUB, 't1')] }, null)).status).toBe(404);
    for (const key of [accountDeletionKey(SUB), originalKey(SUB, 'p1')]) {
      expect((await restore({ date: DATE, keys: [key] })).status).toBe(400);
    }
  });
});
