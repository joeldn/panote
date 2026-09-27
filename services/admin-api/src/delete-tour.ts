import { tilesPrefix, tourKey, userToursPrefix, type TourDoc } from '@internal/contracts';
import { getJson, listChildren } from '@internal/worker-kit/r2-binding';

import { deletePano } from './delete-pano.js';
import { mergePurges, type CdnPurge } from './purge.js';

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

const deleteUnreferenced = async (
  bucket: R2Bucket,
  sub: string,
  panoIds: readonly string[],
  referenced: Set<string>,
  purgePrefixes: string[],
): Promise<string[]> => {
  const stillReferenced: string[] = [];
  for (let i = 0; i < panoIds.length; i += REFERENCE_CONCURRENCY) {
    const batch = panoIds.slice(i, i + REFERENCE_CONCURRENCY);
    await Promise.all(
      batch.map(async (panoId) => {
        if (referenced.has(panoId)) stillReferenced.push(panoId);
        else if ((await deletePano(bucket, sub, panoId)).tilesDeleted) {
          purgePrefixes.push(tilesPrefix(panoId));
        }
      }),
    );
  }
  return stillReferenced;
};

// Q5: deletes the tour and its unshared panos; idempotent, tour.json last. `unpublishTour`
// must go through the TourPublisher. Returns what to purge from the CDN, in one batch (B6).
export const deleteTour = async (
  bucket: R2Bucket,
  sub: string,
  tourId: string,
  unpublishTour: () => Promise<string[]>,
): Promise<CdnPurge> => {
  // Unpublish first so a deleted tour never stays public, even on a partial delete.
  const files = await unpublishTour();
  const prefixes: string[] = [];
  const result = (): CdnPurge => mergePurges({ prefixes, files });
  // TOCTOU: a concurrent save can add a scene referencing a pano deleted here; the editor shows "Missing pano" for it, the same as any other missing config.
  const own = await getJson<TourDoc>(bucket, tourKey(sub, tourId));
  if (!own) return result();
  const ownPanoIds = [...new Set(own.value.scenes.map((s) => s.panoId))];

  const referenced = await referencedPanoIds(bucket, sub, tourId);
  const deferred = await deleteUnreferenced(bucket, sub, ownPanoIds, referenced, prefixes);
  await bucket.delete(tourKey(sub, tourId));
  // Again: a publish serialized before this point may have re-published it.
  files.push(...(await unpublishTour()));

  // Recheck after this tour.json is gone: catches the common 2-tour race
  // (see PR body); a rarer 3+-way overlap can still leak storage, not safety.
  if (deferred.length === 0) return result();
  const referencedAfter = await referencedPanoIds(bucket, sub, tourId);
  await deleteUnreferenced(bucket, sub, deferred, referencedAfter, prefixes);
  return result();
};
