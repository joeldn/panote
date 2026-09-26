import { tourKey, userToursPrefix, type TourDoc } from '@internal/contracts';
import { getJson, listChildren } from '@internal/worker-kit/r2-binding';

import { deletePano } from './delete-pano.js';

const REFERENCE_CONCURRENCY = 8;

const referencedPanoIds = async (
  bucket: R2Bucket,
  sub: string,
  excludeTourId: string,
): Promise<Set<string>> => {
  const otherTourIds = (await listChildren(bucket, userToursPrefix(sub))).filter(
    (id) => id !== excludeTourId,
  );
  const referenced = new Set<string>();
  for (let i = 0; i < otherTourIds.length; i += REFERENCE_CONCURRENCY) {
    const batch = otherTourIds.slice(i, i + REFERENCE_CONCURRENCY);
    await Promise.all(
      batch.map(async (tourId) => {
        const other = await getJson<TourDoc>(bucket, tourKey(sub, tourId));
        for (const scene of other?.value.scenes ?? []) referenced.add(scene.panoId);
      }),
    );
  }
  return referenced;
};

/**
 * Q5: deletes the tour, plus any of its own panos that no *other* tour of
 * the same owner still references (a pano shared with another tour is left
 * untouched). Idempotent: a tourId that doesn't exist is a no-op.
 *
 * Deletes tour.json LAST, after the pano fan-out - a deliberate reorder from
 * the plan's listed step order (written for the full B2 pipeline this unit
 * doesn't include): a crash-then-retry needs `own` to recompute which panos
 * still need deleting, which a tour.json deleted first would prevent.
 */
export const deleteTour = async (bucket: R2Bucket, sub: string, tourId: string): Promise<void> => {
  const own = await getJson<TourDoc>(bucket, tourKey(sub, tourId));
  if (!own) return;
  const referenced = await referencedPanoIds(bucket, sub, tourId);
  const ownPanoIds = [...new Set(own.value.scenes.map((s) => s.panoId))];
  for (let i = 0; i < ownPanoIds.length; i += REFERENCE_CONCURRENCY) {
    const batch = ownPanoIds.slice(i, i + REFERENCE_CONCURRENCY);
    await Promise.all(
      batch.map(async (panoId) => {
        if (!referenced.has(panoId)) await deletePano(bucket, sub, panoId);
      }),
    );
  }
  await bucket.delete(tourKey(sub, tourId));
};
