import {
  manifestKey,
  originalKey,
  tileGcKey,
  tileVersionPrefix,
  type TileGcRecord,
} from '@internal/contracts';
import {
  createExecutionContext,
  createScheduledController,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import worker from './index.js';
import { BACKUP_CRON } from './backup.js';
import {
  runBackupThenTileGc,
  sweepSupersededTiles,
  sweepTileGcRecord,
  TILE_GC_GRACE_MS,
  TILE_GC_RECORD_MAX_OPS,
  TILE_GC_RUN_OPS,
  tileGcStart,
} from './tile-gc.js';

const SUB = 'auth0|tile-gc-owner';
const TILER = 1;
// Past the grace period for anything written during the test.
const later = () => new Date(Date.now() + TILE_GC_GRACE_MS + 60_000);

/** A pano with a current original, its manifest at `current`, and tiles under each dir. */
const seedPano = async (panoId: string, dirs: string[], current?: string) => {
  const put = await env.BUCKET.put(originalKey(SUB, panoId), 'original bytes');
  const etag = put!.etag;
  const currentVersion = current ?? `t${TILER}-${etag}`;
  await env.BUCKET.put(manifestKey(panoId), JSON.stringify({ version: currentVersion }));
  for (const d of [...dirs, currentVersion]) {
    await env.BUCKET.put(`${tileVersionPrefix(panoId, d)}0/px/0-0.webp`, 'tile');
    await env.BUCKET.put(`${tileVersionPrefix(panoId, d)}preview.webp`, 'tile');
  }
  return { etag, currentVersion };
};

const record = async (panoId: string, version: string, over: Partial<TileGcRecord> = {}) => {
  const body: TileGcRecord = {
    v: 1,
    originalKey: originalKey(SUB, panoId),
    tilerVersion: TILER,
    supersededAt: new Date().toISOString(),
    ...over,
  };
  await env.BUCKET.put(tileGcKey(panoId, version), JSON.stringify(body));
};

const listKeys = async (prefix: string) =>
  (await env.BUCKET.list({ prefix })).objects.map((o) => o.key);

describe('sweepTileGcRecord', () => {
  it('deletes a superseded version dir and its record, leaving the current one whole', async () => {
    const panoId = 'gc-basic';
    const { currentVersion } = await seedPano(panoId, ['t1-old']);
    await record(panoId, 't1-old');

    expect(await sweepTileGcRecord(env.BUCKET, tileGcKey(panoId, 't1-old'))).toBe('deleted');
    expect(await listKeys(tileVersionPrefix(panoId, 't1-old'))).toEqual([]);
    expect(await listKeys(tileVersionPrefix(panoId, currentVersion))).toHaveLength(2);
    expect(await env.BUCKET.head(tileGcKey(panoId, 't1-old'))).toBeNull();
    expect(await env.BUCKET.head(manifestKey(panoId))).not.toBeNull();
  });

  it('never deletes the version the manifest points at, and drops its record', async () => {
    const panoId = 'gc-current';
    const { currentVersion } = await seedPano(panoId, []);
    await record(panoId, currentVersion);

    expect(await sweepTileGcRecord(env.BUCKET, tileGcKey(panoId, currentVersion))).toBe('current');
    expect(await listKeys(tileVersionPrefix(panoId, currentVersion))).toHaveLength(2);
    expect(await env.BUCKET.head(tileGcKey(panoId, currentVersion))).toBeNull();
  });

  it('keeps a dir the current original would tile into (a newer job may be writing there)', async () => {
    const panoId = 'gc-in-progress';
    // The manifest still names an older version; the original's own dir is in flight.
    const put = await env.BUCKET.put(originalKey(SUB, panoId), 'new original');
    const inFlight = `t${TILER}-${put!.etag}`;
    await env.BUCKET.put(manifestKey(panoId), JSON.stringify({ version: 't1-previous' }));
    await env.BUCKET.put(`${tileVersionPrefix(panoId, inFlight)}0/px/0-0.webp`, 'tile');
    await record(panoId, inFlight);

    expect(await sweepTileGcRecord(env.BUCKET, tileGcKey(panoId, inFlight))).toBe('kept');
    expect(await listKeys(tileVersionPrefix(panoId, inFlight))).toHaveLength(1);
    expect(await env.BUCKET.head(tileGcKey(panoId, inFlight))).not.toBeNull();
  });

  it('deletes the same-ETag dir of an older tiler build after a bulk re-tile', async () => {
    const panoId = 'gc-tiler-bump';
    const put = await env.BUCKET.put(originalKey(SUB, panoId), 'same bytes');
    const old = `t1-${put!.etag}`;
    const current = `t2-${put!.etag}`;
    await env.BUCKET.put(manifestKey(panoId), JSON.stringify({ version: current }));
    await env.BUCKET.put(`${tileVersionPrefix(panoId, old)}0/px/0-0.webp`, 'tile');
    await env.BUCKET.put(`${tileVersionPrefix(panoId, current)}0/px/0-0.webp`, 'tile');
    await record(panoId, old, { tilerVersion: 2 });

    expect(await sweepTileGcRecord(env.BUCKET, tileGcKey(panoId, old))).toBe('deleted');
    expect(await listKeys(tileVersionPrefix(panoId, old))).toEqual([]);
    expect(await listKeys(tileVersionPrefix(panoId, current))).toHaveLength(1);
  });

  it('keeps the dir a first upload with no manifest yet tiles into (its job may retry)', async () => {
    const panoId = 'gc-no-manifest';
    const put = await env.BUCKET.put(originalKey(SUB, panoId), 'original');
    const own = `t${TILER}-${put!.etag}`;
    await env.BUCKET.put(`${tileVersionPrefix(panoId, own)}0/px/0-0.webp`, 'tile');
    await record(panoId, own);

    expect(await sweepTileGcRecord(env.BUCKET, tileGcKey(panoId, own), later())).toBe('kept');
    expect(await listKeys(tileVersionPrefix(panoId, own))).toHaveLength(1);
  });

  it('deletes the partial dir of an earlier, failed original when there is no manifest', async () => {
    // Two uploads whose jobs both failed: the first one's dir can never go live.
    const panoId = 'gc-no-manifest-older';
    const first = await env.BUCKET.put(originalKey(SUB, panoId), 'first original');
    const older = `t${TILER}-${first!.etag}`;
    await env.BUCKET.put(`${tileVersionPrefix(panoId, older)}0/px/0-0.webp`, 'tile');
    await record(panoId, older);
    const second = await env.BUCKET.put(originalKey(SUB, panoId), 'second original');
    const own = `t${TILER}-${second!.etag}`;
    await env.BUCKET.put(`${tileVersionPrefix(panoId, own)}0/px/0-0.webp`, 'tile');

    expect(await sweepTileGcRecord(env.BUCKET, tileGcKey(panoId, older), later())).toBe('deleted');
    expect(await listKeys(tileVersionPrefix(panoId, older))).toEqual([]);
    expect(await listKeys(tileVersionPrefix(panoId, own))).toHaveLength(1);
  });

  it('deletes the dir of a pano whose original is gone (deleted pano)', async () => {
    const panoId = 'gc-pano-gone';
    await env.BUCKET.put(`${tileVersionPrefix(panoId, 't1-old')}0/px/0-0.webp`, 'tile');
    await record(panoId, 't1-old');

    expect(await sweepTileGcRecord(env.BUCKET, tileGcKey(panoId, 't1-old'))).toBe('deleted');
    expect(await listKeys(tileVersionPrefix(panoId, 't1-old'))).toEqual([]);
  });

  it.each([
    ['an unparsable body', 'not json'],
    [
      'a record naming another pano',
      JSON.stringify({
        v: 1,
        originalKey: 'panos/x/other/original',
        tilerVersion: 1,
        supersededAt: '',
      }),
    ],
    [
      'a record with a bad original key',
      JSON.stringify({ v: 1, originalKey: '../../x', tilerVersion: 1, supersededAt: '' }),
    ],
  ])('drops %s without touching tiles', async (_label, body) => {
    const panoId = 'gc-invalid';
    await env.BUCKET.put(`${tileVersionPrefix(panoId, 't1-old')}0/px/0-0.webp`, 'tile');
    await env.BUCKET.put(tileGcKey(panoId, 't1-old'), body);

    expect(await sweepTileGcRecord(env.BUCKET, tileGcKey(panoId, 't1-old'))).toBe('invalid');
    expect(await listKeys(tileVersionPrefix(panoId, 't1-old'))).toHaveLength(1);
    expect(await env.BUCKET.head(tileGcKey(panoId, 't1-old'))).toBeNull();
  });
});

describe('sweepTileGcRecord: dirs rewritten or unreadable since the record', () => {
  const longAgo = new Date(Date.now() - 3 * TILE_GC_GRACE_MS).toISOString();

  it('keeps a dir rewritten after the record (undo-replace: E1 -> E2 -> E1 -> E2 within a day)', async () => {
    const panoId = 'gc-undo-replace';
    // E2 is the current original and manifest; t1-E1 was live again in between,
    // so its tiles are newer than the stale record that survived from the first swap.
    const { currentVersion } = await seedPano(panoId, []);
    await env.BUCKET.put(`${tileVersionPrefix(panoId, 't1-E1')}0/px/0-0.webp`, 'rewritten');
    await record(panoId, 't1-E1', { supersededAt: longAgo });
    const now = later();

    expect(await sweepTileGcRecord(env.BUCKET, tileGcKey(panoId, 't1-E1'), now)).toBe('kept');
    expect(await listKeys(tileVersionPrefix(panoId, 't1-E1'))).toHaveLength(1);
    expect(await listKeys(tileVersionPrefix(panoId, currentVersion))).toHaveLength(2);
    // Its time moves on, so a later run gives it a full grace period from now.
    const refreshed = await (await env.BUCKET.get(
      tileGcKey(panoId, 't1-E1'),
    ))!.json<TileGcRecord>();
    expect(refreshed.supersededAt).toBe(now.toISOString());
  });

  it('keeps a dir a rolled-back tiler is writing into, though the record names the newer tiler', async () => {
    const panoId = 'gc-rollback';
    const put = await env.BUCKET.put(originalKey(SUB, panoId), 'same bytes');
    const etag = put!.etag;
    await env.BUCKET.put(manifestKey(panoId), JSON.stringify({ version: `t2-${etag}` }));
    // Tiler 1 is deployed again and re-tiling into t1-<etag>.
    await env.BUCKET.put(`${tileVersionPrefix(panoId, `t1-${etag}`)}0/px/0-0.webp`, 'in flight');
    await record(panoId, `t1-${etag}`, { tilerVersion: 2, supersededAt: longAgo });

    expect(await sweepTileGcRecord(env.BUCKET, tileGcKey(panoId, `t1-${etag}`))).toBe('kept');
    expect(await listKeys(tileVersionPrefix(panoId, `t1-${etag}`))).toHaveLength(1);
  });

  it('keeps everything when the manifest exists but cannot be parsed', async () => {
    const panoId = 'gc-bad-manifest';
    await seedPano(panoId, ['t1-old']);
    await env.BUCKET.put(manifestKey(panoId), 'not json');
    await record(panoId, 't1-old');

    expect(await sweepTileGcRecord(env.BUCKET, tileGcKey(panoId, 't1-old'))).toBe('kept');
    expect(await listKeys(tileVersionPrefix(panoId, 't1-old'))).toHaveLength(2);
    expect(await env.BUCKET.head(tileGcKey(panoId, 't1-old'))).not.toBeNull();
  });

  /** env.BUCKET, with `override` patched over some of its calls. */
  const patched = (override: Partial<Record<'get' | 'head', (key: string) => unknown>>) =>
    ({
      get: override.get ?? ((k: string) => env.BUCKET.get(k)),
      head: override.head ?? ((k: string) => env.BUCKET.head(k)),
      list: (o: R2ListOptions) => env.BUCKET.list(o),
      put: (k: string, v: string, o?: R2PutOptions) => env.BUCKET.put(k, v, o),
      delete: (k: string | string[]) => env.BUCKET.delete(k),
    }) as unknown as R2Bucket;

  it('lets a failed read of the record body throw, leaving the record', async () => {
    const panoId = 'gc-read-error';
    await seedPano(panoId, ['t1-old']);
    await record(panoId, 't1-old');
    const bucket = patched({
      get: async (k) =>
        k === tileGcKey(panoId, 't1-old')
          ? {
              text: async () => {
                throw new Error('stream reset');
              },
            }
          : env.BUCKET.get(k),
    });

    await expect(sweepTileGcRecord(bucket, tileGcKey(panoId, 't1-old'))).rejects.toThrow(
      'stream reset',
    );
    expect(await env.BUCKET.head(tileGcKey(panoId, 't1-old'))).not.toBeNull();
  });

  it('matches a quoted original ETag against the dir name', async () => {
    const panoId = 'gc-quoted-etag';
    const put = await env.BUCKET.put(originalKey(SUB, panoId), 'new original');
    const inFlight = `t${TILER}-${put!.etag}`;
    await env.BUCKET.put(manifestKey(panoId), JSON.stringify({ version: 't1-previous' }));
    await env.BUCKET.put(`${tileVersionPrefix(panoId, inFlight)}0/px/0-0.webp`, 'tile');
    await record(panoId, inFlight, { supersededAt: later().toISOString() });
    const bucket = patched({
      head: async (k) => {
        const o = await env.BUCKET.head(k);
        return o && { etag: `"${o.etag}"` };
      },
    });

    expect(await sweepTileGcRecord(bucket, tileGcKey(panoId, inFlight))).toBe('kept');
    expect(await listKeys(tileVersionPrefix(panoId, inFlight))).toHaveLength(1);
  });
});

describe('sweepSupersededTiles', () => {
  it('leaves records younger than the grace period alone', async () => {
    const panoId = 'gc-young';
    await seedPano(panoId, ['t1-old']);
    await record(panoId, 't1-old');

    const counts = await sweepSupersededTiles(env.BUCKET, new Date());
    expect(counts).toEqual({ deleted: 0, current: 0, kept: 0, invalid: 0 });
    expect(await listKeys(tileVersionPrefix(panoId, 't1-old'))).toHaveLength(2);
  });

  it('handles at most `budget` records per run, leaving the rest for the next', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const panoId of ['gc-budget-a', 'gc-budget-b', 'gc-budget-c']) {
      await seedPano(panoId, ['t1-old']);
      await record(panoId, 't1-old');
    }
    // Other tests' leftover records share the bucket, so count only these three.
    await sweepSupersededTiles(env.BUCKET, later(), { budget: 2 });
    expect((await listKeys('tile-gc/gc-budget-')).length).toBeGreaterThan(0);
    for (let run = 0; run < 5; run++)
      await sweepSupersededTiles(env.BUCKET, later(), { budget: 2 });
    expect(await listKeys('tile-gc/gc-budget-')).toEqual([]);
  });

  it("doesn't let kept records use up the budget for the ones after them", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // 'gc-starve-a...' sorts first and is kept (the original's own in-flight dir).
    const put = await env.BUCKET.put(originalKey(SUB, 'gc-starve-a'), 'original');
    const inFlight = `t${TILER}-${put!.etag}`;
    await env.BUCKET.put(manifestKey('gc-starve-a'), JSON.stringify({ version: 't1-x' }));
    await record('gc-starve-a', inFlight);
    await seedPano('gc-starve-b', ['t1-old']);
    await record('gc-starve-b', 't1-old');

    for (let run = 0; run < 5; run++)
      await sweepSupersededTiles(env.BUCKET, later(), { budget: 1 });
    expect(await listKeys('tile-gc/gc-starve-b/')).toEqual([]);
    expect(await listKeys('tile-gc/gc-starve-a/')).toHaveLength(1);
  });

  it('stops after examining examineCap records, acted on or not', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const put = await env.BUCKET.put(originalKey(SUB, 'gc-cap-a'), 'original');
    await env.BUCKET.put(manifestKey('gc-cap-a'), JSON.stringify({ version: 't1-x' }));
    await record('gc-cap-a', `t${TILER}-${put!.etag}`);
    await seedPano('gc-cap-b', ['t1-old']);
    await record('gc-cap-b', 't1-old');

    const counts = await sweepSupersededTiles(env.BUCKET, later(), { examineCap: 0 });
    expect(counts).toEqual({ deleted: 0, current: 0, kept: 0, invalid: 0 });
    expect(await listKeys('tile-gc/gc-cap-b/')).toHaveLength(1);
  });

  it('stops before a record could take it past its R2 operation budget', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const panoId of ['gc-ops-a', 'gc-ops-b', 'gc-ops-c', 'gc-ops-d']) {
      await seedPano(panoId, ['t1-old']);
      await record(panoId, 't1-old');
    }
    let calls = 0;
    const counting = new Proxy(env.BUCKET, {
      get(target, prop) {
        const v = Reflect.get(target, prop) as unknown;
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => {
          calls += 1;
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    // Room for the listing and two worst-case records, not three.
    const ops = 1 + 2 * TILE_GC_RECORD_MAX_OPS + 5;
    const counts = await sweepSupersededTiles(counting, later(), { ops });
    expect(calls).toBeLessThanOrEqual(ops);
    expect(counts.deleted).toBeGreaterThan(0);
    // With no budget at all, a run touches nothing.
    calls = 0;
    await sweepSupersededTiles(counting, later(), { ops: TILE_GC_RECORD_MAX_OPS });
    expect(calls).toBe(0);
  });

  it('starts each quarter hour at a different point in tile-gc/, and still covers all of it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const base = Date.UTC(2026, 9, 23);
    const starts = Array.from({ length: 16 }, (_, i) =>
      tileGcStart(new Date(base + i * 15 * 60 * 1000)),
    );
    expect(new Set(starts).size).toBe(16);
    expect(starts.every((k) => /^tile-gc\/[0-9a-f]$/.test(k))).toBe(true);

    // Records on both sides of this run's start point all go in one run.
    const now = new Date(later().getTime());
    const start = tileGcStart(now).slice('tile-gc/'.length);
    const before = start === '0' ? null : `${(parseInt(start, 16) - 1).toString(16)}0-rot`;
    const after = `${start}0-rot`;
    for (const panoId of [before, after].filter((p): p is string => p !== null)) {
      await seedPano(panoId, ['t1-old']);
      await record(panoId, 't1-old');
    }
    await sweepSupersededTiles(env.BUCKET, now);
    for (const panoId of [before, after].filter((p): p is string => p !== null))
      expect(await listKeys(`tile-gc/${panoId}/`)).toEqual([]);
  });

  it('runs from the 15-minute cron, after the backup, and not from the daily one', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const panoId = 'gc-cron';
    await seedPano(panoId, ['t1-old']);
    await record(panoId, 't1-old');

    const fire = async (cron: string) => {
      const ctx = createExecutionContext();
      await worker.scheduled(
        createScheduledController({ scheduledTime: later().getTime(), cron }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
    };
    await fire('17 3 * * *');
    expect(await listKeys(tileVersionPrefix(panoId, 't1-old'))).toHaveLength(2);
    await fire(BACKUP_CRON);
    expect(await listKeys(tileVersionPrefix(panoId, 't1-old'))).toEqual([]);
    expect(await env.BUCKET.head(tileGcKey(panoId, 't1-old'))).toBeNull();
  });
});

