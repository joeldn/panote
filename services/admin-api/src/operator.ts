import { accountDisabledKey, PANO_PATTERN, publishKey, tourKey } from '@internal/contracts';

// Helpers for the operator-only takedown route (OPERATOR_TAKEDOWN_PATH in
// index.ts; scripts/takedown.ts, "Takedown" in docs/deploy.md). It needs no
// Auth0 user: the OPERATOR_TOKEN secret is the whole guard, and with no secret
// set the route doesn't exist.

/** True while the operator has the owner disabled: every owner write is refused (403). */
export const isAccountDisabled = async (bucket: R2Bucket, sub: string): Promise<boolean> =>
  !!(await bucket.head(accountDisabledKey(sub)));

const encoder = new TextEncoder();
const sha256 = async (s: string): Promise<ArrayBuffer> =>
  crypto.subtle.digest('SHA-256', encoder.encode(s));

/**
 * Constant-time check of the operator header against the secret. Both sides are
 * hashed first, so timingSafeEqual always compares equal lengths. False when the
 * secret isn't set (or is blank): an unconfigured env has no operator route.
 */
export const isOperator = async (
  secret: string | undefined,
  presented: string | undefined,
): Promise<boolean> => {
  if (!secret?.trim() || presented === undefined) return false;
  const [a, b] = await Promise.all([sha256(secret), sha256(presented)]);
  return crypto.subtle.timingSafeEqual(a, b);
};

/** Whether the owner still has the tour, published or not. */
export const tourExists = async (
  bucket: R2Bucket,
  sub: string,
  tourId: string,
): Promise<boolean> => {
  if (!PANO_PATTERN.test(tourId)) return false;
  const [tour, record] = await Promise.all([
    bucket.head(tourKey(sub, tourId)),
    bucket.head(publishKey(sub, tourId)),
  ]);
  return !!tour || !!record;
};
