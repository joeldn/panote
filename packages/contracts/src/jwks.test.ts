import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeJwksLoader, verifyWithRotation } from './jwks.js';

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const b64urlStr = (s: string): string => b64url(new TextEncoder().encode(s));

/** Mint a genuinely RS256-signed token plus the public JWK that verifies it. */
async function makeSignedToken(
  claims: Record<string, unknown>,
): Promise<{ token: string; jwk: Record<string, unknown> }> {
  const kp = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const kid = 'test-key';
  const header = b64urlStr(JSON.stringify({ alg: 'RS256', kid }));
  const payload = b64urlStr(JSON.stringify(claims));
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, data));
  return {
    token: `${header}.${payload}.${b64url(sig)}`,
    jwk: { kid, kty: 'RSA', n: pub.n, e: pub.e, alg: 'RS256' },
  };
}

describe('makeJwksLoader', () => {
  const keys = [{ kid: 'k1', kty: 'RSA', n: 'n', e: 'AQAB' }];
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ keys }) }));
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('caches within the TTL and force-refetches on demand once past the forced-refetch interval', async () => {
    // minForceIntervalMs: 0 opts out of the throttle below, isolating "does
    // force actually refetch at all" from "is a forced refetch throttled".
    const loader = makeJwksLoader('https://issuer/', 1000, 0);
    expect(await loader.get()).toEqual(keys);
    await loader.get();
    expect(fetchSpy).toHaveBeenCalledTimes(1); // served from cache
    await loader.get(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // forced refetch
  });

  it('refetches after the TTL expires', async () => {
    vi.useFakeTimers();
    const loader = makeJwksLoader('https://issuer/', 1000);
    await loader.get();
    vi.advanceTimersByTime(1500);
    await loader.get();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('throttles forced refetches within the minimum interval', async () => {
    // Simulates a stream of tokens with random, unknown `kid`s each forcing
    // a refetch via verifyWithRotation -- none of them should reach fetchJwks
    // again until the minimum interval has passed.
    const loader = makeJwksLoader('https://issuer/', 1_000_000, 60_000);
    await loader.get();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await loader.get(true);
    await loader.get(true);
    await loader.get(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('honours a forced refetch again once the minimum interval has elapsed', async () => {
    vi.useFakeTimers();
    const loader = makeJwksLoader('https://issuer/', 1_000_000, 1000);
    await loader.get();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1500);
    await loader.get(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent callers onto a single in-flight fetch', async () => {
    const loader = makeJwksLoader('https://issuer/', 1000);
    const [a, b, c] = await Promise.all([loader.get(), loader.get(), loader.get()]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(a).toEqual(keys);
    expect(b).toEqual(keys);
    expect(c).toEqual(keys);
  });

  it('forwards a custom timeoutMs to fetchJwks without disturbing caching', async () => {
    // makeJwksLoader's 4th param threads through to fetchJwks's AbortSignal
    // timeout. This only checks the wiring (a real signal reaches fetch) and
    // that caching still collapses repeat calls to one fetch -- fetchJwks's
    // own test suite (jwt.test.ts) covers the abort actually firing.
    const loader = makeJwksLoader('https://issuer/', 1000, 60_000, 250);
    await loader.get();
    await loader.get();
    expect(fetchSpy).toHaveBeenCalledTimes(1); // still served from cache
    const [, init] = fetchSpy.mock.calls[0] as [string, { signal?: AbortSignal }];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('verifyWithRotation', () => {
  it('refetches JWKS once on an unknown kid and verifies with the rotated key', async () => {
    const { token, jwk } = await makeSignedToken({
      sub: 'auth0|me',
      iss: 'https://issuer/',
      aud: 'api',
      exp: 9999999999,
    });
    const get = vi
      .fn()
      .mockResolvedValueOnce([]) // stale cache: rotated kid absent
      .mockResolvedValueOnce([jwk]); // forced refetch: new key present
    const res = await verifyWithRotation(token, {
      issuer: 'https://issuer/',
      audience: 'api',
      loader: { get },
    });
    expect(res.sub).toBe('auth0|me');
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenLastCalledWith(true);
  });

  it('does not refetch on a non-kid failure (e.g. bad audience)', async () => {
    const { token, jwk } = await makeSignedToken({
      sub: 'x',
      iss: 'https://issuer/',
      aud: 'api',
      exp: 9999999999,
    });
    const get = vi.fn().mockResolvedValue([jwk]);
    await expect(
      verifyWithRotation(token, {
        issuer: 'https://issuer/',
        audience: 'WRONG',
        loader: { get },
      }),
    ).rejects.toThrow('bad audience');
    expect(get).toHaveBeenCalledTimes(1);
  });
});
