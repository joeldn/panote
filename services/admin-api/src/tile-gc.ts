import {
  manifestKey,
  panoIdFromOriginalKey,
  TILE_GC_ROOT,
  TileGcRecordSchema,
  tileVersionPrefix,
} from '@internal/contracts';
import { deletePrefix } from '@internal/worker-kit/r2-binding';
import { BACKUP_RUN_BUDGET, runBackup } from './backup.js';

// How long a superseded tile version stays after the manifest swap that
// superseded it. A viewer that loaded the old manifest keeps fetching that
// version's tiles for its whole session; edge-cached tiles would survive the
// delete, uncached ones would 404. A day is far past any session. The sweep runs
// every 15 minutes, so a version goes 24 hours to 24 hours 15 minutes after the swap.
export const TILE_GC_GRACE_MS = 24 * 60 * 60 * 1000;
// Records acted on (deleted or dropped) per run at most. The R2 budget below is
// what normally ends a run; this only keeps one from doing an unbounded amount
// of cheap work. At 96 runs a day it allows 19,200 records a day.
export const TILE_GC_BUDGET = 200;
// R2 operations (each one a subrequest) the backup and the sweep together may make
// in one 15-minute invocation: BACKUP_RUN_BUDGET, which the backup alone was sized
// to keep well under the per-invocation subrequest limit. The sweep gets what the
// backup leaves of it (runBackupThenTileGc). Once a day's backup set is complete a
// backup run costs 2, so most runs give the sweep about 900.
// A record costs 3 R2 operations to check, plus one list per 1,000 objects in the
// dir to look for newer writes and one list and one delete per 1,000 to delete it,
// and 1 for the record: about 7 for a typical pano, so ~125 records a run, ~12,000 a day.
// CPU is not the constraint: a record is a few small JSON parses.
export const TILE_GC_RUN_OPS = BACKUP_RUN_BUDGET;
// The most one record can cost: a full 16,384 px pyramid is 8,192 objects, so 9
// pages to check, and 9 lists and 9 deletes to delete, plus the record's own 4.
// A run starts a record only with this much of its budget left, so a record is
// never cut off half way by the budget.
export const TILE_GC_RECORD_MAX_OPS = 31;

const RECORD_KEY_RE = /^tile-gc\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\.json$/;
// t<TILER_OUTPUT_VERSION>-<original ETag>, as tiler-consumer's container.ts derives it.
const VERSION_RE = /^t(\d+)-(.+)$/;

export type TileGcOutcome = 'deleted' | 'current' | 'kept' | 'invalid';

const errorName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown error');

/**
 * One record from tiler-consumer (services/tiler-consumer/src/superseded.ts).
 * Deletes the version dir unless:
 * - the manifest points at it again ('current': the record goes, the dir stays);
 * - the manifest exists but can't be read ('kept': nothing is deleted on a guess);
 * - the pano's original would tile into it right now, i.e. its ETag and the
 *   tiler version that recorded it match the dir's name ('kept': a job may be
 *   writing there, so it's checked again next run). That holds with no manifest
 *   at all too, for the dir of a first upload whose job failed (tiler-consumer
 *   records those as well);
 * - anything in the dir was written after the record ('kept', and the record's
 *   time moves to now): a job rewrote it since, e.g. a re-upload of old bytes
 *   or a tiler rollback, so it may be live or about to be.
 * A gone original means the pano was deleted, whose own sweep owns tiles/<panoId>/,
 * so the dir and the record just go. An R2 error throws, deleting nothing more.
 */
