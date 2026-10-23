import {
  ACCOUNTS_ROOT,
  BACKUP_DATE_PATTERN,
  TRASH_RETENTION_DAYS,
  TRASH_ROOT,
  trashDayPrefix,
  trashKey,
  type OperatorRestoreOk,
} from '@internal/contracts';

import { utcDate } from './backup.js';

// Deleted originals wait in trash/<YYYY-MM-DD>/<their key> (contracts keys.ts, TRASH_ROOT)
// for TRASH_RETENTION_DAYS before the daily sweep deletes them, so an original deleted by
// mistake (a pano delete, a tour delete that took its unshared panos, an account delete)
// can be put back by the operator (restore-backup.ts --from-trash). Originals aren't in
// the nightly backup: at up to 150 MB each, a copy every night would double the storage.
// Only what a takedown deletes skips the trash: see deletePano's `trash` option.

const DAY_MS = 24 * 60 * 60 * 1000;
const LOG_PREFIX = '[trash]';

const errorName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown error');

/** Whether a delete keeps a copy in the trash, and the day it is filed under. */
export type DiscardOptions = { trash: boolean; now: Date };

/**
 * Moves `key` to today's trash: copies it (the body streamed, never buffered, with both
 * kinds of metadata), then deletes it. False if there was nothing to move. A copy that
 * fails throws before the original is deleted, and a short copy is removed first. A second delete of the same key on the same
 * day replaces the first copy, which is the older bytes of the same pano.
 */
export const moveToTrash = async (bucket: R2Bucket, key: string, now: Date): Promise<boolean> => {
  const obj = await bucket.get(key);
  if (!obj) return false;
  const copy = await bucket.put(trashKey(utcDate(now), key), obj.body, {
    httpMetadata: obj.httpMetadata ?? {},
    customMetadata: obj.customMetadata ?? {},
  });
  if (copy.size !== obj.size) {
    // The original stays, so the partial copy is only clutter that would read as a restore.
    await bucket.delete(copy.key);
    throw new Error('trash copy is incomplete');
  }
  await bucket.delete(key);
  return true;
};

/** Deletes `key`, through the trash unless `trash` is false. */
export const discard = async (
  bucket: R2Bucket,
  key: string,
  { trash, now }: DiscardOptions,
): Promise<void> => {
  if (trash) await moveToTrash(bucket, key, now);
  else await bucket.delete(key);
};

/** The days trash/ holds, oldest first. */
const trashDays = async (bucket: R2Bucket): Promise<string[]> => {
  const days: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: TRASH_ROOT,
      delimiter: '/',
      ...(cursor ? { cursor } : {}),
    });
    for (const p of page.delimitedPrefixes) {
      const date = p.slice(TRASH_ROOT.length, -1);
      if (BACKUP_DATE_PATTERN.test(date)) days.push(date);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return days.sort();
};

/**
 * For a takedown: deletes, from every day of the trash, the copies under `prefix` (an
 * owner's `panos/<owner>/`) that `match` accepts (all of them without one). An owner who
 * deleted a reported pano before the takedown left its original here, where the takedown
 * would otherwise never look. About two R2 operations a day held (a listing per page, a
 * batch delete), so at most about 64. Returns how many it deleted.
 */
export const deleteFromTrash = async (
  bucket: R2Bucket,
  prefix: string,
  match: (key: string) => boolean = () => true,
): Promise<number> => {
  let deleted = 0;
  for (const date of await trashDays(bucket)) {
    const within = trashKey(date, prefix);
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix: within, ...(cursor ? { cursor } : {}) });
      const keys = page.objects
        .map((o) => o.key)
        .filter((k) => match(k.slice(trashDayPrefix(date).length)));
      if (keys.length) await bucket.delete(keys);
      deleted += keys.length;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  if (deleted) console.warn(`${LOG_PREFIX} takedown deleted ${deleted} trashed original(s)`);
  return deleted;
};

// R2 operations one sweep makes at most: a listing page or a batch delete (up to 1,000
// keys) each. Trash is a few objects a day, so a run normally needs a handful; what a run
// doesn't reach waits for the next day, when the same days are still the oldest.
export const TRASH_SWEEP_BUDGET = 100;

export type TrashSweepResult = {
  /** Objects deleted for good. */
  deleted: number;
  /** Days emptied in full. */
  days: string[];
  /** False when the budget ran out first; the next run carries on. */
  done: boolean;
};

