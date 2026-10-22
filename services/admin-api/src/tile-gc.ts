import {
  manifestKey,
  panoIdFromOriginalKey,
  TILE_GC_ROOT,
  TileGcRecordSchema,
  tileVersionPrefix,
} from '@internal/contracts';
import { deletePrefix } from '@internal/worker-kit/r2-binding';

// How long a superseded tile version stays after the manifest swap that
// superseded it. A viewer that loaded the old manifest keeps fetching that
// version's tiles for its whole session; edge-cached tiles would survive the
// delete, uncached ones would 404. A day is far past any session. The cron runs
// daily, so in practice a version goes between 24 and 48 hours after the swap.
export const TILE_GC_GRACE_MS = 24 * 60 * 60 * 1000;
// Records handled per run at most; the rest wait for the next day. Each costs
// a handful of R2 calls plus one list and one delete per 1000 tiles.
export const TILE_GC_BUDGET = 50;

const RECORD_KEY_RE = /^tile-gc\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\.json$/;
// t<TILER_OUTPUT_VERSION>-<original ETag>, as tiler-consumer's container.ts derives it.
const VERSION_RE = /^t(\d+)-(.+)$/;

export type TileGcOutcome = 'deleted' | 'current' | 'kept' | 'invalid';

const errorName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown error');

/**
 * One record from tiler-consumer (services/tiler-consumer/src/superseded.ts).
 * Deletes the version dir unless:
 * - the manifest points at it again ('current': the record goes, the dir stays);
 * - the pano's original would tile into it right now, i.e. its ETag and the
 *   tiler version that superseded it match the dir's name ('kept': a job may be
 *   writing there, so it's checked again tomorrow);
 * - the original exists but the manifest doesn't ('kept': not a state a swap
 *   leaves behind, so nothing is deleted on a guess).
 * A gone original means the pano was deleted, whose own sweep owns tiles/<panoId>/,
 * so the dir and the record just go.
 */
export const sweepTileGcRecord = async (bucket: R2Bucket, key: string): Promise<TileGcOutcome> => {
  const parsedKey = RECORD_KEY_RE.exec(key);
  const obj = parsedKey ? await bucket.get(key) : null;
  const record = obj ? TileGcRecordSchema.safeParse(await obj.json().catch(() => null)) : null;
  const panoId = parsedKey?.[1];
  const version = parsedKey?.[2];
  let recordPanoId: string | undefined;
  try {
    if (record?.success) recordPanoId = panoIdFromOriginalKey(record.data.originalKey);
  } catch {
    recordPanoId = undefined;
  }
  if (!panoId || !version || !record?.success || recordPanoId !== panoId) {
    // Not something the tiler writes: drop the record, touch no tiles.
    await bucket.delete(key);
    return 'invalid';
  }

  const manifestObj = await bucket.get(manifestKey(panoId));
  const manifest = manifestObj
    ? await manifestObj.json<{ version?: string }>().catch(() => null)
    : null;
  if (manifest?.version === version) {
    await bucket.delete(key);
    return 'current';
  }

  const original = await bucket.head(record.data.originalKey);
  if (original) {
    if (!manifestObj) return 'kept';
    const v = VERSION_RE.exec(version);
    if (v && v[2] === original.etag && Number(v[1]) === record.data.tilerVersion) return 'kept';
  }

  await deletePrefix(bucket, tileVersionPrefix(panoId, version));
  await bucket.delete(key);
  return 'deleted';
};

/**
 * Daily cron: deletes tile version dirs a manifest swap superseded at least
 * TILE_GC_GRACE_MS ago. Lists only tile-gc/, which holds just the versions still
 * waiting, never the whole bucket. One record failing doesn't stop the others.
 */
export const sweepSupersededTiles = async (
  bucket: R2Bucket,
  now: Date,
  budget = TILE_GC_BUDGET,
): Promise<Record<TileGcOutcome, number>> => {
  const counts: Record<TileGcOutcome, number> = { deleted: 0, current: 0, kept: 0, invalid: 0 };
  const cutoff = now.getTime() - TILE_GC_GRACE_MS;
  let handled = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: TILE_GC_ROOT, ...(cursor ? { cursor } : {}) });
    for (const obj of page.objects) {
      if (obj.uploaded.getTime() > cutoff) continue;
      if (handled >= budget) return report(counts, true);
      handled += 1;
      try {
        counts[await sweepTileGcRecord(bucket, obj.key)] += 1;
      } catch (e) {
        // The name only: R2 error messages can carry keys.
        console.error('[tile-gc] sweep failed for one version:', errorName(e));
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return report(counts, false);
};

const report = (
  counts: Record<TileGcOutcome, number>,
  truncated: boolean,
): Record<TileGcOutcome, number> => {
  if (counts.deleted || counts.kept || counts.invalid || truncated) {
    console.warn(
      `[tile-gc] deleted ${counts.deleted} superseded version(s), kept ${counts.kept}, dropped ${counts.current + counts.invalid} record(s)${truncated ? '; budget reached, the rest wait for tomorrow' : ''}`,
    );
  }
  return counts;
};
