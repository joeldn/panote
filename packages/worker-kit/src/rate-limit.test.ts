import { afterEach, describe, expect, it, vi } from 'vitest';

import { rateLimit, type RateLimiter } from './rate-limit.js';

const limiter = (
  impl: RateLimiter['limit'],
): RateLimiter & { limit: ReturnType<typeof vi.fn> } => ({
  limit: vi.fn(impl),
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('rateLimit', () => {
  it('lets the request through while the key is under its limit', async () => {
    const l = limiter(async () => ({ success: true }));
    expect(await rateLimit(l, 'k', 60)).toBeNull();
    expect(l.limit).toHaveBeenCalledWith({ key: 'k' });
  });

  it('answers 429 with Retry-After once the key is over it', async () => {
    const res = await rateLimit(
      limiter(async () => ({ success: false })),
      'k',
      10,
    );
    expect(res?.status).toBe(429);
    expect(res?.headers.get('Retry-After')).toBe('10');
    expect(await res?.json()).toEqual({ error: 'rate limited' });
  });

  it('fails open, and logs, when the limiter itself errors', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await rateLimit(
      limiter(async () => {
        throw new Error('down');
      }),
      'k',
      60,
    );
    expect(res).toBeNull();
    expect(log).toHaveBeenCalledWith('rate limiter unavailable:', 'down');
  });
});