/**
 * Daily cron: deletes every day of trash TRASH_RETENTION_DAYS or more before today. The
 * cron runs at 03:17 UTC, so an original deleted on day D goes on day D+30: kept at least
 * 29 days, gone within 31. Spends at most `budget` R2 operations; the rest waits for the
 * next run, which finds the same expired days first.
 */
export const sweepTrash = async (
  bucket: R2Bucket,
  now: Date,
  budget = TRASH_SWEEP_BUDGET,
): Promise<TrashSweepResult> => {
  const last = utcDate(new Date(now.getTime() - TRASH_RETENTION_DAYS * DAY_MS));
  let operations = 0;
  const spend = (): boolean => {
    if (operations >= budget) return false;
    operations += 1;
    return true;
  };
  const result: TrashSweepResult = { deleted: 0, days: [], done: false };
  const report = (): TrashSweepResult => {
    if (result.deleted || !result.done) {
      console.warn(
        `${LOG_PREFIX} deleted ${result.deleted} object(s) past ${TRASH_RETENTION_DAYS} days${result.done ? '' : '; budget reached, the rest go tomorrow'}`,
      );
    }
    return result;
  };

  const expired: string[] = [];
  let cursor: string | undefined;
  do {
    if (!spend()) return report();
    const page = await bucket.list({
      prefix: TRASH_ROOT,
      delimiter: '/',
      ...(cursor ? { cursor } : {}),
    });
    for (const p of page.delimitedPrefixes) {
      const date = p.slice(TRASH_ROOT.length, -1);
      if (BACKUP_DATE_PATTERN.test(date) && date <= last) expired.push(date);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  for (const date of expired.sort()) {
    for (;;) {
      if (!spend()) return report();
      const page = await bucket.list({ prefix: trashDayPrefix(date) });
      if (page.objects.length) {
        if (!spend()) return report();
        await bucket.delete(page.objects.map((o) => o.key));
        result.deleted += page.objects.length;
      }
      if (!page.truncated) break;
    }
    result.days.push(date);
  }
  result.done = true;
  return report();
};

/**
 * The operator restore route's work for `from: "trash"`: copies trash/<date>/<key> back to
 * <key> for each original key, body streamed and metadata kept, create-only unless
 * `overwrite`. The trash copy stays until it ages out. Refused when the owner's account is
 * marked for deletion: the daily sweep would only delete it again. The R2 notification
 * re-tiles a restored original, as it would a fresh upload. Keys must already be checked
 * with isOriginalKey (the request schema does).
 */
export const restoreFromTrash = async (
  bucket: R2Bucket,
  date: string,
  keys: readonly string[],
  overwrite: boolean,
): Promise<OperatorRestoreOk> => {
  const out: OperatorRestoreOk = {
    restored: [],
    existing: [],
    missing: [],
    refused: [],
    failed: [],
  };
  const deleted = new Map<string, Promise<boolean>>();
  const ownerDeleted = (owner: string) => {
    let hit = deleted.get(owner);
    if (!hit) {
      hit = bucket.head(`${ACCOUNTS_ROOT}${owner}/deletion.json`).then((o) => !!o);
      deleted.set(owner, hit);
    }
    return hit;
  };
  // One at a time: an original can be 150 MB, and each is streamed through this Worker.
  for (const key of new Set(keys)) {
    try {
      const owner = key.split('/')[1]!;
      if (await ownerDeleted(owner)) {
        out.refused.push(key);
        continue;
      }
      const obj = await bucket.get(trashKey(date, key));
      if (!obj) {
        out.missing.push(key);
        continue;
      }
      const written = await bucket.put(key, obj.body, {
        httpMetadata: obj.httpMetadata ?? {},
        customMetadata: obj.customMetadata ?? {},
        ...(overwrite ? {} : { onlyIf: { etagDoesNotMatch: '*' } }),
      });
      if (written) {
        out.restored.push(key);
      } else {
        await obj.body.cancel().catch(() => undefined);
        out.existing.push(key);
      }
    } catch (e) {
      // The name only: R2 error messages can carry keys, and keys carry the owner.
      console.error(`${LOG_PREFIX} one restore failed:`, errorName(e));
      out.failed.push(key);
    }
  }
  return out;
};
