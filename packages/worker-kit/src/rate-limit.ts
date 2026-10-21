// The Workers Rate Limiting binding (`ratelimits` in wrangler.jsonc). Structural,
// so node tests can pass a fake; the generated `RateLimit` type satisfies it.
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * A 429 with Retry-After when `key` is over its limit, else null. The binding
 * is per-location and eventually consistent, a brake rather than an exact
 * count, so an error from it lets the request through (logged) instead of
 * turning a limiter outage into an API outage. `retryAfterSeconds` should be
 * the binding's `simple.period`: the binding doesn't say when a window resets.
 */
export const rateLimit = async (
  limiter: RateLimiter,
  key: string,
  retryAfterSeconds: number,
): Promise<Response | null> => {
  let success: boolean;
  try {
    ({ success } = await limiter.limit({ key }));
  } catch (e) {
    console.error('rate limiter unavailable:', e instanceof Error ? e.message : e);
    return null;
  }
  if (success) return null;
  return Response.json(
    { error: 'rate limited' },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } },
  );
};
