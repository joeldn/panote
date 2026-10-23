import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  assertClaims,
  AUTH_TIME_CLAIM,
  EMAIL_CLAIM,
  fetchJwks,
  DEFAULT_JWKS_TIMEOUT_MS,
  LINKED_SUBS_CLAIM,
  MAX_LINKED_SUBS,
} from './jwt.js';

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

describe('assertClaims: machine-to-machine tokens', () => {
  const opts = { issuer: 'https://x/', audience: 'api' };
  const base = { sub: 'auth0|abc', iss: 'https://x/', aud: 'api', exp: 9999999999 };

  it('rejects a client-credentials grant', () => {
    expect(() =>
      assertClaims({ ...base, sub: 'abc123@clients', gty: 'client-credentials' }, opts),
    ).toThrow(/client-credentials/);
  });

  it('rejects a client-credentials gty even with a user-looking sub', () => {
    expect(() => assertClaims({ ...base, gty: 'client-credentials' }, opts)).toThrow(
      /client-credentials/,
    );
  });

  it('rejects an M2M sub even without gty', () => {
    expect(() => assertClaims({ ...base, sub: 'abc123@clients' }, opts)).toThrow(
      /client-credentials/,
    );
  });

  it('accepts a user token with another grant type (a refresh-token exchange)', () => {
    expect(assertClaims({ ...base, gty: 'refresh_token' }, opts)).toEqual({ sub: 'auth0|abc' });
  });

  it('rejects a non-string sub', () => {
    expect(() =>
      assertClaims({ ...base, sub: 42 } as unknown as Parameters<typeof assertClaims>[0], opts),
    ).toThrow(/subject/);
  });
});

describe('assertClaims: Panote custom claims', () => {
  const opts = { issuer: 'https://x/', audience: 'api' };
  const base = { sub: 'google-oauth2|1', iss: 'https://x/', aud: 'api', exp: 9999999999 };

  it('has no authTime or linkedSubs when the Action added none', () => {
    expect(assertClaims(base, opts)).toEqual({ sub: 'google-oauth2|1' });
  });

  it('reads the sign-in time', () => {
    expect(assertClaims({ ...base, [AUTH_TIME_CLAIM]: 1_800_000_000 }, opts).authTime).toBe(
      1_800_000_000,
    );
  });

  it.each([
    ['a string', '1800000000'],
    ['NaN', Number.NaN],
    ['zero', 0],
    ['negative', -5],
  ])('ignores a sign-in time that is %s', (_label, v) => {
    expect(assertClaims({ ...base, [AUTH_TIME_CLAIM]: v }, opts).authTime).toBeUndefined();
  });

  it('reads linked subs, dropping malformed entries, duplicates and the sub itself', () => {
    const claims = assertClaims(
      {
        ...base,
        [LINKED_SUBS_CLAIM]: [
          'email|abc',
          'email|abc',
          'google-oauth2|1',
          'no-provider',
          'has space|x',
          42,
          `apple|${'x'.repeat(300)}`,
          'apple|001.abc',
        ],
      },
      opts,
    );
    expect(claims.linkedSubs).toEqual(['email|abc', 'apple|001.abc']);
  });

  it(`keeps at most ${MAX_LINKED_SUBS} linked subs`, () => {
    const many = Array.from({ length: MAX_LINKED_SUBS + 5 }, (_, i) => `email|${i}`);
    expect(assertClaims({ ...base, [LINKED_SUBS_CLAIM]: many }, opts).linkedSubs).toEqual(
      many.slice(0, MAX_LINKED_SUBS),
    );
  });

  it('ignores a linked-subs claim that is not a list', () => {
    expect(
      assertClaims({ ...base, [LINKED_SUBS_CLAIM]: 'email|abc' }, opts).linkedSubs,
    ).toBeUndefined();
  });

  it('reads the verified email', () => {
    expect(assertClaims({ ...base, [EMAIL_CLAIM]: 'maya@example.com' }, opts).email).toBe(
      'maya@example.com',
    );
  });

  it.each([
    ['not a string', 42],
    ['not lower case', 'Maya@example.com'],
    ['padded', ' maya@example.com'],
    ['without an @', 'maya.example.com'],
    ['with two @', 'a@b@example.com'],
    ['too long', `${'a'.repeat(250)}@x.io`],
  ])('drops an email that is %s, and keeps the user', (_label, v) => {
    expect(assertClaims({ ...base, [EMAIL_CLAIM]: v }, opts)).toEqual({ sub: 'google-oauth2|1' });
  });

  it('ignores an un-namespaced email claim', () => {
    expect(assertClaims({ ...base, email: 'maya@example.com' }, opts).email).toBeUndefined();
  });

  it('keeps the claim names the Auth0 Action sets', () => {
    // packages/auth0-actions/src/link-accounts.cjs has its own copy: change both together.
    expect(AUTH_TIME_CLAIM).toBe('https://panote.io/auth_time');
    expect(LINKED_SUBS_CLAIM).toBe('https://panote.io/linked_subs');
    expect(EMAIL_CLAIM).toBe('https://panote.io/email');
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
