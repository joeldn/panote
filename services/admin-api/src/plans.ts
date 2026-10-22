import {
  planKey,
  planPrefix,
  pubTourKey,
  TourPlanSchema,
  type TourPlan,
} from '@internal/contracts';
import { getJson } from '@internal/worker-kit/r2-binding';

// Tour floor-plan images (pub/plans/<tourId>/<planId>.<ext>, contracts keys.ts). upload-api
// presigns each upload to a fresh key, so these clean up after it: the whole prefix goes
// with the tour, and an image nothing uses any more goes on the tour's next save.

// One live plan per tour, plus a replaced one now and then: a single page lists them all.
// An upload URL lives 10 minutes (upload-api's UPLOAD_URL_EXPIRY_SECONDS); an image this
// young may be one the editor has uploaded but not saved yet, so the sweep leaves it.
export const PLAN_SWEEP_GRACE_MS = 60 * 60 * 1000;

const keyOf = (tourId: string, plan: TourPlan | undefined): string | null =>
  plan ? planKey(tourId, plan.id, plan.type) : null;

/** Deletes every plan image of the tour; returns their keys, to purge from the CDN. */
export const deletePlans = async (bucket: R2Bucket, tourId: string): Promise<string[]> => {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const r = await bucket.list({ prefix: planPrefix(tourId), ...(cursor ? { cursor } : {}) });
    const page = r.objects.map((o) => o.key);
    if (page.length) await bucket.delete(page);
    keys.push(...page);
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  return keys;
};

/**
 * After a tour save: deletes the tour's plan images that neither the saved tour nor its
 * live share link uses, once they are past the upload grace period. Returns the deleted
 * keys, to purge from the CDN.
 */
export const sweepPlans = async (
  bucket: R2Bucket,
  tourId: string,
  saved: TourPlan | undefined,
  now: number,
): Promise<string[]> => {
  const listed = await bucket.list({ prefix: planPrefix(tourId) });
  const keep = new Set([keyOf(tourId, saved)]);
  const stale = () =>
    listed.objects.filter(
      (o) => !keep.has(o.key) && now - o.uploaded.getTime() > PLAN_SWEEP_GRACE_MS,
    );
  // Only read the bundle when there's something to delete: the share link may still
  // show the previous plan until the publish that follows the save.
  if (stale().length === 0) return [];
  const bundle = await getJson<{ plan?: unknown }>(bucket, pubTourKey(tourId));
  const live = TourPlanSchema.safeParse(bundle?.value.plan);
  if (live.success) keep.add(keyOf(tourId, live.data));
  const gone = stale().map((o) => o.key);
  if (gone.length) await bucket.delete(gone);
  return gone;
};
