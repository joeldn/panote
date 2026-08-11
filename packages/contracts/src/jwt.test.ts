import { describe, it, expect, vi, afterEach } from 'vitest';
import { assertClaims, fetchJwks, DEFAULT_JWKS_TIMEOUT_MS } from './jwt.js';

describe('assertClaims', () => {
  const base = {
    sub: 'auth0|abc',
    iss: 'https://x/',
    aud: 'api',
    exp: 9999999999,
  };
  it('passes for matching iss/aud and future exp', () => {
    expect(assertClaims(base, { issuer: 'https://x/', audience: 'api' }).sub).toBe('auth0|abc');
  });
  it('throws on wrong audience', () => {
    expect(() => assertClaims(base, { issuer: 'https://x/', audience: 'other' })).toThrow();
  });
  it('throws on expired token', () => {
    expect(() =>
      assertClaims({ ...base, exp: 1 }, { issuer: 'https://x/', audience: 'api' }),
    ).toThrow();
  });
  it('fails closed when exp is missing, instead of treating the token as never-expiring', () => {
    // c is an unchecked `as Claims` cast from a JSON.parse'd payload in
    // verifyJwt, so a real caller can hand assertClaims an object shaped like
    // this. Without the exp guard, `undefined * 1000 <= Date.now()` is
    // `NaN <= Date.now()`, which is always false, so the expiry check would
    // silently pass.
    const { exp: _exp, ...noExp } = base;
    expect(() =>
      assertClaims(noExp as unknown as Parameters<typeof assertClaims>[0], {
        issuer: 'https://x/',
        audience: 'api',
      }),
    ).toThrow(/exp/);
  });
  it('fails closed when exp is a non-numeric value', () => {
    expect(() =>
      assertClaims({ ...base, exp: 'soon' } as unknown as Parameters<typeof assertClaims>[0], {
        issuer: 'https://x/',
        audience: 'api',
      }),
    ).toThrow(/exp/);
  });
});

describe('fetchJwks', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the keys from a well-shaped response', async () => {
    const keys = [{ kid: 'k1', kty: 'RSA', n: 'n', e: 'AQAB' }];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ keys }) })),
    );
    expect(await fetchJwks('https://issuer/')).toEqual(keys);
  });

  it('rejects a response whose keys are missing required fields, instead of returning a broken key silently', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        // missing n/e/kty -- a downstream crypto.subtle.importKey failure
        // for this would be far less clear than failing right here.
        json: async () => ({ keys: [{ kid: 'k1' }] }),
      })),
    );
    await expect(fetchJwks('https://issuer/')).rejects.toThrow(/unexpected shape/);
  });

  it('rejects a response that is not a JWKS at all (e.g. an HTML error page parsed as JSON, or the wrong endpoint)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ notKeys: [] }) })),
    );
    await expect(fetchJwks('https://issuer/')).rejects.toThrow(/unexpected shape/);
  });

  it('passes an AbortSignal to fetch so a hanging issuer endpoint cannot stall the caller indefinitely', async () => {
    const fetchSpy = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(new DOMException('aborted', 'AbortError'));
            return;
          }
          signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    // A tiny real timeout, not a mocked one: proves the signal fetchJwks
    // hands to fetch is a genuine AbortSignal.timeout() that actually fires,
    // not just an object shaped like one.
    await expect(fetchJwks('https://issuer/', { timeoutMs: 20 })).rejects.toThrow();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, { signal?: AbortSignal }];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('defaults to DEFAULT_JWKS_TIMEOUT_MS when no timeoutMs is given', async () => {
    expect(DEFAULT_JWKS_TIMEOUT_MS).toBeGreaterThan(0);
    let capturedSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
        capturedSignal = init?.signal;
        return Promise.resolve({ ok: true, json: async () => ({ keys: [] }) });
      }),
    );
    await fetchJwks('https://issuer/');
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });
});
