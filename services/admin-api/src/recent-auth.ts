import { RECENT_AUTH_MAX_AGE_SECONDS } from '@internal/contracts';

// Auth0's clock against the Worker's: a sign-in time this far ahead still counts.
const CLOCK_SKEW_SECONDS = 60;

/**
 * Whether account delete wants a recent sign-in. On unless the env's
 * REQUIRE_RECENT_AUTH var is exactly "false", the escape hatch for a tenant whose
 * Auth0 Action doesn't add the sign-in time yet (docs/deploy.md, "Account deletion").
 */
export const requiresRecentAuth = (env: { REQUIRE_RECENT_AUTH?: string }): boolean =>
  env.REQUIRE_RECENT_AUTH !== 'false';

/** True when `authTime` (epoch seconds, from the token) is within RECENT_AUTH_MAX_AGE_SECONDS. */
export const isRecentAuth = (authTime: number | undefined, nowMs: number): boolean => {
  if (authTime === undefined) return false;
  const age = nowMs / 1000 - authTime;
  return age <= RECENT_AUTH_MAX_AGE_SECONDS && age >= -CLOCK_SKEW_SECONDS;
};