describe('runBackupThenTileGc', () => {
  it('gives the sweep what the backup left of the shared budget', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const panoId = 'gc-shared-budget';
    await seedPano(panoId, ['t1-old']);
    await record(panoId, 't1-old');

    // A backup that used it all leaves the sweep nothing to work with.
    await runBackupThenTileGc(env.BUCKET, later(), async () => ({
      operations: TILE_GC_RUN_OPS,
    }));
    expect(await listKeys(tileVersionPrefix(panoId, 't1-old'))).toHaveLength(2);

    // An idle backup run (2 operations) leaves it the rest.
    await runBackupThenTileGc(env.BUCKET, later(), async () => ({ operations: 2 }));
    expect(await listKeys(tileVersionPrefix(panoId, 't1-old'))).toEqual([]);
  });

  it('skips the sweep when the backup throws, then throws its error', async () => {
    const panoId = 'gc-backup-throws';
    await seedPano(panoId, ['t1-old']);
    await record(panoId, 't1-old');

    await expect(
      runBackupThenTileGc(env.BUCKET, later(), async () => {
        throw new Error('backup broke');
      }),
    ).rejects.toThrow('backup broke');
    expect(await listKeys(tileVersionPrefix(panoId, 't1-old'))).toHaveLength(2);
  });
});
