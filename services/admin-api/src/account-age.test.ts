import { accountSinceKey, originalKey } from '@internal/contracts';
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
  accountSince,
  DEFAULT_NEW_ACCOUNT_HOLD_DAYS,
  heldUntil,
  parseHoldDays,
} from './account-age.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const readSince = async (sub: string) =>
  (await (await env.BUCKET.get(accountSinceKey(sub)))?.json<{ since: string }>())?.since;

// Storage is shared across it() cases in this file, so every case uses its own sub.
describe('accountSince', () => {
  it('latches the oldest original on first use, and never moves it after', async () => {
    const sub = 'auth0|age-latch';
    await env.BUCKET.put(originalKey(sub, 'age-latch-p1'), 'bytes');
    const later = new Date(Date.now() + 3 * DAY_MS);
    const first = await accountSince(env.BUCKET, sub, later);
    // From R2's own upload time, not the clock passed in.
    expect(first).toBeLessThanOrEqual(Date.now());
    expect(Date.parse((await readSince(sub))!)).toBe(first);
    await env.BUCKET.put(originalKey(sub, 'age-latch-p2'), 'bytes');
    expect(await accountSince(env.BUCKET, sub, new Date(Date.now() + 9 * DAY_MS))).toBe(first);
  });

  it('is now for an owner with no originals, and replaces a record that does not parse', async () => {
    const sub = 'auth0|age-empty';
    const now = new Date('2026-10-01T00:00:00.000Z');
    expect(await accountSince(env.BUCKET, sub, now)).toBe(now.getTime());
    await env.BUCKET.put(accountSinceKey(sub), 'not json');
    const again = new Date('2026-10-02T00:00:00.000Z');
    expect(await accountSince(env.BUCKET, sub, again)).toBe(again.getTime());
    expect(await readSince(sub)).toBe(again.toISOString());
  });

  it('keeps the record a racing first publish wrote', async () => {
    const sub = 'auth0|age-race';
    const theirs = '2026-01-01T00:00:00.000Z';
    let gets = 0;
    const racing = new Proxy(env.BUCKET, {
      get(target, prop) {
        // The first GET finds nothing, and the other publish's record lands before the
        // create-only PUT; later GETs read the bucket.
        if (prop === 'get') {
          return async (key: string) => {
            if (gets++ > 0) return target.get(key);
            await target.put(key, JSON.stringify({ v: 1, since: theirs }));
            return null;
          };
        }
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const got = await accountSince(racing, sub, new Date());
    expect(got).toBe(Date.parse(theirs));
  });
});

describe('heldUntil', () => {
  it('is the account start plus the hold while that is still ahead, else null', async () => {
    const sub = 'auth0|age-held';
    const since = Date.parse('2026-10-01T00:00:00.000Z');
    await env.BUCKET.put(
      accountSinceKey(sub),
      JSON.stringify({ v: 1, since: new Date(since).toISOString() }),
    );
    const early = new Date(since + 2 * DAY_MS);
    expect(await heldUntil(env.BUCKET, sub, early, 7)).toBe(
      new Date(since + 7 * DAY_MS).toISOString(),
    );
    expect(await heldUntil(env.BUCKET, sub, new Date(since + 7 * DAY_MS), 7)).toBeNull();
    // 0 turns the hold off, without even reading R2.
    expect(await heldUntil(env.BUCKET, 'auth0|age-off', early, 0)).toBeNull();
    expect(await env.BUCKET.head(accountSinceKey('auth0|age-off'))).toBeNull();
  });
});

describe('parseHoldDays', () => {
  it('reads 0 or more days and falls back to 7 otherwise', () => {
    expect(parseHoldDays('7')).toBe(7);
    expect(parseHoldDays('0')).toBe(0);
    expect(parseHoldDays('1.5')).toBe(1.5);
    for (const bad of [undefined, '', ' ', '-1', 'abc']) {
      expect(parseHoldDays(bad)).toBe(DEFAULT_NEW_ACCOUNT_HOLD_DAYS);
    }
    expect(DEFAULT_NEW_ACCOUNT_HOLD_DAYS).toBe(7);
  });
});
