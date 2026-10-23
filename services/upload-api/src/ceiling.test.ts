import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { ceilingLimits, secondsToNextDay, utcDay, type CeilingLimits } from './ceiling.js';

// Each test gets its own instance, so counts never leak between tests.
let n = 0;
const fresh = () => env.UPLOAD_CEILING.get(env.UPLOAD_CEILING.idFromName(`ceiling-${n++}`));
const NOON = Date.parse('2026-10-22T12:00:00Z');
const limits = (maxUploads: number | null, maxBytes: number | null): CeilingLimits => ({
  maxUploads,
  maxBytes,
});

describe('UploadCeiling', () => {
  it('counts each reservation, and refuses the one past the upload limit', async () => {
    const c = fresh();
    expect(await c.reserve(10, limits(2, null), NOON)).toEqual({ day: '2026-10-22', bytes: 10 });
    expect(await c.reserve(20, limits(2, null), NOON)).toEqual({ day: '2026-10-22', bytes: 20 });
    expect(await c.reserve(1, limits(2, null), NOON)).toBeNull();
    // A refusal counts nothing.
    expect(await c.count(NOON)).toMatchObject({ uploads: 2, bytes: 30 });
  });

  it('refuses a reservation whose bytes would pass the byte limit, and allows one landing on it', async () => {
    const c = fresh();
    expect(await c.reserve(60, limits(null, 100), NOON)).not.toBeNull();
    expect(await c.reserve(41, limits(null, 100), NOON)).toBeNull();
    expect(await c.reserve(40, limits(null, 100), NOON)).not.toBeNull();
    expect(await c.count(NOON)).toMatchObject({ uploads: 2, bytes: 100 });
  });

  it('a limit of 0 refuses everything (the kill switch)', async () => {
    expect(await fresh().reserve(1, limits(0, null), NOON)).toBeNull();
    expect(await fresh().reserve(1, limits(null, 0), NOON)).toBeNull();
  });

  it('null limits never refuse', async () => {
    const c = fresh();
    for (let i = 0; i < 5; i += 1) {
      expect(await c.reserve(2 ** 40, limits(null, null), NOON)).not.toBeNull();
    }
  });

  it('parallel reservations never take it past the limit', async () => {
    const c = fresh();
    const held = await Promise.all(
      Array.from({ length: 20 }, () => c.reserve(1, limits(5, null), NOON)),
    );
    expect(held.filter((h) => h !== null)).toHaveLength(5);
    expect(await c.count(NOON)).toMatchObject({ uploads: 5, bytes: 5 });
  });

  it('starts again at 00:00 UTC', async () => {
    const c = fresh();
    const lastSecond = Date.parse('2026-10-22T23:59:59Z');
    expect(await c.reserve(1, limits(1, null), lastSecond)).not.toBeNull();
    expect(await c.reserve(1, limits(1, null), lastSecond)).toBeNull();
    const midnight = Date.parse('2026-10-23T00:00:00Z');
    expect(await c.reserve(1, limits(1, null), midnight)).toEqual({ day: '2026-10-23', bytes: 1 });
  });

  it('release gives a reservation back, never below zero', async () => {
    const c = fresh();
    const held = await c.reserve(30, limits(1, null), NOON);
    expect(held).not.toBeNull();
    await c.release(held!);
    expect(await c.count(NOON)).toMatchObject({ uploads: 0, bytes: 0 });
    await c.release(held!);
    expect(await c.count(NOON)).toMatchObject({ uploads: 0, bytes: 0 });
    expect(await c.reserve(30, limits(1, null), NOON)).not.toBeNull();
  });

  it("release of a past day's reservation changes nothing", async () => {
    const c = fresh();
    const yesterday = await c.reserve(5, limits(null, null), NOON - 86_400_000);
    await c.reserve(7, limits(null, null), NOON);
    await c.release(yesterday!);
    expect(await c.count(NOON)).toMatchObject({ uploads: 1, bytes: 7 });
  });

  it('logs the first refusal of a day only', async () => {
    const c = fresh();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await c.reserve(1, limits(0, null), NOON);
    await c.reserve(1, limits(0, null), NOON);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await runInDurableObject(c, (_i, state) => state.storage.kv.get('count'))).toMatchObject(
      {
        warned: true,
        uploads: 0,
      },
    );
  });
});

describe('ceilingLimits', () => {
  it('reads the vars; empty lifts a limit; a malformed one throws (fails closed)', () => {
    expect(
      ceilingLimits({ MAX_UPLOADS_PER_DAY_GLOBAL: '2000', MAX_UPLOAD_BYTES_PER_DAY_GLOBAL: '' }),
    ).toEqual({ maxUploads: 2000, maxBytes: null });
    expect(() => ceilingLimits({ MAX_UPLOADS_PER_DAY_GLOBAL: 'lots' })).toThrow(
      'MAX_UPLOADS_PER_DAY_GLOBAL must be a non-negative integer',
    );
  });
});

describe('day helpers', () => {
  it('utcDay is the UTC calendar day', () => {
    expect(utcDay(Date.parse('2026-10-22T23:59:59.999Z'))).toBe('2026-10-22');
    expect(utcDay(Date.parse('2026-10-23T00:00:00Z'))).toBe('2026-10-23');
  });

  it('secondsToNextDay counts to 00:00 UTC, at least 1', () => {
    expect(secondsToNextDay(NOON)).toBe(12 * 3600);
    expect(secondsToNextDay(Date.parse('2026-10-22T23:59:59.500Z'))).toBe(1);
    expect(secondsToNextDay(Date.parse('2026-10-23T00:00:00Z'))).toBe(86_400);
  });
});
