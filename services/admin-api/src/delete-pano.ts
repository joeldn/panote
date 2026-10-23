import {
  deletingKey,
  originalKey,
  panoPrefix,
  tileGcPrefix,
  tilesPrefix,
} from '@internal/contracts';
import { deletePrefix } from '@internal/worker-kit/r2-binding';

import { discard, type DiscardOptions } from './trash.js';

// tilesDeleted: the tiles/<panoId>/ sweep removed objects, so their edge copies need a purge.
export type DeletePanoResult = { ok: true; tilesDeleted: boolean };

// deletePrefix, also handing each page of keys to `collect` before it is deleted.
const deleteCollecting = async (
  bucket: R2Bucket,
  prefix: string,
  collect: string[],
): Promise<number> => {
  let cursor: string | undefined;
  let deleted = 0;
  do {
    const r = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    const keys = r.objects.map((o) => o.key);
    collect.push(...keys);
    if (keys.length) await bucket.delete(keys);
    deleted += keys.length;
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  return deleted;
};

/** Proves ownership via the original OR a tombstone left by an interrupted
 * delete; the route itself checks auth before this ever runs. The original goes to
 * the trash (trash.ts) unless `options.trash` is false, which only a takedown asks for:
 * quarantine keeps what must be kept, and nothing taken down may linger anywhere else.
 * With `tileKeys`, every tile key it deletes is added to it, for a purge by URL
 * (operator takedown). */
export const deletePano = async (
  bucket: R2Bucket,
  sub: string,
  panoId: string,
  options: DiscardOptions & { keepTiles?: boolean } = { trash: true, now: new Date() },
  tileKeys?: string[],
): Promise<DeletePanoResult> => {
  const [original, tombstone] = await Promise.all([
    bucket.head(originalKey(sub, panoId)),
    bucket.head(deletingKey(sub, panoId)),
  ]);
  // No proof of ownership: only the caller's own prefix is touched, so a
  // config-only pano still deletes (and stays deleted) and tiles/ is untouched.
  if (!original && !tombstone) {
    await deletePrefix(bucket, panoPrefix(sub, panoId));
    return { ok: true, tilesDeleted: false };
  }
  if (!tombstone) await bucket.put(deletingKey(sub, panoId), '');
  await discard(bucket, originalKey(sub, panoId), options);
  // A pano lent to a tour the owner handed on (account deletion): its tiles serve that
  // tour's live bundle until the new owner publishes again, so they stay.
  if (options.keepTiles) {
    await deletePrefix(bucket, panoPrefix(sub, panoId));
    return { ok: true, tilesDeleted: false };
  }
  // One sweep suffices: every tiler write precedes that job's own last HEAD
  // of the original, which 404s after this delete and self-cleans that job's writes.
  const tiles = tileKeys
    ? await deleteCollecting(bucket, tilesPrefix(panoId), tileKeys)
    : await deletePrefix(bucket, tilesPrefix(panoId));
  // The tiler's superseded-version records name the owner-bearing original key;
  // they go with the tiles rather than waiting on the daily sweep.
  await deletePrefix(bucket, tileGcPrefix(panoId));
  // Tombstone included: a retry with no proof left still clears this prefix
  // via the no-proof branch above.
  await deletePrefix(bucket, panoPrefix(sub, panoId));
  return { ok: true, tilesDeleted: tiles > 0 };
};
