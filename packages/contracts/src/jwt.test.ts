import { describe, it, expect } from 'vitest';
import { assertClaims } from './jwt.js';

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
