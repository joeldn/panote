import {
  accountDisabledKey,
  PANO_PATTERN,
  publishKey,
  tourKey,
  tourOwnerKey,
  type TourOwnerRecord,
} from '@internal/contracts';
import { getJson, putJson } from '@internal/worker-kit/r2-binding';

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

/**
 * Writes the tour's owner pointer (tourOwnerKey) for the takedown script, create-only:
 * a tourId is only ever one owner's, so an existing pointer is already right.
 * Best-effort: it runs after a create or publish has succeeded, and a failure only
 * logs, since the script falls back to scanning owners without it. A publish racing a
 * delete can leave an orphan pointer to a tour that's gone; harmless, because the
 * script checks the owner still holds the tour before trusting it.
 */
export const recordTourOwner = async (
  bucket: R2Bucket,
  sub: string,
  tourId: string,
): Promise<void> => {
  const record: TourOwnerRecord = { v: 1, sub };
  try {
    await putJson(bucket, tourOwnerKey(tourId), record, { etagDoesNotMatch: '*' });
  } catch (e) {
    // The name only: R2 error messages can carry keys, and this record holds the sub.
    console.error(
      `[takedown] owner pointer for tour ${tourId} not written:`,
      e instanceof Error ? e.name : 'unknown error',
    );
  }
};

/**
 * Removes the owner pointer for a tour that has no tour.json (a publish-only leftover),
 * but only if it names this owner: anyone can DELETE any tourId, and must not clear
 * another owner's pointer by doing so.
 */
export const forgetTourOwner = async (
  bucket: R2Bucket,
  sub: string,
  tourId: string,
): Promise<void> => {
  const got = await getJson<TourOwnerRecord>(bucket, tourOwnerKey(tourId)).catch(() => null);
  if (got?.value.sub === sub) await bucket.delete(tourOwnerKey(tourId));
};
