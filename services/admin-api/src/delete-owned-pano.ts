import { deletingKey, panoPrefix, type PanoDeleteConflict } from '@internal/contracts';

import { deletePano } from './delete-pano.js';
import { summarizePano } from './lists.js';
import { referencedPanoIds } from './references.js';

// Covers the upload flow's own "add to tour" step: it runs while tiling and
// is resumable for an hour (RESUME_MAX_AGE_MS in apps/admin's resume store),
// so until then an unreferenced pano may still be about to get its scene.
export const RECENT_UPLOAD_MS = 60 * 60_000;
// A pano still `pending` this long after upload has a lost tiling job, not a
// running one; deletePano already copes with a late tiler (see its comment).
export const STALLED_TILING_MS = 24 * 60 * 60_000;

export type DeleteOwnedPanoResult =
  | { ok: true; tilesDeleted: boolean }
  | { ok: false; status: 404 }
  | { ok: false; status: 409; conflict: PanoDeleteConflict };

const NOT_FOUND = { ok: false, status: 404 } as const;
const conflict = (c: PanoDeleteConflict) => ({ ok: false, status: 409, conflict: c }) as const;

const isReferenced = async (bucket: R2Bucket, sub: string, panoId: string): Promise<boolean> =>
  (await referencedPanoIds(bucket, sub)).has(panoId);

/**
 * The owner-facing pano delete: refuses a pano any of the owner's tours uses,
 * or one that may still be joining a tour, then runs the same deletePano that
 * tour delete (Q5) uses. The original's delete inside deletePano is the commit
 * point; up to then a delete that finds a new reference rolls its tombstone back.
 *
 * Not atomic: R2 has no multi-key transaction, and the tour PUT doesn't check
 * its scenes' panos. A tour.json that lands after the second reference check,
 * from a client that already had the pano in hand (an editor undo of a scene
 * removal, or an upload's add-to-tour retried after more than an hour), ends
 * up with a scene whose image is gone: the editor marks it "Deleted", as after
 * tour delete's TOCTOU (delete-tour.ts), or, if that retry re-created its
 * config, shows a scene with no image. Either way the owner caused it by
 * deleting the pano, and no other data is touched.
 */
export const deleteOwnedPano = async (
  bucket: R2Bucket,
  sub: string,
  panoId: string,
  now: number = Date.now(),
): Promise<DeleteOwnedPanoResult> => {
  const prefix = panoPrefix(sub, panoId);
  // Ownership: only the caller's own prefix is ever looked at, so another
  // owner's panoId (or one that never existed) is simply empty here.
  const { objects } = await bucket.list({ prefix });
  if (objects.length === 0) return NOT_FOUND;
  const original = objects.find((o) => o.key === `${prefix}original`);
  const tombstone = objects.find((o) => o.key === `${prefix}deleting`);

  if (tombstone) {
    // Resuming an interrupted delete. With the original gone there is no image
    // left to save, so finish; with it still there, a tour that started using
    // the pano since wins and the tombstone is rolled back.
    if (original && (await isReferenced(bucket, sub, panoId))) {
      await bucket.delete(tombstone.key);
      return conflict('in-use');
    }
    return deletePano(bucket, sub, panoId);
  }

  if (await isReferenced(bucket, sub, panoId)) return conflict('in-use');

  if (original) {
    const age = now - original.uploaded.getTime();
    if (
      age < STALLED_TILING_MS &&
      (await summarizePano(bucket, sub, panoId)).tiling === 'pending'
    ) {
      return conflict('processing');
    }
    if (age < RECENT_UPLOAD_MS) return conflict('recent');
    // Tombstone first: from here a config PUT is refused (409), and the
    // second reference check below sees any tour.json written before it.
    await bucket.put(deletingKey(sub, panoId), '');
    if (await isReferenced(bucket, sub, panoId)) {
      await bucket.delete(deletingKey(sub, panoId));
      return conflict('in-use');
    }
  }
  // No original means no ownership proof, so no tombstone: deletePano then
  // only sweeps the caller's own prefix and never the owner-free tiles/.
  return deletePano(bucket, sub, panoId);
};
