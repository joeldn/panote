import { CRON_STATUS_KEY, TILE_GC_STATUS_KEY, type CronStatus } from '@internal/contracts';
import {
  createExecutionContext,
  createScheduledController,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runDailyCron } from './cron-status.js';
import worker from './index.js';

const status = async () =>
  (await (await env.BUCKET.get(CRON_STATUS_KEY))?.json()) as CronStatus | undefined;

const DAY1 = new Date('2026-10-01T03:17:00.000Z');
const DAY2 = new Date('2026-10-02T03:17:00.000Z');

describe('runDailyCron', () => {
  beforeEach(() => env.BUCKET.delete(CRON_STATUS_KEY));

  it('records a clean run as both the last run and the last OK', async () => {
    const failed = await runDailyCron(env.BUCKET, DAY1, {
      a: async () => 1,
      b: async () => undefined,
    });
    expect(failed).toEqual([]);
    expect(await status()).toEqual({
      lastRunAt: DAY1.toISOString(),
      lastOkAt: DAY1.toISOString(),
      failed: [],
    });
  });

  it('runs every task even when one throws, logs a stable line and keeps the last OK', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await runDailyCron(env.BUCKET, DAY1, { a: async () => 1 });
    const ran: string[] = [];
    const failed = await runDailyCron(env.BUCKET, DAY2, {
      'slug-aliases': async () => {
        ran.push('slug-aliases');
        throw new TypeError('secret detail');
      },
      'tile-gc': async () => {
        ran.push('tile-gc');
      },
    });
    expect(ran.sort()).toEqual(['slug-aliases', 'tile-gc']);
    expect(failed).toEqual(['slug-aliases']);
    expect(error).toHaveBeenCalledWith(
      '[cron] daily task failed task=slug-aliases error=TypeError',
    );
    expect(error.mock.calls.flat().join(' ')).not.toContain('secret detail');
    expect(await status()).toEqual({
      lastRunAt: DAY2.toISOString(),
      lastOkAt: DAY1.toISOString(),
      failed: ['slug-aliases'],
    });
  });

  it('treats a task that throws synchronously like any other failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let otherRan = false;
    const failed = await runDailyCron(env.BUCKET, DAY1, {
      sync: () => {
        throw new RangeError('before any promise');
      },
      other: async () => {
        otherRan = true;
      },
    });
    expect(failed).toEqual(['sync']);
    expect(otherRan).toBe(true);
    expect(error).toHaveBeenCalledWith('[cron] daily task failed task=sync error=RangeError');
    expect(await status()).toEqual({
      lastRunAt: DAY1.toISOString(),
      lastOkAt: null,
      failed: ['sync'],
    });
  });

  it('has no last OK when the first run fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await runDailyCron(env.BUCKET, DAY1, { a: () => Promise.reject(new Error('x')) });
    expect((await status())?.lastOkAt).toBeNull();
  });

  it('never throws when the status cannot be written', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = {
      get: () => Promise.resolve(null),
      put: () => Promise.reject(new Error('r2 down')),
    } as unknown as R2Bucket;
    await expect(runDailyCron(broken, DAY1, { a: async () => 1 })).resolves.toEqual([]);
    expect(error).toHaveBeenCalledWith('[cron] daily status not saved: Error');
  });

  it('is what the daily Cron Trigger runs', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Its `tile-gc` task checks the 15-minute sweep finished cleanly lately.
    await env.BUCKET.put(
      TILE_GC_STATUS_KEY,
      JSON.stringify({ lastRunAt: DAY2.toISOString(), lastOkAt: DAY2.toISOString() }),
    );
    const ctx = createExecutionContext();
    await worker.scheduled(
      createScheduledController({ scheduledTime: DAY2.getTime(), cron: '17 3 * * *' }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(await status()).toEqual({
      lastRunAt: DAY2.toISOString(),
      lastOkAt: DAY2.toISOString(),
      failed: [],
    });
  });
});
