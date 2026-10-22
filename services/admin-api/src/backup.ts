import {
  ACCOUNTS_ROOT,
  BACKUP_DATE_PATTERN,
  BACKUP_PROGRESS_KEY,
  BACKUP_ROOT,
  BACKUP_SOURCES,
  backupCompleteKey,
  backupKey,
  backupSetPrefix,
  BackupProgressSchema,
  type BackupCompleteRecord,
  type BackupProgress,
  type OperatorRestoreOk,
} from '@internal/contracts';

// Daily backup of the JSON that defines user content (BACKUP_SOURCES in
// @internal/contracts), copied to backup/<YYYY-MM-DD>/<original key> in the same
// bucket and kept BACKUP_RETENTION_DAYS. It runs on its own cron (BACKUP_CRON,
// every 15 minutes), so it has a whole invocation's subrequest budget to itself.
// Each run does at most BACKUP_RUN_BUDGET R2 operations and records where it got
// to in backup/progress.json; the next run carries on from there, past midnight if
// it must, and a new day's set starts only once the last one is complete. Once a
// set is whole a run writes backup/<date>/complete.json and prunes old sets; after
// that, until the next UTC day, a run costs one GET and one HEAD. See "Backups" in
// docs/deploy.md for the limits and how to restore.

/** The cron expression (wrangler.jsonc, both envs) that runs the backup, not the daily sweeps. */
export const BACKUP_CRON = '*/15 * * * *';
export const BACKUP_RETENTION_DAYS = 30;
// R2 operations (each one a subrequest) one run makes at most: a copy is a GET and
// a PUT. Under the Workers per-invocation subrequest limit with room to spare, so a slow R2
// or a retry can't take a run over it.
export const BACKUP_RUN_BUDGET = 900;
// Objects copied at once. Every copy is read whole into memory, so with the size cap
// below a batch stays far under the isolate's 128 MB.
const COPY_BATCH = 10;
// A document larger than this is not copied (and is counted as skipped): nothing the
// app writes comes near it, so one would be a mistake that shouldn't sink the run.
export const BACKUP_MAX_OBJECT_BYTES = 8 * 1024 * 1024;

const DAY_MS = 24 * 60 * 60 * 1000;
const LOG_PREFIX = '[backup]';

export const utcDate = (at: Date): string => at.toISOString().slice(0, 10);

const errorName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown error');

export type BackupSource = (typeof BACKUP_SOURCES)[number];

export interface BackupRunResult {
  /** 'idle': today's set was already complete. 'partial': the budget ran out first. */
  status: 'idle' | 'partial' | 'complete';
  date: string;
  /** Objects copied by this run. */
  copied: number;
  /** R2 operations this run made. */
  operations: number;
  /** Old sets this run deleted. */
  pruned: string[];
}

const readProgress = async (bucket: R2Bucket): Promise<BackupProgress | null> => {
  const obj = await bucket.get(BACKUP_PROGRESS_KEY);
  if (!obj) return null;
  let body: unknown;
  try {
    body = JSON.parse(await obj.text());
  } catch {
    body = null;
  }
  const parsed = BackupProgressSchema.safeParse(body);
  if (!parsed.success || !BACKUP_DATE_PATTERN.test(parsed.data.date)) {
    // Starting the day's set again is safe: a copy just overwrites itself.
    console.error(`${LOG_PREFIX} progress record unreadable, starting a new set`);
    return null;
  }
  return parsed.data;
};

const putJsonRecord = (bucket: R2Bucket, key: string, value: unknown) =>
  bucket.put(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } });

type CopyOutcome = 'copied' | 'gone' | 'skipped' | 'failed';

/** Copies one object into the set, body and both kinds of metadata, as the binding stores them. */
const copyOne = async (
  bucket: R2Bucket,
  date: string,
  key: string,
): Promise<{ outcome: CopyOutcome; bytes: number }> => {
  try {
    const obj = await bucket.get(key);
    // Deleted since the listing: it isn't part of the content any more.
    if (!obj) return { outcome: 'gone', bytes: 0 };
    if (obj.size > BACKUP_MAX_OBJECT_BYTES) {
      await obj.body.cancel();
      return { outcome: 'skipped', bytes: 0 };
    }
    const body = await obj.arrayBuffer();
    await bucket.put(backupKey(date, key), body, {
      httpMetadata: obj.httpMetadata ?? {},
      customMetadata: obj.customMetadata ?? {},
    });
    return { outcome: 'copied', bytes: body.byteLength };
  } catch (e) {
    // The name only: R2 error messages can carry keys, and keys carry the owner.
    console.error(`${LOG_PREFIX} one copy failed:`, errorName(e));
    return { outcome: 'failed', bytes: 0 };
  }
};

