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
import { sweepSupersededTiles, sweepTileGcRecord, TILE_GC_GRACE_MS } from './tile-gc.js';

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

  it('keeps everything when the original exists but the manifest does not', async () => {
    const panoId = 'gc-no-manifest';
    await env.BUCKET.put(originalKey(SUB, panoId), 'original');
    await env.BUCKET.put(`${tileVersionPrefix(panoId, 't1-old')}0/px/0-0.webp`, 'tile');
    await record(panoId, 't1-old');

    expect(await sweepTileGcRecord(env.BUCKET, tileGcKey(panoId, 't1-old'))).toBe('kept');
    expect(await listKeys(tileVersionPrefix(panoId, 't1-old'))).toHaveLength(1);
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
    const first = await sweepSupersededTiles(env.BUCKET, later(), 2);
    expect(first.deleted).toBe(2);
    const second = await sweepSupersededTiles(env.BUCKET, later(), 2);
    expect(second.deleted).toBe(1);
    expect(await listKeys('tile-gc/gc-budget-')).toEqual([]);
  });

  it('runs from the daily cron', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const panoId = 'gc-cron';
    await seedPano(panoId, ['t1-old']);
    await record(panoId, 't1-old');

    const ctx = createExecutionContext();
    await worker.scheduled(
      createScheduledController({ scheduledTime: later().getTime(), cron: '17 3 * * *' }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(await listKeys(tileVersionPrefix(panoId, 't1-old'))).toEqual([]);
    expect(await env.BUCKET.head(tileGcKey(panoId, 't1-old'))).toBeNull();
  });
});
