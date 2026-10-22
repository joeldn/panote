import { planKey, planPrefix, pubTourKey, tourKey, TourPlanSchema } from '@internal/contracts';
import { getJson } from '@internal/worker-kit/r2-binding';

// Tour floor-plan images (pub/plans/<tourId>/<planId>.<ext>, contracts keys.ts). upload-api
// presigns each upload to a fresh key, so these clean up after it: the whole prefix goes
// with the tour, and an image nothing uses any more goes on the tour's next save. The
// prefix is owner-free: callers only get here once the owner's own tour.json is proven.

// An upload URL lives 10 minutes (upload-api's UPLOAD_URL_EXPIRY_SECONDS); an image this
// young may be one the editor has uploaded but not saved yet, so the sweep leaves it. An
// older one only an unsaved draft holds can go (docs/decisions.md, plan images).
export const PLAN_SWEEP_GRACE_MS = 60 * 60 * 1000;

// The image key a stored tour or bundle names, if its plan reads as one.
const storedKey = (tourId: string, plan: unknown): string | null => {
  const parsed = TourPlanSchema.safeParse(plan);
  return parsed.success ? planKey(tourId, parsed.data.id, parsed.data.type) : null;
};

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

// A tour has one live plan and a few replaced ones; this many pages (1000 keys each) is far
// past that, and anything beyond waits for the next save.
export const PLAN_SWEEP_MAX_PAGES = 10;

/**
 * After the owner's tour save: deletes the tour's plan images that neither the tour.json now
 * stored nor its live share link uses, once they are past the upload grace period. Reads the
 * stored state, not the request, so a later save's plan is never taken for a stale one.
 * Returns the deleted keys, to purge from the CDN.
 */
export const sweepPlans = async (
  bucket: R2Bucket,
  sub: string,
  tourId: string,
  now: number,
): Promise<string[]> => {
  let keep: Set<string | null> | null = null;
  const gone: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < PLAN_SWEEP_MAX_PAGES; page += 1) {
    const listed = await bucket.list({
      prefix: planPrefix(tourId),
      ...(cursor ? { cursor } : {}),
    });
    const old = listed.objects
      .filter((o) => now - o.uploaded.getTime() > PLAN_SWEEP_GRACE_MS)
      .map((o) => o.key);
    // Only read the tour and its bundle when something is old enough to go: the share link
    // may still show the previous plan until the publish that follows the save.
    if (old.length && !keep) {
      const [tour, bundle] = await Promise.all([
        getJson<{ plan?: unknown }>(bucket, tourKey(sub, tourId)),
        getJson<{ plan?: unknown }>(bucket, pubTourKey(tourId)),
      ]);
      // Deleted since the save: the tour's delete takes its images.
      if (!tour) return gone;
      keep = new Set([storedKey(tourId, tour.value.plan), storedKey(tourId, bundle?.value.plan)]);
    }
    const stale = old.filter((k) => !keep?.has(k));
    if (stale.length) await bucket.delete(stale);
    gone.push(...stale);
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
  return gone;
};