/** Deletes `prefix` page by page while the budget lasts; true once it's all gone. */
const deletePrefixWithin = async (
  bucket: R2Bucket,
  prefix: string,
  spend: (n: number) => boolean,
): Promise<boolean> => {
  for (;;) {
    if (!spend(2)) return false;
    const page = await bucket.list({ prefix });
    if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
    if (!page.truncated) return true;
  }
};

/**
 * Deletes every dated set older than BACKUP_RETENTION_DAYS before `now`, but never
 * `keep` (the newest complete set), so a backup that has been failing for a month
 * still leaves its last good set behind. Returns the dates deleted in full.
 */
export const pruneBackups = async (
  bucket: R2Bucket,
  now: Date,
  keep: string,
  spend: (n: number) => boolean = () => true,
): Promise<string[]> => {
  const oldest = utcDate(new Date(now.getTime() - BACKUP_RETENTION_DAYS * DAY_MS));
  const dates: string[] = [];
  let cursor: string | undefined;
  do {
    if (!spend(1)) return [];
    const page = await bucket.list({
      prefix: BACKUP_ROOT,
      delimiter: '/',
      ...(cursor ? { cursor } : {}),
    });
    for (const p of page.delimitedPrefixes) {
      const date = p.slice(BACKUP_ROOT.length, -1);
      if (BACKUP_DATE_PATTERN.test(date) && date < oldest && date !== keep) dates.push(date);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const pruned: string[] = [];
  for (const date of dates.sort()) {
    if (!(await deletePrefixWithin(bucket, backupSetPrefix(date), spend))) break;
    pruned.push(date);
  }
  return pruned;
};

/**
 * One cron run: carries on with the set in backup/progress.json, or starts today's
 * if today has no complete set yet, and copies until the set is done or `budget`
 * R2 operations are spent. A copy that fails is counted and left out of the set
 * rather than retried forever; the next day's set has another go at it.
 */
export const runBackup = async (
  bucket: R2Bucket,
  now: Date,
  budget = BACKUP_RUN_BUDGET,
  sources: readonly BackupSource[] = BACKUP_SOURCES,
): Promise<BackupRunResult> => {
  let operations = 0;
  // Always leaves one operation over, for the progress write that ends a partial run.
  const spend = (n: number): boolean => {
    if (operations + n + 1 > budget) return false;
    operations += n;
    return true;
  };
  const today = utcDate(now);

  operations += 1;
  let progress = await readProgress(bucket);
  if (!progress) {
    operations += 1;
    if (await bucket.head(backupCompleteKey(today))) {
      return { status: 'idle', date: today, copied: 0, operations, pruned: [] };
    }
    progress = {
      v: 1,
      date: today,
      startedAt: now.toISOString(),
      objects: 0,
      bytes: 0,
      failed: 0,
      skipped: 0,
      runs: 0,
      source: 0,
    };
  } else if (progress.date < utcDate(new Date(now.getTime() - DAY_MS))) {
    console.warn(
      `${LOG_PREFIX} set ${progress.date} is still being written; the backup is falling behind (docs/deploy.md, Backups)`,
    );
  }
  const state = progress;
  state.runs += 1;
  const { date } = state;
  let copied = 0;

  const stop = async (): Promise<BackupRunResult> => {
    operations += 1;
    await putJsonRecord(bucket, BACKUP_PROGRESS_KEY, state);
    console.warn(
      `${LOG_PREFIX} set ${date}: ${copied} object(s) copied this run, ${state.objects} so far; the next run carries on`,
    );
    return { status: 'partial', date, copied, operations, pruned: [] };
  };

  while (state.source < sources.length) {
    const source = sources[state.source]!;
    let cursor: string | undefined;
    for (;;) {
      if (!spend(1)) return stop();
      const page = await bucket.list({
        prefix: source.prefix,
        ...(cursor
          ? { cursor }
          : state.startAfter !== undefined
            ? { startAfter: state.startAfter }
            : {}),
      });
      const wanted = page.objects.filter((o) => source.match.test(o.key));
      // Oversized objects are counted, not read, so they cost nothing.
      const small = wanted.filter((o) => o.size <= BACKUP_MAX_OBJECT_BYTES);
      state.skipped += wanted.length - small.length;
      for (let i = 0; i < small.length;) {
        // A full batch, or as much of one as the budget still covers.
        const room = Math.floor((budget - operations - 1) / 2);
        const batch = small.slice(i, i + Math.min(COPY_BATCH, room));
        if (batch.length === 0 || !spend(2 * batch.length)) return stop();
        const results = await Promise.all(batch.map((o) => copyOne(bucket, date, o.key)));
        for (const r of results) {
          if (r.outcome === 'copied') {
            copied += 1;
            state.objects += 1;
            state.bytes += r.bytes;
          } else if (r.outcome === 'failed') {
            state.failed += 1;
          } else if (r.outcome === 'skipped') {
            state.skipped += 1;
          }
        }
        state.startAfter = batch.at(-1)!.key;
        i += batch.length;
      }
      const last = page.objects.at(-1);
      if (last) state.startAfter = last.key;
      if (!page.truncated) break;
      cursor = page.cursor;
      // After every page, so an invocation that dies part way loses one page's work at most.
      if (!spend(1)) return stop();
      await putJsonRecord(bucket, BACKUP_PROGRESS_KEY, state);
    }
    state.source += 1;
    delete state.startAfter;
  }

  const record: BackupCompleteRecord = {
    v: 1,
    date,
    startedAt: state.startedAt,
    completedAt: now.toISOString(),
    objects: state.objects,
    bytes: state.bytes,
    failed: state.failed,
    skipped: state.skipped,
    runs: state.runs,
  };
  // The marker and the progress delete: one from the budget, one from its reserve.
  if (!spend(1)) return stop();
  operations += 1;
  await putJsonRecord(bucket, backupCompleteKey(date), record);
  await bucket.delete(BACKUP_PROGRESS_KEY);
  // Whatever budget is left; a prune cut short finishes after the next set.
  const pruned = await pruneBackups(bucket, now, date, spend);
  const problems =
    state.failed || state.skipped
      ? `; ${state.failed} failed and ${state.skipped} over ${BACKUP_MAX_OBJECT_BYTES} bytes are NOT in it`
      : '';
  const log = state.failed || state.skipped ? console.error : console.warn;
  log(
    `${LOG_PREFIX} set ${date} complete: ${state.objects} object(s), ${state.bytes} bytes, in ${state.runs} run(s)${problems}; pruned ${pruned.length} old set(s)`,
  );
  return { status: 'complete', date, copied, operations, pruned };
};

/**
 * The operator restore route's work: copies backup/<date>/<key> back to <key>, body
 * and metadata, for each key. Create-only unless `overwrite`, so by default nothing
 * that exists now is touched. Keys of an owner whose account is marked for deletion
 * are refused: the daily sweep would only delete them again. Keys must already be
 * checked with isRestorableKey (the request schema does).
 */
export const restoreFromBackup = async (
  bucket: R2Bucket,
  date: string,
  keys: readonly string[],
  overwrite: boolean,
): Promise<OperatorRestoreOk> => {
  const out: OperatorRestoreOk = { restored: [], existing: [], missing: [], refused: [] };
  const deleted = new Map<string, Promise<boolean>>();
  const ownerDeleted = (key: string): Promise<boolean> => {
    const owner = /^(?:tours|panos)\/([^/]+)\//.exec(key)?.[1];
    if (!owner) return Promise.resolve(false);
    let hit = deleted.get(owner);
    if (!hit) {
      hit = bucket.head(`${ACCOUNTS_ROOT}${owner}/deletion.json`).then((h) => !!h);
      deleted.set(owner, hit);
    }
    return hit;
  };
  const restoreOne = async (key: string): Promise<keyof OperatorRestoreOk> => {
    if (await ownerDeleted(key)) return 'refused';
    const obj = await bucket.get(backupKey(date, key));
    if (!obj) return 'missing';
    const written = await bucket.put(key, await obj.arrayBuffer(), {
      httpMetadata: obj.httpMetadata ?? {},
      customMetadata: obj.customMetadata ?? {},
      ...(overwrite ? {} : { onlyIf: { etagDoesNotMatch: '*' } }),
    });
    return written ? 'restored' : 'existing';
  };
  const unique = [...new Set(keys)];
  for (let i = 0; i < unique.length; i += COPY_BATCH) {
    const batch = unique.slice(i, i + COPY_BATCH);
    const outcomes = await Promise.all(batch.map(restoreOne));
    outcomes.forEach((o, j) => out[o].push(batch[j]!));
  }
  return out;
};
