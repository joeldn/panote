import { describe, it, expect } from 'vitest';
import { configKey, originalKey, userPanosPrefix, parseOwnerFromKey } from './keys.js';

describe('keys', () => {
  it('builds a config key with encoded user', () => {
    expect(configKey('auth0|abc', 'p1')).toBe('panos/auth0%7Cabc/p1/config.json');
  });
  it('builds a list prefix', () => {
    expect(userPanosPrefix('auth0|abc')).toBe('panos/auth0%7Cabc/');
  });
  it('round-trips owner from an original key', () => {
    expect(parseOwnerFromKey(originalKey('auth0|abc', 'p1'))).toEqual({
      userId: 'auth0|abc',
      panoId: 'p1',
    });
  });
  it('returns null for an unrelated key', () => {
    expect(parseOwnerFromKey('tours/x/y/tour.json')).toBeNull();
  });
});
