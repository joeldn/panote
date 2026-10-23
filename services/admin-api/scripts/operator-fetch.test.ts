import { describe, expect, it, vi } from 'vitest';

import { fetchWaitingOut429, OPERATOR_429_RETRIES } from './operator-fetch.ts';

const limited = (retryAfter?: string) =>
  new Response('{"error":"rate limited"}', {
    status: 429,
    headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter },
  });

describe('fetchWaitingOut429', () => {
  it('waits for Retry-After and sends the same request again', async () => {
    const fetchFn = vi
      .fn<(input: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(limited('7'))
      .mockResolvedValueOnce(new Response('ok'));
    const sleep = vi.fn(async (_ms: number) => undefined);
    const init = { method: 'POST', body: '{"a":1}' };
    const res = await fetchWaitingOut429(fetchFn, 'https://x/op', init, sleep);
    expect(await res.text()).toBe('ok');
    expect(sleep).toHaveBeenCalledWith(7000);
    expect(fetchFn.mock.calls).toEqual([
      ['https://x/op', init],
      ['https://x/op', init],
    ]);
  });

  it('waits a minute when Retry-After is missing or unusable, and at most five minutes', async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    for (const [header, ms] of [
      [undefined, 60_000],
      ['soon', 60_000],
      ['86400', 300_000],
    ] as const) {
      const fetchFn = vi
        .fn<(input: string, init: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(limited(header))
        .mockResolvedValueOnce(new Response('ok'));
      await fetchWaitingOut429(fetchFn, 'https://x/op', {}, sleep);
      expect(sleep).toHaveBeenLastCalledWith(ms);
    }
  });

  it('gives up and returns the 429 after OPERATOR_429_RETRIES waits', async () => {
    const fetchFn = vi.fn(async () => limited('1'));
    const sleep = vi.fn(async (_ms: number) => undefined);
    const res = await fetchWaitingOut429(fetchFn, 'https://x/op', {}, sleep);
    expect(res.status).toBe(429);
    expect(sleep).toHaveBeenCalledTimes(OPERATOR_429_RETRIES);
    expect(fetchFn).toHaveBeenCalledTimes(OPERATOR_429_RETRIES + 1);
  });

  it('passes any other answer straight back', async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const res = await fetchWaitingOut429(
      async () => new Response(null, { status: 404 }),
      'https://x/op',
      {},
      sleep,
    );
    expect(res.status).toBe(404);
    expect(sleep).not.toHaveBeenCalled();
  });
});
