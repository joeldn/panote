import { tourKey, userToursPrefix, type TourDoc } from '@internal/contracts';
import { getJson, listChildren } from '@internal/worker-kit/r2-binding';

export const REFERENCE_CONCURRENCY = 8;

/** Q5: every panoId a scene of the owner's tours uses, read from each
 * tour.json (customMetadata only carries the cover). `excludeTourId` leaves
 * out a tour that is being deleted. */
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
        const tour = await getJson<TourDoc>(bucket, tourKey(sub, tourId));
        for (const scene of tour?.value.scenes ?? []) referenced.add(scene.panoId);
      }),
    );
  }
  return referenced;
};
