import {
  manifestKey,
  panoIdFromOriginalKey,
  tileFailedKeyFromOriginalKey,
} from '@internal/contracts';
import { TILER_OUTPUT_VERSION } from '@internal/tiler/version';
import { putJson } from '@internal/worker-kit/r2-binding';
import { errorText, panoIdForLog } from './upload-prefix.js';

export type FailureReason = 'dlq' | 'oversize' | 'unprocessable-key';
export type MarkerOutcome = 'written' | 'skipped' | 'failed';

// R2 event etags may arrive quoted (S3-style) or bare; R2Object.etag is
// always bare - strip quotes from both sides before comparing.
const bareEtag = (raw: string | null | undefined): string | null =>
  raw ? raw.replace(/^"|"$/g, '') : null;

// Writes panos/<owner>/<panoId>/tile-failed for a permanently failed
// original; skips it if the original is gone or was superseded (unit B4).
export const writeFailureMarker = async (
  bucket: R2Bucket,
  originalNotificationKey: string,
  reason: FailureReason,
  expectedEtag?: string,
): Promise<MarkerOutcome> => {
  // Log lines name the pano only: both keys below carry the owner segment.
  const pano = panoIdForLog(originalNotificationKey);
  let markerKey: string;
  try {
    markerKey = tileFailedKeyFromOriginalKey(originalNotificationKey);
  } catch {
    // No owner/panoId to hang a marker off - nothing to write. A fixed
    // reason only: the parse error describes the segments it rejected.
    console.warn(
      `cannot derive tile-failed marker pano=${pano}: key is not panos/<owner>/<panoId>/original with valid segments`,
    );
    return 'skipped';
  }
  // Same input already validated above, so this cannot throw again.
  const panoId = panoIdFromOriginalKey(originalNotificationKey);

  // Resurrection guard: a completed delete must not be recreated by a
  // marker write that lands after deletePano already swept this prefix.
  let head: R2Object | null;
  try {
    head = await bucket.head(originalNotificationKey);
  } catch (e) {
    // An R2 error here must not read as "original is gone" - skip, don't write.
    console.warn(`skip tile-failed marker pano=${pano}: HEAD failed (${errorText(e)})`);
    return 'skipped';
  }
  if (!head) {
    console.warn(`skip tile-failed marker pano=${pano}: original no longer exists`);
    return 'skipped';
  }
  // Cloudflare create events always carry object.eTag; a missing one can't
  // be proven current, so skip rather than fail open onto whatever's there.
  if (expectedEtag === undefined) {
    console.warn(`skip tile-failed marker pano=${pano}: notification carried no eTag`);
    return 'skipped';
  }
  if (bareEtag(head.etag) !== bareEtag(expectedEtag)) {
    console.warn(
      `skip tile-failed marker pano=${pano}: original etag changed (superseded by a newer upload)`,
    );
    return 'skipped';
  }

  // Same-etag race: a concurrent success (duplicate delivery or identical
  // re-upload) may already have tiled this etag - best-effort, non-blocking.
  try {
    const manifestObj = await bucket.get(manifestKey(panoId));
    if (manifestObj) {
      const manifest = (await manifestObj.json()) as { version?: string };
      const expectedVersion = `t${TILER_OUTPUT_VERSION}-${bareEtag(head.etag)}`;
      if (manifest.version === expectedVersion) {
        console.warn(
          `skip tile-failed marker pano=${pano}: a concurrent attempt already tiled this etag (manifest version ${expectedVersion})`,
        );
        return 'skipped';
      }
    }
  } catch (e) {
    console.warn(
      `could not check the manifest pano=${pano} before writing a marker: ${errorText(e)}`,
    );
  }

  try {
    await putJson(
      bucket,
      markerKey,
      { reason, at: new Date().toISOString(), originalEtag: head.etag },
      undefined,
      { reason, originalEtag: head.etag },
    );
  } catch (e) {
    console.error(`failed to write tile-failed marker pano=${pano}: ${errorText(e)}`);
    return 'failed';
  }

  // The original can be deleted between the pre-write HEAD above and the
  // PUT just above; clean up rather than leave a marker with no original.
  try {
    const postHead = await bucket.head(originalNotificationKey);
    if (!postHead) {
      // A failed delete leaves an orphan marker behind, so report it as failed.
      let cleared = true;
      await bucket.delete(markerKey).catch((e: unknown) => {
        cleared = false;
        console.warn(`failed to clear a just-written marker pano=${pano}: ${errorText(e)}`);
      });
      return cleared ? 'skipped' : 'failed';
    }
  } catch (e) {
    // The marker is already written; log only - there is nothing safe to
    // undo without knowing whether the original is actually still there.
    console.warn(
      `could not verify the original still exists after writing the marker pano=${pano}: ${errorText(e)}`,
    );
  }
  return 'written';
};
