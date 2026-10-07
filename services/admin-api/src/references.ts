import {
  publishKey,
  pubTourKey,
  tourKey,
  userToursPrefix,
  type PublishedTour,
  type TourDoc,
} from '@internal/contracts';
import { getJson, listChildren } from '@internal/worker-kit/r2-binding';

export const REFERENCE_CONCURRENCY = 8;

// The scenes a tour serves publicly. A failed publish (422, not-ready, a lost
// slug, a dropped request) leaves the last bundle live, so it can still use a
// pano the draft tour.json has since dropped. pub/ is owner-free, so the
// owner's publish.json is the proof that this tourId's bundle is theirs.
const publishedPanoIds = async (
  bucket: R2Bucket,
  sub: string,
  tourId: string,
): Promise<string[]> => {
  if (!(await bucket.head(publishKey(sub, tourId)))) return [];
  const bundle = await getJson<Partial<PublishedTour>>(bucket, pubTourKey(tourId));
  const scenes = bundle?.value.scenes;
  if (!Array.isArray(scenes)) return [];
  return scenes.map((s) => s?.panoId).filter((id): id is string => typeof id === 'string');
};

/** Q5: every panoId the owner's tours use, in the draft tour.json or in the
 * live published bundle. customMetadata only carries the cover, so both are
 * read. `excludeTourId` leaves out a tour that is being deleted (its bundle
 * is unpublished first). */
export const referencedPanoIds = async (
  bucket: R2Bucket,
  sub: string,
  excludeTourId?: string,
): Promise<Set<string>> => {
  const tourIds = (await listChildren(bucket, userToursPrefix(sub))).filter(
    (id) => id !== excludeTourId,
  );
  const referenced = new Set<string>();
  for (let i = 0; i < tourIds.length; i += REFERENCE_CONCURRENCY) {
    const batch = tourIds.slice(i, i + REFERENCE_CONCURRENCY);
    await Promise.all(
      batch.map(async (tourId) => {
        const [tour, published] = await Promise.all([
          getJson<TourDoc>(bucket, tourKey(sub, tourId)),
          publishedPanoIds(bucket, sub, tourId),
        ]);
        for (const scene of tour?.value.scenes ?? []) referenced.add(scene.panoId);
        for (const panoId of published) referenced.add(panoId);
      }),
    );
  }
  return referenced;
};