export const sweepTileGcRecord = async (
  bucket: R2Bucket,
  key: string,
  now: Date = new Date(),
): Promise<TileGcOutcome> => {
  const parsedKey = RECORD_KEY_RE.exec(key);
  const panoId = parsedKey?.[1];
  const version = parsedKey?.[2];
  const obj = parsedKey ? await bucket.get(key) : null;
  // Gone since the listing: nothing to do.
  if (parsedKey && !obj) return 'current';
  // A read error throws; only a body that was read and doesn't parse is invalid.
  const text = obj ? await obj.text() : null;
  let body: unknown;
  try {
    body = text === null ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  const record = TileGcRecordSchema.safeParse(body);
  let recordPanoId: string | undefined;
  try {
    if (record.success) recordPanoId = panoIdFromOriginalKey(record.data.originalKey);
  } catch {
    recordPanoId = undefined;
  }
  if (!panoId || !version || !record.success || recordPanoId !== panoId) {
    // Not something the tiler writes: drop the record, touch no tiles.
    await bucket.delete(key);
    return 'invalid';
  }

  const manifestObj = await bucket.get(manifestKey(panoId));
  let manifestVersion: string | undefined;
  if (manifestObj) {
    try {
      manifestVersion = (JSON.parse(await manifestObj.text()) as { version?: unknown }).version as
        string | undefined;
    } catch {
      return 'kept';
    }
    if (typeof manifestVersion !== 'string') return 'kept';
  }
  if (manifestVersion === version) {
    await bucket.delete(key);
    return 'current';
  }

  // With a manifest or without one (a pano whose jobs have only failed so far),
  // a dir the current original would tile into is kept. Any other dir is from an
  // earlier original or tiler build: no job will write a manifest naming it.
  const original = await bucket.head(record.data.originalKey);
  if (original) {
    const v = VERSION_RE.exec(version);
    if (v && v[2] === bareEtag(original.etag) && Number(v[1]) === record.data.tilerVersion) {
      return 'kept';
    }
  }

  const prefix = tileVersionPrefix(panoId, version);
  const recordedAt = Date.parse(record.data.supersededAt);
  if (await writtenSince(bucket, prefix, Number.isNaN(recordedAt) ? 0 : recordedAt)) {
    await bucket.put(key, JSON.stringify({ ...record.data, supersededAt: now.toISOString() }), {
      httpMetadata: { contentType: 'application/json' },
    });
    return 'kept';
  }

  await deletePrefix(bucket, prefix);
  await bucket.delete(key);
  return 'deleted';
};

// R2 binding ETags are bare today; strip quotes anyway so a quoted form can't
// make the in-flight guard miss.
const bareEtag = (raw: string): string => raw.replace(/^"|"$/g, '');

/** True if any object under `prefix` was written after `since` (ms). */
const writtenSince = async (bucket: R2Bucket, prefix: string, since: number): Promise<boolean> => {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    if (page.objects.some((o) => o.uploaded.getTime() > since)) return true;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return false;
};

// At most this many records are looked at per run, acted on or not, so a pile of
// kept ones can't make a run unbounded.
export const TILE_GC_EXAMINE_CAP = 500;

export interface TileGcRunLimits {
  /** Records acted on (deleted, current, invalid). */
  budget?: number;
  /** Records looked at, kept ones included. */
  examineCap?: number;
  /** R2 operations, the listing included. */
  ops?: number;
}

/** Counts every R2 call made through it. */
const metered = (bucket: R2Bucket): { bucket: R2Bucket; spent: () => number } => {
  let n = 0;
  const count = <T>(call: () => T): T => {
    n += 1;
    return call();
  };
  const counted = {
    get: (...a: Parameters<R2Bucket['get']>) => count(() => bucket.get(...a)),
    head: (...a: Parameters<R2Bucket['head']>) => count(() => bucket.head(...a)),
    list: (...a: Parameters<R2Bucket['list']>) => count(() => bucket.list(...a)),
    put: (...a: Parameters<R2Bucket['put']>) => count(() => bucket.put(...a)),
    delete: (...a: Parameters<R2Bucket['delete']>) => count(() => bucket.delete(...a)),
  };
  // The sweep only calls these five.
  return { bucket: counted as unknown as R2Bucket, spent: () => n };
};

/**
 * Where a run starts in tile-gc/, so kept records listed first can't take every
 * run's budget: one of 16 points, moving on each quarter hour. Pano ids are UUIDs,
 * so records spread evenly over them. A run lists from there to the end, then
 * from the start back round to it.
 */
export const tileGcStart = (now: Date): string =>
  `${TILE_GC_ROOT}${(Math.floor(now.getTime() / (15 * 60 * 1000)) % 16).toString(16)}`;

/**
 * Deletes tile version dirs a manifest swap superseded (or a failed job left) at
 * least TILE_GC_GRACE_MS ago. Runs every 15 minutes after the backup (index.ts).
 * Lists only tile-gc/, which holds just the versions still waiting, never the
 * whole bucket. A run stops at whichever limit it reaches first: `budget` records
 * acted on (deleted, current, invalid), `examineCap` records looked at (kept ones
 * only count here, so they can't starve the records listed after them), or `ops`
 * R2 operations; the rest wait for the next run. One record failing doesn't stop
 * the others.
 */
export const sweepSupersededTiles = async (
  bucket: R2Bucket,
  now: Date,
  limits: TileGcRunLimits = {},
): Promise<Record<TileGcOutcome, number>> => {
  const budget = limits.budget ?? TILE_GC_BUDGET;
  const examineCap = limits.examineCap ?? TILE_GC_EXAMINE_CAP;
  const ops = limits.ops ?? TILE_GC_RUN_OPS;
  const meter = metered(bucket);
  const counts: Record<TileGcOutcome, number> = { deleted: 0, current: 0, kept: 0, invalid: 0 };
  const cutoff = now.getTime() - TILE_GC_GRACE_MS;
  const start = tileGcStart(now);
  let acted = 0;
  let examined = 0;
  // Two passes: [start, end), then [beginning, start).
  for (const pass of [{ startAfter: start }, { until: start }] as const) {
    let cursor: string | undefined;
    do {
      // Room for this listing and one whole record after it.
      if (meter.spent() + 1 + TILE_GC_RECORD_MAX_OPS > ops) return report(counts, true);
      const page = await meter.bucket.list({
        prefix: TILE_GC_ROOT,
        // A cursor carries on from the page before; startAfter only opens the pass.
        ...(cursor ? { cursor } : 'startAfter' in pass ? { startAfter: pass.startAfter } : {}),
      });
      for (const obj of page.objects) {
        if ('until' in pass && obj.key >= pass.until) return report(counts, false);
        if (obj.uploaded.getTime() > cutoff) continue;
        if (
          acted >= budget ||
          examined >= examineCap ||
          meter.spent() + TILE_GC_RECORD_MAX_OPS > ops
        )
          return report(counts, true);
        examined += 1;
        try {
          const outcome = await sweepTileGcRecord(meter.bucket, obj.key, now);
          counts[outcome] += 1;
          if (outcome !== 'kept') acted += 1;
        } catch (e) {
          // The name only: R2 error messages can carry keys.
          console.error('[tile-gc] sweep failed for one version:', errorName(e));
        }
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  return report(counts, false);
};

const report = (
  counts: Record<TileGcOutcome, number>,
  truncated: boolean,
): Record<TileGcOutcome, number> => {
  if (counts.deleted || counts.kept || counts.invalid || truncated) {
    console.warn(
      `[tile-gc] deleted ${counts.deleted} superseded version(s), kept ${counts.kept}, dropped ${counts.current + counts.invalid} record(s)${truncated ? '; a limit was reached, the rest wait for the next run' : ''}`,
    );
  }
  return counts;
};

/**
 * The 15-minute cron: the backup first, then the tile sweep with the R2 operations
 * the backup left of TILE_GC_RUN_OPS. A backup that throws is assumed to have spent
 * its whole budget, so the sweep skips that run, and its error is thrown again
 * once the sweep is done.
 */
export const runBackupThenTileGc = async (
  bucket: R2Bucket,
  now: Date,
  backup: (bucket: R2Bucket, now: Date) => Promise<{ operations: number }> = runBackup,
): Promise<void> => {
  let spent = TILE_GC_RUN_OPS;
  let backupError: { error: unknown } | undefined;
  try {
    spent = (await backup(bucket, now)).operations;
  } catch (error) {
    backupError = { error };
  }
  try {
    await sweepSupersededTiles(bucket, now, { ops: TILE_GC_RUN_OPS - spent });
  } catch (e) {
    console.error('[tile-gc] run failed:', errorName(e));
  }
  if (backupError) throw backupError.error;
};
