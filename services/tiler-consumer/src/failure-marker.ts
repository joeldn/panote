import {
  manifestKey,
  panoIdFromOriginalKey,
  tileFailedKeyFromOriginalKey,
} from '@internal/contracts';
import { TILER_OUTPUT_VERSION } from '@internal/tiler/version';
import { putJson } from '@internal/worker-kit/r2-binding';

export type FailureReason = 'dlq' | 'oversize' | 'unprocessable-key';

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
): Promise<void> => {
  let markerKey: string;
  try {
    markerKey = tileFailedKeyFromOriginalKey(originalNotificationKey);
  } catch (e) {
    // No owner/panoId to hang a marker off - nothing to write.
    console.warn(
      `cannot derive tile-failed marker for ${originalNotificationKey}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
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
    console.warn(
      `skip tile-failed marker for ${originalNotificationKey}: HEAD failed (${e instanceof Error ? e.message : String(e)})`,
    );
    return;
  }
  if (!head) {
    console.warn(
      `skip tile-failed marker for ${originalNotificationKey}: original no longer exists`,
    );
    return;
  }
  // Cloudflare create events always carry object.eTag; a missing one can't
  // be proven current, so skip rather than fail open onto whatever's there.
  if (expectedEtag === undefined) {
    console.warn(
      `skip tile-failed marker for ${originalNotificationKey}: notification carried no eTag`,
    );
    return;
  }
  if (bareEtag(head.etag) !== bareEtag(expectedEtag)) {
    console.warn(
      `skip tile-failed marker for ${originalNotificationKey}: original etag changed (superseded by a newer upload)`,
    );
    return;
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
          `skip tile-failed marker for ${originalNotificationKey}: a concurrent attempt already tiled this etag (manifest version ${expectedVersion})`,
        );
        return;
      }
    }
  } catch (e) {
    console.warn(
      `could not check the manifest for ${originalNotificationKey} before writing a marker: ${e instanceof Error ? e.message : String(e)}`,
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
    console.error(
      `failed to write tile-failed marker ${markerKey}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }

  // The original can be deleted between the pre-write HEAD above and the
  // PUT just above; clean up rather than leave a marker with no original.
  try {
    const postHead = await bucket.head(originalNotificationKey);
    if (!postHead) {
      await bucket.delete(markerKey).catch((e: unknown) => {
        console.warn(`failed to clear a just-written marker ${markerKey}: ${String(e)}`);
      });
    }
  } catch (e) {
    // The marker is already written; log only - there is nothing safe to
    // undo without knowing whether the original is actually still there.
    console.warn(
      `could not verify the original still exists after writing ${markerKey}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
};
