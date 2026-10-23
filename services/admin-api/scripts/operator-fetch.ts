// The operator scripts' calls to admin-api's operator routes, which OPERATOR_LIMITER caps per
// client IP (docs/deploy.md, Rate limits). A long run (a restore of thousands of keys, a
// takedown --all-tours) can pass that limit: a 429 is waited out and the request sent again.

/** How many times one request is sent again after a 429 before the 429 is returned. */
export const OPERATOR_429_RETRIES = 5;
// Longest wait for one 429, whatever its Retry-After says.
const MAX_WAIT_SECONDS = 300;
// When a 429 has no usable Retry-After: the limiter's period.
const DEFAULT_WAIT_SECONDS = 60;

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `fetchFn(input, init)`, sent again after each 429's Retry-After, at most OPERATOR_429_RETRIES times. */
export async function fetchWaitingOut429(
  fetchFn: (input: string, init: RequestInit) => Promise<Response>,
  input: string,
  init: RequestInit,
  sleep: Sleep = realSleep,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetchFn(input, init);
    if (res.status !== 429 || attempt >= OPERATOR_429_RETRIES) return res;
    const after = Number(res.headers.get('Retry-After'));
    const seconds = Number.isFinite(after) && after > 0 ? after : DEFAULT_WAIT_SECONDS;
    await sleep(Math.min(seconds, MAX_WAIT_SECONDS) * 1000);
  }
}
