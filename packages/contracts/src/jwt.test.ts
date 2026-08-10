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
});
