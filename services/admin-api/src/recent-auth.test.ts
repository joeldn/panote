import { RECENT_AUTH_MAX_AGE_SECONDS } from '@internal/contracts';
import { describe, expect, it } from 'vitest';

import { isRecentAuth, requiresRecentAuth } from './recent-auth.js';

describe('isRecentAuth', () => {
  const now = Date.parse('2026-10-23T00:00:00.000Z');
  const secondsAgo = (s: number) => now / 1000 - s;

  it('accepts a sign-in up to RECENT_AUTH_MAX_AGE_SECONDS ago', () => {
    expect(isRecentAuth(secondsAgo(0), now)).toBe(true);
    expect(isRecentAuth(secondsAgo(RECENT_AUTH_MAX_AGE_SECONDS), now)).toBe(true);
    expect(isRecentAuth(secondsAgo(RECENT_AUTH_MAX_AGE_SECONDS + 1), now)).toBe(false);
  });

  it('allows a minute of clock skew into the future, no more', () => {
    expect(isRecentAuth(secondsAgo(-60), now)).toBe(true);
    expect(isRecentAuth(secondsAgo(-61), now)).toBe(false);
  });

  it('refuses a token that does not say', () => {
    expect(isRecentAuth(undefined, now)).toBe(false);
  });
});

describe('requiresRecentAuth', () => {
  it('is on unless the var is exactly "false"', () => {
    expect(requiresRecentAuth({ REQUIRE_RECENT_AUTH: 'true' })).toBe(true);
    expect(requiresRecentAuth({})).toBe(true);
    expect(requiresRecentAuth({ REQUIRE_RECENT_AUTH: 'FALSE' })).toBe(true);
    expect(requiresRecentAuth({ REQUIRE_RECENT_AUTH: 'false' })).toBe(false);
  });
});
