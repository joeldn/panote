import {
  isContentId,
  LENT_PANOS_ROOT,
  LentPanosSchema,
  publishKey,
  pubTourKey,
  tourKey,
  tourTransferKey,
  userLentPanosPrefix,
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
const bundlePanoIds = async (bucket: R2Bucket, tourId: string): Promise<string[]> => {
  const bundle = await getJson<Partial<PublishedTour>>(bucket, pubTourKey(tourId));
  const scenes = bundle?.value.scenes;
  if (!Array.isArray(scenes)) return [];
  return scenes.map((s) => s?.panoId).filter((id): id is string => typeof id === 'string');
};

const publishedPanoIds = async (
  bucket: R2Bucket,
  sub: string,
  tourId: string,
): Promise<string[]> => {
  if (!(await bucket.head(publishKey(sub, tourId)))) return [];
  return bundlePanoIds(bucket, tourId);
};

/**
 * The owner's panos that tours they handed on still use (lent-panos/, transfer.ts): all
 * of a tour's while its transfer runs, then those its live bundle names, until the new
 * owner's next publish (or unpublish, or delete) drops them. The daily sweep removes a
 * record that protects nothing any more (dropSpentLoans).
 */
export const lentPanoIds = async (
  bucket: R2Bucket,
  sub: string,
  excludeTourId?: string,
): Promise<Set<string>> => {
  const prefix = userLentPanosPrefix(sub);
  const tourIds: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const o of page.objects) tourIds.push(o.key.slice(prefix.length, -'.json'.length));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const lent = new Set<string>();
  await Promise.all(
    tourIds
      .filter((id) => id !== excludeTourId)
      .map(async (tourId) => {
        const got = await getJson<unknown>(bucket, `${prefix}${tourId}.json`);
        const rec = LentPanosSchema.safeParse(got?.value);
        if (!rec.success) return;
        if (await bucket.head(tourTransferKey(tourId))) {
          for (const id of rec.data.panoIds) lent.add(id);
          return;
        }
        const live = new Set(await bundlePanoIds(bucket, tourId));
        for (const id of rec.data.panoIds) if (live.has(id)) lent.add(id);
      }),
  );
  return lent;
};

/** The daily sweep's part: deletes every lent-panos record that protects nothing. */
export const dropSpentLoans = async (bucket: R2Bucket): Promise<void> => {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: LENT_PANOS_ROOT, ...(cursor ? { cursor } : {}) });
    for (const { key } of page.objects) {
      const tourId = key.slice(key.lastIndexOf('/') + 1, -'.json'.length);
      if (!isContentId(tourId) || (await bucket.head(tourTransferKey(tourId)))) continue;
      const got = await getJson<unknown>(bucket, key);
      const rec = LentPanosSchema.safeParse(got?.value);
      const live = new Set(await bundlePanoIds(bucket, tourId));
      if (!rec.success || !rec.data.panoIds.some((id) => live.has(id))) await bucket.delete(key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
};

/** Q5: every panoId the owner's tours use, in the draft tour.json or in the
 * live published bundle. customMetadata only carries the cover, so both are
 * read. `excludeTourId` leaves out a tour that is being deleted (its bundle
 * is unpublished first) or handed on. Panos lent to a tour handed on count too. */
export const referencedPanoIds = async (
  bucket: R2Bucket,
  sub: string,
  excludeTourId?: string,
): Promise<Set<string>> => {
  const tourIds = (await listChildren(bucket, userToursPrefix(sub))).filter(
    (id) => id !== excludeTourId,
  );
  const referenced = await lentPanoIds(bucket, sub, excludeTourId);
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
