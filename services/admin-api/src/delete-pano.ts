import { deletingKey, originalKey, panoPrefix, tilesPrefix } from '@internal/contracts';
import { deletePrefix } from '@internal/worker-kit/r2-binding';

export type DeletePanoResult = { ok: true };

/** Proves ownership via the original OR a tombstone left by an interrupted
 * delete; the route itself checks auth before this ever runs. */
export const deletePano = async (
  bucket: R2Bucket,
  sub: string,
  panoId: string,
): Promise<DeletePanoResult> => {
  const [original, tombstone] = await Promise.all([
    bucket.head(originalKey(sub, panoId)),
    bucket.head(deletingKey(sub, panoId)),
  ]);
  // No proof of ownership: only the caller's own prefix is touched, so a
  // config-only pano still deletes (and stays deleted) and tiles/ is untouched.
  if (!original && !tombstone) {
    await deletePrefix(bucket, panoPrefix(sub, panoId));
    return { ok: true };
  }
  if (!tombstone) await bucket.put(deletingKey(sub, panoId), '');
  await bucket.delete(originalKey(sub, panoId));
  // One sweep suffices: every tiler write precedes that job's own last HEAD
  // of the original, which 404s after this delete and self-cleans that job's writes.
  await deletePrefix(bucket, tilesPrefix(panoId));
  // Tombstone included: a retry with no proof left still clears this prefix
  // via the no-proof branch above.
  await deletePrefix(bucket, panoPrefix(sub, panoId));
  return { ok: true };
};
